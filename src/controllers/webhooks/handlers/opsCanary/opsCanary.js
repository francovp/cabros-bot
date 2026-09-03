'use strict';

/**
 * POST /api/ops/test-alert - post-deploy channel-delivery canary.
 *
 * Sends one synthetic alert through `notificationManager.sendToChannels()` (or
 * `sendToAll()` when no channels are specified) using the same formatter, retry,
 * and redrive pipeline as a real webhook alert. Pure delivery probe - no Gemini
 * enrichment, no TradingView MCP, no Langfuse.
 *
 * Synthetic alerts are tagged `source: 'canary'` so they can be filtered out of
 * signal-outcome metrics and downstream aggregates.
 *
 * Gated by `ENABLE_CANARY_ENDPOINT` (default: false). When disabled, the
 * endpoint returns `404 FEATURE_DISABLED`.
 */

const { v4: uuidv4 } = require('uuid');
const sentryService = require('../../../../services/monitoring/SentryService');
const {
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
} = require('../../../../services/notification/requestRouting');
const { getNotificationManager, initializeNotificationServices } = require('../alert/alert');

const DEFAULT_CANARY_TEXT = 'Cabros Bot canary alert - ignore';
const MAX_CANARY_TEXT_LENGTH = 4000;
const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED';
const CANARY_SOURCE = 'canary';

function isCanaryEndpointEnabled() {
	return process.env.ENABLE_CANARY_ENDPOINT === 'true';
}

function buildCanaryAlert(rawText, routing) {
	const sourceText = typeof rawText === 'string' && rawText.trim().length > 0
		? rawText.trim()
		: DEFAULT_CANARY_TEXT;
	const text = sourceText.length > MAX_CANARY_TEXT_LENGTH
		? sourceText.substring(0, MAX_CANARY_TEXT_LENGTH)
		: sourceText;

	return {
		text,
		source: CANARY_SOURCE,
		telegramChatId: routing.telegramChatId,
		telegramThreadId: routing.telegramThreadId,
		whatsappChatId: routing.whatsappChatId,
		discordWebhookUrl: routing.discordWebhookUrl,
	};
}

async function resolveNotificationManager(botOrGetter) {
	let manager = getNotificationManager();
	if (manager) {
		return manager;
	}

	const bot = typeof botOrGetter === 'function' ? botOrGetter() : (botOrGetter || null);
	if (bot) {
		await initializeNotificationServices(bot);
		manager = getNotificationManager();
	}

	return manager || null;
}

function postOpsCanary(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		if (!isCanaryEndpointEnabled()) {
			return res.status(404).json({
				success: false,
				error: 'Canary endpoint is disabled',
				code: FEATURE_DISABLED_CODE,
				requestId,
			});
		}

		let routing;
		try {
			routing = parseNotificationRouting(req.body || {});
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(error.statusCode).json({
					success: false,
					error: error.message,
					code: 'INVALID_REQUEST',
					details: error.details,
					requestId,
				});
			}
			throw error;
		}

		const rawText = req.body && typeof req.body.text === 'string'
			? req.body.text
			: (req.body && typeof req.body.message === 'string' ? req.body.message : undefined);
		const alert = buildCanaryAlert(rawText, routing);

		let notificationManager;
		try {
			notificationManager = await resolveNotificationManager(botOrGetter);
		} catch (initError) {
			console.warn('[OpsCanary] Failed to initialize NotificationManager:', initError.message);
		}

		if (!notificationManager) {
			return res.status(503).json({
				success: false,
				error: 'Notification services not initialized',
				code: 'NOTIFICATION_SERVICES_UNAVAILABLE',
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		}

		const httpContext = {
			endpoint: '/api/ops/test-alert',
			method: 'POST',
		};

		try {
			const results = await sendWithNotificationRouting(
				notificationManager,
				alert,
				routing,
				{
					http: httpContext,
					endpoint: '/api/ops/test-alert',
					method: 'POST',
				},
			);

			const successCount = Array.isArray(results)
				? results.filter((r) => r && r.success).length
				: 0;
			const failureCount = Array.isArray(results)
				? results.filter((r) => r && !r.success).length
				: 0;

			console.info(
				'[OpsCanary] canary dispatch complete',
				JSON.stringify({
					requestId,
					source: CANARY_SOURCE,
					results: Array.isArray(results)
						? results.map((r) => ({
							channel: r ? r.channel : 'unknown',
							success: r ? r.success === true : false,
						}))
						: [],
				}),
			);

			return res.status(200).json({
				success: failureCount === 0,
				source: CANARY_SOURCE,
				results: Array.isArray(results) ? results : [],
				requestedChannels: routing.channels || notificationManager.getEnabledChannels(),
				successCount,
				failureCount,
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
			console.error('[OpsCanary] Dispatch failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'http-canary',
				error,
				http: httpContext,
				extra: {
					category: 'http_webhook_error',
					source: CANARY_SOURCE,
				},
			});
			return res.status(500).json({
				success: false,
				error: 'Internal server error',
				code: 'INTERNAL_ERROR',
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		}
	};
}

module.exports = {
	postOpsCanary,
	isCanaryEndpointEnabled,
	CANARY_SOURCE,
};
