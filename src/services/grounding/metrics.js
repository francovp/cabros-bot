/**
 * Basic metrics tracking via structured logs
 */

// Metrics counters
let totalRequests = 0;
let successRequests = 0;
let failureRequests = 0;
let timeoutRequests = 0;

/**
 * Record a successful grounding operation
 * @param {number} latencyMs Time taken in milliseconds
 */
function recordSuccess(latencyMs) {
	totalRequests++;
	successRequests++;
	console.debug('[METRICS] Grounding succeeded', {
		latencyMs,
		totalRequests,
		successRequests,
		failureRequests,
		timeoutRequests,
	});
}

/**
 * Record a failed grounding operation
 * @param {string} reason Error type (timeout or error)
 * @param {Error} error The actual error object
 */
function recordFailure(reason, error) {
	totalRequests++;
	if (reason === 'timeout') {
		timeoutRequests++;
	} else {
		failureRequests++;
	}

	console.error('[METRICS] Grounding failed', {
		reason,
		error: error.message,
		totalRequests,
		successRequests,
		failureRequests,
		timeoutRequests,
	});
}

module.exports = {
	recordSuccess,
	recordFailure,
};