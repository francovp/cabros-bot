'use strict';

/**
 * LlmConcurrencyGate - process-wide LLM provider concurrency gate.
 *
 * Caps the number of in-flight provider calls per provider key (e.g. gemini)
 * so simultaneous surfaces (alert grounding, news analysis, expanded-analysis,
 * scanner confluence, job workers) cannot combine into provider-level bursts
 * that trigger 429 RESOURCE_EXHAUSTED. Excess callers either queue for a
 * bounded timeout or fail-open with a typed error so callers can degrade
 * gracefully (alert/news delivery always proceeds without enrichment).
 *
 * Pair with the existing GeminiQuotaManager (cooldown management) - this
 * gate handles capacity, not quota cooldown state.
 */

const DEFAULT_MAX_CONCURRENT = Number.POSITIVE_INFINITY;
const DEFAULT_QUEUE_TIMEOUT_MS = 0;

class LlmConcurrencyGate {
	constructor(options = {}) {
		const { defaultMaxConcurrent, defaultQueueTimeoutMs } = options;
		this.maxConcurrent = Number.isFinite(defaultMaxConcurrent)
			? defaultMaxConcurrent
			: DEFAULT_MAX_CONCURRENT;
		this.queueTimeoutMs = Number.isFinite(defaultQueueTimeoutMs)
			? defaultQueueTimeoutMs
			: DEFAULT_QUEUE_TIMEOUT_MS;

		this._waiters = [];
		this._counter = 0;
		this._shedTotal = 0;
		this._timeoutTotal = 0;
		this._acquiredTotal = 0;
	}

	configure({ maxConcurrent, queueTimeoutMs } = {}) {
		if (Number.isFinite(maxConcurrent) && maxConcurrent >= 1 && maxConcurrent <= 1000) {
			this.maxConcurrent = Math.floor(maxConcurrent);
		}
		if (Number.isFinite(queueTimeoutMs) && queueTimeoutMs >= 0 && queueTimeoutMs <= 300000) {
			this.queueTimeoutMs = Math.floor(queueTimeoutMs);
		}
	}

	async acquire(options = {}) {
		const timeoutMs = Number.isFinite(options.timeoutMs)
			? options.timeoutMs
			: this.queueTimeoutMs;

		if (this._counter < this.maxConcurrent) {
			this._counter += 1;
			this._acquiredTotal += 1;
			return this._createRelease();
		}

		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			this._shedTotal += 1;
			const error = new Error(
				`LLM concurrency gate at capacity (inFlight=${this._counter}, max=${this.maxConcurrent}); shedding call`
			);
			error.code = 'LLM_GATE_SHED';
			error.status = 503;
			error.shed = true;
			throw error;
		}

		return new Promise((resolve, reject) => {
			const queuedAt = Date.now();
			const waiter = { resolve, reject, queuedAt, timer: null };
			waiter.timer = setTimeout(() => {
				const index = this._waiters.indexOf(waiter);
				if (index !== -1) {
					this._waiters.splice(index, 1);
				}
				this._timeoutTotal += 1;
				const error = new Error(
					`LLM concurrency gate queue timeout after ${timeoutMs}ms (inFlight=${this._counter}, queued=${this._waiters.length})`
				);
				error.code = 'LLM_GATE_TIMEOUT';
				error.status = 503;
				error.timedOut = true;
				reject(error);
			}, timeoutMs);
			this._waiters.push(waiter);
		});
	}

	getSnapshot() {
		return {
			maxConcurrent: Number.isFinite(this.maxConcurrent) ? this.maxConcurrent : null,
			queueTimeoutMs: this.queueTimeoutMs,
			inFlight: this._counter,
			queueDepth: this._waiters.length,
			acquiredTotal: this._acquiredTotal,
			shedTotal: this._shedTotal,
			timeoutTotal: this._timeoutTotal,
		};
	}

	resetForTesting() {
		for (const waiter of this._waiters) {
			if (waiter.timer) clearTimeout(waiter.timer);
			const err = new Error('Gate reset for testing');
			err.code = 'LLM_GATE_RESET';
			waiter.reject(err);
		}
		this._waiters = [];
		this._counter = 0;
		this._shedTotal = 0;
		this._timeoutTotal = 0;
		this._acquiredTotal = 0;
	}

	_createRelease() {
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this._counter = Math.max(0, this._counter - 1);
			this._drainOne();
		};
	}

	_drainOne() {
		while (this._waiters.length > 0 && this._counter < this.maxConcurrent) {
			const next = this._waiters.shift();
			if (next.timer) clearTimeout(next.timer);
			this._counter += 1;
			this._acquiredTotal += 1;
			next.resolve(this._createRelease());
		}
	}
}

const instance = new LlmConcurrencyGate();

module.exports = instance;
module.exports.LlmConcurrencyGate = LlmConcurrencyGate;
