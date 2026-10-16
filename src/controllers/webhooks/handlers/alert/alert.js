require('dotenv').config();
const crypto = require('crypto');
const { enrichAlert, ENRICHMENT_PROVIDER_OUTCOMES } = require('./grounding');
const { validateAlert } = require('../../../../lib/validation');
const { v4: uuidv4 } = require('uuid');
const signalOutcomeService = require('../../../../services/storage/SignalOutcomeService');
const MarkdownV2Formatter = require('../../../../services/notification/formatters/markdownV2Formatter');
const sentryService = require('../../../../services/monitoring/SentryService');
const { TokenUsageTracker, tokenCostBudgetService } = require('../../../../lib/tokenUsage');
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
	resolveSymbolRouteDispatches,
} = require('../../../../services/notification/requestRouting');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { resolveRequestId } = require('../../../../lib/requestDeadline');
const { resolveDryRun } = require('../../../../lib/dryRunRequest');
const { parseTradingViewSignal, TIMEFRAME_MAP } = require('../../../../services/tradingview/parseTradingViewSignal');
const { signalRepeatCooldown, oppositeKeyOf, buildSignalKey } = require('../../../../services/alerts/signalRepeatCooldown');
const {
	buildMinAlertContext,
	applyMinAlertContext,
	buildFooterPriceSourceLine,
} = require('../../../../services/alerts/minAlertContext');
const { outcomeAnnotationService, renderAnnotationLine } = require('../../../../services/alerts/outcomeAnnotationService');
const { crossTimeframeCooldown } = require('../../../../services/alerts/crossTimeframeCooldown');
const { burstAggregator, buildBurstGroupKey } = require('../../../../services/alerts/burstAggregator');
const { alertModeration } = require('../../../../services/alerts/alertModeration');
const { classifySignal } = require('../../../../services/alerts/signalClassifier');
const { notificationRedriveService } = require('../../../../services/notification/NotificationRedriveService');
const { isPreviewEnvironment } = require('../../../../lib/deploymentEnvironment');
const { alertSubscriberDeliveryService } = require('../../../../services/subscribers/AlertSubscriberDeliveryService');
const { buildReplyMarkup } = require('../../../../services/alerts/telegramAlertKeyboard');
const { routeAlertToOrder, isEnabled: isAutoTradeEnabled } = require('../../../../services/trading/AlertSignalRouter');
const {
	buildErrorEnvelope,
	sendError,
	STANDARD_ERROR_CODES,
} = require('../../../../lib/errorEnvelope');
const {
	isEquityExchange,
	classifySession,
	isEquitySessionTagEnabled,
} = require('../../../../services/storage/EquitySessionService');

const ENRICHMENT_PROVIDER_STATUSES = new Set(['full', 'partial', 'failed']);

function normalizeProviderOutcomes(outcomes) {
	if (!outcomes || typeof outcomes !== 'object') return null;
	const normalized = {};
	for (const provider of ['gemini', 'tradingViewMcp']) {
		const status = outcomes[provider] && outcomes[provider].status;
		if (ENRICHMENT_PROVIDER_STATUSES.has(status)) normalized[provider] = { status };
	}
	return Object.keys(normalized).length > 0 ? normalized : null;
}

function applyProviderOutcomes(enrichmentAudit, outcomes) {
	const providers = normalizeProviderOutcomes(outcomes);
	if (!providers) return;

	enrichmentAudit.providers = providers;
	const statuses = Object.values(providers).map((provider) => provider.status);
	const hasFailure = statuses.includes('failed');
	const hasSuccess = statuses.some((status) => ['full', 'partial'].includes(status));
	if (hasFailure && hasSuccess) {
		enrichmentAudit.status = 'partial';
		enrichmentAudit.fallbackUsed = true;
	} else if (hasFailure) {
		enrichmentAudit.status = 'failed';
		enrichmentAudit.fallbackUsed = true;
	}
}

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
	let isGeminiEnabled = runtimeConfig.ENABLE_GEMINI_GROUNDING === true;
	try {
		if (tokenCostBudgetService.isBudgetExceeded()) isGeminiEnabled = false;
	} catch (_) {
		// Budget telemetry fails open; the provider enablement remains authoritative.
	}
	const isTradingViewMcpEnabled = runtimeConfig.ENABLE_TRADINGVIEW_MCP_ENRICHMENT && useTradingViewData;
	const isTradingViewMcpAttemptEligible = isTradingViewMcpEnabled && hasTradingViewSignal;
	const enrichmentAttempted = isGeminiEnabled || isTradingViewMcpAttemptEligible;
	const enrichmentAudit = {
		attempted: Boolean(enrichmentAttempted),
		provider: isGeminiEnabled && isTradingViewMcpAttemptEligible
			? 'gemini-grounding+tradingview-mcp'
			: (isTradingViewMcpAttemptEligible ? 'tradingview-mcp' : (isGeminiEnabled ? 'gemini-grounding' : null)),
		status: enrichmentAttempted ? 'pending' : (isTradingViewMcpEnabled ? 'not_applicable' : 'not_attempted'),
		fallbackUsed: false,
	};
	alert.decisionEnrichment = enrichmentAudit;

	let enriched = false;

	if (isGeminiEnabled || isTradingViewMcpAttemptEligible) {
		const enrichmentSpan = sentryService.startInactiveSpan({
			name: 'alerts.enrichment',
			op: 'alert.enrich',
			onlyIfParent: true,
			parentSpan,
			attributes: {
				'alert.length': alert.text.length,
				'alert.use_tradingview_data': useTradingViewData,
				'feature.gemini_grounding': isGeminiEnabled,
				'feature.tradingview_mcp_enrichment': isTradingViewMcpAttemptEligible,
			},
		});

		try {
			console.debug('Starting alert enrichment process');
			const enrichedAlert = await enrichAlert({ text: alert.text }, {
				tokenUsage,
				useTradingViewData: isTradingViewMcpAttemptEligible,
				parsedSignal: parsed,
			});
			if (enrichedAlert && typeof enrichedAlert === 'object') {
				if (alert.session && !enrichedAlert.session) {
					enrichedAlert.session = alert.session;
				}
				enrichedAlert.tokenUsage = tokenUsage && typeof tokenUsage.toJSON === 'function' ? tokenUsage.toJSON() : null;
				enriched = true;
				alert.enriched = enrichedAlert;
				if (isTradingViewMcpAttemptEligible) {
					const tradingViewEnrichmentStatus = enrichedAlert.tradingViewEnrichmentStatus
						|| (enrichedAlert.tradingViewEnrichmentApplied === true
							? 'full'
							: (hasTradingViewSignal ? 'failed' : 'not_applicable'));
					enrichedAlert.tradingViewEnrichmentStatus = tradingViewEnrichmentStatus;
					enrichedAlert.tradingViewEnrichmentApplied = ['full', 'partial'].includes(tradingViewEnrichmentStatus);
					alert.tradingViewEnrichmentStatus = tradingViewEnrichmentStatus;
				}
				enrichmentAudit.status = isTradingViewMcpAttemptEligible
					? (alert.tradingViewEnrichmentStatus || 'success')
					: (isGeminiEnabled ? 'success' : (alert.tradingViewEnrichmentStatus || 'success'));
				enrichmentAudit.fallbackUsed = enrichmentAudit.status === 'failed';
				applyProviderOutcomes(enrichmentAudit, enrichedAlert[ENRICHMENT_PROVIDER_OUTCOMES]);
				console.debug('[Alert] Enrichment completed, sources:', (enrichedAlert.sources && enrichedAlert.sources.length) || 0);
			} else {
				if (isTradingViewMcpAttemptEligible) {
					alert.tradingViewEnrichmentStatus = hasTradingViewSignal ? 'failed' : 'not_applicable';
				}
				enrichmentAudit.status = enrichmentAudit.attempted ? 'failed' : (alert.tradingViewEnrichmentStatus || 'not_attempted');
				enrichmentAudit.fallbackUsed = enrichmentAudit.attempted;
				console.debug('[Alert] Enrichment skipped: alert text did not match enabled providers');
			}
		} catch (error) {
			if (isTradingViewMcpAttemptEligible) {
				alert.tradingViewEnrichmentStatus = hasTradingViewSignal ? 'failed' : 'not_applicable';
			}
			enrichmentAudit.status = enrichmentAudit.attempted ? 'failed' : (alert.tradingViewEnrichmentStatus || 'not_attempted');
			enrichmentAudit.fallbackUsed = enrichmentAudit.attempted;
			applyProviderOutcomes(enrichmentAudit, error && error[ENRICHMENT_PROVIDER_OUTCOMES]);
			console.warn('[Alert] Enrichment failed, using original text:', error.message);
		} finally {
			sentryService.endSpan(enrichmentSpan);
		}
	}

	// GH-581 / CB-269: minimum viable alert context — synthesize a degraded-but-honest
	// decision package (entry reference + provisional invalidation/target) when both
	// the configured enrichment pipeline is unavailable or returned an incomplete
	// payload. Fail-open: any failure here is logged and never blocks delivery.
	try {
		const ctx = await buildMinAlertContext({
			text: alert.text,
			enriched: alert.enriched || null,
			runtimeConfig,
		});
		if (ctx && ctx.applied) {
			alert.minAlertContext = ctx;
			alert.enriched = applyMinAlertContext(alert.enriched || null, ctx);
			enriched = enriched || true;
			const footerLine = buildFooterPriceSourceLine(ctx, runtimeConfig);
			if (footerLine && alert.enriched) {
				const existingExtra = typeof alert.enriched.extraText === 'string' ? alert.enriched.extraText : '';
				const merged = existingExtra.includes(footerLine)
					? existingExtra
					: (existingExtra ? existingExtra + '\n' + footerLine : footerLine);
				alert.enriched.extraText = merged;
			}
		}
	} catch (error) {
		console.warn('[Alert] Min alert context synthesis failed, continuing with original text:', error.message);
	}

	return enriched;
}

/**
 * Auto-trade is opt-in twice: the operator sets ENABLE_AUTO_TRADE, and the
 * caller must additionally ask for it per request. Auto-trade never runs in a
 * preview deployment, where a "real" order would be meaningless anyway.
 */
function resolveAutoTradeRequest(req) {
	if (isPreviewEnvironment()) return false;
	if (!isAutoTradeEnabled()) return false;
	const queryFlag = req.query && (req.query.autoTrade === 'true' || req.query.autoTrade === true);
	const bodyFlag = req.body && typeof req.body === 'object'
		&& req.body.autoTrade === true;
	return Boolean(queryFlag || bodyFlag);
}

/**
 * Runs the alert-to-order bridge and returns a safe, non-sensitive summary for
 * the webhook response. Never throws, so trading failures cannot turn a
 * delivered alert into an error response. Live submission is tracked after a
 * durable reservation; dry-run validation completes before the response.
 */
async function dispatchAutoTrade({ alert, parsedSignal, requestId, signalId }) {
	try {
		const outcome = await routeAlertToOrder({
			alert,
			parsed: parsedSignal,
			requestId,
			signalId,
		});
		console.info('[Alert] auto-trade outcome', {
			requestId,
			executed: Boolean(outcome && outcome.executed),
			reason: outcome && outcome.reason,
		});
		return {
			executed: Boolean(outcome && outcome.executed),
			...(outcome && outcome.reason ? { reason: outcome.reason } : {}),
			...(outcome && outcome.symbol ? { symbol: outcome.symbol } : {}),
			...(outcome && outcome.dryRun !== undefined ? { dryRun: outcome.dryRun } : {}),
			...(outcome && outcome.orderId ? { orderId: outcome.orderId } : {}),
		};
	} catch (error) {
		console.warn('[Alert] auto-trade bridge failed (fail-open)', {
			requestId,
			message: error && error.message,
		});
		return { executed: false, reason: 'AUTO_TRADE_BRIDGE_ERROR' };
	}
}

function buildDecisionAudit({ requestId, parsedSignal, enrichment, gates, requestedChannels, requestedChannelMode, deliveredChannels, errors } = {}) {
	if (getRuntimeConfig().ENABLE_ALERT_DECISION_AUDIT !== true) return null;
	const decision = {
		parsed: parsedSignal
			? {
				ok: true,
				exchange: parsedSignal.exchange || null,
				symbol: parsedSignal.symbol || null,
				side: parsedSignal.side || null,
				rawTimeframe: parsedSignal.rawTimeframe || null,
				timeframe: parsedSignal.timeframe || null,
			}
			: { ok: false },
	};
	if (enrichment && typeof enrichment === 'object') {
		const providers = normalizeProviderOutcomes(enrichment.providers);
		decision.enrichment = {
			attempted: Boolean(enrichment.attempted),
			provider: typeof enrichment.provider === 'string' ? enrichment.provider : null,
			status: typeof enrichment.status === 'string' ? enrichment.status : null,
			fallbackUsed: Boolean(enrichment.fallbackUsed),
			...(providers ? { providers } : {}),
		};
	}
	if (Array.isArray(gates) && gates.length > 0) {
		decision.gates = gates.map((gate) => ({
			name: gate.name,
			decision: gate.decision,
			...(gate.reason ? { reason: gate.reason } : {}),
			...(gate.evidence ? { evidence: gate.evidence } : {}),
		}));
	}
	if (Array.isArray(requestedChannels) || Array.isArray(deliveredChannels)) {
		decision.dispatch = {
			requestedChannels: Array.isArray(requestedChannels) ? requestedChannels.slice(0, 16) : [],
			...(requestedChannelMode ? { requestedChannelMode } : {}),
			sentTo: Array.isArray(deliveredChannels) ? deliveredChannels.slice(0, 16) : [],
		};
	}
	if (Array.isArray(errors) && errors.length > 0) {
		decision.errors = errors.slice(0, 16).map((entry) => ({
			stage: typeof entry.stage === 'string' ? entry.stage : 'unknown',
			code: typeof entry.code === 'string' ? entry.code : null,
			message: typeof entry.message === 'string' ? entry.message : null,
		}));
	}
	if (typeof requestId === 'string' && requestId) decision.requestId = requestId;
	return decision;
}

function getRequestedChannelMode(routing = {}, text) {
	if (resolveSymbolRouteDispatches(text, routing.symbolRoutes, routing)) return 'symbol_route';
	return Array.isArray(routing.channels) ? 'explicit' : 'broadcast';
}

function buildCooldownGateAudit(name, requestedChannels, allowedChannels) {
	const requested = [...new Set((requestedChannels || []).filter((channel) => typeof channel === 'string'))];
	const allowed = new Set((allowedChannels || []).filter((channel) => typeof channel === 'string'));
	const suppressed = requested.filter((channel) => !allowed.has(channel));
	return {
		name,
		decision: suppressed.length > 0 ? 'suppress' : 'allow',
		...(suppressed.length > 0 ? { reason: 'channel_cooldown' } : {}),
		evidence: {
			requestedChannels: requested.join(','),
			allowedChannels: requested.filter((channel) => allowed.has(channel)).join(','),
			suppressedChannels: suppressed.join(','),
		},
	};
}

async function processOutcomeAnnotation(alert, options = {}) {
	if (!outcomeAnnotationService.isEnabled()) {
		return null;
	}
	if (!alert || typeof alert.text !== 'string') {
		return null;
	}

	const parsed = parseTradingViewSignal(alert.text);
	if (!parsed || !parsed.symbol || !parsed.side) {
		return null;
	}

	const setupType = alert.enriched && typeof alert.enriched.setup_type === 'string'
		? alert.enriched.setup_type
		: null;

	const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : undefined;
	const annotation = await outcomeAnnotationService.annotate({
		exchange: parsed.exchange || null,
		symbol: parsed.symbol,
		side: parsed.side,
		setupType,
	}, timeoutMs !== undefined ? { timeoutMs } : undefined);

	if (annotation && annotation.summary) {
		const existingExtra = typeof alert.extraText === 'string' && alert.extraText.length > 0
			? alert.extraText
			: '';
		alert.extraText = existingExtra
			? `${existingExtra}\n${annotation.summary}`
			: annotation.summary;
		if (alert.enriched && typeof alert.enriched === 'object') {
			const existingEnrichedExtra = typeof alert.enriched.extraText === 'string' && alert.enriched.extraText.length > 0
				? alert.enriched.extraText
				: '';
			alert.enriched.extraText = existingEnrichedExtra
				? `${existingEnrichedExtra}\n${annotation.summary}`
				: annotation.summary;
			alert.enriched.outcomeAnnotation = {
				exchange: annotation.exchange,
				symbol: annotation.symbol,
				side: annotation.side,
				setupType: annotation.setupType,
				windowLabel: annotation.windowLabel,
				sampleSize: annotation.sampleSize,
				hitRatePercent: annotation.hitRatePercent,
				expectancyR: annotation.expectancyR,
				totalWins: annotation.totalWins,
				totalLosses: annotation.totalLosses,
				summary: annotation.summary,
			};
		}
		alert.outcomeAnnotation = {
			...annotation,
		};
	}

	return annotation;
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
		if (body && typeof body === 'object'
			&& Object.prototype.hasOwnProperty.call(body, 'autoTrade')
			&& typeof body.autoTrade !== 'boolean') {
			return res.status(400).json({ success: false, error: 'INVALID_AUTO_TRADE_FLAG' });
		}
		const useTradingViewData = req.query && (req.query.useTradingViewData === true || req.query.useTradingViewData === 'true');
		const dryRun = resolveDryRun(req);
		const autoTradeRequested = resolveAutoTradeRequest(req);

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
			const parsedSignal = parseTradingViewSignal(text);
			const session = parsedSignal?.session
				|| (parsedSignal?.exchange && isEquityExchange(parsedSignal.exchange) ? classifySession({ exchange: parsedSignal.exchange, symbol: parsedSignal.symbol }) : undefined);
			alert = { text, source, signalClass, ...(session ? { session } : {}), ...truncation };

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

			const outcomeAnnotation = await processOutcomeAnnotation(alert);

			if (dryRun) {
				console.debug('[Alert] Dry-run mode: skipping delivery; decision persistence is opt-in');
				const dryRunNotificationManager = notificationManager || bootstrapGetInitialized();
				const dryRunRequestedChannels = getRequestedChannels(dryRunNotificationManager, routing, alert.text);
				const requestedChannelMode = getRequestedChannelMode(routing, alert.text);
				const dryRunDecision = buildDecisionAudit({
					requestId,
					parsedSignal,
					enrichment: alert.decisionEnrichment,
					gates: [{ name: 'dryRun', decision: 'skip', reason: 'dry_run' }],
					requestedChannels: dryRunRequestedChannels,
					requestedChannelMode,
					deliveredChannels: [],
				});
				res.json({
					success: true,
					dryRun: true,
					...truncation,
					enriched,
					outcomeAnnotation: outcomeAnnotation
						? {
							summary: outcomeAnnotation.summary,
							exchange: outcomeAnnotation.exchange,
							symbol: outcomeAnnotation.symbol,
							side: outcomeAnnotation.side,
							setupType: outcomeAnnotation.setupType,
							windowLabel: outcomeAnnotation.windowLabel,
							sampleSize: outcomeAnnotation.sampleSize,
							hitRatePercent: outcomeAnnotation.hitRatePercent,
							expectancyR: outcomeAnnotation.expectancyR,
						}
						: null,
					payload: {
						text: alert.text,
						enrichedData: alert.enriched || null,
						signalClass: alert.signalClass,
					},
					tokenUsage: tokenUsageJSON,
					requestId,
				});
				if (dryRunDecision && alertStorageService.isEnabled()) {
					const dryRunPersistence = alertStorageService.saveAlert({
						requestId,
						text: alert.text,
						enriched,
						enrichmentData: alert.enriched || null,
						tokenUsage: tokenUsageJSON,
						deliveryResults: [],
						channels: dryRunRequestedChannels,
						useTradingViewData,
						processingTimeMs: Math.max(0, Date.now() - startTime),
						tradingViewEnrichmentApplied: Boolean(alert.enriched && alert.enriched.tradingViewEnrichmentApplied === true),
						tradingViewEnrichmentStatus: alert.tradingViewEnrichmentStatus,
						source: alert.source,
						decision: dryRunDecision,
					});
					trackBackgroundTask(Promise.resolve(dryRunPersistence).catch(() => {}));
				}
				return;
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
			const cooldownGateAudits = [];
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
						cooldownGateAudits.push(buildCooldownGateAudit('same-signal-cooldown', cooldownChannelNames, []));
						signalRepeatCooldown.recordSuppression();
						console.log(
							`[Alert] Repeat suppressed for ${verdict.key} (${Math.round(verdict.elapsedMs / 1000)}s elapsed, retry in ${Math.round(verdict.retryInMs / 1000)}s)`,
						);
					} else if (verdict.key) {
						const allowedChannelNames = [...new Set((verdict.channels || []).map(getChannelName))];
						cooldownGateAudits.push(buildCooldownGateAudit(
							'same-signal-cooldown',
							cooldownChannelNames,
							allowedChannelNames,
						));
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
					cooldownGateAudits.push(buildCooldownGateAudit('cross-timeframe-cooldown', cooldownChannelNames, []));
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
						: cooldownChannelNames;
					cooldownGateAudits.push(buildCooldownGateAudit(
						'cross-timeframe-cooldown',
						effectiveChannelNames,
						availableChannelNames,
					));
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
						alert,
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
			const decisionAudit = buildDecisionAudit({
				requestId,
				parsedSignal,
				enrichment: alert.decisionEnrichment,
				gates: cooldownGateAudits,
				requestedChannels,
				requestedChannelMode: getRequestedChannelMode(routing, alert.text),
				deliveredChannels,
			});
			const processingTimeMs = Math.max(0, Date.now() - startTime);

			// Live Binance submission is tracked after the durable reservation.
			let autoTrade = null;
			if (autoTradeRequested && !suppressedRepeat) {
				autoTrade = {
					requested: true,
					...(await dispatchAutoTrade({ alert, parsedSignal, requestId,
						signalId: body && typeof body === 'object' ? body.signalId : undefined })),
				};
			}

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
				...(autoTrade ? { autoTrade } : {}),
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
				outcomeAnnotation: outcomeAnnotation
					? {
						exchange: outcomeAnnotation.exchange,
						symbol: outcomeAnnotation.symbol,
						side: outcomeAnnotation.side,
						setupType: outcomeAnnotation.setupType,
						windowLabel: outcomeAnnotation.windowLabel,
						sampleSize: outcomeAnnotation.sampleSize,
						hitRatePercent: outcomeAnnotation.hitRatePercent,
						expectancyR: outcomeAnnotation.expectancyR,
						totalWins: outcomeAnnotation.totalWins,
						totalLosses: outcomeAnnotation.totalLosses,
						summary: outcomeAnnotation.summary,
					}
					: null,
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
				session: alert.session || undefined,
				burstAggregateId,
				burstSignalCount,
				decision: decisionAudit,
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
				});
			trackBackgroundTask(postPersistenceTask);

			const subscriberDispatchTask = alertSubscriberDeliveryService.dispatchAlert({
				alertId: inlineAlertId || undefined,
				text: alert.text,
				symbol: extracted.symbol !== 'unknown' ? extracted.symbol : null,
				exchange: extracted.exchange || null,
				side: parsedSignal?.side || null,
				enriched,
				enrichmentData: alert.enriched || null,
				channels: requestedChannels,
				source: body.source || 'webhook-alert',
			}).catch((err) => {
				console.warn('[WebhookAlert] Subscriber dispatch task failed:', err && err.message);
			});
			trackBackgroundTask(subscriberDispatchTask);

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
						session: alert.session || parsedSignal.session || undefined,
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
