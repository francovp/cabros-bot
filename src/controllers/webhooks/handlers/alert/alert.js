require('dotenv').config();
const { enrichAlert } = require('./grounding');
const { validateAlert } = require('../../../../lib/validation');
const MarkdownV2Formatter = require('../../../../services/notification/formatters/markdownV2Formatter');
const TelegramService = require('../../../../services/notification/TelegramService');
const WhatsAppService = require('../../../../services/notification/WhatsAppService');
const NotificationManager = require('../../../../services/notification/NotificationManager');
const { getURLShortener } = require('../../handlers/newsMonitor/urlShortener');
const sentryService = require('../../../../services/monitoring/SentryService');
const { TokenUsageTracker } = require('../../../../lib/tokenUsage');
const alertStorageService = require('../../../../services/storage/AlertStorageService');

// Initialize services
let notificationManager = null;

/**
 * Initialize notification services
 * Call this once on app startup
 * @param {Object} bot - Telegraf bot instance
 * @returns {Promise<NotificationManager>}
 */
async function initializeNotificationServices(bot) {
	const telegramService = new TelegramService({
		bot,
		logger: console,
	});

	const whatsappService = new WhatsAppService({
		logger: console,
		urlShortener: getURLShortener(),
	});

	notificationManager = new NotificationManager(telegramService, whatsappService);

	console.debug('Initializing notification services...');
	await notificationManager.validateAll();

	const enabledChannels = notificationManager.getEnabledChannels();
	console.debug(`Notification services initialized: ${enabledChannels.join(', ')}`);

	return notificationManager;
}

/**
 * Get the initialized NotificationManager instance
 * Used by other handlers (e.g., newsMonitor) to send alerts
 * @returns {NotificationManager|null}
 */
function getNotificationManager() {
	return notificationManager;
}

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}

	return botOrGetter || null;
}

async function processEnrichment(alert, options) {
	const { tokenUsage, useTradingViewData, parentSpan } = options;
	const isGeminiEnabled = process.env.ENABLE_GEMINI_GROUNDING === 'true';
	const isTradingViewMcpEnabled = process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT === 'true' && useTradingViewData;

	let enriched = false;

	if (isGeminiEnabled || isTradingViewMcpEnabled) {
		const enrichmentSpan = sentryService.startInactiveSpan({
			name: 'alerts.enrichment',
			op: 'alert.enrich',
			onlyIfParent: true,
			parentSpan,
			attributes: {
				'alert.length': alert.text.length,
				'alert.use_tradingview_data': useTradingViewData,
				'feature.gemini_grounding': isGeminiEnabled,
				'feature.tradingview_mcp_enrichment': isTradingViewMcpEnabled,
			},
		});

		try {
			console.debug('Starting alert enrichment process');
			const enrichedAlert = await enrichAlert({ text: alert.text }, { tokenUsage, useTradingViewData });
			if (enrichedAlert && typeof enrichedAlert === 'object') {
				enrichedAlert.tokenUsage = tokenUsage.toJSON();
				enriched = true;
				alert.enriched = enrichedAlert;
				console.debug('[Alert] Enrichment completed, sources:', (enrichedAlert.sources && enrichedAlert.sources.length) || 0);
			} else {
				console.debug('[Alert] Enrichment skipped: alert text did not match enabled providers');
			}
		} catch (error) {
			console.warn('[Alert] Enrichment failed, using original text:', error.message);
		} finally {
			sentryService.endSpan(enrichmentSpan);
		}
	}

	return enriched;
}

function postAlert(botOrGetter) {
	return async (req, res) => {
		const { body } = req;
		const useTradingViewData = req.query && (req.query.useTradingViewData === true || req.query.useTradingViewData === 'true');

		let alertText = '';
		let alert = null;

		try {
			const requestSpan = sentryService.getActiveSpan();
			const bot = resolveBot(botOrGetter);
			if (!notificationManager) {
				await initializeNotificationServices(bot);
			}

			if (typeof body === 'object' && 'text' in body) {
				alertText = body.text;
			} else {
				alertText = body;
			}

			const { text } = validateAlert(alertText);
			alert = { text };

			const tokenUsage = new TokenUsageTracker();
			const enriched = await processEnrichment(alert, { tokenUsage, useTradingViewData, parentSpan: requestSpan });

			// NotificationManager owns the custom dispatch spans.
			const results = await notificationManager.sendToAll(alert, { parentSpan: requestSpan });

			// Return 200 OK regardless of delivery success (fail-open pattern)
			const tokenUsageJSON = tokenUsage.toJSON();
			tokenUsageJSON.formattedSummary = tokenUsage.formatSummary();
			res.json({ success: true, results, enriched, tokenUsage: tokenUsageJSON });

			// Fire-and-forget: persist alert to Firestore after responding to the caller.
			// Errors are caught inside saveAlert — delivery is never blocked by storage.
			alertStorageService.saveAlert({
				text: alert.text,
				enriched,
				enrichmentData: alert.enriched || null,
				tokenUsage: tokenUsageJSON,
				deliveryResults: results,
				useTradingViewData,
			}).catch(() => {}); // errors already logged inside AlertStorageService
		} catch (error) {
			console.error('[Alert] Request failed:', error.message);

			// Capture runtime error to Sentry (T012)
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/webhook/alert',
					method: 'POST',
					statusCode: (error.response && error.response.error_code) || 500,
				},
				alert: {
					textLength: alertText ? alertText.length : 0,
					hasEnrichment: !!(alert && alert.enriched),
					enrichedSource: alert && alert.enriched && alert.enriched.extraText && alert.enriched.extraText.includes('tradingview-mcp') ? 'tradingview-mcp' : (alert && alert.enriched ? 'gemini-grounding' : undefined),
					truncated: false,
				},
			});

			const status = (error.response && error.response.error_code) || 500;
			const errorResponse = error.response || { error: 'Internal server error', details: error.message };
			res.status(status).send(errorResponse);
		}
	};
}

module.exports = {
	postAlert,
	initializeNotificationServices,
	getNotificationManager,
};
