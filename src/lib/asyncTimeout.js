'use strict';

/**
 * Bounded async helper used by fail-open consumers (alert annotation, news
 * monitor caches, etc.) when an upstream Promise must never block the caller.
 *
 * Behavior:
 * - The promise and the timeout race. Whichever settles first wins.
 * - If the timeout fires first, the returned promise rejects with the supplied
 *   message; the underlying promise is left to settle in the background and
 *   its result (or rejection) is dropped on the floor.
 * - Errors from the upstream promise propagate unchanged so callers can
 *   distinguish a timeout from a real upstream failure if they need to.
 *
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {string} message
 * @returns {Promise<T>}
 * @template T
 */
function awaitWithTimeout(promise, timeoutMs, message) {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer = null;

		const settle = (fn, value) => {
			if (settled) return;
			settled = true;
			if (timer !== null && typeof globalThis.clearTimeout === 'function') {
				globalThis.clearTimeout(timer);
			}
			timer = null;
			fn(value);
		};

		timer = setTimeout(() => {
			settle(reject, new Error(message));
		}, timeoutMs);

		Promise.resolve(promise)
			.then((value) => settle(resolve, value))
			.catch((error) => settle(reject, error));
	});
}

module.exports = {
	awaitWithTimeout,
};
