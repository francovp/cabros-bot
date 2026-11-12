'use strict';

const { validateAlert } = require('../../../../lib/validation');
const {
	parseNotificationRouting,
	sendWithNotificationRouting,
} = require('../../../../services/notification/requestRouting');
const { enrichAlert } = require('../alert/grounding');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../alert/alert');
const MarkdownV2Formatter = require('../../../../services/notification/formatters/markdownV2Formatter');
const alertStorageService = require('../../../../services/storage/AlertStorageService');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { TokenUsageTracker } = require('../../../../lib/tokenUsage');

const DEFAULT_CANARY_ALERT_TEXT = 'CANARY: BINANCE:BTCUSDT 1h BUY - synthetic pipeline validation probe';

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}
	return botOrGetter || null;
}

/**
 * Controller for synthetic canary alert pipeline validation
 * Executes validation, enrichment, notification routing/readiness, and storage probe stages
 * without persisting real alerts into the alerts collection or creating alert noise.
 *
 * @param {Function|Object} botOrGetter - Telegraf bot instance or getter
 * @returns {Function} Express request handler
 */
function extractSymbolAndExchange(data) {
	if (!data || typeof data !== 'object') {
		return { symbol: null, exchange: null };
	}
	if (typeof data.symbol === 'string' && data.symbol.trim()) {
		const sym = data.symbol.trim().toUpperCase();
		if (sym.includes(':')) {
			const parts = sym.split(':');
			return { symbol: parts[1], exchange: parts[0] };
		}
		return { symbol: sym, exchange: null };
	}
	if (typeof data.text === 'string') {
		const match = data.text.match(/(?:^|\b)(?<exchange>[A-Z0-9_]{2,10}):(?<symbol>[A-Z0-9._-]{2,20})/i);
		if (match && match.groups && match.groups.symbol) {
			return {
				symbol: match.groups.symbol.toUpperCase(),
				exchange: match.groups.exchange ? match.groups.exchange.toUpperCase() : null,
			};
		}
		const singleMatch = data.text.match(/(?:^|\s)(?<symbol>[A-Z0-9._-]{2,20})\b/i);
		if (singleMatch && singleMatch.groups && singleMatch.groups.symbol) {
			return { symbol: singleMatch.groups.symbol.toUpperCase(), exchange: null };
		}
	}
	return { symbol: null, exchange: null };
}

function postCanaryAlert(botOrGetter) {
	return async (req, res) => {
		const runtimeConfig = getRuntimeConfig();
		const isCanaryEnabled = Boolean(runtimeConfig && runtimeConfig.ENABLE_CANARY_ALERT)
			|| process.env.ENABLE_CANARY_ALERT === 'true';

		if (!isCanaryEnabled) {
			return res.status(404).json({
				success: false,
				error: 'Canary alert is not enabled',
				code: 'FEATURE_DISABLED',
			});
		}

		const overallStartTime = Date.now();
		const deliver = (req.body && req.body.deliver === true)
			|| (req.query && (req.query.deliver === 'true' || req.query.deliver === true));

		const stages = {
			validation: { ok: false, status: 'fail', ms: 0 },
			enrichment: { ok: false, status: 'fail', ms: 0 },
			notification: { ok: false, status: 'fail', ms: 0 },
			storage: { ok: false, status: 'fail', ms: 0 },
		};

		// 1. Validation stage
		const validationStart = Date.now();
		let alertText = (req.body && req.body.text !== undefined) ? req.body.text : DEFAULT_CANARY_ALERT_TEXT;

		let validatedText = null;
		let routing = null;
		try {
			const validated = validateAlert(alertText);
			validatedText = validated.text;
			routing = parseNotificationRouting(typeof req.body === 'object' ? req.body : undefined);
			const extracted = extractSymbolAndExchange({
				symbol: req.body && req.body.symbol,
				text: validatedText,
			});
			stages.validation = {
				ok: true,
				status: 'pass',
				parsedSymbol: extracted.symbol !== 'unknown' ? extracted.symbol : null,
				exchange: extracted.exchange,
				ms: Math.max(1, Date.now() - validationStart),
			};
		} catch (error) {
			stages.validation = {
				ok: false,
				status: 'fail',
				error: error.message,
				ms: Math.max(1, Date.now() - validationStart),
			};

			const totalMs = Math.max(1, Date.now() - overallStartTime);
			const failureReport = {
				canary: true,
				success: false,
				overall: 'unhealthy',
				mode: deliver ? 'delivery' : 'dry_run',
				stages,
				totalMs,
				executionTimeMs: totalMs,
				timestamp: new Date().toISOString(),
			};
			console.error('[CANARY] Alert pipeline validation failed at validation stage', failureReport);
			return res.status(503).json(failureReport);
		}

		// 2. Enrichment stage
		const enrichmentStart = Date.now();
		const tokenUsage = new TokenUsageTracker();
		const isGeminiEnabled = Boolean(runtimeConfig.ENABLE_GEMINI_GROUNDING);
		const isTradingViewMcpEnabled = Boolean(runtimeConfig.ENABLE_TRADINGVIEW_MCP_ENRICHMENT);
		const useTradingViewData = (req.body && req.body.useTradingViewData === true)
			|| (req.query && (req.query.useTradingViewData === 'true' || req.query.useTradingViewData === true));

		let provider = 'none';
		if (isGeminiEnabled && isTradingViewMcpEnabled) {
			provider = 'gemini+tradingview';
		} else if (isGeminiEnabled) {
			provider = 'gemini';
		} else if (isTradingViewMcpEnabled) {
			provider = 'tradingview';
		}

		let enrichedAlert = null;
		if (provider !== 'none') {
			try {
				enrichedAlert = await enrichAlert({ text: validatedText }, { tokenUsage, useTradingViewData });
				stages.enrichment = {
					ok: true,
					status: 'pass',
					provider,
					enriched: Boolean(enrichedAlert),
					ms: Math.max(1, Date.now() - enrichmentStart),
				};
			} catch (error) {
				stages.enrichment = {
					ok: false,
					status: 'fail',
					provider,
					enriched: false,
					error: error.message,
					ms: Math.max(1, Date.now() - enrichmentStart),
				};
			}
		} else {
			stages.enrichment = {
				ok: true,
				status: 'pass',
				provider: 'none',
				enriched: false,
				skipped: true,
				ms: 0,
			};
		}

		// 3. Notification stage
		const notificationStart = Date.now();
		try {
			const bot = resolveBot(botOrGetter);
			let manager = getNotificationManager();
			if (!manager) {
				manager = await initializeNotificationServices(bot);
			}

			if (deliver) {
				const canaryPayload = {
					text: validatedText,
					source: 'canary-alert',
					enriched: enrichedAlert,
				};
				const deliveryResults = await sendWithNotificationRouting(manager, routing, canaryPayload);
				const attempted = Array.isArray(deliveryResults) ? deliveryResults.map((r) => r.channel) : [];
				const allSucceeded = Array.isArray(deliveryResults) && deliveryResults.length > 0 && deliveryResults.every((r) => r.success);
				stages.notification = {
					ok: allSucceeded,
					status: allSucceeded ? 'pass' : 'fail',
					channel: attempted[0] || 'none',
					channels: attempted,
					delivered: true,
					ms: Math.max(1, Date.now() - notificationStart),
				};
			} else {
				if (manager && typeof manager.validateAll === 'function') {
					await manager.validateAll();
				}
				const enabledChannels = (manager && typeof manager.getEnabledChannels === 'function')
					? manager.getEnabledChannels()
					: ['telegram'];
				const formatter = new MarkdownV2Formatter();
				if (enrichedAlert) {
					formatter.formatEnriched({ original_text: validatedText, ...enrichedAlert });
				} else {
					formatter.format(validatedText);
				}

				const primaryChannel = enabledChannels[0] || (routing && routing.channels && routing.channels[0]) || 'none';
				stages.notification = {
					ok: true,
					status: 'pass',
					channel: primaryChannel,
					channels: enabledChannels,
					delivered: false,
					ms: Math.max(1, Date.now() - notificationStart),
				};
			}
		} catch (error) {
			stages.notification = {
				ok: false,
				status: 'fail',
				channel: 'none',
				delivered: false,
				error: error.message,
				ms: Math.max(1, Date.now() - notificationStart),
			};
		}

		// 4. Storage stage
		const storageStart = Date.now();
		try {
			if (alertStorageService.isEnabled()) {
				const firestore = alertStorageService.getFirestore();
				if (!firestore) {
					stages.storage = {
						ok: false,
						status: 'fail',
						collection: 'alerts',
						checked: true,
						error: 'Firestore alert storage is enabled but uninitialized',
						ms: Math.max(1, Date.now() - storageStart),
					};
				} else {
					await firestore.collection('alerts').limit(1).get();
					stages.storage = {
						ok: true,
						status: 'pass',
						collection: 'alerts',
						checked: true,
						ms: Math.max(1, Date.now() - storageStart),
					};
				}
			} else {
				stages.storage = {
					ok: true,
					status: 'pass',
					collection: 'alerts',
					checked: false,
					enabled: false,
					skipped: true,
					ms: 0,
				};
			}
		} catch (error) {
			stages.storage = {
				ok: false,
				status: 'fail',
				collection: 'alerts',
				checked: true,
				error: error.message,
				ms: Math.max(1, Date.now() - storageStart),
			};
		}

		// 5. Evaluate overall health
		const totalMs = Math.max(1, Date.now() - overallStartTime);
		let overall = 'healthy';
		if (!stages.validation.ok || !stages.notification.ok || !stages.storage.ok) {
			overall = 'unhealthy';
		} else if (!stages.enrichment.ok) {
			overall = 'degraded';
		}

		const success = overall !== 'unhealthy';
		const report = {
			canary: true,
			success,
			overall,
			mode: deliver ? 'delivery' : 'dry_run',
			stages,
			totalMs,
			executionTimeMs: totalMs,
			timestamp: new Date().toISOString(),
		};

		if (overall === 'healthy') {
			console.info('[CANARY] Alert pipeline validation report', report);
		} else if (overall === 'degraded') {
			console.warn('[CANARY] Alert pipeline validation degraded', report);
		} else {
			console.error('[CANARY] Alert pipeline validation unhealthy', report);
		}

		const httpStatus = overall === 'unhealthy' ? 503 : 200;
		return res.status(httpStatus).json(report);
	};
}

module.exports = {
	postCanaryAlert,
	DEFAULT_CANARY_ALERT_TEXT,
};
