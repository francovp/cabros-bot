'use strict';

/**
 * Canonical event-name catalog for the in-process event bus
 * (`src/lib/eventBus.js`). Keeping the strings here — rather than inline
 * — gives us a single grep-able surface for every subscriber and lets
 * tests assert that newly-registered events are documented.
 *
 * Event ordering rules (see eventBus.js for the bus core):
 * - Synchronous emit runs handlers in **insertion order** (FIFO).
 * - Asynchronous emit also runs in insertion order; `Promise.allSettled`
 *   means handlers execute in parallel, but the *result array* preserves
 *   the insertion order.
 * - Handlers must not rely on the return value of other handlers — the
 *   bus does not pipe values between handlers.
 *
 * Payload schemas are documented per event; subscribers MUST treat every
 * payload field as read-only. Mutating a payload is undefined behavior.
 */

const EVENT_NAMES = Object.freeze({
	ALERT_RECEIVED: 'alert.received',
	ALERT_ENRICHED: 'alert.enriched',
	ALERT_DELIVERED: 'alert.delivered',
	ALERT_FAILED: 'alert.failed',
	ALERT_SUPPRESSED: 'alert.suppressed',
	ALERT_PERSISTED: 'alert.persisted',
	JOB_CREATED: 'job.created',
	JOB_COMPLETED: 'job.completed',
	JOB_FAILED: 'job.failed',
	SIGNAL_EVALUATED: 'signal.evaluated',
	REDRIVE_SWEEP_COMPLETED: 'redrive.sweep_completed',
});

const EVENT_DESCRIPTORS = Object.freeze([
	{
		name: EVENT_NAMES.ALERT_RECEIVED,
		description: 'Emitted by alert-producing routes immediately after the webhook has validated and accepted the alert body, before enrichment or delivery.',
		payload: {
			alertId: 'string',
			text: 'string',
			source: 'string (webhook | news-monitor | message | scanner | analysis)',
			requestId: 'string',
			requestedChannels: 'string[] | undefined',
		},
	},
	{
		name: EVENT_NAMES.ALERT_ENRICHED,
		description: 'Emitted after alert enrichment (Gemini grounding, TradingView MCP, combined analysis) has run and produced an `alert.enriched` payload.',
		payload: {
			alertId: 'string',
			enriched: 'boolean',
			tokenUsage: 'object | undefined',
		},
	},
	{
		name: EVENT_NAMES.ALERT_DELIVERED,
		description: 'Emitted after notification delivery completes (every enabled channel has either succeeded or failed).',
		payload: {
			alertId: 'string',
			results: 'Array<{ channel, success, messageId?, error?, statusCode?, attemptCount?, durationMs? }>',
		},
	},
	{
		name: EVENT_NAMES.ALERT_FAILED,
		description: 'Emitted when delivery fails for every enabled channel (all results have `success: false`). Subscribers typically trigger an admin paging path.',
		payload: {
			alertId: 'string',
			results: 'Array<{ channel, success, error?, statusCode?, attemptCount?, durationMs? }>',
		},
	},
	{
		name: EVENT_NAMES.ALERT_SUPPRESSED,
		description: 'Emitted when an alert is suppressed by the signal-repeat cooldown before delivery (see `src/services/alerts/signalRepeatCooldown.js`).',
		payload: {
			alertId: 'string',
			reason: 'string (signal-repeat-cooldown)',
			signalKey: 'string',
		},
	},
	{
		name: EVENT_NAMES.ALERT_PERSISTED,
		description: 'Emitted after a successful `/api/webhook/alert` payload has been persisted to the Firestore alerts collection (fail-open; not emitted if storage is disabled or unavailable).',
		payload: {
			alertId: 'string',
			storageId: 'string (Firestore document id)',
		},
	},
	{
		name: EVENT_NAMES.JOB_CREATED,
		description: 'Emitted when an async TradingView job is created (POST /api/jobs/tradingview-analysis).',
		payload: {
			jobId: 'string',
			type: 'string (expanded-analysis | market-scanner)',
			requestId: 'string',
		},
	},
	{
		name: EVENT_NAMES.JOB_COMPLETED,
		description: 'Emitted when an async job reaches the `completed` terminal state.',
		payload: {
			jobId: 'string',
			type: 'string',
			result: 'object',
		},
	},
	{
		name: EVENT_NAMES.JOB_FAILED,
		description: 'Emitted when an async job reaches a terminal failure state (`failed`, `cancelled`, or `timed_out`).',
		payload: {
			jobId: 'string',
			type: 'string',
			reason: 'string',
			error: 'Error | undefined',
		},
	},
	{
		name: EVENT_NAMES.SIGNAL_EVALUATED,
		description: 'Emitted by the signal-outcome worker after a shadow-mode signal is evaluated against Binance historical candlesticks.',
		payload: {
			outcomeId: 'string',
			side: 'string (BUY | SELL)',
			hitRate: 'number | undefined',
			windows: 'string[]',
		},
	},
	{
		name: EVENT_NAMES.REDRIVE_SWEEP_COMPLETED,
		description: 'Emitted after a notification-redrive sweep completes (whether or not it recovered any dead-letter entries).',
		payload: {
			sweepId: 'string',
			attempted: 'number',
			recovered: 'number',
			skipped: 'number',
		},
	},
]);

function isKnownEvent(eventName) {
	return typeof eventName === 'string' && Object.values(EVENT_NAMES).includes(eventName);
}

module.exports = {
	EVENT_NAMES,
	EVENT_DESCRIPTORS,
	isKnownEvent,
};
