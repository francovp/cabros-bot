'use strict';

/**
 * Small in-process pub/sub for decoupling side-effect consumers from the
 * request hot path. Subscribers register handlers for named events and
 * publishers emit payloads synchronously (default) or asynchronously
 * (`emitAsync`, with bounded per-handler timeouts and isolated error
 * swallowing so a failing subscriber never affects the request response,
 * other subscribers, or the delivery path).
 *
 * Conventions:
 * - Event names are arbitrary strings; see `src/lib/eventBusCatalog.js`
 *   for the canonical event-name constants.
 * - Payloads are passed by reference. Do not mutate them inside a handler
 *   unless the publisher documented the payload as mutable.
 * - Handler ordering is insertion order (FIFO). The first registered
 *   handler runs first; the last registered handler runs last.
 * - `emit()` is synchronous and never throws — handler errors are caught
 *   and logged so they cannot break the calling stack.
 * - `emitAsync()` returns a Promise that settles when every handler has
 *   settled (or timed out). It is the recommended variant for any
 *   side-effect that may do I/O.
 *
 * Per-handler latency overhead for `emit()` is sub-millisecond on the
 * happy path because it only walks the subscriber Set synchronously
 * without scheduling promises.
 */

const DEFAULT_ASYNC_TIMEOUT_MS = 5000;

class EventBus {
	constructor(options = {}) {
		this._subscribers = new Map();
		this._asyncTimeoutMs = Number.isFinite(options.asyncTimeoutMs) && options.asyncTimeoutMs > 0
			? options.asyncTimeoutMs
			: DEFAULT_ASYNC_TIMEOUT_MS;
		this._logger = options.logger || console;
	}

	/**
	 * Register a handler for an event. Returns an unsubscribe function.
	 * Calling the unsubscribe function twice is a no-op.
	 */
	on(eventName, handler) {
		if (typeof eventName !== 'string' || eventName.length === 0) {
			throw new TypeError('eventBus.on requires a non-empty event name');
		}
		if (typeof handler !== 'function') {
			throw new TypeError('eventBus.on requires a function handler');
		}
		let bucket = this._subscribers.get(eventName);
		if (!bucket) {
			bucket = new Set();
			this._subscribers.set(eventName, bucket);
		}
		bucket.add(handler);
		return () => this.off(eventName, handler);
	}

	/**
	 * Register a one-shot handler that unsubscribes itself after the
	 * first invocation. Returns the unsubscribe function.
	 */
	once(eventName, handler) {
		const off = this.on(eventName, (payload, name) => {
			off();
			return handler(payload, name);
		});
		return off;
	}

	/**
	 * Remove a previously-registered handler. Silently no-ops if the
	 * handler was never registered or has already been removed.
	 */
	off(eventName, handler) {
		const bucket = this._subscribers.get(eventName);
		if (!bucket) {
			return false;
		}
		const removed = bucket.delete(handler);
		if (bucket.size === 0) {
			this._subscribers.delete(eventName);
		}
		return removed;
	}

	/**
	 * Synchronously invoke every registered handler for `eventName` in
	 * insertion order. Handler errors are caught and logged so they
	 * cannot break the caller. Returns the array of handler return values.
	 */
	emit(eventName, payload) {
		const bucket = this._subscribers.get(eventName);
		if (!bucket || bucket.size === 0) {
			return [];
		}
		const results = [];
		for (const handler of [...bucket]) {
			let value;
			try {
				value = handler(payload, eventName);
			} catch (error) {
				this._logHandlerError(eventName, handler, error);
				results.push(undefined);
				continue;
			}
			results.push(value);
			if (value && typeof value.then === 'function') {
				value.catch((error) => {
					this._logHandlerError(eventName, handler, error);
				});
			}
		}
		return results;
	}

	/**
	 * Asynchronously invoke every registered handler for `eventName` in
	 * insertion order. Each handler runs under a bounded timeout; if it
	 * does not settle within `this._asyncTimeoutMs` it is treated as a
	 * timeout error (logged, not thrown). Handlers run in parallel —
	 * `Promise.allSettled` semantics — so one slow handler does not block
	 * the others. Returns a Promise that resolves with the settled
	 * outcome array (in insertion order).
	 */
	async emitAsync(eventName, payload, options = {}) {
		const bucket = this._subscribers.get(eventName);
		if (!bucket || bucket.size === 0) {
			return [];
		}
		const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: this._asyncTimeoutMs;
		const handlers = [...bucket];
		const settled = await Promise.allSettled(handlers.map((handler) => this._invokeWithTimeout(handler, eventName, payload, timeoutMs)));
		for (let i = 0; i < settled.length; i += 1) {
			const entry = settled[i];
			if (entry.status === 'rejected') {
				this._logHandlerError(eventName, handlers[i], entry.reason);
			}
		}
		return settled.map((entry) => (entry.status === 'fulfilled' ? { value: entry.value } : { error: entry.reason }));
	}

	async _invokeWithTimeout(handler, eventName, payload, timeoutMs) {
		let timeoutHandle;
		try {
			const timeoutPromise = new Promise((_, reject) => {
				timeoutHandle = setTimeout(() => {
					const err = new Error(`eventBus handler for "${eventName}" exceeded ${timeoutMs}ms`);
					err.code = 'EVENT_BUS_HANDLER_TIMEOUT';
					reject(err);
				}, timeoutMs);
				if (typeof timeoutHandle.unref === 'function') {
					timeoutHandle.unref();
				}
			});
			const result = await Promise.race([
				Promise.resolve().then(() => handler(payload, eventName)),
				timeoutPromise,
			]);
			return result;
		} finally {
			if (timeoutHandle) {
				clearTimeout(timeoutHandle);
			}
		}
	}

	_logHandlerError(eventName, handler, error) {
		const handlerName = handler && handler.name ? handler.name : '<anonymous>';
		const message = error && error.message ? error.message : String(error);
		if (this._logger && typeof this._logger.warn === 'function') {
			this._logger.warn(`[eventBus] handler "${handlerName}" for "${eventName}" failed: ${message}`);
		}
	}

	/**
	 * Return the number of registered handlers for `eventName`. Intended
	 * for tests and operational diagnostics — not used by the bus core.
	 */
	listenerCount(eventName) {
		const bucket = this._subscribers.get(eventName);
		return bucket ? bucket.size : 0;
	}

	/**
	 * Return the sorted list of registered event names. Useful for
	 * startup diagnostics and tests; not used by the bus core.
	 */
	eventNames() {
		return [...this._subscribers.keys()].sort();
	}

	/**
	 * Drop every registered handler. Intended for tests so each case
	 * starts from a clean subscriber set.
	 */
	removeAllListeners(eventName) {
		if (typeof eventName === 'string') {
			this._subscribers.delete(eventName);
			return;
		}
		this._subscribers.clear();
	}

	resetForTesting() {
		this._subscribers.clear();
	}
}

const defaultBus = new EventBus();

module.exports = {
	EventBus,
	eventBus: defaultBus,
	createEventBus: (options) => new EventBus(options),
};
