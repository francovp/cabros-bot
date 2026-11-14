/**
 * Basic metrics tracking via structured logs
 */

// Metrics counters
let totalRequests = 0;
let successRequests = 0;
let failureRequests = 0;
let timeoutRequests = 0;
let coalescingHits = 0;
let coalescingMisses = 0;
let coalescingFailures = 0;

/**
 * Record a successful grounding operation
 * @param {number} latencyMs Time taken in milliseconds
 * @param {string} promptType Type of prompt used (ALERT_ENRICHMENT or NEWS_ANALYSIS)
 */
function recordSuccess(latencyMs, promptType = 'UNKNOWN') {
	totalRequests++;
	successRequests++;
	console.debug('[METRICS] Enrichment succeeded', {
		latencyMs,
		promptType,
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
 * @param {string} promptType Type of prompt used (ALERT_ENRICHMENT or NEWS_ANALYSIS)
 */
function recordFailure(reason, error, promptType = 'UNKNOWN') {
	totalRequests++;
	if (reason === 'timeout') {
		timeoutRequests++;
	} else {
		failureRequests++;
	}

	console.error('[METRICS] Enrichment failed', {
		reason,
		error: error.message,
		promptType,
		totalRequests,
		successRequests,
		failureRequests,
		timeoutRequests,
	});
}

// Process start timestamp for uptime tracking (ISO string)
const processStartTime = new Date();
let uptimeSince = processStartTime.toISOString();

/**
 * Get snapshot of grounding request metrics
 * @returns {object}
 */
function getSnapshot() {
	return {
		totalRequests,
		successRequests,
		failureRequests,
		timeoutRequests,
	};
}

/**
 * Get operational metrics for grounding requests including calculated success rate and uptime
 * Note: Counters are in-memory, process-local, and reset on process restart.
 * @returns {{totalRequests: number, successRequests: number, failureRequests: number, timeoutRequests: number, successRate: number, uptimeSince: string}}
 */
function getMetrics() {
	const successRate = totalRequests > 0
		? Math.round((successRequests / totalRequests) * 1000) / 1000
		: 0;

	return {
		totalRequests,
		successRequests,
		failureRequests,
		timeoutRequests,
		successRate,
		uptimeSince,
	};
}

function recordCoalescingHit() {
	coalescingHits++;
	console.debug('[METRICS] Grounding search coalesced', { coalescingHits });
}

function recordCoalescingMiss() {
	coalescingMisses++;
}

function recordCoalescingFailure() {
	coalescingFailures++;
	console.warn('[METRICS] Grounding search coalescing failed', { coalescingFailures });
}

function getCoalescingSnapshot() {
	return {
		hits: coalescingHits,
		misses: coalescingMisses,
		failures: coalescingFailures,
	};
}

/**
 * Reset metrics counters for testing
 * @param {string|null} [customUptimeSince] Optional uptime string to set for testing
 */
function resetForTesting(customUptimeSince = null) {
	totalRequests = 0;
	successRequests = 0;
	failureRequests = 0;
	timeoutRequests = 0;
	coalescingHits = 0;
	coalescingMisses = 0;
	coalescingFailures = 0;
	if (customUptimeSince) {
		uptimeSince = customUptimeSince;
	}
}

module.exports = {
	recordSuccess,
	recordFailure,
	getSnapshot,
	getMetrics,
	recordCoalescingHit,
	recordCoalescingMiss,
	recordCoalescingFailure,
	getCoalescingSnapshot,
	resetForTesting,
};
