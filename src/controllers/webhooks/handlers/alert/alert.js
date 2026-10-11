require('dotenv').config();
const crypto = require('crypto');
const { enrichAlert } = require('./grounding');
const { validateAlert } = require('../../../../lib/validation');
const { v4: uuidv4 } = require('uuid');
const signalOutcomeService = require('../../../../services/storage/SignalOutcomeService');
const MarkdownV2Formatter = require('../../../../services/notification/formatters/markdownV2Formatter');
const sentryService = require('../../../../services/monitoring/SentryService');
const { TokenUsageTracker } = require('../../../../lib/tokenUsage');
const { trackBackgroundTask } = require('../../../../lib/backgroundTaskTracker');
const alertStorageService = require('../../../../services/storage/AlertStorageService');
const {
	NotificationRoutingValidationError,
	parseNotificationRouting,
	validateNotificationRouting,
	assertChannelsAvailable,
	sendWithNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
} = require('../../../../services/notification/requestRouting');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { resolveRequestId } = require('../../../../lib/requestDeadline');
const { resolveDryRun } = require('../../../../lib/dryRunRequest');
const { parseTradingViewSignal, TIMEFRAME_MAP } = require('../../../../services/tradingview/parseTradingViewSignal');
const { signalRepeatCooldown, oppositeKeyOf, buildSignalKey } = require('../../../../services/alerts/signalRepeatCooldown');
const { crossTimeframeCooldown } = require('../../../../services/alerts/crossTimeframeCooldown');
const { burstAggregator, buildBurstGroupKey } = require('../../../../services/alerts/burstAggregator');
const { alertModeration } = require('../../../../services/alerts/alertModeration');
const { classifySignal } = require('../../../../services/alerts/signalClassifier');
const { notificationRedriveService } = require('../../../../services/notification/NotificationRedriveService');
const { isPreviewEnvironment } = require('../../../../lib/deploymentEnvironment');
const { buildReplyMarkup } = require('../../../../services/alerts/telegramAlertKeyboard');
const {
	buildErrorEnvelope,
	sendError,
	STANDARD_ERROR_CODES,
} = require('../../../../lib/errorEnvelope');

const {
	initialize: bootstrapInitialize,
	getOrInitialize: bootstrapGetOrInitialize,
	getInitialized: bootstrapGetInitialized,
	getBootstrapStatus,
	resetForTesting: bootstrapResetForTesting,
} = require('../../../../services/notification/NotificationManagerBootstrap');

/**
 * Initialize notification services
 * Backwards-compatible thin wrapper around `NotificationManagerBootstrap.initialize(bot)`.
 * Existing call sites (e.g., `index.js`, handlers) keep working while the canonical
 * bootstrap lives in the dedicated module.
 *
 * @param {Object} bot - Telegraf bot instance
 * @returns {Promise<NotificationManager|null>}
 */
function initializeNotificationServices(bot) {
	return bootstrapInitialize(bot);
}

/**
 * Get the initialized NotificationManager instance, lazily initializing if missing.
 * Backwards-compatible wrapper around `NotificationManagerBootstrap.getOrInitialize(bot)`.
 *
 * @param {Object|null|Function} [botOrGetter]
 * @returns {Promise<NotificationManager|null>}
 */
function getOrInitializeNotificationManager(botOrGetter) {
	return bootstrapGetOrInitialize(botOrGetter);
}

/**
 * Get the initialized NotificationManager instance (without triggering init).
 * Used by other handlers (e.g., newsMonitor) to send alerts.
 * @returns {NotificationManager|null}
 */
function getNotificationManager() {
	return bootstrapGetInitialized();
}

/**
 * Read-only bootstrap status (for `/api/status` and tests).
 */
function getNotificationManagerBootstrapStatus() {
	return getBootstrapStatus();
}

/**
 * Reset internal state (tests only).
 */
function resetNotificationManagerForTesting() {
	bootstrapResetForTesting();
}

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}

	return botOrGetter || null;
}

function getFirstTelegramMessageId(result) {
	const rawMessageId = Array.isArray(result?.messageIds)
		? result.messageIds[0]
		: (typeof result?.messageId === 'string' ? result.messageId.split(',')[0] : result?.messageId);
	if (rawMessageId === undefined || rawMessageId === null || rawMessageId === '') return null;
	const numericMessageId = Number(rawMessageId);
	return Number.isSafeInteger(numericMessageId) ? numericMessageId : rawMessageId;
}

const INLINE_KEYBOARD_ATTACH_TIMEOUT_MS = 5000;

async function attachInlineKeyboardAfterPersistence({
	manager,
	results,
	routing,
	replyMarkup,
	aggregated,
	timeoutMs = INLINE_KEYBOARD_ATTACH_TIMEOUT_MS,
}) {
	// An aggregated burst delivers one synthetic message shared by every
	// constituent alert. Attaching N per-alert keyboards would race on the same
	// Telegram message id, and a replay button for one symbol would sit on a
	// message that represents all of them.
	if (aggregated || !replyMarkup || !Array.isArray(results)) return;
	const telegramResult = results.find((result) => result?.channel === 'telegram' && result.success);
	const messageId = getFirstTelegramMessageId(telegramResult);
	const telegramService = manager?.channels?.get?.('telegram');
	const editMessageReplyMarkup = telegramService?.bot?.telegram?.editMessageReplyMarkup;
	const chatId = routing?.telegramChatId || process.env.TELEGRAM_CHAT_ID;
	if (!messageId || !chatId || typeof editMessageReplyMarkup !== 'function') return;

	let timeoutId;
	try {
		const editPromise = Promise.resolve().then(() => editMessageReplyMarkup.call(
			telegramService.bot.telegram,
			chatId,
			messageId,
			undefined,
			replyMarkup,
		));
		editPromise.catch(() => {});
		const timeoutPromise = new Promise((_, reject) => {
			timeoutId = setTimeout(() => {
				const error = new Error(`editMessageReplyMarkup timed out after ${timeoutMs}ms`);
				error.code = 'TELEGRAM_KEYBOARD_ATTACH_TIMEOUT';
				reject(error);
			}, timeoutMs);
		});
		await Promise.race([editPromise, timeoutPromise]);
	} catch (error) {
		console.warn('[Alert] Failed to attach inline keyboard after persistence:', error.message);
	} finally {
		clearTimeout(timeoutId);
	}
}

async function processEnrichment(alert, options) {
	const { tokenUsage, useTradingViewData, parentSpan, parsedSignal } = options;
	// `postAlert` parses the same signal for repeat-suppression/persistence/outcome eligibility.
	// Reuse that parse when supplied so enrichment and persistence agree on the trade direction
	// used for deterministic risk/reward (GH-599); fall back to a local parse for direct callers.
	const parsed = parsedSignal || parseTradingViewSignal(alert.text);
	const hasTradingViewSignal = Boolean(parsed);
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
			const enrichedAlert = await enrichAlert({ text: alert.text }, { tokenUsage, useTradingViewData, parsedSignal: parsed });
			if (enrichedAlert && typeof enrichedAlert === 'object') {
				enrichedAlert.tokenUsage = tokenUsage && typeof tokenUsage.toJSON === 'function' ? tokenUsage.toJSON() : null;
				enriched = true;
				alert.enriched = enrichedAlert;
				if (isTradingViewMcpEnabled) {
					const tradingViewEnrichmentStatus = enrichedAlert.tradingViewEnrichmentStatus
						|| (enrichedAlert.tradingViewEnrichmentApplied === true
							? 'full'
							: (hasTradingViewSignal ? 'failed' : 'not_applicable'));
					enrichedAlert.tradingViewEnrichmentStatus = tradingViewEnrichmentStatus;
					enrichedAlert.tradingViewEnrichmentApplied = ['full', 'partial'].includes(tradingViewEnrichmentStatus);
					alert.tradingViewEnrichmentStatus = tradingViewEnrichmentStatus;
				}
				console.debug('[Alert] Enrichment completed, sources:', (enrichedAlert.sources && enrichedAlert.sources.length) || 0);
			} else {
				if (isTradingViewMcpEnabled) {
					alert.tradingViewEnrichmentStatus = hasTradingViewSignal ? 'failed' : 'not_applicable';
				}
				console.debug('[Alert] Enrichment skipped: alert text did not match enabled providers');
			}
		} catch (error) {
			if (isTradingViewMcpEnabled) {
				alert.tradingViewEnrichmentStatus = hasTradingViewSignal ? 'failed' : 'not_applicable';
			}
			console.warn('[Alert] Enrichment failed, using original text:', error.message);
		} finally {
			sentryService.endSpan(enrichmentSpan);
		}
	}

	return enriched;
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

/**
 * Restricts a routing decision to `allowedChannelNames`, intersecting any
 * `symbolRoutes` entry with the same set. A route's own channel list must not
 * resurrect a channel that a cooldown gate is still holding.
 */
function narrowDeliveryRouting(baseRouting, allowedChannelNames) {
	return {
		...baseRouting,
		channels: allowedChannelNames,
		symbolRoutes: baseRouting.symbolRoutes
			? Object.fromEntries(
				Object.entries(baseRouting.symbolRoutes).map(([symbol, route]) => [
					symbol,
					{
						...route,
						channels: (route.channels || []).filter((channel) =>
							allowedChannelNames.includes(channel),
						),
					},
				]),
			)
			: undefined,
	};
}

function resolveSignalOutcomePriceSource(enriched, parsed) {
	const explicitSource = typeof enriched?.priceSource === 'string'
		? enriched.priceSource.trim().toLowerCase()
		: '';
	if (explicitSource && explicitSource !== 'derived-quote') {
		return explicitSource;
	}

	if (enriched?.tradingViewEnrichmentApplied === true
		|| ['full', 'partial'].includes(enriched?.tradingViewEnrichmentStatus)) {
		return 'tradingview-mcp';
	}

	if (enriched?.levelsSource === 'derived-quote') {
		return (parsed?.exchange || 'BINANCE') === 'BINANCE' ? 'binance' : 'twelve-data';
	}

	return enriched?.levelsSource === 'gemini-grounding' ? 'gemini-grounding' : 'tradingview-mcp';
}

function postAlert(botOrGetter) {
	return async (req, res) => {
		const requestId = req.requestId || resolveRequestId(req);
		const startTime = Date.now();
		const { body } = req;
		const useTradingViewData = req.query && (req.query.useTradingViewData === true || req.query.useTradingViewData === 'true');
		const dryRun = resolveDryRun(req);

		let alertText = '';
		let alert = null;
		let notificationManager = null;

		try {
			const requestSpan = sentryService.getActiveSpan();
			const routing = parseNotificationRouting(typeof body === 'object' ? body : undefined);

			if (typeof body === 'object' && 'text' in body) {
				alertText = body.text;
			} else {
				alertText = body;
			}

			const rawSignalClass = (typeof body === 'object' && body && 'signalClass' in body)
				? body.signalClass
				: req.query?.signalClass;
			// `validateAlert` falls back to `metadata.signalClass` when neither the body
			// nor the query carried one. The classifier must see the same precedence, or
			// a caller using the documented metadata form is silently misclassified -
			// and replay, which preserves metadata, would not round-trip (AGENTS.md
			// "Replay Payload Preservation"). Mirrors validation's `!== undefined` test
			// exactly, including the `'signalClass' in body` short-circuit above.
			const metadataSignalClass = (rawSignalClass === undefined
				&& typeof body === 'object' && body && body.metadata && typeof body.metadata === 'object')
				? body.metadata.signalClass
				: undefined;
			const effectiveSignalClass = rawSignalClass === undefined ? metadataSignalClass : rawSignalClass;

			const validatedAlert = validateAlert(
				alertText,
				typeof body === 'object' ? body.metadata : undefined,
				rawSignalClass,
			);
			const { text } = validatedAlert;
			// `validateAlert` collapses "no explicit class" into the string
			// 'unknown', which would always beat derivation and leave the badge
			// markers rendering for a class nothing populated (issue #858). So we
			// classify here from the RAW explicit value instead - honouring an
			// explicit 'unknown' - and fall back to deriving from the text.
			// Deterministic, channel neutral, fail-open to 'unknown'.
			const signalClass = classifySignal(text, { explicit: effectiveSignalClass });
			const truncation = validatedAlert.truncated === true
				? {
					truncated: true,
					originalLength: validatedAlert.originalLength,
					deliveredLength: validatedAlert.deliveredLength,
				}
				: {};
			if (truncation.truncated) {
				console.warn('[Alert] Alert text truncated before processing', truncation);
			}
			const source = (typeof body === 'object' && body && typeof body.source === 'string' && body.source.trim())
				? body.source.trim()
				: 'webhook-alert';
			alert = { text, source, signalClass, ...truncation };
			// `alert.text` is immutable from here on, so the TradingView signal is parsed
			// once and shared by the repeat-suppression, persistence, and outcome-eligibility
			// paths below.
			const parsedSignal = parseTradingViewSignal(alert.text);

			if (alertModeration.isEnabled()) {
				alertModeration.refreshConfig();
				const verdict = alertModeration.evaluate(alert.text, { requestId });
				if (verdict && verdict.rejected === true) {
					console.warn(`[Alert] Moderation rejected payload (reason=${verdict.reason}, requestId=${requestId})`);
					return res.json({
						success: true,
						delivered: false,
						reason: 'moderation_rejected',
						moderationReason: verdict.reason,
						requestId,
					});
				}
			}

			// Fail-fast channel availability check (GH-854): when the caller
			// explicitly requests channels, validate they are enabled and
			// configured BEFORE spending Gemini/TradingView MCP enrichment
			// budget. The notification manager is initialized eagerly here so
			// the availability check can resolve the enabled-channel set;
			// delivery still uses the same singleton.
			if (routing.channels) {
				const bot = resolveBot(botOrGetter);
				notificationManager = bootstrapGetInitialized() || await bootstrapGetOrInitialize(bot);
				assertChannelsAvailable(notificationManager, routing);
			}

			const tokenUsage = new TokenUsageTracker('grounding');
			const enriched = await processEnrichment(alert, { tokenUsage, useTradingViewData, parentSpan: requestSpan, parsedSignal });

			const tokenUsageJSON = tokenUsage.toJSON();
			tokenUsageJSON.formattedSummary = tokenUsage.formatSummary();

			if (dryRun) {
				console.debug('[Alert] Dry-run mode: skipping delivery and Firestore persistence');
				return res.json({
					success: true,
					dryRun: true,
					...truncation,
					enriched,
					payload: {
						text: alert.text,
						enrichedData: alert.enriched || null,
						signalClass: alert.signalClass,
					},
					tokenUsage: tokenUsageJSON,
					requestId,
				});
			}

			// Defer notification service initialization until we know we need delivery.
			const bot = resolveBot(botOrGetter);
			notificationManager = notificationManager || bootstrapGetInitialized() || await bootstrapGetOrInitialize(bot);
			validateNotificationRouting(notificationManager, routing);
			const requestedChannels = getRequestedChannels(notificationManager, routing, alert.text);

			// Opt-in repeat suppression: same (exchange, symbol, timeframe, side)
			// inside its cooldown window skips channel delivery but is still
			// persisted with a marker below. Storage errors fail open. The
			// reservation is made before delivery so overlapping requests cannot
			// both send; failed channels remain retryable.
			let suppressedRepeat = false;
			let suppressionReason = null;
			let reservation = null;
			let crossReservation = null;
			let deliveryRouting = routing;
			let repeatCooldownOptions;
			const crossTimeframeSuppressionEnabled = crossTimeframeCooldown.isEnabled();
			const anyRepeatSuppressionEnabled = signalRepeatCooldown.isEnabled() || crossTimeframeSuppressionEnabled;
			// Both cooldown gates key per (channel, destination), so a reservation for
			// one chat/thread/webhook never suppresses a signal routed elsewhere.
			const cooldownChannelNames = anyRepeatSuppressionEnabled
				? (requestedChannels.length > 0 ? requestedChannels : ['telegram', 'whatsapp', 'discord'])
				: [];
			const cooldownChannels = cooldownChannelNames.map((channel) => getCooldownChannelIdentity(channel, routing));
			// Unsupported timeframes normalize to the default timeframe, so
			// they must never enter either cooldown store: a raw token like
			// "3M" collapses to "1h" and stays unsuppressed, while "4H"
			// legitimately maps to the 4h bar via the TIMEFRAME_MAP.
			const hasUsableTimeframe = Boolean(
				parsedSignal
			&& parsedSignal.rawTimeframe
			&& Object.prototype.hasOwnProperty.call(TIMEFRAME_MAP, parsedSignal.rawTimeframe)
			&& TIMEFRAME_MAP[parsedSignal.rawTimeframe] === parsedSignal.timeframe,
			);
			if (signalRepeatCooldown.isEnabled()) {
				if (parsedSignal && hasUsableTimeframe) {
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
							deliveryRouting = narrowDeliveryRouting(routing, verdict.channels.map(getChannelName));
						}
					}
				}
			}

			// Issue #1103: same symbol + same direction on two timeframes seconds apart
			// (BINANCE:BTCUSDT(D) VENTA then BINANCE:BTCUSDT(240) VENTA) is one trading
			// idea; CB-230 cannot catch it because its key includes timeframe. Runs after
			// the CB-230 gate so an already-suppressed request is not double-booked.
			if (crossTimeframeSuppressionEnabled && !suppressedRepeat && parsedSignal && hasUsableTimeframe) {
				const crossVerdict = crossTimeframeCooldown.reserve(parsedSignal, cooldownChannels);
				if (crossVerdict.suppressed) {
					suppressedRepeat = true;
					suppressionReason = crossVerdict.reason;
					crossTimeframeCooldown.recordSuppression();
					console.log(
						`[Alert] Cross-timeframe duplicate suppressed for ${crossVerdict.key} `
					+ `(${crossVerdict.suppressedTimeframe} collapsed against ${crossVerdict.conflictingTimeframe} inside the window, `
					+ `${Math.round(crossVerdict.elapsedMs / 1000)}s elapsed)`,
					);
				} else if (crossVerdict.key) {
					crossReservation = crossVerdict;
					const availableChannelNames = [...new Set(crossVerdict.channels.map(getChannelName))];
					const effectiveChannelNames = deliveryRouting.channels && deliveryRouting.channels.length > 0
						? deliveryRouting.channels
						: requestedChannels;
					if (availableChannelNames.length < effectiveChannelNames.length) {
						deliveryRouting = narrowDeliveryRouting(deliveryRouting, availableChannelNames);
					}
				}
			}

			let results;
			// Inline keyboard markup is opt-in: only when alert storage is
			// enabled (so /api/alerts/:alertId/replay can resolve the alert
			// after the user clicks "Replay") and the Telegram channel is
			// actually selected for delivery. The alertId is generated
			// synchronously so it can be embedded in the markup callback_data
			// before the message is sent.
			let inlineAlertId = null;
			let inlineReplyMarkup = null;
			try {
				const storageEnabled = typeof alertStorageService.isEnabled === 'function'
					&& alertStorageService.isEnabled();
				const telegramEnabled = process.env.ENABLE_TELEGRAM_BOT === 'true';
				const telegramRequested = requestedChannels.length === 0
					|| requestedChannels.includes('telegram');
				if (storageEnabled && telegramEnabled && telegramRequested && !suppressedRepeat) {
					inlineAlertId = uuidv4();
					const replyMarkup = buildReplyMarkup({
						alertId: inlineAlertId,
						hasEnrichment: Boolean(alert.enriched),
						includeReplay: true,
					});
					if (replyMarkup) {
						inlineReplyMarkup = replyMarkup;
					}
				}
			} catch (error) {
				console.warn('[Alert] Failed to attach inline keyboard markup:', error.message);
				inlineAlertId = null;
			}
			let burstAggregateId;
			let burstSignalCount;
			let aggregated = false;
			try {
				if (suppressedRepeat) {
					results = [];
				} else {
					// A held alert dispatches after its request span ended, so the
					// deferred send must not claim that span as its parent (it would
					// report a duration longer than the span that contains it).
					const willBuffer = burstAggregator.isEnabled()
						&& buildBurstGroupKey({ parsedSignal, routing: deliveryRouting }) !== null;
					const dispatchOutcome = await burstAggregator.dispatch({
						parsedSignal,
						routing: deliveryRouting,
						deliver: async (overrides = {}) => sendWithNotificationRouting(
							notificationManager,
							overrides.alert || alert,
							deliveryRouting,
							{
								parentSpan: willBuffer ? undefined : requestSpan,
								// One synthetic message cannot satisfy N per-signal cooldown
								// reservations; each member finalizes its own reservation
								// against the shared delivery results instead.
								repeatCooldown: overrides.dropRepeatCooldown ? undefined : repeatCooldownOptions,
							},
						),
					});
					results = dispatchOutcome.results;
					aggregated = dispatchOutcome.aggregated === true;
					burstAggregateId = dispatchOutcome.burstAggregateId;
					burstSignalCount = dispatchOutcome.burstSignalCount;
				}
			} catch (error) {
				if (reservation) {
					signalRepeatCooldown.finalize(reservation.key, reservation.channels, [], [], reservation.generation);
				}
				if (crossReservation) {
					crossTimeframeCooldown.release(crossReservation.key, crossReservation.reservedAt);
				}
				throw error;
			}
			const deliveredChannels = suppressedRepeat ? [] : getDeliveredChannels(results);
			const zeroChannelRedriveExpected = requestedChannels.length === 0
			&& !notificationManager.isIntentionalApiOnly();
			const keepFailedForRedrive = notificationRedriveService.isEnabled()
			&& notificationRedriveService.getWorkerRole() !== 'disabled'
			&& (notificationRedriveService.getWorkerRole() === 'web' || notificationRedriveService.hasDurableStore())
			&& (results.some((result) => result && !result.success) || zeroChannelRedriveExpected);
			// A reservation that notified nobody must not swallow the next real signal
			// on another timeframe, unless the redrive queue owns the retry.
			if (crossReservation && !keepFailedForRedrive) {
				const undeliveredChannels = crossReservation.channels.filter((channel) => (
					!deliveredChannels.includes(getChannelName(channel))
				));
				if (undeliveredChannels.length > 0) {
					crossTimeframeCooldown.release(crossReservation.key, crossReservation.reservedAt, undeliveredChannels);
				}
			}
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
				const deliveredReservationChannels = reservation.channels.filter((channel) => (
					deliveredChannels.includes(getChannelName(channel))
				));
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
					// A pending dead letter on this repeat key is stale on every identity this
					// delivery just satisfied, not only the synthetic default one: a
					// redrive keyed to the very chat that just received the alert would
					// otherwise fire after its backoff and deliver a duplicate (#918).
					const deliveredCooldownChannels = [...new Set([
						...deliveredReservationChannels,
						...defaultDestinationChannels,
					])];
					if (deliveredCooldownChannels.length > 0) {
						const cancellation = notificationRedriveService.cancelPendingRepeatCooldowns(
							reservation.key,
							deliveredCooldownChannels,
						);
						await Promise.race([
							cancellation,
							new Promise((resolve) => setTimeout(resolve, 500)),
						]);
						trackBackgroundTask(cancellation).catch(() => {});
					}
					const oppositeKey = oppositeKeyOf(reservation.key);
					if (oppositeKey) {
						const cancellation = notificationRedriveService.cancelPendingRepeatCooldowns(oppositeKey, deliveredCooldownChannels);
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
				...truncation,
				enriched,
				suppressedRepeat: suppressedRepeat || undefined,
				suppressionReason: suppressionReason || undefined,
				aggregated: aggregated || undefined,
				burstAggregateId,
				burstSignalCount,
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
			const saveAlertPromise = alertStorageService.saveAlert({
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
				suppressionReason,
				signalClass: alert.signalClass,
				source: body.source || 'webhook-alert',
				telegramChatId: routing.telegramChatId,
				telegramThreadId: routing.telegramThreadId,
				whatsappChatId: routing.whatsappChatId,
				discordWebhookUrl: routing.discordWebhookUrl,
				alertId: inlineAlertId || undefined,
				side: parsedSignal?.side || null,
				burstAggregateId,
				burstSignalCount,
			});
			const postPersistenceTask = Promise.resolve(saveAlertPromise)
				.then((storedAlertId) => {
					if (!storedAlertId) return null;
					return attachInlineKeyboardAfterPersistence({
						manager: notificationManager,
						results,
						routing,
						replyMarkup: inlineReplyMarkup,
						aggregated,
					});
				})
				.catch(() => {}); // errors already logged inside AlertStorageService
			trackBackgroundTask(postPersistenceTask);

			if (signalOutcomeService.isEnabled() && !suppressedRepeat) {
				if (parsedSignal) {
					const mcpPrice = (alert.enriched && typeof alert.enriched.current_price === 'number' && Number.isFinite(alert.enriched.current_price) && alert.enriched.current_price > 0)
						? alert.enriched.current_price
						: (alert.enriched && alert.enriched.price_data && typeof alert.enriched.price_data.current_price === 'number' && Number.isFinite(alert.enriched.price_data.current_price) && alert.enriched.price_data.current_price > 0)
							? alert.enriched.price_data.current_price
							: null;

					const riskMetadata = alert.enriched && typeof alert.enriched === 'object' ? {
						invalidation_level: alert.enriched.invalidation_level !== undefined ? alert.enriched.invalidation_level : alert.enriched.invalidationLevel,
						target_level: alert.enriched.target_level !== undefined ? alert.enriched.target_level : alert.enriched.targetLevel,
						setup_type: alert.enriched.setup_type !== undefined ? alert.enriched.setup_type : alert.enriched.setupType,
						risk_reward_ratio: alert.enriched.risk_reward_ratio !== undefined ? alert.enriched.risk_reward_ratio : alert.enriched.riskRewardRatio,
					} : null;

					const stopLevel = riskMetadata && typeof riskMetadata.invalidation_level === 'number' && Number.isFinite(riskMetadata.invalidation_level) && riskMetadata.invalidation_level > 0
						? riskMetadata.invalidation_level
						: (riskMetadata && typeof riskMetadata.invalidation_level === 'string' && Number.isFinite(Number(riskMetadata.invalidation_level)) && Number(riskMetadata.invalidation_level) > 0
							? Number(riskMetadata.invalidation_level)
							: null);

					const targetLevel = riskMetadata && typeof riskMetadata.target_level === 'number' && Number.isFinite(riskMetadata.target_level) && riskMetadata.target_level > 0
						? riskMetadata.target_level
						: (riskMetadata && typeof riskMetadata.target_level === 'string' && Number.isFinite(Number(riskMetadata.target_level)) && Number(riskMetadata.target_level) > 0
							? Number(riskMetadata.target_level)
							: null);

					const setupType = (riskMetadata && typeof riskMetadata.setup_type === 'string' && riskMetadata.setup_type.trim())
						? riskMetadata.setup_type.trim()
						: 'tradingview-enrichment';

					const riskRewardRatio = riskMetadata ? riskMetadata.risk_reward_ratio : null;

					const priceSource = mcpPrice !== null
						? resolveSignalOutcomePriceSource(alert.enriched, parsedSignal)
						: null;

					signalOutcomeService.recordSignal({
						requestId,
						source: 'webhook-alert',
						symbol: parsedSignal.symbol,
						exchange: parsedSignal.exchange || 'BINANCE',
						timeframe: parsedSignal.timeframe,
						setupType,
						score: alert.enriched ? alert.enriched.sentiment_score : null,
						confidenceScore: (typeof alert.enriched?.confidence === 'number' && Number.isFinite(alert.enriched.confidence) && alert.enriched.confidence >= 0 && alert.enriched.confidence <= 1)
							? alert.enriched.confidence
							: (typeof alert.enriched?.sentiment_score === 'number' && Number.isFinite(alert.enriched.sentiment_score) && Math.abs(alert.enriched.sentiment_score) <= 1
								? Math.abs(alert.enriched.sentiment_score)
								: null),
						side: parsedSignal.side,
						price: mcpPrice,
						stop: stopLevel,
						target: targetLevel,
						invalidationLevel: stopLevel,
						targetLevel,
						riskRewardRatio,
						priceSource,
						sources: alert.enriched && Array.isArray(alert.enriched.sources) ? alert.enriched.sources : [],
						tokenUsage: tokenUsageJSON,
						processingTimeMs: Date.now() - startTime,
					}).catch(() => {});
				}
			}
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return sendError(res, error.statusCode, {
					error: error.message,
					code: STANDARD_ERROR_CODES.INVALID_REQUEST,
					requestId,
					details: error.details,
				});
			}

			const status = (error.response && error.response.error_code) || error.statusCode || 500;
			const isClientError = status >= 400 && status < 500;

			if (!isClientError) {
				console.error('[Alert] Request failed:', error.message);

				// Capture runtime error to Sentry (T012)
				sentryService.captureRuntimeError({
					channel: 'http-alert',
					error,
					http: {
						endpoint: '/api/webhook/alert',
						method: 'POST',
						statusCode: status,
						requestId,
					},
					alert: {
						textLength: alertText ? alertText.length : 0,
						hasEnrichment: !!(alert && alert.enriched),
						enrichedSource: alert && alert.enriched && alert.enriched.extraText && alert.enriched.extraText.includes('tradingview-mcp') ? 'tradingview-mcp' : (alert && alert.enriched ? 'gemini-grounding' : undefined),
						truncated: Boolean(alert && alert.truncated),
					},
				});
			}

			const upstreamEnvelope = error.response && typeof error.response === 'object'
				? error.response
				: null;
			const envelope = buildErrorEnvelope({
				error: (upstreamEnvelope && upstreamEnvelope.error) || error.message || 'Internal server error',
				code: (upstreamEnvelope && upstreamEnvelope.code) || (status < 500 ? STANDARD_ERROR_CODES.INVALID_REQUEST : STANDARD_ERROR_CODES.INTERNAL_ERROR),
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
	__resetNotificationManagerForTesting: resetNotificationManagerForTesting,
	getNotificationManager,
	getOrInitializeNotificationManager,
	getNotificationManagerBootstrapStatus,
	resetNotificationManagerForTesting,
	getCooldownChannelIdentity,
	processEnrichment,
	attachInlineKeyboardAfterPersistence,
	INLINE_KEYBOARD_ATTACH_TIMEOUT_MS,
};
