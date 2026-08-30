require('dotenv').config();
const crypto = require('crypto');
const { enrichAlert } = require('./grounding');
const { validateAlert } = require('../../../../lib/validation');
const { v4: uuidv4 } = require('uuid');
const signalOutcomeService = require('../../../../services/storage/SignalOutcomeService');
const MarkdownV2Formatter = require('../../../../services/notification/formatters/markdownV2Formatter');
const TelegramService = require('../../../../services/notification/TelegramService');
const WhatsAppService = require('../../../../services/notification/WhatsAppService');
const DiscordService = require('../../../../services/notification/DiscordService');
const NotificationManager = require('../../../../services/notification/NotificationManager');
const { getURLShortener } = require('../../handlers/newsMonitor/urlShortener');
const sentryService = require('../../../../services/monitoring/SentryService');
const { TokenUsageTracker } = require('../../../../lib/tokenUsage');
const { trackBackgroundTask } = require('../../../../lib/backgroundTaskTracker');
const alertStorageService = require('../../../../services/storage/AlertStorageService');
const {
	NotificationRoutingValidationError,
	parseNotificationRouting,
	validateNotificationRouting,
	sendWithNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
} = require('../../../../services/notification/requestRouting');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { parseTradingViewSignal, TIMEFRAME_MAP } = require('../../../../services/tradingview/parseTradingViewSignal');
const { signalRepeatCooldown, oppositeKeyOf, buildSignalKey } = require('../../../../services/alerts/signalRepeatCooldown');
const { notificationRedriveService } = require('../../../../services/notification/NotificationRedriveService');
const { isPreviewEnvironment } = require('../../../../lib/deploymentEnvironment');

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

	const discordService = new DiscordService({
		logger: console,
	});

	notificationManager = new NotificationManager(telegramService, whatsappService, discordService);

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
	const runtimeConfig = getRuntimeConfig();
	const isGeminiEnabled = runtimeConfig.ENABLE_GEMINI_GROUNDING;
	const isTradingViewMcpEnabled = runtimeConfig.ENABLE_TRADINGVIEW_MCP_ENRICHMENT && useTradingViewData;

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
				if (isTradingViewMcpEnabled) {
					const tradingViewEnrichmentStatus = enrichedAlert.tradingViewEnrichmentStatus
						|| (enrichedAlert.tradingViewEnrichmentApplied === true
							? 'full'
							: (parseTradingViewSignal(alert.text) ? 'failed' : 'not_applicable'));
					enrichedAlert.tradingViewEnrichmentStatus = tradingViewEnrichmentStatus;
					enrichedAlert.tradingViewEnrichmentApplied = ['full', 'partial'].includes(tradingViewEnrichmentStatus);
					alert.tradingViewEnrichmentStatus = tradingViewEnrichmentStatus;
				}
				console.debug('[Alert] Enrichment completed, sources:', (enrichedAlert.sources && enrichedAlert.sources.length) || 0);
			} else {
				if (isTradingViewMcpEnabled) {
					alert.tradingViewEnrichmentStatus = parseTradingViewSignal(alert.text) ? 'failed' : 'not_applicable';
				}
				console.debug('[Alert] Enrichment skipped: alert text did not match enabled providers');
			}
		} catch (error) {
			if (isTradingViewMcpEnabled) {
				alert.tradingViewEnrichmentStatus = parseTradingViewSignal(alert.text) ? 'failed' : 'not_applicable';
			}
			console.warn('[Alert] Enrichment failed, using original text:', error.message);
		} finally {
			sentryService.endSpan(enrichmentSpan);
		}
	}

	return enriched;
}

function resolveRequestId(req) {
	const raw = req && req.headers && (req.headers['x-request-id'] || req.headers['X-Request-Id'] || req.headers['x-request-ID']);
	if (typeof raw === 'string') {
		const trimmed = raw.trim();
		if (trimmed.length > 0 && trimmed.length <= 128 && /^[\x21-\x7E]+$/.test(trimmed)) {
			return trimmed;
		}
	}
	return uuidv4();
}

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

function getCooldownDestination(channel, routing = {}) {
	const overrideByChannel = {
		telegram: routing.telegramChatId,
		whatsapp: routing.whatsappChatId,
		discord: routing.discordWebhookUrl,
	};
	const envByChannel = {
		telegram: process.env.TELEGRAM_CHAT_ID,
		whatsapp: (isPreviewEnvironment() && process.env.WHATSAPP_PREVIEW_CHAT_ID) || process.env.WHATSAPP_CHAT_ID,
		discord: process.env.DISCORD_WEBHOOK_URL,
	};
	return overrideByChannel[channel] || envByChannel[channel] || 'default';
}

function getCooldownChannelIdentity(channel, routing) {
	const destination = String(getCooldownDestination(channel, routing));
	return getCooldownChannelIdentityForDestination(channel, destination);
}

function getCooldownChannelIdentityForDestination(channel, destination) {
	const fingerprint = crypto.createHash('sha256').update(destination).digest('hex').slice(0, 16);
	return `${channel}:${fingerprint}`;
}

function getChannelName(identity) {
	return String(identity).split(':', 1)[0];
}

function postAlert(botOrGetter) {
	return async (req, res) => {
		const requestId = resolveRequestId(req);
		const startTime = Date.now();
		const { body } = req;
		const useTradingViewData = req.query && (req.query.useTradingViewData === true || req.query.useTradingViewData === 'true');
		const dryRun = resolveDryRun(req);

		let alertText = '';
		let alert = null;

		try {
			const requestSpan = sentryService.getActiveSpan();
			const routing = parseNotificationRouting(typeof body === 'object' ? body : undefined);

			if (typeof body === 'object' && 'text' in body) {
				alertText = body.text;
			} else {
				alertText = body;
			}

			const { text } = validateAlert(alertText);
			alert = { text };

			const tokenUsage = new TokenUsageTracker();
			const enriched = await processEnrichment(alert, { tokenUsage, useTradingViewData, parentSpan: requestSpan });

			const tokenUsageJSON = tokenUsage.toJSON();
			tokenUsageJSON.formattedSummary = tokenUsage.formatSummary();

			if (dryRun) {
				console.debug('[Alert] Dry-run mode: skipping delivery and Firestore persistence');
				return res.json({
					success: true,
					dryRun: true,
					enriched,
					payload: {
						text: alert.text,
						enrichedData: alert.enriched || null,
					},
					tokenUsage: tokenUsageJSON,
					requestId,
				});
			}

			// Defer notification service initialization until we know we need delivery.
			const bot = resolveBot(botOrGetter);
			if (!notificationManager) {
				await initializeNotificationServices(bot);
			}
			validateNotificationRouting(notificationManager, routing);
			const requestedChannels = getRequestedChannels(notificationManager, routing);

			// Opt-in repeat suppression: same (exchange, symbol, timeframe, side)
			// inside its cooldown window skips channel delivery but is still
			// persisted with a marker below. Storage errors fail open. The
			// reservation is made before delivery so overlapping requests cannot
			// both send; failed channels remain retryable.
			let suppressedRepeat = false;
			let reservation = null;
			let deliveryRouting = routing;
			let repeatCooldownOptions;
			if (signalRepeatCooldown.isEnabled()) {
				const parsedSignal = parseTradingViewSignal(alert.text);
				// Unsupported timeframes normalize to the default timeframe, so
				// they must never enter the cooldown store: a raw token like
				// "3M" collapses to "1h" and stays unsuppressed, while "4H"
				// legitimately maps to the 4h bar via the TIMEFRAME_MAP.
				const hasUsableTimeframe = Boolean(
					parsedSignal
					&& parsedSignal.rawTimeframe
					&& Object.prototype.hasOwnProperty.call(TIMEFRAME_MAP, parsedSignal.rawTimeframe)
					&& TIMEFRAME_MAP[parsedSignal.rawTimeframe] === parsedSignal.timeframe,
				);
				const cooldownChannelNames = requestedChannels.length > 0
					? requestedChannels
					: ['telegram', 'whatsapp', 'discord'];
				if (parsedSignal && hasUsableTimeframe) {
					const cooldownChannels = cooldownChannelNames.map((channel) => getCooldownChannelIdentity(channel, routing));
					await notificationRedriveService.reconcileRepeatCooldown(buildSignalKey(parsedSignal), cooldownChannels);
					const verdict = signalRepeatCooldown.reserve(
						{ ...parsedSignal, timeframe: parsedSignal.timeframe },
						cooldownChannels,
					);
					if (verdict.suppressed) {
						suppressedRepeat = true;
						signalRepeatCooldown.recordSuppression();
						console.log(
							`[Alert] Repeat suppressed for ${verdict.key} (${Math.round(verdict.elapsedMs / 1000)}s elapsed, retry in ${Math.round(verdict.retryInMs / 1000)}s)`,
						);
					} else if (verdict.key) {
						reservation = verdict;
						repeatCooldownOptions = {
							key: verdict.key,
							reservedAt: verdict.reservedAt,
							generation: verdict.generation,
							channelsByName: Object.fromEntries(verdict.channels.map((channel) => [getChannelName(channel), channel])),
							destinationsByName: Object.fromEntries(verdict.channels.map((channel) => {
								const channelName = getChannelName(channel);
								return [channelName, getCooldownDestination(channelName, routing)];
							})),
							defaultChannelsByName: Object.fromEntries(verdict.channels.map((channel) => {
								const channelName = getChannelName(channel);
								return [channelName, getCooldownChannelIdentityForDestination(channelName, 'default')];
							})),
						};
						if (verdict.channels.length < requestedChannels.length) {
							deliveryRouting = { ...routing, channels: verdict.channels.map(getChannelName) };
						}
					}
				}
			}

			let results;
			try {
				results = suppressedRepeat
					? []
					: await sendWithNotificationRouting(notificationManager, alert, deliveryRouting, {
						parentSpan: requestSpan,
						repeatCooldown: repeatCooldownOptions,
					});
			} catch (error) {
				if (reservation) {
					signalRepeatCooldown.finalize(reservation.key, reservation.channels, [], [], reservation.generation);
				}
				throw error;
			}
			const deliveredChannels = suppressedRepeat ? [] : getDeliveredChannels(results);
			if (reservation) {
				const failedChannelNames = new Set(
					results.filter((result) => result && !result.success).map((result) => result.channel),
				);
				const supersededReservationChannels = new Set();
				if (notificationRedriveService.isEnabled() && failedChannelNames.size > 0) {
					await Promise.all(reservation.channels
						.filter((channel) => failedChannelNames.has(getChannelName(channel)))
						.map(async (channel) => {
							const superseded = await notificationRedriveService.isRepeatCooldownSuperseded({
								id: `${requestId}_${getChannelName(channel)}`,
								repeatCooldown: {
									key: reservation.key,
									channel,
									reservedAt: reservation.reservedAt,
									generation: reservation.generation,
								},
							});
							if (superseded) {
								supersededReservationChannels.add(channel);
							}
						}));
				}
				const zeroChannelRedriveExpected = requestedChannels.length === 0
					&& !notificationManager.isIntentionalApiOnly();
				const deliveredReservationChannels = reservation.channels.filter((channel) => (
					deliveredChannels.includes(getChannelName(channel))
				));
				const keepFailedForRedrive = notificationRedriveService.isEnabled()
					&& notificationRedriveService.getWorkerRole() !== 'disabled'
					&& (notificationRedriveService.getWorkerRole() === 'web' || notificationRedriveService.hasDurableStore())
					&& (results.some((result) => result && !result.success) || zeroChannelRedriveExpected);
				const redriveReservationChannels = reservation.channels.filter((channel) => (
					!supersededReservationChannels.has(channel)
				));
				const finalizationChannels = keepFailedForRedrive
					? redriveReservationChannels
					: deliveredReservationChannels;
				signalRepeatCooldown.finalize(
					reservation.key,
					reservation.channels,
					finalizationChannels,
					deliveredReservationChannels,
					reservation.generation,
				);
				if (notificationRedriveService.isEnabled() && deliveredReservationChannels.length > 0) {
					const defaultDestinationChannels = deliveredReservationChannels
						.map((channel) => repeatCooldownOptions?.defaultChannelsByName?.[getChannelName(channel)])
						.filter(Boolean);
					if (defaultDestinationChannels.length > 0) {
						const cancellation = notificationRedriveService.cancelPendingRepeatCooldowns(
							reservation.key,
							defaultDestinationChannels,
						);
						await Promise.race([
							cancellation,
							new Promise((resolve) => setTimeout(resolve, 500)),
						]);
						trackBackgroundTask(cancellation).catch(() => {});
					}
					const oppositeKey = oppositeKeyOf(reservation.key);
					if (oppositeKey) {
						const oppositeChannels = [...new Set([
							...deliveredReservationChannels,
							...defaultDestinationChannels,
						])];
						const cancellation = notificationRedriveService.cancelPendingRepeatCooldowns(oppositeKey, oppositeChannels);
						await Promise.race([
							cancellation,
							new Promise((resolve) => setTimeout(resolve, 500)),
						]);
						trackBackgroundTask(cancellation).catch(() => {});
					}
				}
			}
			const processingTimeMs = Math.max(0, Date.now() - startTime);

			// Return 200 OK regardless of delivery success (fail-open pattern)
			res.json({
				success: true,
				results,
				enriched,
				suppressedRepeat: suppressedRepeat || undefined,
				tokenUsage: tokenUsageJSON,
				requestedChannels,
				deliveredChannels,
				requestId,
			});

			const extracted = alertStorageService.extractSymbolAndExchange({
				text: alert.text,
				enrichmentData: alert.enriched || null,
			});

			if (alert.enriched && typeof alert.enriched === 'object') {
				if (!alert.enriched.symbol && extracted.symbol !== 'unknown') {
					alert.enriched.symbol = extracted.symbol;
				}
				if (!alert.enriched.exchange && extracted.exchange) {
					alert.enriched.exchange = extracted.exchange;
				}
			}

			// Fire-and-forget: persist alert to Firestore after responding to the caller.
			// Errors are caught inside saveAlert — delivery is never blocked by storage.
			alertStorageService.saveAlert({
				requestId,
				text: alert.text,
				symbol: extracted.symbol !== 'unknown' ? extracted.symbol : null,
				exchange: extracted.exchange || null,
				enriched,
				enrichmentData: alert.enriched || null,
				tokenUsage: tokenUsageJSON,
				deliveryResults: results,
				channels: requestedChannels,
				useTradingViewData,
				processingTimeMs,
				tradingViewEnrichmentApplied: Boolean(alert.enriched && alert.enriched.tradingViewEnrichmentApplied === true),
				tradingViewEnrichmentStatus: alert.tradingViewEnrichmentStatus,
				suppressedRepeat,
			}).catch(() => {}); // errors already logged inside AlertStorageService

			if (signalOutcomeService.isEnabled() && !suppressedRepeat) {
				const { parseTradingViewSignal } = require('../../../../services/tradingview/parseTradingViewSignal');
				const parsed = parseTradingViewSignal(alert.text);
				if (parsed) {
					const mcpPrice = (alert.enriched && typeof alert.enriched.current_price === 'number' && Number.isFinite(alert.enriched.current_price) && alert.enriched.current_price > 0)
						? alert.enriched.current_price
						: (alert.enriched && alert.enriched.price_data && typeof alert.enriched.price_data.current_price === 'number' && Number.isFinite(alert.enriched.price_data.current_price) && alert.enriched.price_data.current_price > 0)
							? alert.enriched.price_data.current_price
							: null;

					signalOutcomeService.recordSignal({
						requestId,
						source: 'webhook-alert',
						symbol: parsed.symbol,
						exchange: parsed.exchange || 'BINANCE',
						timeframe: parsed.timeframe,
						setupType: 'tradingview-enrichment',
						score: alert.enriched ? alert.enriched.sentiment_score : null,
						side: parsed.side,
						price: mcpPrice,
						priceSource: mcpPrice !== null ? 'tradingview-mcp' : null,
						sources: alert.enriched && Array.isArray(alert.enriched.sources) ? alert.enriched.sources : [],
						tokenUsage: tokenUsageJSON,
						processingTimeMs: Date.now() - startTime,
					}).catch(() => {});
				}
			}
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(error.statusCode).json({
					success: false,
					error: error.message,
					details: error.details,
					requestId,
				});
			}

			console.error('[Alert] Request failed:', error.message);

			// Capture runtime error to Sentry (T012)
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/webhook/alert',
					method: 'POST',
					statusCode: (error.response && error.response.error_code) || 500,
					requestId,
				},
				alert: {
					textLength: alertText ? alertText.length : 0,
					hasEnrichment: !!(alert && alert.enriched),
					enrichedSource: alert && alert.enriched && alert.enriched.extraText && alert.enriched.extraText.includes('tradingview-mcp') ? 'tradingview-mcp' : (alert && alert.enriched ? 'gemini-grounding' : undefined),
					truncated: false,
				},
			});

			const status = (error.response && error.response.error_code) || 500;
			const errorResponse = error.response || { error: 'Internal server error', details: error.message, requestId };
			res.status(status).send(errorResponse);
		}
	};
}

module.exports = {
	postAlert,
	resolveRequestId,
	initializeNotificationServices,
	getNotificationManager,
	getCooldownChannelIdentity,
};
