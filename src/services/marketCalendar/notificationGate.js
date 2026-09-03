'use strict';

/**
 * Market-calendar delivery gate.
 *
 * Determines whether the NotificationManager should suppress delivery for a
 * given alert based on the alert's resolved exchange + the current U.S. market
 * session state. The gate is opt-in via `ENABLE_MARKET_CALENDAR_GATING=true`
 * and is fail-open:
 *
 *   - Feature flag off → never suppress.
 *   - Missing/malformed exchange → never suppress.
 *   - Crypto venue → never suppress (24/7 venues).
 *   - Unknown venue kind → never suppress.
 *   - Session classifier returns `unknown` or fails → never suppress.
 *
 * Suppression routes the alert to the existing `NotificationRedriveService`
 * dead-letter queue with `reason: "market_holiday"` (or `"market_closed"` for
 * non-holiday closures) so operators can audit and replay.
 */

const sentryService = require('../monitoring/SentryService');
const { getSessionState, shouldSuppressDelivery } = require('./sessionState');

const FEATURE_FLAG = 'ENABLE_MARKET_CALENDAR_GATING';

function isFeatureEnabled(env = process.env) {
	if (!env || typeof env !== 'object') return false;
	const raw = env[FEATURE_FLAG];
	if (raw === undefined || raw === null || raw === '') return false;
	return String(raw).toLowerCase() === 'true';
}

/**
 * Resolve the destination exchange for an alert. Tries, in order:
 *   1. `alert.exchange`
 *   2. `alert.enriched.exchange`
 *   3. `alert.enriched.symbolInfo.exchange`
 *   4. `alert.enriched.exchange` derived from `signal.exchange`
 * Returns null when none can be resolved.
 *
 * @param {Object} alert
 * @returns {string|null}
 */
function resolveAlertExchange(alert) {
	if (!alert || typeof alert !== 'object') return null;
	const candidates = [
		alert.exchange,
		alert && alert.enriched && alert.enriched.exchange,
		alert && alert.enriched && alert.enriched.signal && alert.enriched.signal.exchange,
		alert && alert.signal && alert.signal.exchange,
		alert && alert.metadata && alert.metadata.exchange,
	];
	for (const c of candidates) {
		if (typeof c === 'string' && c.trim()) return c.trim().toUpperCase();
	}
	return null;
}

/**
 * Decide whether delivery should be suppressed and, if so, return the structured
 * suppression reason for the dead-letter queue.
 *
 * @param {Object} alert
 * @param {Object} [options]
 * @param {Date|number|string} [options.timestamp]  defaults to now
 * @param {Object} [options.env]  defaults to `process.env`
 * @returns {{ suppress: boolean, reason: string|null, sessionState: Object|null, exchange: string|null }}
 */
function evaluateDeliveryGate(alert, options = {}) {
	const env = options.env || process.env;
	const timestamp = options.timestamp || new Date();

	if (!isFeatureEnabled(env)) {
		return { suppress: false, reason: null, sessionState: null, exchange: null };
	}

	const exchange = resolveAlertExchange(alert);
	if (!exchange) {
		return { suppress: false, reason: null, sessionState: null, exchange: null };
	}

	let sessionState;
	try {
		sessionState = getSessionState({ exchange, timestamp });
	} catch (error) {
		sentryService.captureRuntimeError(error, {
			feature: 'marketCalendar',
			context: { exchange },
		});
		console.warn(`[marketCalendar] classifier failed for ${exchange}; fail-open delivery:`, error.message);
		return { suppress: false, reason: null, sessionState: null, exchange };
	}

	if (!sessionState || sessionState.suppressDelivery !== true) {
		return { suppress: false, reason: null, sessionState, exchange };
	}

	let reason;
	if (sessionState.state === 'holiday') {
		reason = 'market_holiday';
	} else if (sessionState.state === 'half_day') {
		reason = 'market_half_day_outside_window';
	} else if (sessionState.state === 'closed') {
		reason = sessionState.holiday ? 'market_holiday' : 'market_closed';
	} else {
		reason = 'market_closed';
	}

	return { suppress: true, reason, sessionState, exchange };
}

/**
 * Convenience helper for callers that want only the boolean decision.
 */
function isDeliverySuppressed(alert, options = {}) {
	return evaluateDeliveryGate(alert, options).suppress;
}

/**
 * Re-export `shouldSuppressDelivery` so tests can hit the underlying classifier
 * without reaching into `sessionState` directly.
 */
function isClosedOrHoliday(input) {
	return shouldSuppressDelivery(input);
}

module.exports = {
	evaluateDeliveryGate,
	isDeliverySuppressed,
	isClosedOrHoliday,
	resolveAlertExchange,
	isFeatureEnabled,
	FEATURE_FLAG,
};
