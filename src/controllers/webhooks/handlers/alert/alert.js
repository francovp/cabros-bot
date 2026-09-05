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
const { burstAggregator } = require('../../../../services/alerts/burstAggregator');
const { notificationRedriveService } = require('../../../../services/notification/NotificationRedriveService');
const { isPreviewEnvironment } = require('../../../../lib/deploymentEnvironment');
const {
	buildErrorEnvelope,
	sendError,
	STANDARD_ERROR_CODES,
} = require('../../../../lib/errorEnvelope');

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
	const defaultTelegramChatId = process.env.TELEGRAM_CHAT_ID;
	const telegramChatId = routing.telegramChatId || defaultTelegramChatId;
	const telegramThreadId = (typeof routing.telegramThreadId === 'number' && Number.isSafeInteger(routing.telegramThreadId))
		? routing.telegramThreadId
		: undefined;
	const telegramDestination = telegramChatId
		? (telegramThreadId !== undefined ? `${telegramChatId}:${telegramThreadId}` : telegramChatId)
		: undefined;

	const overrideByChannel = {
		telegram: telegramDestination,
		whatsapp: routing.whatsappChatId,
		discord: routing.discordWebhookUrl,
	};
	const envByChannel = {
		telegram: defaultTelegramChatId,
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
			const source = (typeof body === 'object' && body && typeof body.source === 'string' && body.source.trim())
				? body.source.trim()
				: 'webhook-alert';
			alert = { text, source };

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

			// Build a closure that performs the full delivery + persistence +
			// signal-outcome recording path for one parsed alert. The burst
			// aggregator can call this from its onFlush callback so buffered
			// alerts preserve identical behavior once their window closes.
			const deliverAndPersist = async ({
				alertOverride,
				routingOverride,
				burstAggregateId: aggregateMarker,
				aggregated: aggregatedFlag,
				requestIdOverride,
			} = {}) => {
				const effectiveAlert = alertOverride || alert;
				const effectiveRouting = routingOverride || routing;
				const effectiveRequestId = requestIdOverride || requestId;

				let suppressedRepeatInner = false;
				let reservationInner = null;
				let deliveryRoutingInner = effectiveRouting;
				let repeatCooldownOptionsInner;
				if (signalRepeatCooldown.isEnabled()) {
					const parsedSignal = parseTradingViewSignal(effectiveAlert.text);
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
						const cooldownChannels = cooldownChannelNames.map((channel) => getCooldownChannelIdentity(channel, effectiveRouting));
						await notificationRedriveService.reconcileRepeatCooldown(buildSignalKey(parsedSignal), cooldownChannels);
						const verdict = signalRepeatCooldown.reserve(
							{ ...parsedSignal, timeframe: parsedSignal.timeframe },
							cooldownChannels,
						);
						if (verdict.suppressed) {
							suppressedRepeatInner = true;
							signalRepeatCooldown.recordSuppression();
						} else if (verdict.key) {
							reservationInner = verdict;
							repeatCooldownOptionsInner = {
								key: verdict.key,
								reservedAt: verdict.reservedAt,
								generation: verdict.generation,
								channelsByName: Object.fromEntries(verdict.channels.map((channel) => [getChannelName(channel), channel])),
								destinationsByName: Object.fromEntries(verdict.channels.map((channel) => {
									const channelName = getChannelName(channel);
									return [channelName, getCooldownDestination(channelName, effectiveRouting)];
								})),
								defaultChannelsByName: Object.fromEntries(verdict.channels.map((channel) => {
									const channelName = getChannelName(channel);
									return [channelName, getCooldownChannelIdentityForDestination(channelName, 'default')];
								})),
							};
							if (verdict.channels.length < requestedChannels.length) {
								deliveryRoutingInner = { ...effectiveRouting, channels: verdict.channels.map(getChannelName) };
							}
						}
					}
				}

				let resultsInner;
				try {
					resultsInner = suppressedRepeatInner
						? []
						: await sendWithNotificationRouting(notificationManager, effectiveAlert, deliveryRoutingInner, {
							parentSpan: requestSpan,
							repeatCooldown: repeatCooldownOptionsInner,
						});
				} catch (error) {
					if (reservationInner) {
						signalRepeatCooldown.finalize(reservationInner.key, reservationInner.channels, [], [], reservationInner.generation);
					}
					throw error;
				}
				const deliveredChannelsInner = suppressedRepeatInner ? [] : getDeliveredChannels(resultsInner);
				if (reservationInner) {
					const failedChannelNames = new Set(
						resultsInner.filter((result) => result && !result.success).map((result) => result.channel),
					);
					const supersededReservationChannels = new Set();
					if (notificationRedriveService.isEnabled() && failedChannelNames.size > 0) {
						await Promise.all(reservationInner.channels
							.filter((channel) => failedChannelNames.has(getChannelName(channel)))
							.map(async (channel) => {
								const superseded = await notificationRedriveService.isRepeatCooldownSuperseded({
									id: `${effectiveRequestId}_${getChannelName(channel)}`,
									repeatCooldown: {
										key: reservationInner.key,
										channel,
										reservedAt: reservationInner.reservedAt,
										generation: reservationInner.generation,
									},
								});
								if (superseded) {
									supersededReservationChannels.add(channel);
								}
							}));
					}
					const zeroChannelRedriveExpected = requestedChannels.length === 0
						&& !notificationManager.isIntentionalApiOnly();
					const deliveredReservationChannels = reservationInner.channels.filter((channel) => (
						deliveredChannelsInner.includes(getChannelName(channel))
					));
					const keepFailedForRedrive = notificationRedriveService.isEnabled()
						&& notificationRedriveService.getWorkerRole() !== 'disabled'
						&& (notificationRedriveService.getWorkerRole() === 'web' || notificationRedriveService.hasDurableStore())
						&& (resultsInner.some((result) => result && !result.success) || zeroChannelRedriveExpected);
					const redriveReservationChannels = reservationInner.channels.filter((channel) => (
						!supersededReservationChannels.has(channel)
					));
					const finalizationChannels = keepFailedForRedrive
						? redriveReservationChannels
						: deliveredReservationChannels;
					signalRepeatCooldown.finalize(
						reservationInner.key,
						reservationInner.channels,
						finalizationChannels,
						deliveredReservationChannels,
						reservationInner.generation,
					);
					if (notificationRedriveService.isEnabled() && deliveredReservationChannels.length > 0) {
						const defaultDestinationChannels = deliveredReservationChannels
							.map((channel) => repeatCooldownOptionsInner?.defaultChannelsByName?.[getChannelName(channel)])
							.filter(Boolean);
						if (defaultDestinationChannels.length > 0) {
							const cancellation = notificationRedriveService.cancelPendingRepeatCooldowns(
								reservationInner.key,
								defaultDestinationChannels,
							);
							await Promise.race([
								cancellation,
								new Promise((resolve) => setTimeout(resolve, 500)),
							]);
							trackBackgroundTask(cancellation).catch(() => {});
						}
						const oppositeKey = oppositeKeyOf(reservationInner.key);
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
				const processingTimeMsInner = Math.max(0, Date.now() - startTime);

				const extractedInner = alertStorageService.extractSymbolAndExchange({
					text: effectiveAlert.text,
					enrichmentData: effectiveAlert.enriched || null,
				});

				if (effectiveAlert.enriched && typeof effectiveAlert.enriched === 'object') {
					if (!effectiveAlert.enriched.symbol && extractedInner.symbol !== 'unknown') {
						effectiveAlert.enriched.symbol = extractedInner.symbol;
					}
					if (!effectiveAlert.enriched.exchange && extractedInner.exchange) {
						effectiveAlert.enriched.exchange = extractedInner.exchange;
					}
				}

				alertStorageService.saveAlert({
					requestId: effectiveRequestId,
					text: effectiveAlert.text,
					symbol: extractedInner.symbol !== 'unknown' ? extractedInner.symbol : null,
					exchange: extractedInner.exchange || null,
					enriched,
					enrichmentData: effectiveAlert.enriched || null,
					tokenUsage: tokenUsageJSON,
					deliveryResults: resultsInner,
					channels: requestedChannels,
					useTradingViewData,
					processingTimeMs: processingTimeMsInner,
					tradingViewEnrichmentApplied: Boolean(effectiveAlert.enriched && effectiveAlert.enriched.tradingViewEnrichmentApplied === true),
					tradingViewEnrichmentStatus: effectiveAlert.tradingViewEnrichmentStatus,
					suppressedRepeat: suppressedRepeatInner,
					source: body.source || 'webhook-alert',
					telegramChatId: effectiveRouting.telegramChatId,
					telegramThreadId: effectiveRouting.telegramThreadId,
					whatsappChatId: effectiveRouting.whatsappChatId,
					discordWebhookUrl: effectiveRouting.discordWebhookUrl,
					burstAggregateId: aggregateMarker || null,
					aggregated: aggregatedFlag === true,
				}).catch(() => {});

				if (signalOutcomeService.isEnabled() && !suppressedRepeatInner) {
					const { parseTradingViewSignal } = require('../../../../services/tradingview/parseTradingViewSignal');
					const parsed = parseTradingViewSignal(effectiveAlert.text);
					if (parsed) {
						const mcpPrice = (effectiveAlert.enriched && typeof effectiveAlert.enriched.current_price === 'number' && Number.isFinite(effectiveAlert.enriched.current_price) && effectiveAlert.enriched.current_price > 0)
							? effectiveAlert.enriched.current_price
							: (effectiveAlert.enriched && effectiveAlert.enriched.price_data && typeof effectiveAlert.enriched.price_data.current_price === 'number' && Number.isFinite(effectiveAlert.enriched.price_data.current_price) && effectiveAlert.enriched.price_data.current_price > 0)
								? effectiveAlert.enriched.price_data.current_price
								: null;

						const stopLevel = effectiveAlert.enriched && typeof effectiveAlert.enriched.invalidation_level === 'number' && Number.isFinite(effectiveAlert.enriched.invalidation_level) && effectiveAlert.enriched.invalidation_level > 0
							? effectiveAlert.enriched.invalidation_level
							: (effectiveAlert.enriched && typeof effectiveAlert.enriched.invalidation_level === 'string' && Number.isFinite(Number(effectiveAlert.enriched.invalidation_level)) && Number(effectiveAlert.enriched.invalidation_level) > 0
								? Number(effectiveAlert.enriched.invalidation_level)
								: null);

						const targetLevel = effectiveAlert.enriched && typeof effectiveAlert.enriched.target_level === 'number' && Number.isFinite(effectiveAlert.enriched.target_level) && effectiveAlert.enriched.target_level > 0
							? effectiveAlert.enriched.target_level
							: (effectiveAlert.enriched && typeof effectiveAlert.enriched.target_level === 'string' && Number.isFinite(Number(effectiveAlert.enriched.target_level)) && Number(effectiveAlert.enriched.target_level) > 0
								? Number(effectiveAlert.enriched.target_level)
								: null);

						const levelsSource = effectiveAlert.enriched && effectiveAlert.enriched.levelsSource;
						const priceSource = mcpPrice !== null
							? (levelsSource === 'derived-quote' ? 'derived-quote' : (levelsSource === 'gemini-grounding' ? 'gemini-grounding' : 'tradingview-mcp'))
							: null;

						signalOutcomeService.recordSignal({
							requestId: effectiveRequestId,
							source: 'webhook-alert',
							symbol: parsed.symbol,
							exchange: parsed.exchange || 'BINANCE',
							timeframe: parsed.timeframe,
							setupType: (effectiveAlert.enriched && effectiveAlert.enriched.setup_type) || 'tradingview-enrichment',
							score: effectiveAlert.enriched ? effectiveAlert.enriched.sentiment_score : null,
							side: parsed.side,
							price: mcpPrice,
							stop: stopLevel,
							target: targetLevel,
							priceSource,
							sources: effectiveAlert.enriched && Array.isArray(effectiveAlert.enriched.sources) ? effectiveAlert.enriched.sources : [],
							tokenUsage: tokenUsageJSON,
							processingTimeMs: Date.now() - startTime,
						}).catch(() => {});
					}
				}

				return {
					results: resultsInner,
					suppressedRepeat: suppressedRepeatInner,
					deliveredChannels: deliveredChannelsInner,
				};
			};

			// Opt-in burst aggregation: when enabled, buffer parsed alerts with
			// identical routing + direction for a short rolling window. The
			// aggregator decides whether to emit a single aggregated regime
			// message or fall through to individual delivery, then calls
			// deliverAndPersist for each participating alert.
			let burstAggregateId = null;
			let burstPending = false;
			let burstAggregatorStats = null;
			if (burstAggregator.isEnabled()) {
				const burstVerdict = burstAggregator.accept({
					text: alert.text,
					requestId,
					routing,
					onFlush: ({ aggregated: aggregatedByAggregator } = {}) => {
						if (aggregatedByAggregator === false) {
							trackBackgroundTask(deliverAndPersist());
						}
					},
					onComplete: (error, payload, metadata) => {
						if (error || !payload) {
							return;
						}
						const aggregateId = payload && payload.aggregateId || (metadata && metadata.aggregateId);
						const aggregatedAlert = {
							text: payload.text,
							source,
							enriched: {
								original_text: payload.text,
								burstAggregate: {
									aggregateId,
									side: payload.side,
									signalCount: payload.signalCount,
									constituentAlertIds: payload.constituentAlertIds,
									constituentSymbols: payload.constituentSymbols,
								},
							},
						};
						trackBackgroundTask(deliverAndPersist({
							alertOverride: aggregatedAlert,
							burstAggregateId: aggregateId,
							aggregated: true,
						}));
					},
				});
				burstAggregatorStats = burstVerdict;
				if (burstVerdict && burstVerdict.pending === true) {
					burstPending = true;
					burstAggregateId = burstVerdict.aggregateId || null;
				}
			}

			if (burstPending) {
				const processingTimeMs = Math.max(0, Date.now() - startTime);
				res.json({
					success: true,
					results: [],
					enriched,
					pending: true,
					burstAggregateId: burstAggregateId || undefined,
					burstWindowMs: burstAggregatorStats && burstAggregatorStats.windowMs,
					burstMinSignals: burstAggregatorStats && burstAggregatorStats.minSignals,
					burstSignalCount: burstAggregatorStats && burstAggregatorStats.signalCount,
					tokenUsage: tokenUsageJSON,
					requestedChannels,
					deliveredChannels: [],
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

				alertStorageService.saveAlert({
					requestId,
					text: alert.text,
					symbol: extracted.symbol !== 'unknown' ? extracted.symbol : null,
					exchange: extracted.exchange || null,
					enriched,
					enrichmentData: alert.enriched || null,
					tokenUsage: tokenUsageJSON,
					deliveryResults: [],
					channels: requestedChannels,
					useTradingViewData,
					processingTimeMs,
					tradingViewEnrichmentApplied: Boolean(alert.enriched && alert.enriched.tradingViewEnrichmentApplied === true),
					tradingViewEnrichmentStatus: alert.tradingViewEnrichmentStatus,
					suppressedRepeat: false,
					source: body.source || 'webhook-alert',
					telegramChatId: routing.telegramChatId,
					telegramThreadId: routing.telegramThreadId,
					whatsappChatId: routing.whatsappChatId,
					discordWebhookUrl: routing.discordWebhookUrl,
					burstAggregateId,
					aggregated: false,
					pending: true,
				}).catch(() => {});
				return;
			}

			const inlineDelivery = await deliverAndPersist();

			// Return 200 OK regardless of delivery success (fail-open pattern)
			res.json({
				success: true,
				results: inlineDelivery.results,
				enriched,
				suppressedRepeat: inlineDelivery.suppressedRepeat || undefined,
				tokenUsage: tokenUsageJSON,
				requestedChannels,
				deliveredChannels: inlineDelivery.deliveredChannels,
				requestId,
			});
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return sendError(res, error.statusCode, {
					error: error.message,
					code: STANDARD_ERROR_CODES.INVALID_REQUEST,
					requestId,
					details: error.details,
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
			const upstreamEnvelope = error.response && typeof error.response === 'object'
				? error.response
				: null;
			const envelope = buildErrorEnvelope({
				error: (upstreamEnvelope && upstreamEnvelope.error) || error.message || 'Internal server error',
				code: (upstreamEnvelope && upstreamEnvelope.code) || STANDARD_ERROR_CODES.INTERNAL_ERROR,
				requestId,
				statusCode: status,
				details: (upstreamEnvelope && upstreamEnvelope.details) || undefined,
			});
			res.status(status).json(envelope);
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
