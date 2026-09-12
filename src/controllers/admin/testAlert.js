'use strict';

const { v4: uuidv4 } = require('uuid');
const { validateAlert } = require('../../lib/validation');
const { TokenUsageTracker } = require('../../lib/tokenUsage');
const alertStorageService = require('../../services/storage/AlertStorageService');
const MarkdownV2Formatter = require('../../services/notification/formatters/markdownV2Formatter');
const WhatsAppMarkdownFormatter = require('../../services/notification/formatters/whatsappMarkdownFormatter');
const { parseTradingViewSignal } = require('../../services/tradingview/parseTradingViewSignal');
const sentryService = require('../../services/monitoring/SentryService');
const { getRuntimeConfig } = require('../../services/remoteConfig/RemoteConfigService');
const {
	parseNotificationRouting,
	validateNotificationRouting,
	sendWithNotificationRouting,
} = require('../../services/notification/requestRouting');
const {
	getNotificationManager,
	initializeNotificationServices,
	processEnrichment,
} = require('../webhooks/handlers/alert/alert');

const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const adminRateLimits = new Map();
let dailyRunsCount = 0;
let dailyRunsDate = new Date().toISOString().slice(0, 10);
let lastRunAt = null;
let lastRunStatus = null;

function getDailyLimit() {
	const runtimeConfig = getRuntimeConfig();
	const val = Number(
		runtimeConfig.TEST_ALERT_DAILY_LIMIT
		?? process.env.TEST_ALERT_DAILY_LIMIT
		?? 30,
	);
	return Number.isSafeInteger(val) && val >= 1 && val <= 1000 ? val : 30;
}

function checkAndIncrementDailyLimit() {
	const today = new Date().toISOString().slice(0, 10);
	if (dailyRunsDate !== today) {
		dailyRunsDate = today;
		dailyRunsCount = 0;
	}
	const limit = getDailyLimit();
	if (dailyRunsCount >= limit) {
		return false;
	}
	dailyRunsCount += 1;
	return true;
}

function isTestAlertEnabled() {
	const runtimeConfig = getRuntimeConfig();
	if (runtimeConfig.ENABLE_TEST_ALERT !== undefined) {
		return runtimeConfig.ENABLE_TEST_ALERT === true || runtimeConfig.ENABLE_TEST_ALERT === 'true';
	}
	if (process.env.ENABLE_TEST_ALERT !== undefined) {
		return process.env.ENABLE_TEST_ALERT === 'true' || process.env.ENABLE_TEST_ALERT === true;
	}
	return true;
}

function getAdminKey(req) {
	const user = req.adminUser || req.user;
	if (user && (user.uid || user.email)) {
		return `user:${user.uid || user.email}`;
	}
	const ip = req.ip || req.socket?.remoteAddress || '127.0.0.1';
	return `ip:${ip}`;
}

function getRateLimitState() {
	const today = new Date().toISOString().slice(0, 10);
	const count = dailyRunsDate === today ? dailyRunsCount : 0;
	return {
		windowMs: RATE_LIMIT_WINDOW_MS,
		dailyLimit: getDailyLimit(),
		dailyRunsToday: count,
	};
}

function getLastRunAt() {
	return lastRunAt;
}

function getLastRunStatus() {
	return lastRunStatus;
}

function _resetForTesting() {
	adminRateLimits.clear();
	dailyRunsCount = 0;
	dailyRunsDate = new Date().toISOString().slice(0, 10);
	lastRunAt = null;
	lastRunStatus = null;
}

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}
	return botOrGetter || null;
}

function postTestAlert(botOrGetter) {
	return async (req, res) => {
		if (!isTestAlertEnabled()) {
			return res.status(403).json({
				error: 'Test alert endpoint is disabled',
				code: 'FEATURE_DISABLED',
			});
		}

		const now = Date.now();
		const adminKey = getAdminKey(req);
		const lastCallTime = adminRateLimits.get(adminKey);
		if (lastCallTime && now - lastCallTime < RATE_LIMIT_WINDOW_MS) {
			const remainingMs = RATE_LIMIT_WINDOW_MS - (now - lastCallTime);
			const retryAfterSeconds = Math.ceil(remainingMs / 1000);
			res.set('Retry-After', String(retryAfterSeconds));
			return res.status(429).json({
				error: 'Rate limit exceeded. Test alert can only be called once per minute.',
				code: 'RATE_LIMITED',
				retryAfterSeconds,
			});
		}

		if (!checkAndIncrementDailyLimit()) {
			return res.status(429).json({
				error: `Daily test alert limit reached (${getDailyLimit()}).`,
				code: 'RATE_LIMITED',
			});
		}

		adminRateLimits.set(adminKey, now);

		const body = req.body && typeof req.body === 'object' ? req.body : {};
		const dryRun = Boolean(
			body.dryRun === true ||
			body.dryRun === 'true' ||
			(req.query && (req.query.dryRun === true || req.query.dryRun === 'true')),
		);
		const includeEnrichment = Boolean(body.includeEnrichment === true || body.includeEnrichment === 'true');
		const defaultMarkerText = `[TEST-ALERT] cabros-bot smoke probe ${new Date().toISOString()}`;
		const rawText = body.text === undefined ? defaultMarkerText : body.text;

		let alertText;
		try {
			const validated = validateAlert(rawText);
			alertText = validated.text;
		} catch (validationErr) {
			return res.status(400).json({
				error: validationErr.message,
				code: 'INVALID_REQUEST',
			});
		}

		let routing;
		try {
			routing = parseNotificationRouting(body);
		} catch (routingErr) {
			return res.status(400).json({
				error: routingErr.message,
				code: 'INVALID_REQUEST',
			});
		}

		let notificationManager = getNotificationManager();
		if (!notificationManager) {
			const bot = resolveBot(botOrGetter);
			notificationManager = await initializeNotificationServices(bot);
		}

		let channelsToUse;
		if (routing.channels && routing.channels.length > 0) {
			try {
				validateNotificationRouting(notificationManager, routing);
			} catch (validationErr) {
				return res.status(400).json({
					error: validationErr.message,
					code: 'INVALID_REQUEST',
				});
			}
			channelsToUse = routing.channels;
		} else {
			const enabledChannels = notificationManager ? notificationManager.getEnabledChannels() : [];
			if (!enabledChannels || enabledChannels.length === 0) {
				return res.status(400).json({
					error: 'No notification channels are enabled',
					code: 'INVALID_REQUEST',
				});
			}
			channelsToUse = enabledChannels;
		}

		const alert = { text: alertText, source: 'test-alert' };
		let enrichmentApplied = false;
		let tokenUsageJSON = null;

		if (includeEnrichment) {
			const tokenUsage = new TokenUsageTracker();
			try {
				enrichmentApplied = await processEnrichment(alert, {
					tokenUsage,
					useTradingViewData: true,
					parentSpan: sentryService.getActiveSpan(),
				});
				tokenUsageJSON = tokenUsage.toJSON();
				tokenUsageJSON.formattedSummary = tokenUsage.formatSummary();
			} catch (enrichErr) {
				console.warn('[AdminTestAlert] Enrichment failed:', enrichErr.message);
			}
		}

		// Channel formatting
		const telegramFormatter = new MarkdownV2Formatter();
		const whatsappFormatter = new WhatsAppMarkdownFormatter();
		const telegramText = alert.enriched && typeof alert.enriched === 'object'
			? telegramFormatter.formatEnriched(alert.enriched)
			: telegramFormatter.format(alert.text);
		const whatsappText = alert.enriched && typeof alert.enriched === 'object'
			? await whatsappFormatter.formatEnriched(alert.enriched)
			: (typeof alert.text === 'string' ? alert.text : '');
		const discordText = alert.enriched && typeof alert.enriched === 'object'
			? await whatsappFormatter.formatEnriched(alert.enriched)
			: alert.text;

		if (dryRun) {
			const formatted = {};
			for (const ch of channelsToUse) {
				let preview = alert.text;
				if (ch === 'telegram') preview = telegramText;
				else if (ch === 'whatsapp') preview = whatsappText;
				else if (ch === 'discord') preview = discordText;
				formatted[ch] = {
					length: preview.length,
					preview,
					text: preview,
				};
			}

			lastRunAt = new Date().toISOString();
			lastRunStatus = 'dry-run';

			return res.status(200).json({
				ok: true,
				alertId: uuidv4(),
				persisted: false,
				results: [],
				tokenUsage: tokenUsageJSON,
				enrichmentApplied,
				dryRun: true,
				formatted,
			});
		}

		const startTime = Date.now();
		const deliveryPayload = {
			text: alert.text,
			enriched: alert.enriched,
			source: 'test-alert',
		};
		const effectiveRouting = {
			...routing,
			channels: channelsToUse,
		};

		let results = [];
		try {
			results = await sendWithNotificationRouting(
				notificationManager,
				deliveryPayload,
				effectiveRouting,
			);
		} catch (sendErr) {
			console.error('[AdminTestAlert] Delivery error:', sendErr);
			results = channelsToUse.map((channel) => ({
				channel,
				success: false,
				error: {
					code: 'DELIVERY_FAILED',
					message: sendErr.message,
				},
			}));
		}

		const processingTimeMs = Date.now() - startTime;
		let persisted = false;
		let alertId = uuidv4();

		if (alertStorageService.isEnabled()) {
			const extracted = parseTradingViewSignal(alert.text) || { symbol: 'unknown', exchange: null };
			try {
				const storageTimeoutMs = 2000;
				let timer;
				const timeoutPromise = new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error('Firestore save timed out')), storageTimeoutMs);
				});
				const savePromise = alertStorageService.saveAlert({
					requestId: alertId,
					text: alert.text,
					symbol: extracted.symbol !== 'unknown' ? extracted.symbol : null,
					exchange: extracted.exchange || null,
					enriched: enrichmentApplied,
					enrichmentData: alert.enriched || null,
					tokenUsage: tokenUsageJSON,
					deliveryResults: results,
					channels: channelsToUse,
					useTradingViewData: includeEnrichment,
					processingTimeMs,
					tradingViewEnrichmentApplied: Boolean(alert.enriched && alert.enriched.tradingViewEnrichmentApplied === true),
					tradingViewEnrichmentStatus: alert.tradingViewEnrichmentStatus,
					suppressedRepeat: false,
					source: 'test-alert',
					telegramChatId: routing.telegramChatId,
					telegramThreadId: routing.telegramThreadId,
					whatsappChatId: routing.whatsappChatId,
					// Do not persist raw discordWebhookUrl to avoid storing sensitive webhook credentials.
				});
				const storedId = await Promise.race([savePromise, timeoutPromise]);
				clearTimeout(timer);
				if (storedId) {
					alertId = storedId;
					persisted = true;
				}
			} catch (storageErr) {
				console.warn('[AdminTestAlert] Failed or timed out storing alert in Firestore:', storageErr.message);
			}
		}

		const ok = Array.isArray(results) && results.length > 0 && results.every((r) => r.success === true);
		const anySuccess = Array.isArray(results) && results.some((r) => r.success === true);
		lastRunAt = new Date().toISOString();
		lastRunStatus = ok ? 'success' : (anySuccess ? 'partial' : 'failed');

		return res.status(200).json({
			ok,
			alertId,
			persisted,
			results,
			tokenUsage: tokenUsageJSON,
			enrichmentApplied,
			dryRun: false,
		});
	};
}

module.exports = {
	postTestAlert,
	isTestAlertEnabled,
	getLastRunAt,
	getLastRunStatus,
	getRateLimitState,
	_resetForTesting,
};
