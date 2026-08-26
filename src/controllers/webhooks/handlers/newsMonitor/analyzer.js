/**
 * News Analyzer Orchestrator
 * Manages parallel symbol analysis with timeout handling
 * Integrates Gemini, Binance, and notification services
 * 003-news-monitor: User Stories 1-6
 */

const { analyzeNewsForSymbol } = require('../../../../services/grounding/gemini');
const { getCacheInstance } = require('./cache');
const { getEnrichmentService } = require('../../../../services/inference/enrichmentService');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { AnalysisStatus, EventCategory } = require('./constants');
const { GROUNDING_MODEL_NAME, ENABLE_NEWS_MONITOR_TEST_MODE } = require('../../../../services/grounding/config');
const geminiQuotaManager = require('../../../../services/grounding/geminiQuotaManager');
const geminiPriceService = require('../../../../services/grounding/geminiPriceService');
const { getPromptService, PromptKeys } = require('../../../../services/prompts');
const { MainClient } = require('binance');
const { createHash } = require('node:crypto');
const { TokenUsageTracker } = require('../../../../lib/tokenUsage');
const {
	sendWithNotificationRouting,
	getRequestedChannels,
	validateNotificationRouting,
} = require('../../../../services/notification/requestRouting');

const promptService = getPromptService();

// Placeholder for NotificationManager - will be injected
let notificationManager = null;

// Binance client singleton
let binanceClient = null;

function getBinanceClient() {
	if (!binanceClient) {
		binanceClient = new MainClient({
			beautifyResponses: true,
		});
	}
	return binanceClient;
}

function setNotificationManager(manager) {
	notificationManager = manager;
}

function getNotificationManager() {
	return notificationManager;
}

const ROUTING_IDENTITY_FIELDS = {
	telegram: 'telegramChatId',
	whatsapp: 'whatsappChatId',
	discord: 'discordWebhookFingerprint',
};

function hashDiscordWebhook(webhookUrl) {
	if (typeof webhookUrl !== 'string' || webhookUrl.length === 0) {
		return undefined;
	}
	return createHash('sha256').update(webhookUrl).digest('hex');
}

function getChannelDefaultDestination(notificationMgr, channel) {
	const service = notificationMgr?.channels?.get(channel);
	if (channel === 'telegram') return service?.chatId;
	if (channel === 'whatsapp') return service?.chatId;
	if (channel === 'discord') return service?.webhookUrl;
	return undefined;
}

function getRoutingDestination(notificationMgr, routing = {}, channel) {
	if (channel === 'discord') {
		if (typeof routing.discordWebhookFingerprint === 'string') return routing.discordWebhookFingerprint;
		return hashDiscordWebhook(routing.discordWebhookUrl || getChannelDefaultDestination(notificationMgr, channel));
	}

	const field = ROUTING_IDENTITY_FIELDS[channel];
	if (field && typeof routing[field] === 'string') return routing[field];
	return getChannelDefaultDestination(notificationMgr, channel);
}

function getStoredRoutingIdentity(routing = {}, channel) {
	if (channel === 'discord') {
		return routing.discordWebhookFingerprint || hashDiscordWebhook(routing.discordWebhookUrl);
	}
	return routing[ROUTING_IDENTITY_FIELDS[channel]];
}

function getCachedRoutingMetadata(routing = {}, previousRouting = {}, notificationMgr) {
	const isRequestedChannel = (channel) => !Array.isArray(routing.channels) || routing.channels.includes(channel);
	const getIdentity = (channel) => isRequestedChannel(channel)
		? getRoutingDestination(notificationMgr, routing, channel)
		: getStoredRoutingIdentity(previousRouting, channel);
	const metadata = {};
	if (Array.isArray(routing.channels)) {
		metadata.channels = [...routing.channels];
	}
	for (const [channel, field] of Object.entries(ROUTING_IDENTITY_FIELDS)) {
		const identity = getIdentity(channel);
		if (identity !== undefined) {
			metadata[field] = identity;
		}
	}
	return metadata;
}

function getCachedRedeliveryChannels(notificationMgr, cachedEntry = {}, routing = {}) {
	if (!notificationMgr) {
		return [];
	}

	const requestedChannels = getRequestedChannels(notificationMgr, routing);
	const cachedResults = new Map(
		(Array.isArray(cachedEntry.deliveryResults) ? cachedEntry.deliveryResults : [])
			.filter((result) => result && result.channel)
			.map((result) => [result.channel, result]),
	);

	return requestedChannels.filter((channel) => {
		const cachedResult = cachedResults.get(channel);
		const destinationDiffers = getRoutingDestination(notificationMgr, cachedEntry.routing, channel)
			!== getRoutingDestination(notificationMgr, routing, channel);
		return !cachedResult || !cachedResult.success || destinationDiffers;
	});
}

function getActiveCachedDeliveryResults(
	cachedEntry = {},
	requestedChannels = [],
	retryChannels = [],
	routing = {},
	notificationMgr,
) {
	const requestedSet = new Set(requestedChannels);
	const retrySet = new Set(retryChannels);

	return (Array.isArray(cachedEntry.deliveryResults) ? cachedEntry.deliveryResults : [])
		.filter((result) => {
			if (!result || !requestedSet.has(result.channel)) {
				return false;
			}
			if (!retrySet.has(result.channel)) {
				return true;
			}
			return getRoutingDestination(notificationMgr, cachedEntry.routing, result.channel)
				=== getRoutingDestination(notificationMgr, routing, result.channel);
		});
}

function mergeDeliveryResults(cachedResults = [], retryResults = [], requestedChannels = []) {
	const resultByChannel = new Map();
	for (const result of [...cachedResults, ...retryResults]) {
		if (result && result.channel) {
			resultByChannel.set(result.channel, result);
		}
	}

	return requestedChannels
		.map((channel) => resultByChannel.get(channel))
		.filter(Boolean);
}

function parseNewsTimeoutMs(value, fallback = 30000) {
	if (value === undefined) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^\d+$/.test(str)) {
		console.warn('[Analyzer] Invalid NEWS_TIMEOUT_MS configuration, using default');
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
		console.warn('[Analyzer] Invalid NEWS_TIMEOUT_MS configuration, using default');
		return fallback;
	}
	return parsed;
}

function parseNewsAlertThreshold(value, fallback = 0.7) {
	if (value === undefined) {
		return fallback;
	}
	const str = String(value).trim();
	if (str === '') {
		return fallback;
	}
	if (!/^[+-]?(\d+(\.\d+)?|\.\d+)$/.test(str)) {
		console.warn('[Analyzer] Invalid NEWS_ALERT_THRESHOLD configuration, using default');
		return fallback;
	}
	const parsed = Number(str);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		console.warn('[Analyzer] Invalid NEWS_ALERT_THRESHOLD configuration, using default');
		return fallback;
	}
	return parsed;
}

function isGeminiQuotaError(error) {
	return geminiQuotaManager.isQuotaError(error);
}

function getQuotaRetryDelayMs(error, attempt, baseDelayMs) {
	return geminiQuotaManager.extractRetryDelayMs(error, attempt, baseDelayMs);
}

function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function getKlineClose(kline) {
	if (typeof kline === 'object' && kline !== null && !Array.isArray(kline)) {
		return parseFloat(kline.close);
	}
	if (Array.isArray(kline)) {
		return parseFloat(kline[4]);
	}
	return 0;
}

function getKlineCloseTime(kline) {
	if (typeof kline === 'object' && kline !== null && !Array.isArray(kline)) {
		return Number(kline.closeTime);
	}
	if (Array.isArray(kline)) {
		return Number(kline[6]);
	}
	return NaN;
}

function getKlineVolume(kline) {
	if (typeof kline === 'object' && kline !== null && !Array.isArray(kline)) {
		return parseFloat(kline.volume);
	}
	if (Array.isArray(kline)) {
		return parseFloat(kline[5]);
	}
	return 0;
}

function isKlineOpen(kline, now = Date.now()) {
	if (!kline) {
		return false;
	}

	if (typeof kline === 'object' && !Array.isArray(kline)) {
		if (typeof kline.isClosed === 'boolean') return !kline.isClosed;
		if (typeof kline.closed === 'boolean') return !kline.closed;
		if (typeof kline.open === 'boolean') return kline.open;
		if (typeof kline.isComplete === 'boolean') return !kline.isComplete;

		const closeTime = Number(kline.closeTime);
		if (Number.isFinite(closeTime) && closeTime > 0) {
			return now <= closeTime;
		}

		const openTime = Number(kline.openTime);
		if (Number.isFinite(openTime) && openTime > 0) {
			return now < openTime + 3600000;
		}

		return false;
	}

	if (Array.isArray(kline)) {
		const closeTime = Number(kline[6]);
		if (Number.isFinite(closeTime) && closeTime > 0) {
			return now <= closeTime;
		}

		const openTime = Number(kline[0]);
		if (Number.isFinite(openTime) && openTime > 0) {
			return now < openTime + 3600000;
		}

		return false;
	}

	return false;
}

function calculateVolumeRatio(klines, options = {}) {
	if (!Array.isArray(klines) || klines.length < 2) {
		return null;
	}

	const now = typeof options === 'number' ? options : (options && options.now) || Date.now();

	let completedKlines = klines;
	while (completedKlines.length > 0 && isKlineOpen(completedKlines[completedKlines.length - 1], now)) {
		completedKlines = completedKlines.slice(0, completedKlines.length - 1);
	}

	if (completedKlines.length < 2) {
		return null;
	}

	const latestVolume = getKlineVolume(completedKlines[completedKlines.length - 1]);
	const previousKlines = completedKlines.slice(0, completedKlines.length - 1);
	const sumPreviousVolume = previousKlines.reduce((sum, k) => sum + getKlineVolume(k), 0);
	const avgPreviousVolume = sumPreviousVolume / previousKlines.length;

	if (avgPreviousVolume <= 0) {
		return null;
	}

	const ratio = latestVolume / avgPreviousVolume;
	return Math.round(ratio * 100) / 100;
}

function calculateRSI(closes, period = 14) {
	if (!Array.isArray(closes) || closes.length <= period) {
		return null;
	}

	const changes = [];
	for (let i = 1; i < closes.length; i++) {
		changes.push(closes[i] - closes[i - 1]);
	}

	let gainSum = 0;
	let lossSum = 0;

	for (let i = 0; i < period; i++) {
		const change = changes[i];
		if (change > 0) {
			gainSum += change;
		} else {
			lossSum += Math.abs(change);
		}
	}

	let avgGain = gainSum / period;
	let avgLoss = lossSum / period;

	for (let i = period; i < changes.length; i++) {
		const change = changes[i];
		const gain = change > 0 ? change : 0;
		const loss = change < 0 ? Math.abs(change) : 0;

		avgGain = (avgGain * (period - 1) + gain) / period;
		avgLoss = (avgLoss * (period - 1) + loss) / period;
	}

	if (avgLoss === 0) {
		return 100;
	}

	const rs = avgGain / avgLoss;
	const rsi = 100 - (100 / (1 + rs));
	return Math.round(rsi * 10) / 10;
}

class NewsAnalyzer {
	constructor() {
		this.cache = getCacheInstance();
		this.enrichmentService = getEnrichmentService();
		// Do NOT store notificationManager in constructor - get it dynamically
		// to handle delayed initialization in tests and app startup

		this.enableBinance = process.env.ENABLE_BINANCE_PRICE_CHECK === 'true';
	}

	get timeout() {
		return this._timeoutOverride ?? parseNewsTimeoutMs(getRuntimeConfig().NEWS_TIMEOUT_MS);
	}

	set timeout(value) {
		this._timeoutOverride = value;
	}

	get alertThreshold() {
		return this._alertThresholdOverride ?? parseNewsAlertThreshold(getRuntimeConfig().NEWS_ALERT_THRESHOLD);
	}

	set alertThreshold(value) {
		this._alertThresholdOverride = value;
	}

	get geminiConcurrency() {
		return getRuntimeConfig().NEWS_GEMINI_CONCURRENCY;
	}

	get geminiQuotaMaxRetries() {
		return getRuntimeConfig().NEWS_GEMINI_QUOTA_MAX_RETRIES;
	}

	get geminiQuotaRetryBaseMs() {
		return getRuntimeConfig().NEWS_GEMINI_QUOTA_RETRY_BASE_MS;
	}

	calculateAdjustedConfidence(baseConfidence, marketContext) {
		if (!marketContext || (typeof marketContext.volumeRatio !== 'number' && typeof marketContext.rsi !== 'number')) {
			return baseConfidence;
		}

		let confidence = baseConfidence;

		if (typeof marketContext.volumeRatio === 'number') {
			if (marketContext.volumeRatio > 1.5) {
				confidence += 0.10;
			} else if (marketContext.volumeRatio < 1.0) {
				confidence -= 0.10;
			}
		}

		if (typeof marketContext.rsi === 'number') {
			if (marketContext.rsi >= 40 && marketContext.rsi <= 65) {
				confidence += 0.05;
			} else if (marketContext.rsi > 75) {
				confidence -= 0.15;
			} else if (marketContext.rsi < 25) {
				confidence -= 0.15;
			}
		}

		return Math.min(1.0, Math.max(0.0, Math.round(confidence * 100) / 100));
	}

	/**
   * Analyze multiple symbols in parallel
   * Returns results even if some timeout or error
   * @param {string[]} symbols - Financial symbols to analyze
   * @param {string} requestId - Correlation ID for tracing
   * @returns {Promise<Object[]>} Array of AnalysisResult objects
   */
	async analyzeSymbols(symbols, requestId, tokenUsage, routing = {}, options = {}) {
		const limit = Math.min(this.geminiConcurrency, symbols.length);
		const results = [];
		let nextIndex = 0;
		const batchStartedAt = Date.now();

		const runNext = async () => {
			while (nextIndex < symbols.length) {
				const currentIndex = nextIndex;
				nextIndex += 1;
				const symbol = symbols[currentIndex];
				const symbolTokenUsage = new TokenUsageTracker();
				results[currentIndex] = await this.analyzeSymbol(symbol, requestId, symbolTokenUsage, routing, batchStartedAt, options)
					.then((result) => {
						if (tokenUsage) {
							tokenUsage.merge(symbolTokenUsage);
						}
						return result;
					})
					.catch(error => {
						if (tokenUsage) {
							tokenUsage.merge(symbolTokenUsage);
						}
						return {
							symbol,
							status: AnalysisStatus.ERROR,
							error: {
								code: isGeminiQuotaError(error) ? 'GEMINI_QUOTA_EXHAUSTED' : 'ANALYSIS_ERROR',
								message: error.message,
							},
							totalDurationMs: 0,
							cached: false,
							requestId,
						};
					});
			}
		};

		await Promise.all(Array.from({ length: limit }, runNext));

		return results;
	}

	async runSymbolAnalysisWithRetry(symbol, requestId, tokenUsage, routing, startedAt, options = {}) {
		let attempt = 0;
		let lastQuotaError = null;
		const deadline = options.deadline ?? startedAt + this.timeout;

		while (attempt <= this.geminiQuotaMaxRetries) {
			let timeoutHandle;
			const elapsedMs = Date.now() - startedAt;
			const remainingMs = this.timeout - elapsedMs;
			if (remainingMs <= 0) {
				throw new Error('TIMEOUT');
			}

			await geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: remainingMs, throwOnExceeded: true });

			const remainingAfterWaitMs = this.timeout - (Date.now() - startedAt);
			if (remainingAfterWaitMs <= 0) {
				throw new Error('TIMEOUT');
			}

			try {
				const timeoutPromise = new Promise((_, reject) => {
					timeoutHandle = setTimeout(() => reject(new Error('TIMEOUT')), remainingAfterWaitMs);
				});
				return await Promise.race([
					this.analyzeSymbolInternal(symbol, requestId, tokenUsage, routing, { ...options, deadline }),
					timeoutPromise,
				]);
			} catch (error) {
				if (!isGeminiQuotaError(error) || attempt >= this.geminiQuotaMaxRetries) {
					throw error;
				}

				lastQuotaError = error;
				attempt += 1;
				const delayMs = geminiQuotaManager.triggerQuotaCooldown(error, attempt, this.geminiQuotaRetryBaseMs);
				const remainingAfterAttemptMs = this.timeout - (Date.now() - startedAt);
				if (delayMs >= remainingAfterAttemptMs) {
					console.warn('[Analyzer] Gemini quota retry skipped; delay exceeds remaining budget:', symbol);
					throw lastQuotaError;
				}

				console.warn('[Analyzer] Gemini quota exhausted, retrying symbol analysis:', {
					symbol,
					attempt,
					delayMs,
					remainingMs: remainingAfterAttemptMs,
				});
				await geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: remainingAfterAttemptMs, throwOnExceeded: true });
			} finally {
				clearTimeout(timeoutHandle);
			}
		}

		throw lastQuotaError;
	}

	/**
   * Analyze single symbol with timeout
   * Checks cache first, then runs full analysis if cache miss
   * @param {string} symbol - Financial symbol
   * @param {string} requestId - Correlation ID
   * @returns {Promise<Object>} AnalysisResult object
   */
	async analyzeSymbol(symbol, requestId, tokenUsage, routing = {}, startedAt = Date.now(), options = {}) {
		const startTime = startedAt;
		const analysis = {
			symbol,
			status: AnalysisStatus.ANALYZED,
			totalDurationMs: 0,
			cached: false,
			requestId,
		};

		try {
			// Attempt to run analysis with timeout
			const result = await this.runSymbolAnalysisWithRetry(symbol, requestId, tokenUsage, routing, startTime, options);

			return {
				...analysis,
				...result,
				totalDurationMs: Date.now() - startTime,
			};
		} catch (error) {
			if (error.message === 'TIMEOUT') {
				console.warn('[Analyzer] Symbol analysis timeout:', symbol);
				return {
					...analysis,
					status: AnalysisStatus.TIMEOUT,
					error: {
						code: 'ANALYSIS_TIMEOUT',
						message: `Analysis exceeded ${this.timeout}ms budget`,
					},
					totalDurationMs: Date.now() - startTime,
				};
			}
			throw error;
		}
	}

	/**
   * Internal symbol analysis (with full flow)
   * @param {string} symbol - Financial symbol
   * @param {string} requestId - Correlation ID
   * @returns {Promise<Object>} Partial AnalysisResult (status, alert, etc.)
   */
	async analyzeSymbolInternal(symbol, requestId, tokenUsage, routing = {}, options = {}) {
		const { dryRun = false } = options;

		// Try cache first
		if (!dryRun) {
			for (const category of Object.values(EventCategory)) {
				const cached = await this.cache.get(symbol, category);
				if (cached) {
					console.debug('[Analyzer] Returning cached result:', symbol, category);
					let deliveryResults = cached.deliveryResults;
					let redelivered = false;
					let attemptedDeliveryResults = [];
					if (cached.alert) {
						const notificationMgr = getNotificationManager();
						if (notificationMgr) {
							validateNotificationRouting(notificationMgr, routing);
							const requestedChannels = getRequestedChannels(notificationMgr, routing);
							const retryChannels = getCachedRedeliveryChannels(notificationMgr, cached, routing);
							const claimedRetryChannels = [];
							for (const channel of retryChannels) {
								if (await this.cache.claimDelivery(symbol, category, channel)) {
									claimedRetryChannels.push(channel);
								}
							}
							const activeCachedDeliveryResults = getActiveCachedDeliveryResults(
								cached,
								requestedChannels,
								retryChannels,
								routing,
								notificationMgr,
							);
							if (claimedRetryChannels.length > 0) {
								const leaseAbortControllers = new Map(
									claimedRetryChannels.map((channel) => [channel, new AbortController()]),
								);
								const leaseOwnership = new Map(
									claimedRetryChannels.map((channel) => [channel, true]),
								);
								const persistenceOwnership = new Map(
									claimedRetryChannels.map((channel) => [channel, true]),
								);
								const markLeaseOwnershipLost = (channel) => {
									if (leaseOwnership.get(channel)) {
										leaseOwnership.set(channel, false);
										persistenceOwnership.set(channel, false);
										leaseAbortControllers.get(channel)?.abort('Cached delivery lease ownership lost');
									}
								};
								const markPersistenceOwnershipLost = (channel) => {
									persistenceOwnership.set(channel, false);
								};
								const renewLease = async (channel) => {
									try {
										const renewed = await this.cache.renewDelivery(symbol, category, channel);
										if (renewed === false) {
											markLeaseOwnershipLost(channel);
										} else if (renewed !== true) {
											markPersistenceOwnershipLost(channel);
										}
									} catch (error) {
										markPersistenceOwnershipLost(channel);
										console.warn('[Analyzer] Cached delivery lease renewal indeterminate:', error.message);
									}
								};
								const leaseDeadline = options.deadline ?? Date.now() + this.timeout;
								const waitForLeaseRenewals = async (renewalEntries) => {
									const pending = renewalEntries
										.filter(([, renewal]) => renewal)
										.map(([channel, renewal]) => {
											const state = { channel, settled: false };
											state.promise = Promise.resolve(renewal).finally(() => { state.settled = true; });
											return state;
										});
									if (pending.length === 0) return [];
									const remainingMs = leaseDeadline - Date.now();
									if (remainingMs <= 0) return pending.map(({ channel }) => channel);
									let timeoutHandle;
									try {
										const completed = await Promise.race([
											Promise.all(pending.map(({ promise }) => promise)).then(() => true),
											new Promise(resolve => {
												timeoutHandle = setTimeout(() => resolve(false), remainingMs);
											}),
										]);
										return completed ? [] : pending.filter(({ settled }) => !settled).map(({ channel }) => channel);
									} finally {
										clearTimeout(timeoutHandle);
									}
								};
								const pendingLeaseRenewals = new Map(
									claimedRetryChannels.map((channel) => [channel, null]),
								);
								const queueLeaseRenewal = (channel) => {
									if (pendingLeaseRenewals.get(channel)) {
										return;
									}
									const renewal = renewLease(channel).finally(() => pendingLeaseRenewals.set(channel, null));
									pendingLeaseRenewals.set(channel, renewal);
								};
								const leaseRenewalIntervals = claimedRetryChannels.map((channel) => setInterval(
									() => queueLeaseRenewal(channel),
									this.cache.getDeliveryLeaseRenewIntervalMs(),
								));
								try {
									const signalByChannel = Object.fromEntries(
										claimedRetryChannels.map((channel) => [channel, leaseAbortControllers.get(channel).signal]),
									);
									const retryResults = await sendWithNotificationRouting(
										notificationMgr,
										cached.alert,
										{ ...routing, channels: claimedRetryChannels },
										{ signalByChannel },
									);
									leaseRenewalIntervals.forEach(clearInterval);
									const timedOutPendingChannels = await waitForLeaseRenewals([...pendingLeaseRenewals.entries()],
									);
									timedOutPendingChannels.forEach(markPersistenceOwnershipLost);
									const finalRenewals = claimedRetryChannels
										.filter(channel => !pendingLeaseRenewals.get(channel))
										.map(channel => [channel, renewLease(channel)]);
									const timedOutFinalChannels = await waitForLeaseRenewals(finalRenewals);
									timedOutFinalChannels.forEach(markPersistenceOwnershipLost);
									const ownedRetryChannels = claimedRetryChannels.filter((channel) => leaseOwnership.get(channel));
									const persistenceRetryChannels = claimedRetryChannels.filter((channel) => persistenceOwnership.get(channel));
									const successfulRetryChannels = new Set(
										retryResults.filter(result => result.success).map(result => result.channel),
									);
									attemptedDeliveryResults = retryResults.filter((result) => ownedRetryChannels.includes(result.channel));
									redelivered = attemptedDeliveryResults.some((result) => result && result.success);
									deliveryResults = mergeDeliveryResults(
										activeCachedDeliveryResults,
										retryResults.filter((result) => ownedRetryChannels.includes(result.channel)),
										requestedChannels,
									);
									if (ownedRetryChannels.length > 0) {
										await this.cache.set(symbol, category, {
											...cached,
											routing: getCachedRoutingMetadata(routing, cached.routing, notificationMgr),
											deliveryResults,
										}, {
											preserveTtl: true,
											deliveryChannels: persistenceRetryChannels,
											localDeliveryChannels: ownedRetryChannels,
											localOnlyChannels: ownedRetryChannels.filter(
												channel => successfulRetryChannels.has(channel) && !persistenceRetryChannels.includes(channel),
											),
											awaitPersistence: persistenceRetryChannels.length > 0,
											skipPersistence: persistenceRetryChannels.length === 0,
										});
									}
								} finally {
									leaseRenewalIntervals.forEach(clearInterval);
									claimedRetryChannels.forEach((channel) => this.cache.releaseDelivery(symbol, category, channel));
								}
							} else {
								deliveryResults = activeCachedDeliveryResults;
							}
						} else {
							deliveryResults = [];
						}
					}
					return {
						status: AnalysisStatus.CACHED,
						alert: cached.alert,
						deliveryResults,
						cached: true,
						redelivered,
						attemptedDeliveryResults,
					};
				}
			}
		}

		// Fetch market context (price, 24h change, etc.)
		const marketContext = await this.getMarketContext(symbol, tokenUsage);

		// Build analysis context for Gemini
		const analysisContext = this.buildAnalysisContext(symbol, marketContext);

		// Call Gemini for sentiment analysis
		const geminiAnalysis = await analyzeNewsForSymbol(symbol, analysisContext, { tokenUsage });

		// Adjust confidence score with volume expansion & RSI filters if marketContext contains them
		geminiAnalysis.confidence = this.calculateAdjustedConfidence(geminiAnalysis.confidence, marketContext);

		// If no event detected, cache and return
		if (geminiAnalysis.event_category === EventCategory.NONE) {
			if (!dryRun) {
				await this.cache.set(symbol, EventCategory.NONE, {
					alert: null,
					analysisResult: {
						symbol,
						status: AnalysisStatus.ANALYZED,
						cached: false,
						requestId,
					},
				});
			}
			return {
				status: AnalysisStatus.ANALYZED,
				alert: null,
				cached: false,
			};
		}

		// Check confidence threshold
		if (geminiAnalysis.confidence < this.alertThreshold) {
			console.info('[Analyzer] Confidence below threshold for', symbol, '-', geminiAnalysis.confidence.toFixed(2), '<', this.alertThreshold);
			if (!dryRun) {
				await this.cache.set(symbol, geminiAnalysis.event_category, {
					alert: null,
					analysisResult: {
						symbol,
						status: AnalysisStatus.ANALYZED,
						cached: false,
						requestId,
					},
				});
			}
			return {
				status: AnalysisStatus.ANALYZED,
				alert: null,
				cached: false,
			};
		}

		// Optional LLM enrichment
		let enrichmentMetadata = null;
		if (this.enrichmentService.isEnabled() && ENABLE_NEWS_MONITOR_TEST_MODE !== true) {
			enrichmentMetadata = await this.enrichmentService.enrichAlert(geminiAnalysis);
			if (enrichmentMetadata && enrichmentMetadata.enriched_confidence < this.alertThreshold) {
				console.debug('[Analyzer] Enrichment lowered confidence below threshold');
				return {
					status: AnalysisStatus.ANALYZED,
					alert: null,
					cached: false,
				};
			}
		}

		// Build alert object
		const tokenUsageSummary = tokenUsage ? tokenUsage.toJSON() : null;
		const alert = this.buildAlert(symbol, geminiAnalysis, marketContext, enrichmentMetadata, tokenUsageSummary);

		if (dryRun) {
			console.debug('[Analyzer] Dry-run mode: skipping delivery, signal outcome, and cache persistence');
			return {
				status: AnalysisStatus.ANALYZED,
				alert,
				deliveryResults: [],
				cached: false,
			};
		}

		// Claim the cache key atomically before delivering the alert to prevent race conditions
		const claimed = await this.cache.claim(symbol, geminiAnalysis.event_category);
		if (!claimed) {
			console.info('[Analyzer] Duplicate alert detected during claim, suppressing delivery for:', symbol, geminiAnalysis.event_category);
			const cached = await this.cache.get(symbol, geminiAnalysis.event_category);
			return {
				status: AnalysisStatus.CACHED,
				alert: cached ? cached.alert : alert,
				deliveryResults: cached ? cached.deliveryResults : [],
				cached: true,
			};
		}

		// Send to all notification channels
		console.info('[Analyzer] Sending alert:', symbol, 'confidence:', alert.confidence.toFixed(2), 'event:', alert.eventCategory);
		const notificationMgr = getNotificationManager();
		if (!notificationMgr) {
			console.warn('[Analyzer] NotificationManager not initialized - skipping alert delivery');
			return {
				status: AnalysisStatus.ANALYZED,
				alert,
				deliveryResults: [],
				cached: false,
			};
		}
		const deliveryResults = await sendWithNotificationRouting(notificationMgr, alert, routing);
		console.info('[Analyzer] Alert delivery results for', symbol, ':', deliveryResults);

		const signalOutcomeService = require('../../../../services/storage/SignalOutcomeService');
		if (signalOutcomeService.isEnabled()) {
			const sentimentScore = typeof alert.sentimentScore === 'number' ? alert.sentimentScore : 0;
			const hasUncertainty = typeof alert.uncertainty_reason === 'string' && alert.uncertainty_reason.trim().length > 0;
			const meetsConviction = Math.abs(sentimentScore) >= 0.15 && !hasUncertainty;

			if (meetsConviction) {
				const side = (sentimentScore > 0) ? 'BUY' : 'SELL';
				const stop = (alert.marketContext && typeof alert.marketContext.stop === 'number')
					? alert.marketContext.stop
					: (typeof alert.stop === 'number' ? alert.stop : null);
				const target = (alert.marketContext && typeof alert.marketContext.target === 'number')
					? alert.marketContext.target
					: (typeof alert.target === 'number' ? alert.target : null);

				signalOutcomeService.recordSignal({
					requestId,
					source: 'news-monitor',
					symbol: alert.symbol,
					assetClass: options.assetClassBySymbol
						? options.assetClassBySymbol[String(alert.symbol).trim().toUpperCase()]
						: null,
					exchange: alert.marketContext && alert.marketContext.source === 'binance' ? 'BINANCE' : 'UNKNOWN',
					timeframe: null,
					setupType: 'news-alert',
					score: alert.confidence,
					side,
					price: alert.marketContext ? alert.marketContext.price : null,
					priceSource: alert.marketContext ? alert.marketContext.source : null,
					stop,
					target,
					sources: alert.sources || [],
					tokenUsage: alert.enriched ? alert.enriched.tokenUsage : null,
				}).catch(() => {});
			}
		}

		// Cache the final results (updates the claimed cache entry with final metadata/results)
		await this.cache.set(symbol, geminiAnalysis.event_category, {
			alert,
			analysisResult: {
				symbol,
				status: AnalysisStatus.ANALYZED,
				cached: false,
				requestId,
			},
			routing: getCachedRoutingMetadata(routing, {}, notificationMgr),
			deliveryResults,
		});

		return {
			status: AnalysisStatus.ANALYZED,
			alert,
			deliveryResults,
			cached: false,
		};
	}

	/**
   * Get market context (price, 24h change) from Binance or Gemini
   * @param {string} symbol - Financial symbol
   * @returns {Promise<Object|null>} MarketContext or null if unavailable
   */
	async getMarketContext(symbol, tokenUsage) {
		// Try Binance if enabled
		if (this.enableBinance) {
			try {
				const binanceContext = await this.fetchBinancePrice(symbol);
				if (binanceContext) return binanceContext;
			} catch (error) {
				// Fall back to Gemini
			}
		}

		// Fall back to Gemini
		try {
			return await this.fetchGeminiPrice(symbol, tokenUsage);
		} catch (error) {
			if (isGeminiQuotaError(error)) {
				throw error;
			}
			console.warn('[Analyzer] Price context fetch failed:', error.message);
			return null;
		}
	}

	/**
	 * Fetch price from Binance API (crypto only)
	 * @param {string} symbol - Crypto symbol (e.g., BTCUSDT)
	 * @returns {Promise<Object>} MarketContext or null
	 */
	async fetchBinancePrice(symbol) {
		try {
			const timeoutMs = getRuntimeConfig().BINANCE_FETCH_TIMEOUT_MS;
			const client = getBinanceClient();

			const withTimeout = (promise, ms, fallbackValue, isReject = false) => {
				let timerId;
				const timeoutPromise = new Promise((resolve, reject) => {
					timerId = setTimeout(() => {
						if (isReject) {
							reject(new Error('Binance fetch timeout'));
						} else {
							resolve(fallbackValue);
						}
					}, ms);
				});

				return Promise.race([promise, timeoutPromise]).finally(() => {
					if (timerId) {
						clearTimeout(timerId);
					}
				});
			};

			const pricePromise = withTimeout(
				client.getAvgPrice({ symbol }),
				timeoutMs,
				null,
				true,
			);

			const klinesPromise = (typeof client.getKlines === 'function')
				? withTimeout(
					client.getKlines({ symbol, interval: '1h', limit: 30 }).catch(() => null),
					timeoutMs,
					null,
					false,
				)
				: Promise.resolve(null);

			const [data, klines] = await Promise.all([pricePromise, klinesPromise]);

			console.debug(`[Analyzer] Binance price for ${symbol}: $${data.price}`);
			const price = parseFloat(data.price);
			const priceCloseTime = Number(data.closeTime);
			const targetCloseTime = (Number.isFinite(priceCloseTime) && priceCloseTime > 0
				? priceCloseTime
				: Date.now()) - 24 * 60 * 60 * 1000;
			const referenceKline = Array.isArray(klines)
				? klines.reduce((closest, kline) => {
					const closeTime = getKlineCloseTime(kline);
					const closestCloseTime = getKlineCloseTime(closest);
					return Number.isFinite(closeTime)
						&& (!Number.isFinite(closestCloseTime)
							|| Math.abs(closeTime - targetCloseTime) < Math.abs(closestCloseTime - targetCloseTime))
						? kline
						: closest;
				}, null)
				: null;
			const referenceCloseTime = getKlineCloseTime(referenceKline);
			const price24hAgo = Number.isFinite(referenceCloseTime)
				&& Math.abs(referenceCloseTime - targetCloseTime) <= 60 * 60 * 1000
				? getKlineClose(referenceKline)
				: null;
			const change24h = Number.isFinite(price24hAgo) && price24hAgo > 0 && Number.isFinite(price)
				? Math.round(((price - price24hAgo) / price24hAgo) * 10000) / 100
				: null;

			let volumeRatio = null;
			let rsi = null;

			if (Array.isArray(klines) && klines.length > 0) {
				volumeRatio = calculateVolumeRatio(klines);
				const closes = klines.map(getKlineClose);
				rsi = calculateRSI(closes);
			}

			return {
				price,
				change24h,
				volumeRatio,
				rsi,
				source: 'binance',
				timestamp: Date.now(),
			};
		} catch (error) {
			// Binance fetch failed - will fall back to Gemini
			return null;
		}
	}

	/**
	 * Fetch price via Gemini GoogleSearch
	 * Extracts numeric price data from grounded search snippets
	 * @param {string} symbol - Financial symbol
	 * @param {TokenUsageTracker} [tokenUsage] - Optional token usage tracker
	 * @returns {Promise<Object>} MarketContext with parsed price/change or null
	 */
	async fetchGeminiPrice(symbol, tokenUsage) {
		return geminiPriceService.fetchGeminiPrice(symbol, {
			tokenUsage,
			timeoutMs: 30000,
			rethrowQuotaErrors: true,
		});
	}

	/**
	 * Build analysis context for Gemini
	 * @param {string} symbol - Financial symbol
	 * @param {Object} marketContext - Optional market context
	 * @returns {string} Analysis context string
	 */
	buildAnalysisContext(symbol, marketContext) {
		let context = `Analyze recent news and market sentiment for ${symbol}.`;

		if (marketContext) {
			context += `\n\nCurrent Market Data:
- Price: $${marketContext.price}
- 24h Change: ${marketContext.change24h}%
- Context: ${marketContext.context || 'N/A'}`;
		}

		context += '\n\nDetect any significant market-moving events.';
		return context;
	}

	/**
   * Build NewsAlert from analysis result
   * @param {string} symbol - Financial symbol
   * @param {Object} geminiAnalysis - Gemini analysis result
   * @param {Object} marketContext - Optional market context
   * @param {Object} enrichmentMetadata - Optional enrichment metadata
   * @returns {Object} NewsAlert object
   */
	buildAlert(symbol, geminiAnalysis, marketContext, enrichmentMetadata, tokenUsageSummary) {
		// Use enriched confidence if available
		const finalConfidence = enrichmentMetadata
			? enrichmentMetadata.enriched_confidence
			: geminiAnalysis.confidence;

		// Use geminiAnalysis confidence_reason unless enrichment provides its own
		const confidenceReason = enrichmentMetadata && enrichmentMetadata.confidence_reason
			? enrichmentMetadata.confidence_reason
			: (geminiAnalysis.confidence_reason || '');

		// Include confidence calibration fields in alert for downstream delivery
		const calibrationFields = {
			source_count: geminiAnalysis.source_count,
			source_freshness: geminiAnalysis.source_freshness,
			source_quality: geminiAnalysis.source_quality,
			event_age_hours: geminiAnalysis.event_age_hours,
			time_horizon: geminiAnalysis.time_horizon,
			uncertainty_reason: geminiAnalysis.uncertainty_reason,
			invalidation_hint: geminiAnalysis.invalidation_hint,
			confidence_reason: confidenceReason,
		};
		if (geminiAnalysis.calibration) {
			calibrationFields.grounding_calibration = geminiAnalysis.calibration;
		}

		// Build the title/original text
		const eventLabel = this.eventCategoryLabel(geminiAnalysis.event_category);
		const headline = (geminiAnalysis.headline && geminiAnalysis.headline.trim())
			? geminiAnalysis.headline
			: `${eventLabel} event detected`;
		const alertTitle = `${symbol}: ${headline}`;

		// Build the context (includes sentiment, confidence, price context)
		const sentimentScore = geminiAnalysis.sentiment_score ?? 0;
		const confidense = (finalConfidence * 100).toFixed(0);

		let context = (geminiAnalysis.description && geminiAnalysis.description.trim())
			? `${geminiAnalysis.description}\n\n`
			: '';

		context += `*Sentiment:* ${this.sentimentLabel(sentimentScore)} (${sentimentScore.toFixed(2)})`;

		if (marketContext) {
			if (marketContext.price) {
				const change = marketContext.change24h ?? 0;
				context += `\n*Price:* $${marketContext.price} (${change > 0 ? '+' : ''}${change.toFixed(1)}%)`;
			}
			if (typeof marketContext.volumeRatio === 'number') {
				context += `\n*Volume Ratio:* ${marketContext.volumeRatio.toFixed(2)}x`;
			}
			if (typeof marketContext.rsi === 'number') {
				context += `\n*RSI (14):* ${marketContext.rsi.toFixed(1)}`;
			}
		}

		if (geminiAnalysis.time_horizon && typeof geminiAnalysis.time_horizon === 'string' && geminiAnalysis.time_horizon.trim()) {
			const horizonLabel = this.timeHorizonLabel(geminiAnalysis.time_horizon);
			if (horizonLabel) {
				context += `\n*Horizonte:* ${horizonLabel}`;
			}
		}

		if (geminiAnalysis.invalidation_hint && typeof geminiAnalysis.invalidation_hint === 'string' && geminiAnalysis.invalidation_hint.trim()) {
			context += `\n*Invalidación:* ${geminiAnalysis.invalidation_hint.trim()}`;
		}

		// Derive outcome barriers when marketContext has a valid numeric price
		let derivedBarriers = null;
		if (marketContext && typeof marketContext.price === 'number' && Number.isFinite(marketContext.price) && marketContext.price > 0) {
			derivedBarriers = this.deriveBarriers(marketContext.price, geminiAnalysis.sentiment_score, geminiAnalysis.time_horizon);
		}

		// Build citations from sources
		const citations = [];
		if (geminiAnalysis.sources && Array.isArray(geminiAnalysis.sources)) {
			geminiAnalysis.sources.slice(0, 3).forEach(source => {
				if (typeof source === 'object' && source.title && source.url) {
					citations.push({
						title: source.title,
						url: source.url,
					});
				} else if (typeof source === 'string') {
					// Fallback for plain URLs
					citations.push({
						title: source,
						url: source,
					});
				}
			});
		}

		// Build enriched object for formatEnriched methods
		const enrichedExtraText = confidenceReason
			? `_Model Confidence: ${confidense}%_\n_Reason: ${confidenceReason}_\n_Model used: ${GROUNDING_MODEL_NAME}_`
			: `_Model Confidence: ${confidense}%_\n_Model used: ${GROUNDING_MODEL_NAME}_`;
		const enriched = {
			originalText: alertTitle,
			summary: context,
			citations,
			extraText: enrichedExtraText,
			tokenUsage: tokenUsageSummary || undefined,
			time_horizon: geminiAnalysis.time_horizon,
			invalidation_hint: geminiAnalysis.invalidation_hint,
		};

		return {
			symbol,
			eventCategory: geminiAnalysis.event_category,
			headline: geminiAnalysis.headline,
			sentimentScore: geminiAnalysis.sentiment_score,
			confidence: finalConfidence,
			confidence_reason: confidenceReason,
			sources: geminiAnalysis.sources,
			text: alertTitle,
			enriched,
			volumeRatio: (marketContext && typeof marketContext.volumeRatio === 'number') ? marketContext.volumeRatio : undefined,
			rsi: (marketContext && typeof marketContext.rsi === 'number') ? marketContext.rsi : undefined,
			// Include calibration fields at top level for backward compatibility
			source_count: geminiAnalysis.source_count,
			source_freshness: geminiAnalysis.source_freshness,
			source_quality: geminiAnalysis.source_quality,
			event_age_hours: geminiAnalysis.event_age_hours,
			time_horizon: geminiAnalysis.time_horizon,
			uncertainty_reason: geminiAnalysis.uncertainty_reason,
			invalidation_hint: geminiAnalysis.invalidation_hint,
			calibration: geminiAnalysis.calibration || undefined,
			timestamp: Date.now(),
			marketContext: marketContext || undefined,
			enrichmentMetadata: enrichmentMetadata || undefined,
			stop: (marketContext && typeof marketContext.stop === 'number')
				? marketContext.stop
				: (derivedBarriers ? derivedBarriers.stop : undefined),
			target: (marketContext && typeof marketContext.target === 'number')
				? marketContext.target
				: (derivedBarriers ? derivedBarriers.target : undefined),
		};
	}

	/**
   * Format alert message for notification channels
   * @param {string} symbol - Financial symbol
   * @param {Object} analysis - Analysis result
   * @param {Object} marketContext - Optional market context
   * @returns {string} Formatted message
   */
	formatAlertMessage(symbol, analysis, marketContext) {
		// Defensive checks for undefined properties
		if (!analysis) {
			return `*${symbol} Alert*\n\nNo analysis data available`;
		}

		let message = `*${symbol} Alert*\n\n`;

		// Use headline from analysis; provide sensible defaults if missing
		const eventLabel = this.eventCategoryLabel(analysis.event_category);
		const headline = (analysis.headline && analysis.headline.trim())
			? analysis.headline
			: `${eventLabel} event detected`;
		message += `Event: ${headline}\n`;

		const sentimentScore = analysis.sentiment_score ?? 0;
		message += `Sentiment: ${this.sentimentLabel(sentimentScore)} (${sentimentScore.toFixed(2)})\n`;

		const confidence = analysis.confidence ?? 0;
		message += `Confidence: ${(confidence * 100).toFixed(0)}%\n`;
		const reason = analysis.confidence_reason || '';
		if (reason) {
			message += `Reason: ${reason}\n`;
		}

		if (marketContext) {
			if (marketContext.price) {
				const change = marketContext.change24h ?? 0;
				message += `Price: $${marketContext.price} (${change > 0 ? '+' : ''}${change.toFixed(1)}%)\n`;
			}
			if (typeof marketContext.volumeRatio === 'number') {
				message += `Volume Ratio: ${marketContext.volumeRatio.toFixed(2)}x\n`;
			}
			if (typeof marketContext.rsi === 'number') {
				message += `RSI (14): ${marketContext.rsi.toFixed(1)}\n`;
			}
		}

		if (analysis.time_horizon && typeof analysis.time_horizon === 'string' && analysis.time_horizon.trim()) {
			const horizonLabel = this.timeHorizonLabel(analysis.time_horizon);
			if (horizonLabel) {
				message += `Horizonte: ${horizonLabel}\n`;
			}
		}

		if (analysis.invalidation_hint && typeof analysis.invalidation_hint === 'string' && analysis.invalidation_hint.trim()) {
			message += `Invalidación: ${analysis.invalidation_hint.trim()}\n`;
		}

		if (analysis.sources && Array.isArray(analysis.sources) && analysis.sources.length > 0) {
			const formattedSources = analysis.sources
				.slice(0, 3)
				.map(source => {
					// Handle both full SearchResult objects and plain URLs for backward compatibility
					if (typeof source === 'object' && source.title && source.url) {
						// Escape special chars in title for MarkdownV2
						const escapedTitle = (source.title || 'Source').replace(/[_*\[\]()~`>#+-=|{}.!]/g, '\\$&');
						return `[${escapedTitle}](${source.url})`;
					}
					// Fallback for plain URLs
					return source;
				})
				.join(' | ');
			message += `Sources: ${formattedSources}\n`;
		}

		return message;
	}

	/**
	 * Get event category label
	 * @param {string} category - Event category
	 * @returns {string} Label
	 */
	eventCategoryLabel(category) {
		const labels = {
			price_surge: 'Bullish',
			price_decline: 'Bearish',
			public_figure: 'Public figure mention',
			regulatory: 'Regulatory',
			none: 'Market',
		};
		return labels[category] || 'Market';
	}

	/**
   * Get sentiment label from score
   * @param {number} score - Sentiment score [-1, 1]
   * @returns {string} Label
   */
	sentimentLabel(score) {
		if (score > 0.5) return 'Bullish 🚀';
		if (score > 0) return 'Positive 📈';
		if (score < -0.5) return 'Bearish 📉';
		if (score < 0) return 'Negative 📉';
		return 'Neutral ➡️';
	}

	/**
	 * Get human-friendly label for time horizon
	 * @param {string} horizon - Time horizon
	 * @returns {string} Label
	 */
	timeHorizonLabel(horizon) {
		if (!horizon || typeof horizon !== 'string') return '';
		const labels = {
			very_short_term: 'Muy corto plazo',
			short_term: 'Corto plazo',
			medium_term: 'Medio plazo',
			long_term: 'Largo plazo',
		};
		return labels[horizon.toLowerCase()] || horizon;
	}

	/**
	 * Derive conservative barriers (stop and target) from price, sentiment, and time horizon.
	 * @param {number} price - Entry price
	 * @param {number} sentimentScore - Sentiment score [-1, 1]
	 * @param {string} [timeHorizon='short_term'] - Time horizon string
	 * @param {Object} [options] - Optional overrides for minConviction and rewardMultiplier
	 * @returns {Object|null} { stop, target, side, stopPct, rewardMultiplier } or null if invalid/low conviction
	 */
	deriveBarriers(price, sentimentScore, timeHorizon, options = {}) {
		if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
			return null;
		}
		if (typeof sentimentScore !== 'number' || !Number.isFinite(sentimentScore)) {
			return null;
		}

		const minConviction = typeof options.minConviction === 'number' ? options.minConviction : 0.15;
		if (Math.abs(sentimentScore) < minConviction) {
			return null;
		}

		const side = sentimentScore > 0 ? 'BUY' : 'SELL';
		const TIME_HORIZON_STOP_PCT = {
			very_short_term: 0.01,
			short_term: 0.02,
			medium_term: 0.035,
			long_term: 0.05,
		};
		const normalizedHorizon = typeof timeHorizon === 'string' ? timeHorizon.toLowerCase() : 'short_term';
		const stopPct = TIME_HORIZON_STOP_PCT[normalizedHorizon] || 0.02;
		const rewardMultiplier = typeof options.rewardMultiplier === 'number' ? options.rewardMultiplier : 1.5;
		const riskDistance = price * stopPct;

		if (side === 'BUY') {
			const stop = price - riskDistance;
			const target = price + (rewardMultiplier * riskDistance);
			if (stop > 0 && stop < price && target > price) {
				return {
					stop: parseFloat(stop.toFixed(8)),
					target: parseFloat(target.toFixed(8)),
					side,
					stopPct,
					rewardMultiplier,
				};
			}
		} else {
			const stop = price + riskDistance;
			const target = price - (rewardMultiplier * riskDistance);
			if (target > 0 && stop > price && target < price) {
				return {
					stop: parseFloat(stop.toFixed(8)),
					target: parseFloat(target.toFixed(8)),
					side,
					stopPct,
					rewardMultiplier,
				};
			}
		}

		return null;
	}

	/**
   * Helper for timeout promise
   * @param {number} ms - Timeout milliseconds
   * @returns {Promise} Promise that rejects after timeout
   */
	timeoutPromise(ms) {
		return new Promise((_, reject) =>
			setTimeout(() => reject(new Error('TIMEOUT')), ms),
		);
	}
}

// Singleton instance
let instance = null;

function getAnalyzer() {
	if (!instance) {
		instance = new NewsAnalyzer();
	}
	return instance;
}

module.exports = {
	getAnalyzer,
	NewsAnalyzer,
	setNotificationManager,
	calculateVolumeRatio,
	calculateRSI,
	isKlineOpen,
	parseNewsTimeoutMs,
	parseNewsAlertThreshold,
	getCachedRoutingMetadata,
	hashDiscordWebhook,
};
