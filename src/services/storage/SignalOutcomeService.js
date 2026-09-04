'use strict';

const admin = require('firebase-admin');
const AlertStorageService = require('./AlertStorageService');
const equityMarketDataService = require('./EquityMarketDataService');
const geminiPriceService = require('../grounding/geminiPriceService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { applyStartupJitter, resolveStartupJitterMs } = require('../../lib/startupJitter');
const { MainClient } = require('binance');

const { encodeAlertPaginationCursor, parseAlertPaginationCursor } = require('./alertPaginationCursor');

const COLLECTION_NAME = 'tradingSignalOutcomes';
const HEARTBEAT_COLLECTION_NAME = 'workerHeartbeats';
const HEARTBEAT_DOCUMENT_ID = 'signal-outcome';
const HEARTBEAT_WRITE_TIMEOUT_MS = 5000;
const MAX_WORKER_DRAIN_TIMEOUT_MS = 30000;
const MAX_TIMER_DELAY_MS = 2147483647;
const MAX_CONFIGURED_INTERVAL_MS = 3600000;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';
const INVALID_CURSOR_MESSAGE = 'Invalid before cursor. Use an ISO-8601 timestamp or the nextBefore cursor from a previous response.';
const WORKER_ROLES = new Set(['web', 'worker', 'disabled']);
const DEFAULT_BINANCE_DATA_BASE_URL = 'https://api.binance.com';
const REASON_BINANCE_UNAVAILABLE = 'binance_unavailable';
const REASON_BINANCE_REGION_BLOCKED = 'binance_region_blocked';
const REASON_MARKET_DATA_REGION_BLOCKED = 'market_data_region_blocked';
const REGION_BLOCK_MESSAGE_PATTERNS = [
	'restricted location',
	'service unavailable from restricted',
	'451',
];
const DEFAULT_SIGNAL_OUTCOME_RETENTION_DAYS = 365;
const MAX_SIGNAL_OUTCOME_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;

let binanceClient = null;
let isEvaluating = false;
let workerTimer = null;
let activeEvaluationPromise = null;
let shutdownRequested = false;
let activeIntervalMs = null;
let lastRunAt = null;
let lastRunDurationMs = null;
let lastRunScannedCount = 0;
let lastRunEvaluatedCount = 0;
let lastRunPendingCount = 0;
let lastRunErrorCount = 0;
let lastRunRegionBlockedCount = 0;
let lastEvaluatedDoc = null;
let lastRetentionWarningValue = null;

function getSignalOutcomeRetentionDays() {
	const rawValue = process.env.SIGNAL_OUTCOME_RETENTION_DAYS;
	if (rawValue !== undefined && rawValue !== null) {
		const normalizedValue = String(rawValue).trim();
		const parsedValue = Number(normalizedValue);
		if (!/^\d+$/.test(normalizedValue)
			|| !Number.isSafeInteger(parsedValue)
			|| parsedValue < 1
			|| parsedValue > MAX_SIGNAL_OUTCOME_RETENTION_DAYS) {
			if (lastRetentionWarningValue !== rawValue) {
				console.warn('[SignalOutcomeService] Invalid SIGNAL_OUTCOME_RETENTION_DAYS configuration, using default');
				lastRetentionWarningValue = rawValue;
			}
			const runtimeDays = getRuntimeConfig?.().SIGNAL_OUTCOME_RETENTION_DAYS;
			if (typeof runtimeDays === 'number' && Number.isSafeInteger(runtimeDays) && runtimeDays >= 1 && runtimeDays <= MAX_SIGNAL_OUTCOME_RETENTION_DAYS) {
				return runtimeDays;
			}
			return DEFAULT_SIGNAL_OUTCOME_RETENTION_DAYS;
		}
		lastRetentionWarningValue = null;
	}

	const runtimeDays = getRuntimeConfig?.().SIGNAL_OUTCOME_RETENTION_DAYS;
	if (typeof runtimeDays === 'number' && Number.isSafeInteger(runtimeDays) && runtimeDays >= 1 && runtimeDays <= MAX_SIGNAL_OUTCOME_RETENTION_DAYS) {
		return runtimeDays;
	}

	return DEFAULT_SIGNAL_OUTCOME_RETENTION_DAYS;
}

function getTimestampMillis(value) {
	if (value && typeof value.toMillis === 'function') {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : null;
	}

	if (value && typeof value.toDate === 'function') {
		const millis = value.toDate().getTime();
		return Number.isFinite(millis) ? millis : null;
	}

	if (value instanceof Date) {
		const millis = value.getTime();
		return Number.isFinite(millis) ? millis : null;
	}

	if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) {
		const millis = new Date(value).getTime();
		return Number.isFinite(millis) ? millis : null;
	}

	return null;
}

function buildRetentionExpiryTimestamp(baseDate = new Date()) {
	const baseTime = baseDate instanceof Date ? baseDate.getTime() : Date.now();
	return admin.firestore.Timestamp.fromDate(
		new Date(baseTime + (getSignalOutcomeRetentionDays() * DAY_MS)),
	);
}

function isRetentionExpired(data) {
	const now = Date.now();
	const explicitExpiry = getTimestampMillis(data && data.expiresAt);
	if (explicitExpiry !== null && explicitExpiry <= now) {
		return true;
	}

	const receivedAtMs = getTimestampMillis(data && data.receivedAt);
	if (receivedAtMs !== null && receivedAtMs + (getSignalOutcomeRetentionDays() * DAY_MS) <= now) {
		return true;
	}

	return false;
}

function awaitWithTimeout(promise, timeoutMs, message) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timerId = setTimeout(() => {
			settled = true;
			reject(new Error(message));
		}, timeoutMs);

		Promise.resolve(promise).then((value) => {
			if (settled) return;
			settled = true;
			globalThis.clearTimeout?.(timerId);
			resolve(value);
		}, (error) => {
			if (settled) return;
			settled = true;
			globalThis.clearTimeout?.(timerId);
			reject(error);
		});
	});
}

function getBinanceClient(requestOptions = {}) {
	const baseUrl = resolveBinanceBaseUrl();
	const clientOptions = {
		beautifyResponses: true,
	};
	if (baseUrl) {
		clientOptions.baseUrl = baseUrl;
	}
	if (!binanceClient || (requestOptions && Object.keys(requestOptions).length > 0)) {
		return new MainClient(clientOptions, requestOptions);
	}
	return binanceClient;
}

function resolveBinanceBaseUrl() {
	const configured = process.env.BINANCE_DATA_BASE_URL;
	if (typeof configured === 'string' && configured.trim() !== '') {
		const trimmed = configured.trim();
		if (/^https?:\/\//i.test(trimmed)) {
			return trimmed;
		}
		console.warn(
			`[SignalOutcomeService] Ignoring BINANCE_DATA_BASE_URL="${configured}" — must be an http(s) URL. Falling back to ${DEFAULT_BINANCE_DATA_BASE_URL}.`,
		);
	}
	return DEFAULT_BINANCE_DATA_BASE_URL;
}

function isRegionBlockedError(err) {
	if (!err) {
 return false;
}
	const message = typeof err.message === 'string' ? err.message : '';
	const code = err.code;
	if (code === 451) {
 return true;
}
	if (typeof code === 'string' && code.trim() === '451') {
 return true;
}
	const lower = message.toLowerCase();
	return REGION_BLOCK_MESSAGE_PATTERNS.some((pattern) => lower.includes(pattern));
}

function isEnabled() {
	return process.env.ENABLE_SIGNAL_OUTCOME_TRACKING === 'true';
}

function getWorkerRole() {
	const configuredRole = String(process.env.SIGNAL_OUTCOME_WORKER_ROLE || 'web').trim().toLowerCase();
	return WORKER_ROLES.has(configuredRole) ? configuredRole : 'web';
}

async function persistWorkerHeartbeat() {
	if (getWorkerRole() === 'disabled') {
		return;
	}

	try {
		const firestore = AlertStorageService.getFirestore();
		if (!firestore) {
			return;
		}

		const status = getWorkerStatus();
		await awaitWithTimeout(firestore.collection(HEARTBEAT_COLLECTION_NAME).doc(HEARTBEAT_DOCUMENT_ID).set({
			worker: 'signal-outcome',
			role: status.role,
			enabled: status.enabled,
			running: status.running,
			shutdownRequested: status.shutdownRequested,
			intervalMs: status.intervalMs,
			batchLimit: status.batchLimit,
			maxDurationMs: status.maxDurationMs,
			isEvaluating: status.isEvaluating,
			lastRunAt: status.lastRunAt
				? admin.firestore.Timestamp.fromDate(status.lastRunAt)
				: null,
			lastRunDurationMs: status.lastRunDurationMs,
			lastRunScannedCount: status.lastRunScannedCount,
			lastRunEvaluatedCount: status.lastRunEvaluatedCount,
			lastRunPendingCount: status.lastRunPendingCount,
			lastRunErrorCount: status.lastRunErrorCount,
			updatedAt: admin.firestore.Timestamp.fromDate(new Date()),
		}, { merge: true }), HEARTBEAT_WRITE_TIMEOUT_MS, `Heartbeat write timed out after ${HEARTBEAT_WRITE_TIMEOUT_MS}ms`);
	} catch (error) {
		console.warn('[SignalOutcomeService] Failed to persist worker heartbeat:', error.message);
	}
}

function parsePositiveInteger(val, defaultVal) {
	if (val === undefined || val === null || val === '') {
		return defaultVal;
	}
	const parsed = typeof val === 'number' ? val : Number(String(val).trim());
	if (Number.isSafeInteger(parsed) && parsed > 0) {
		return parsed;
	}
	return defaultVal;
}

function parseTimerInterval(val, defaultVal) {
	const parsed = parsePositiveInteger(val, defaultVal);
	return parsed <= MAX_TIMER_DELAY_MS ? parsed : defaultVal;
}

function getConfiguredInterval(defaultVal) {
	const intervalMs = parseTimerInterval(
		process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS || process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS,
		defaultVal,
	);
	return intervalMs <= MAX_CONFIGURED_INTERVAL_MS ? intervalMs : defaultVal;
}

function normalizeSide(side) {
	if (!side || typeof side !== 'string') {
		return 'BUY';
	}
	const upper = side.trim().toUpperCase();
	if (['SELL', 'VENTA', 'BEARISH', 'SHORT', 'BAJISTA'].includes(upper)) {
		return 'SELL';
	}
	return 'BUY';
}

function normalizeSymbolAndExchange(rawSymbol, rawExchange) {
	if (!rawSymbol || typeof rawSymbol !== 'string' || rawSymbol.trim().toUpperCase() === 'UNKNOWN') {
		return { symbol: 'UNKNOWN', exchange: 'UNKNOWN' };
	}
	const parts = rawSymbol.trim().toUpperCase().split(':');
	if (parts.length === 2) {
		const symbol = parts[1].replace(/\s*\([A-Za-z0-9]+\)$/, '');
		return { exchange: parts[0], symbol };
	}
	const exchange = rawExchange ? String(rawExchange).trim().toUpperCase() : 'BINANCE';
	const symbol = parts[0].replace(/\s*\([A-Za-z0-9]+\)$/, '');
	return { exchange, symbol };
}

function normalizeAssetClass(rawAssetClass) {
	const assetClass = String(rawAssetClass || '').trim().toLowerCase();
	return ['crypto', 'stock', 'forex', 'index'].includes(assetClass) ? assetClass : null;
}

const DEFAULT_MAX_RETRY_ATTEMPTS = 3;
const DEFAULT_MAX_RETRY_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function determineEligibility(normSymbolInfo, assetClass, entryPrice, equityProviderName = null, entryPriceReason = null) {
	const isClassifiedBareStock = normSymbolInfo.exchange === 'UNKNOWN' && assetClass === 'stock';
	if (normSymbolInfo.symbol === 'UNKNOWN' || (normSymbolInfo.exchange === 'UNKNOWN' && !isClassifiedBareStock)) {
		return {
			state: 'unparseable_symbol',
			reason: 'Symbol or exchange unparseable or unknown',
		};
	}
	if (normSymbolInfo.exchange !== 'BINANCE'
		&& !isClassifiedBareStock
		&& !equityMarketDataService.isSupportedExchange(normSymbolInfo.exchange)) {
		return {
			state: 'unsupported_exchange',
			reason: `Exchange ${normSymbolInfo.exchange} not supported by Binance market-data evaluator`,
		};
	}
	if (normSymbolInfo.exchange !== 'BINANCE' && !equityProviderName) {
		return {
			state: equityMarketDataService.REASONS.NOT_CONFIGURED,
			reason: 'Twelve Data equity market-data provider is not configured',
		};
	}
	if (entryPrice === null || entryPrice === undefined) {
		const isTransient = equityMarketDataService.isTransientReason(entryPriceReason)
			|| entryPriceReason === REASON_BINANCE_UNAVAILABLE
			|| entryPriceReason === REASON_BINANCE_REGION_BLOCKED
			|| entryPriceReason === 'twelve_data_unavailable'
			|| entryPriceReason === 'twelve_data_rate_limited'
			|| entryPriceReason === 'twelve_data_timeout';
		if (isTransient) {
			return {
				state: 'pending_entry_price',
				reason: entryPriceReason || 'Entry price temporarily unavailable; will resolve on sweep',
			};
		}
		return {
			state: equityProviderName ? 'equity_provider_unavailable' : 'missing_entry_price',
			reason: entryPriceReason || (equityProviderName
				? `${equityProviderName} entry price unavailable for symbol`
				: 'Entry price unavailable for symbol'),
		};
	}
	return {
		state: 'supported_provider',
		reason: equityProviderName ? `${equityProviderName} market data supported` : 'Binance market data supported',
	};
}

const WINDOW_CONFIGS = {
	'1h': { durationMs: 1 * 60 * 60 * 1000, interval: '5m' },
	'4h': { durationMs: 4 * 60 * 60 * 1000, interval: '15m' },
	'1D': { durationMs: 24 * 60 * 60 * 1000, interval: '1h' },
	'1W': { durationMs: 7 * 24 * 60 * 60 * 1000, interval: '4h' },
};

/**
 * Persist signal metadata to Firestore.
 */
async function recordSignalInternal({
	requestId,
	source,
	symbol,
	exchange,
	timeframe,
	setupType,
	score,
	side,
	price,
	priceSource,
	stop,
	target,
	sources,
	tokenUsage,
	processingTimeMs,
	assetClass,
} = {}) {
	if (!isEnabled()) {
		return null;
	}

	const firestore = AlertStorageService.getFirestore();
	if (!firestore) {
		return null;
	}

	try {
		const normSymbolInfo = normalizeSymbolAndExchange(symbol, exchange);
		const normAssetClass = normalizeAssetClass(assetClass);
		const normSide = normalizeSide(side);
		const now = new Date();
		const equityProviderName = equityMarketDataService.getProviderName(normSymbolInfo.exchange, normAssetClass);

		let entryPrice = typeof price === 'number' && Number.isFinite(price) && price > 0 ? price : null;
		let entryPriceSource = entryPrice !== null
			? (priceSource || (normSymbolInfo.exchange === 'BINANCE' ? 'tradingview-mcp' : (equityProviderName || 'direct')))
			: null;
		let entryPriceReason = null;

		if (entryPrice === null && normSymbolInfo.exchange === 'BINANCE') {
			let abortController = null;
			let timerId = null;
			try {
				abortController = new AbortController();
				const requestOptions = {
					timeout: 5000,
					signal: abortController.signal,
				};
				const client = getBinanceClient(requestOptions);
				const timeoutPromise = new Promise((_, reject) => {
					timerId = setTimeout(() => {
						abortController.abort();
						reject(new Error('Binance getAvgPrice timeout (5000ms)'));
					}, 5000);
				});
				const avgPricePromise = client.getAvgPrice({ symbol: normSymbolInfo.symbol });
				const avgPriceResult = await Promise.race([avgPricePromise, timeoutPromise]);
				if (avgPriceResult && avgPriceResult.price) {
					const parsedAvg = parseFloat(avgPriceResult.price);
					if (Number.isFinite(parsedAvg) && parsedAvg > 0) {
						entryPrice = parsedAvg;
						entryPriceSource = 'binance';
					}
				}
			} catch (err) {
				const isRegionBlocked = isRegionBlockedError(err);
				const isInvalidSymbol = err.message
					&& (err.message.includes('400')
						|| err.message.includes('UNKNOWN_SYMBOL')
						|| err.message.includes('Invalid symbol'));
				if (isRegionBlocked) {
					entryPriceReason = REASON_BINANCE_REGION_BLOCKED;
				} else if (isInvalidSymbol) {
					entryPriceReason = 'binance_invalid_symbol';
				} else {
					entryPriceReason = REASON_BINANCE_UNAVAILABLE;
				}
				console.warn('[SignalOutcomeService] Failed to fetch entry price from Binance:', err.message);
			} finally {
				if (timerId) clearTimeout(timerId);
			}

			if (entryPrice === null && entryPriceReason !== 'binance_invalid_symbol' && geminiPriceService.isGeminiGroundingEnabled({ requireGroundingFlag: true })) {
				try {
					const geminiResult = await geminiPriceService.fetchGeminiPrice(normSymbolInfo.symbol, {
						timeoutMs: 5000,
						tokenUsage,
						requireGroundingFlag: true,
					});
					if (geminiResult && typeof geminiResult.price === 'number' && Number.isFinite(geminiResult.price) && geminiResult.price > 0) {
						entryPrice = geminiResult.price;
						entryPriceSource = 'gemini-grounding';
						entryPriceReason = null;
					}
				} catch (geminiErr) {
					console.warn('[SignalOutcomeService] Failed to fetch tertiary entry price from Gemini:', geminiErr.message);
				}
			}
		} else if (entryPrice === null && equityProviderName) {
			try {
				entryPrice = await equityMarketDataService.getEntryPrice({
					symbol: normSymbolInfo.symbol,
					exchange: normSymbolInfo.exchange === 'UNKNOWN' ? undefined : normSymbolInfo.exchange,
				});
				if (entryPrice !== null) {
					entryPriceSource = equityProviderName;
				}
			} catch (err) {
				entryPriceReason = err.reason || equityMarketDataService.REASONS.UNAVAILABLE;
				console.warn('[SignalOutcomeService] Failed to fetch equity entry price:', entryPriceReason);
			}
		}

		const eligibility = determineEligibility(normSymbolInfo, normAssetClass, entryPrice, equityProviderName, entryPriceReason);
		const isEligible = eligibility.state === 'supported_provider' || eligibility.state === 'pending_entry_price';

		const outcomes = {};
		for (const [winKey, config] of Object.entries(WINDOW_CONFIGS)) {
			outcomes[winKey] = {
				status: isEligible ? 'pending' : 'unavailable',
				reason: isEligible ? null : eligibility.state,
				targetTime: new Date(now.getTime() + config.durationMs).toISOString(),
				price: null,
				return: null,
				maxFavorableExcursion: null,
				maxAdverseExcursion: null,
			};
		}

		const document = {
			receivedAt: admin.firestore.Timestamp.fromDate(now),
			expiresAt: buildRetentionExpiryTimestamp(now),
			requestId: typeof requestId === 'string' ? requestId : 'unknown',
			source: typeof source === 'string' ? source : 'unknown',
			symbol: normSymbolInfo.symbol,
			exchange: normSymbolInfo.exchange,
			assetClass: normAssetClass || null,
			timeframe: timeframe ? String(timeframe).toLowerCase() : null,
			setupType: setupType ? String(setupType).toLowerCase() : null,
			score: typeof score === 'number' && Number.isFinite(score) ? score : null,
			side: normSide,
			price: entryPrice,
			entryPriceSource: entryPriceSource || null,
			stop: typeof stop === 'number' && Number.isFinite(stop) ? stop : null,
			target: typeof target === 'number' && Number.isFinite(target) ? target : null,
			sources: Array.isArray(sources) ? sources : [],
			tokenUsage: tokenUsage || null,
			processingTimeMs: typeof processingTimeMs === 'number' && Number.isFinite(processingTimeMs) ? processingTimeMs : null,
			marketDataProvider: normSymbolInfo.exchange === 'BINANCE' ? 'binance' : (equityProviderName || null),
			eligibilityState: eligibility.state,
			eligibilityReason: eligibility.reason || null,
			outcomeEvaluated: !isEligible,
			outcomes,
		};

		const docRef = await firestore.collection(COLLECTION_NAME).add(document);
		console.debug(`[SignalOutcomeService] Signal outcome recorded with ID: ${docRef.id}`);
		return docRef.id;
	} catch (error) {
		console.warn('[SignalOutcomeService] Failed to record signal outcome:', error.message);
		return null;
	}
}

function recordSignal(params) {
	return trackBackgroundTask(recordSignalInternal(params));
}

/**
 * Scan for pending signals and evaluate outcomes that have passed their target time.
 * Accepts optional options to control batch limit and duration budget.
 */
async function evaluatePendingOutcomesInternal(options = {}) {
	if (!isEnabled()) {
		return { scannedCount: 0, evaluatedCount: 0, skipped: true, reason: 'disabled' };
	}

	if (isEvaluating) {
		return { scannedCount: 0, evaluatedCount: 0, skipped: true, reason: 'already_evaluating' };
	}

	isEvaluating = true;
	const startTime = Date.now();
	let scannedCount = 0;
	let evaluatedCount = 0;
	let pendingCount = 0;
	let errorCount = 0;
	let regionBlockedCount = 0;

	try {
		const firestore = AlertStorageService.getFirestore();
		if (!firestore) {
			return { scannedCount: 0, evaluatedCount: 0, skipped: true, reason: 'no_firestore' };
		}

		const effectiveLimit = parsePositiveInteger(
			options.limit !== undefined ? options.limit : getRuntimeConfig().SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT,
			50
		);

		const effectiveMaxDurationMs = parseTimerInterval(
			options.maxDurationMs !== undefined ? options.maxDurationMs : getRuntimeConfig().SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS,
			30000
		);

		const maxRetryAttempts = parsePositiveInteger(
			options.maxRetryAttempts !== undefined ? options.maxRetryAttempts : getRuntimeConfig().SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS,
			DEFAULT_MAX_RETRY_ATTEMPTS
		);

		const maxRetryAgeMs = parsePositiveInteger(
			options.maxRetryAgeMs !== undefined ? options.maxRetryAgeMs : getRuntimeConfig().SIGNAL_OUTCOME_MAX_RETRY_AGE_MS,
			DEFAULT_MAX_RETRY_AGE_MS
		);

		let query = firestore.collection(COLLECTION_NAME).where('outcomeEvaluated', '==', false);
		if (lastEvaluatedDoc) {
			query = query.startAfter(lastEvaluatedDoc);
		}
		if (effectiveLimit && typeof effectiveLimit === 'number' && effectiveLimit > 0) {
			query = query.limit(effectiveLimit);
		}

		let snapshot = await query.get();

		if (snapshot.empty && lastEvaluatedDoc) {
			lastEvaluatedDoc = null;
			query = firestore.collection(COLLECTION_NAME).where('outcomeEvaluated', '==', false);
			if (effectiveLimit && typeof effectiveLimit === 'number' && effectiveLimit > 0) {
				query = query.limit(effectiveLimit);
			}
			snapshot = await query.get();
		}

		if (snapshot.empty) {
			return { scannedCount: 0, evaluatedCount: 0 };
		}

		const now = Date.now();
		let sweepDeadlineExceeded = false;

		for (const doc of snapshot.docs) {
			if (Date.now() - startTime >= effectiveMaxDurationMs || sweepDeadlineExceeded) {
				console.warn(`[SignalOutcomeService] Outcome evaluation sweep max duration budget (${effectiveMaxDurationMs}ms) exceeded. Halting sweep.`);
				break;
			}

			scannedCount++;
			const data = doc.data() || {};
			if (isRetentionExpired(data)) {
				lastEvaluatedDoc = doc;
				continue;
			}
			let entryPrice = data.price;
			const side = data.side;
			const receivedAtMs = data.receivedAt ? (typeof data.receivedAt.toDate === 'function' ? data.receivedAt.toDate().getTime() : new Date(data.receivedAt).getTime()) : Date.now();
			const equityProviderName = data.exchange === 'BINANCE'
				? null
				: equityMarketDataService.getProviderName(data.exchange, data.assetClass);

			let docUpdated = false;
			let allResolved = true;

			if (!entryPrice || typeof entryPrice !== 'number') {
				// Check structural eligibility first
				if (data.exchange !== 'BINANCE' && !equityProviderName) {
					const isClassifiedBareStock = data.exchange === 'UNKNOWN' && data.assetClass === 'stock';
					const state = (data.symbol === 'UNKNOWN' || (data.exchange === 'UNKNOWN' && !isClassifiedBareStock))
						? 'unparseable_symbol'
						: ((equityMarketDataService.isSupportedExchange(data.exchange) || isClassifiedBareStock) && !equityProviderName
							? equityMarketDataService.REASONS.NOT_CONFIGURED
							: 'unsupported_exchange');
					const outcomes = { ...data.outcomes };
					for (const winKey of Object.keys(outcomes)) {
						if (outcomes[winKey].status === 'pending') {
							outcomes[winKey].status = 'unavailable';
							outcomes[winKey].reason = state;
						}
					}
					await doc.ref.update({
						outcomeEvaluated: true,
						eligibilityState: state,
						eligibilityReason: state === 'unparseable_symbol'
							? 'Symbol or exchange unparseable or unknown'
							: state === equityMarketDataService.REASONS.NOT_CONFIGURED
								? 'Twelve Data equity market-data provider is not configured'
								: `Exchange ${data.exchange} not supported by Binance market-data evaluator`,
						marketDataProvider: data.marketDataProvider || equityProviderName,
						outcomes,
					});
					evaluatedCount++;
					lastEvaluatedDoc = doc;
					continue;
				}

				// Attempt to resolve entry price
				let resolvedPrice = null;
				let resolvedPriceSource = null;
				let entryPriceError = null;

				const remainingMs = effectiveMaxDurationMs - (Date.now() - startTime);
				if (remainingMs <= 0) {
					allResolved = false;
					sweepDeadlineExceeded = true;
					break;
				}

				if (data.exchange === 'BINANCE') {
					let abortController = null;
					let timerId = null;
					try {
						abortController = new AbortController();
						const requestOptions = {
							timeout: Math.max(1, remainingMs),
							signal: abortController.signal,
						};
						const sweepClient = getBinanceClient(requestOptions);
						const timeoutPromise = new Promise((_, reject) => {
							timerId = setTimeout(() => {
								abortController.abort();
								reject(new Error(`Signal outcome sweep deadline exceeded (${effectiveMaxDurationMs}ms)`));
							}, remainingMs);
						});

						const klinesPromise = sweepClient.getKlines({
							symbol: data.symbol,
							interval: '5m',
							startTime: receivedAtMs,
							limit: 1,
						});
						const klines = await Promise.race([klinesPromise, timeoutPromise]);
						if (Array.isArray(klines) && klines.length > 0 && klines[0][1]) {
							const parsed = parseFloat(klines[0][1]);
							if (Number.isFinite(parsed) && parsed > 0) {
								resolvedPrice = parsed;
								resolvedPriceSource = 'binance';
							}
						}
						if (!resolvedPrice) {
							const remainingAfterKlines = effectiveMaxDurationMs - (Date.now() - startTime);
							if (remainingAfterKlines <= 0) {
								throw new Error(`Signal outcome sweep deadline exceeded (${effectiveMaxDurationMs}ms)`);
							}
							const avgPromise = sweepClient.getAvgPrice({ symbol: data.symbol });
							const avgRes = await Promise.race([avgPromise, timeoutPromise]);
							if (avgRes && avgRes.price) {
								const parsed = parseFloat(avgRes.price);
								if (Number.isFinite(parsed) && parsed > 0) {
									resolvedPrice = parsed;
									resolvedPriceSource = 'binance';
								}
							}
						}
					} catch (err) {
						entryPriceError = err;
					} finally {
						if (timerId) clearTimeout(timerId);
					}
				} else {
					try {
						const bars = await equityMarketDataService.getHistoricalBars({
							symbol: data.symbol,
							exchange: data.exchange === 'UNKNOWN' ? undefined : data.exchange,
							interval: '5m',
							startTime: receivedAtMs,
							endTime: receivedAtMs + 2 * 60 * 60 * 1000,
							timeoutMs: remainingMs,
						});
						if (Array.isArray(bars) && bars.length > 0 && bars[0][1]) {
							const parsed = parseFloat(bars[0][1]);
							if (Number.isFinite(parsed) && parsed > 0) {
								resolvedPrice = parsed;
								resolvedPriceSource = equityProviderName;
							}
						}
					} catch (err) {
						entryPriceError = err;
					}
					if (!resolvedPrice) {
						try {
							const quotePrice = await equityMarketDataService.getEntryPrice({
								symbol: data.symbol,
								exchange: data.exchange === 'UNKNOWN' ? undefined : data.exchange,
								timeoutMs: remainingMs,
							});
							if (typeof quotePrice === 'number' && Number.isFinite(quotePrice) && quotePrice > 0) {
								resolvedPrice = quotePrice;
								resolvedPriceSource = equityProviderName;
								entryPriceError = null;
							}
						} catch (err) {
							if (!entryPriceError) entryPriceError = err;
						}
					}
				}

				if (resolvedPrice !== null) {
					entryPrice = resolvedPrice;
					data.price = resolvedPrice;
					data.entryPriceSource = resolvedPriceSource;
					data.eligibilityState = 'supported_provider';
					data.eligibilityReason = data.exchange === 'BINANCE' ? 'Binance market data supported' : 'Twelve Data market data supported';
					docUpdated = true;
				} else {
					const isStructural = entryPriceError && (
						(entryPriceError instanceof equityMarketDataService.EquityMarketDataError && equityMarketDataService.isStructuralReason(entryPriceError.reason))
						|| (entryPriceError.message && (entryPriceError.message.includes('400') || entryPriceError.message.includes('Invalid symbol') || entryPriceError.message.includes('UNKNOWN_SYMBOL')))
					);

					const entryAttempts = (data.entryPriceAttempts || 0) + 1;
					const lastAttemptAt = new Date().toISOString();
					const isExpired = (now - receivedAtMs) > maxRetryAgeMs || entryAttempts >= maxRetryAttempts;

					if (isStructural || isExpired) {
						const outcomes = { ...data.outcomes };
						for (const winKey of Object.keys(outcomes)) {
							if (outcomes[winKey].status === 'pending') {
								outcomes[winKey].status = 'unavailable';
								outcomes[winKey].reason = (entryPriceError && entryPriceError.reason) || 'missing_entry_price';
								if (isExpired && !isStructural) {
									outcomes[winKey].retryExhausted = true;
								}
							}
						}
						await doc.ref.update({
							outcomeEvaluated: true,
							eligibilityState: isStructural && entryPriceError ? (entryPriceError.reason || 'missing_entry_price') : 'missing_entry_price',
							eligibilityReason: 'Entry price unavailable for symbol',
							entryPriceAttempts: entryAttempts,
							lastEntryPriceAttemptAt: lastAttemptAt,
							outcomes,
						});
						evaluatedCount++;
						lastEvaluatedDoc = doc;
						continue;
					} else {
						await doc.ref.update({
							entryPriceAttempts: entryAttempts,
							lastEntryPriceAttemptAt: lastAttemptAt,
						});
						pendingCount++;
						lastEvaluatedDoc = doc;
						continue;
					}
				}
			}

			const outcomes = { ...data.outcomes };

			for (const [winKey, outcome] of Object.entries(outcomes)) {
				if (outcome.status !== 'pending') {
					continue;
				}

				const targetTimeMs = Date.parse(outcome.targetTime);
				if (targetTimeMs > now) {
					allResolved = false; // still waiting for this window to mature
					continue;
				}

				const remainingMs = effectiveMaxDurationMs - (Date.now() - startTime);
				if (remainingMs <= 0) {
					console.warn(`[SignalOutcomeService] Outcome evaluation sweep max duration budget (${effectiveMaxDurationMs}ms) exceeded before window ${winKey} for ${data.symbol}. Halting sweep.`);
					allResolved = false;
					sweepDeadlineExceeded = true;
					break;
				}

				const config = WINDOW_CONFIGS[winKey];

				let abortController = null;
				let timerId = null;

				try {
					let klines;
					if (data.exchange === 'BINANCE') {
						abortController = new AbortController();
						const requestOptions = {
							timeout: Math.max(1, remainingMs),
							signal: abortController.signal,
						};
						const sweepClient = getBinanceClient(requestOptions);
						const klinesPromise = sweepClient.getKlines({
							symbol: data.symbol,
							interval: config.interval,
							startTime: receivedAtMs,
							endTime: targetTimeMs,
							limit: 1000,
						});
						const timeoutPromise = new Promise((_, reject) => {
							timerId = setTimeout(() => {
								abortController.abort();
								reject(new Error(`Signal outcome sweep deadline exceeded (${effectiveMaxDurationMs}ms)`));
							}, remainingMs);
						});
						klines = await Promise.race([klinesPromise, timeoutPromise]);
					} else {
						klines = await equityMarketDataService.getHistoricalBars({
							symbol: data.symbol,
							exchange: data.exchange === 'UNKNOWN' ? undefined : data.exchange,
							interval: config.interval,
							startTime: receivedAtMs,
							endTime: targetTimeMs,
							timeoutMs: remainingMs,
						});
					}

					if (!Array.isArray(klines) || klines.length === 0) {
						const attempts = (outcome.attempts || 0) + 1;
						outcome.attempts = attempts;
						outcome.lastAttemptAt = new Date().toISOString();
						outcome.lastError = 'no_data';
						const isExpired = (now - targetTimeMs) > maxRetryAgeMs || attempts >= maxRetryAttempts;
						if (isExpired) {
							outcome.status = 'unavailable';
							outcome.reason = 'market_data_unavailable';
							outcome.retryExhausted = true;
							docUpdated = true;
						} else {
							allResolved = false;
							docUpdated = true;
						}
						continue;
					}

					const sortedKlines = [...klines].sort((a, b) => (Number(a[0]) || 0) - (Number(b[0]) || 0));
					const lastKline = sortedKlines[sortedKlines.length - 1];
					let exitPrice = parseFloat(lastKline[4]); // close price of last kline

					const stop = typeof data.stop === 'number' && Number.isFinite(data.stop) && data.stop > 0 ? data.stop : null;
					const target = typeof data.target === 'number' && Number.isFinite(data.target) && data.target > 0 ? data.target : null;

					let highestHigh = -Infinity;
					let lowestLow = Infinity;
					let firstHit = null;
					let firstHitTime = null;
					let targetHit = false;
					let stopHit = false;

					for (let i = 0; i < sortedKlines.length; i++) {
						const kline = sortedKlines[i];
						const barTimestamp = typeof kline[0] === 'number' ? kline[0] : parseInt(kline[0], 10);
						const high = parseFloat(kline[2]);
						const low = parseFloat(kline[3]);
						if (high > highestHigh) highestHigh = high;
						if (low < lowestLow) lowestLow = low;

						if (side === 'BUY') {
							const isStopHit = stop !== null && low <= stop;
							const isTargetHit = target !== null && high >= target;

							if (isStopHit && isTargetHit) {
								// Both hit on same candle: conservative assumption is stop hit
								firstHit = 'stop';
								stopHit = true;
								exitPrice = stop;
								firstHitTime = Number.isFinite(barTimestamp) ? new Date(barTimestamp).toISOString() : null;
								break;
							} else if (isStopHit) {
								firstHit = 'stop';
								stopHit = true;
								exitPrice = stop;
								firstHitTime = Number.isFinite(barTimestamp) ? new Date(barTimestamp).toISOString() : null;
								break;
							} else if (isTargetHit) {
								firstHit = 'target';
								targetHit = true;
								exitPrice = target;
								firstHitTime = Number.isFinite(barTimestamp) ? new Date(barTimestamp).toISOString() : null;
								break;
							}
						} else { // SELL
							const isStopHit = stop !== null && high >= stop;
							const isTargetHit = target !== null && low <= target;

							if (isStopHit && isTargetHit) {
								firstHit = 'stop';
								stopHit = true;
								exitPrice = stop;
								firstHitTime = Number.isFinite(barTimestamp) ? new Date(barTimestamp).toISOString() : null;
								break;
							} else if (isStopHit) {
								firstHit = 'stop';
								stopHit = true;
								exitPrice = stop;
								firstHitTime = Number.isFinite(barTimestamp) ? new Date(barTimestamp).toISOString() : null;
								break;
							} else if (isTargetHit) {
								firstHit = 'target';
								targetHit = true;
								exitPrice = target;
								firstHitTime = Number.isFinite(barTimestamp) ? new Date(barTimestamp).toISOString() : null;
								break;
							}
						}
					}

					let returnVal = 0;
					let mfe = 0;
					let mae = 0;

					if (side === 'BUY') {
						returnVal = ((exitPrice - entryPrice) / entryPrice) * 100;
						mfe = ((highestHigh - entryPrice) / entryPrice) * 100;
						mae = ((lowestLow - entryPrice) / entryPrice) * 100;
					} else {
						returnVal = ((entryPrice - exitPrice) / entryPrice) * 100;
						mfe = ((entryPrice - lowestLow) / entryPrice) * 100;
						mae = ((entryPrice - highestHigh) / entryPrice) * 100;
					}

					let rMultiple = null;
					if (stop !== null) {
						const initialRisk = side === 'BUY' ? (entryPrice - stop) : (stop - entryPrice);
						if (initialRisk > 0) {
							const realizedGain = side === 'BUY' ? (exitPrice - entryPrice) : (entryPrice - exitPrice);
							rMultiple = parseFloat((realizedGain / initialRisk).toFixed(4));
						}
					}

					outcome.status = 'evaluated';
					outcome.price = exitPrice;
					outcome.return = parseFloat(returnVal.toFixed(4));
					outcome.maxFavorableExcursion = parseFloat(Math.max(0, mfe).toFixed(4));
					outcome.maxAdverseExcursion = parseFloat(Math.min(0, mae).toFixed(4));
					outcome.firstHit = firstHit;
					outcome.targetHit = targetHit;
					outcome.stopHit = stopHit;
					outcome.firstHitTime = firstHitTime;
					if (rMultiple !== null) {
						outcome.rMultiple = rMultiple;
					}
					docUpdated = true;
				} catch (error) {
					if (abortController) {
						abortController.abort();
					}
					errorCount++;
					console.warn(`[SignalOutcomeService] Error evaluating window ${winKey} for ${data.symbol}:`, error.message);

					if (error.message && (error.message.includes('deadline exceeded') || error.name === 'AbortError')) {
						allResolved = false;
						sweepDeadlineExceeded = true;
						break;
					}

					let isStructural = false;
					let reason = 'market_data_unavailable';
					let errorIdentifier = error.message;

					if (error instanceof equityMarketDataService.EquityMarketDataError) {
						isStructural = equityMarketDataService.isStructuralReason(error.reason);
						reason = error.reason;
						errorIdentifier = error.reason;
					} else if (data.exchange === 'BINANCE') {
						const isBinanceRegionBlocked = isRegionBlockedError(error);
						const isBinanceStructural = !isBinanceRegionBlocked && Boolean(error.message && (
							error.message.includes('400') ||
							error.message.includes('Invalid symbol') ||
							error.message.includes('UNKNOWN_SYMBOL')
						));
						if (isBinanceRegionBlocked) {
							isStructural = false;
							reason = REASON_MARKET_DATA_REGION_BLOCKED;
							errorIdentifier = REASON_MARKET_DATA_REGION_BLOCKED;
							regionBlockedCount++;
						} else {
							isStructural = isBinanceStructural;
							reason = isBinanceStructural ? 'binance_invalid_symbol' : REASON_BINANCE_UNAVAILABLE;
							errorIdentifier = reason;
						}
					} else {
						isStructural = Boolean(error.message && (
							error.message.includes('400') ||
							error.message.includes('Invalid symbol') ||
							error.message.includes('UNKNOWN_SYMBOL')
						));
						reason = 'market_data_unavailable';
						errorIdentifier = error.message;
					}

					if (isStructural) {
						outcome.status = 'unavailable';
						outcome.reason = reason;
						docUpdated = true;
					} else {
						const attempts = (outcome.attempts || 0) + 1;
						outcome.attempts = attempts;
						outcome.lastAttemptAt = new Date().toISOString();
						outcome.lastError = errorIdentifier;

						const isExpired = (now - targetTimeMs) > maxRetryAgeMs || attempts >= maxRetryAttempts;
						if (isExpired) {
							outcome.status = 'unavailable';
							outcome.reason = reason;
							outcome.retryExhausted = true;
							docUpdated = true;
						} else {
							outcome.status = 'pending';
							// Surface the region-blocked classification to operators without
							// forcing a terminal unavailable state. Replaced on the next
							// transient attempt if the host becomes reachable.
							if (reason) {
								outcome.reason = reason;
							}
							allResolved = false;
							docUpdated = true;
						}
					}
				} finally {
					if (timerId) {
						clearTimeout(timerId);
					}
				}
			}

			if (docUpdated) {
				const updateFields = { outcomes };
				if (data.price !== undefined && data.price !== null) {
					updateFields.price = data.price;
				}
				if (data.entryPriceSource) {
					updateFields.entryPriceSource = data.entryPriceSource;
				}
				if (data.eligibilityState) {
					updateFields.eligibilityState = data.eligibilityState;
				}
				if (data.eligibilityReason) {
					updateFields.eligibilityReason = data.eligibilityReason;
				}
				if (allResolved) {
					updateFields.outcomeEvaluated = true;
				}
				await doc.ref.update(updateFields);
				evaluatedCount++;
			}

			if (!allResolved) {
				pendingCount++;
			}

			if (!sweepDeadlineExceeded) {
				lastEvaluatedDoc = doc;
			}

			if (sweepDeadlineExceeded) {
				break;
			}
		}

		return { scannedCount, evaluatedCount, durationMs: Date.now() - startTime };
	} catch (error) {
		errorCount++;
		console.warn('[SignalOutcomeService] Failed to evaluate pending outcomes:', error.message);
		return { scannedCount, evaluatedCount, error: error.message };
	} finally {
		isEvaluating = false;
		lastRunAt = new Date();
		lastRunDurationMs = Date.now() - startTime;
		lastRunScannedCount = scannedCount;
		lastRunEvaluatedCount = evaluatedCount;
		lastRunPendingCount = pendingCount;
		lastRunErrorCount = errorCount;
		lastRunRegionBlockedCount = regionBlockedCount;
	}
}

function evaluatePendingOutcomes(options = {}) {
	if (isEvaluating) {
		return Promise.resolve({ scannedCount: 0, evaluatedCount: 0, skipped: true, reason: 'already_evaluating' });
	}

	const evaluationPromise = evaluatePendingOutcomesInternal(options);
	const trackedPromise = evaluationPromise.finally(() => {
		if (activeEvaluationPromise === trackedPromise) {
			activeEvaluationPromise = null;
		}
	});
	activeEvaluationPromise = trackedPromise;
	return trackedPromise;
}

function runScheduledSweep() {
	if (shutdownRequested) {
		return;
	}

	evaluatePendingOutcomes()
		.then(() => persistWorkerHeartbeat())
		.catch((err) => {
			console.warn('[SignalOutcomeService] Scheduled worker sweep failed:', err.message);
		});
}

/**
 * Start background autonomous evaluation worker if signal outcome tracking is enabled.
 */
function startWorker(options = {}) {
	if (!isEnabled()) {
		return false;
	}

	const source = options.source === 'worker' ? 'worker' : 'web';
	if (getWorkerRole() !== source) {
		return false;
	}

	if (workerTimer) {
		return true;
	}

	shutdownRequested = false;

	const DEFAULT_INTERVAL_MS = 300000;
	let intervalMs;
	if (options.intervalMs !== undefined && options.intervalMs !== null) {
		intervalMs = parseTimerInterval(options.intervalMs, DEFAULT_INTERVAL_MS);
	} else {
		intervalMs = getConfiguredInterval(DEFAULT_INTERVAL_MS);
	}

	activeIntervalMs = intervalMs;

	const globalStartupJitter = process.env.WORKER_STARTUP_JITTER_MS !== undefined && process.env.WORKER_STARTUP_JITTER_MS.trim() !== ''
		? Number.parseInt(process.env.WORKER_STARTUP_JITTER_MS, 10)
		: null;
	const startupJitterMs = resolveStartupJitterMs({
		envVar: 'SIGNAL_OUTCOME_WORKER_STARTUP_JITTER_MS',
		runtimeKey: 'SIGNAL_OUTCOME_WORKER_STARTUP_JITTER_MS',
		defaultValue: Number.isFinite(globalStartupJitter) ? globalStartupJitter : 5000,
	});
	if (startupJitterMs > 0) {
		console.info(`[SignalOutcomeService] Applying startup jitter (${startupJitterMs}ms max)`);
	}

	// Trigger initial sweep non-blockingly after server readiness, with optional startup jitter
	if (startupJitterMs > 0) {
		Promise.resolve().then(async () => {
			await applyStartupJitter(startupJitterMs);
			if (shutdownRequested) {
				return;
			}
			runScheduledSweep();
		});
	} else {
		Promise.resolve().then(() => {
			runScheduledSweep();
		});
	}

	workerTimer = setInterval(runScheduledSweep, intervalMs);

	if (workerTimer && options.unref !== false && typeof workerTimer.unref === 'function') {
		workerTimer.unref();
	}
	void persistWorkerHeartbeat();

	return true;
}

/**
 * Stop background autonomous evaluation worker and clear timers.
 */
function stopWorker(options = {}) {
	shutdownRequested = true;
	if (workerTimer) {
		clearInterval(workerTimer);
		workerTimer = null;
	}
	activeIntervalMs = null;
	lastEvaluatedDoc = null;

	if (options.drain !== true || !activeEvaluationPromise) {
		isEvaluating = false;
		return persistWorkerHeartbeat();
	}

	const drainTimeoutMs = Math.min(getWorkerStatus().maxDurationMs, MAX_WORKER_DRAIN_TIMEOUT_MS);
	return awaitWithTimeout(
		activeEvaluationPromise,
		drainTimeoutMs,
		`Dedicated worker drain timed out after ${drainTimeoutMs}ms`,
	)
		.catch((error) => {
			console.warn('[SignalOutcomeService] Dedicated worker drain failed:', error.message);
		})
		.then(() => {
			isEvaluating = false;
			return persistWorkerHeartbeat();
		});
}

/**
 * Get operational status of the evaluation worker.
 */
function getWorkerStatus() {
	const DEFAULT_INTERVAL_MS = 300000;
	const runtimeConfig = getRuntimeConfig();
	const intervalMs = activeIntervalMs || getConfiguredInterval(DEFAULT_INTERVAL_MS);

	const batchLimit = parsePositiveInteger(runtimeConfig.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT, 50);

	const maxDurationMs = parseTimerInterval(runtimeConfig.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS, 30000);
	const maxRetryAttempts = parsePositiveInteger(runtimeConfig.SIGNAL_OUTCOME_MAX_RETRY_ATTEMPTS, DEFAULT_MAX_RETRY_ATTEMPTS);
	const maxRetryAgeMs = parsePositiveInteger(runtimeConfig.SIGNAL_OUTCOME_MAX_RETRY_AGE_MS, DEFAULT_MAX_RETRY_AGE_MS);

	return {
		enabled: isEnabled(),
		role: getWorkerRole(),
		running: workerTimer !== null,
		shutdownRequested,
		intervalMs,
		batchLimit,
		maxDurationMs,
		maxRetryAttempts,
		maxRetryAgeMs,
		isEvaluating,
		lastRunAt,
		lastRunDurationMs,
		lastRunScannedCount,
		lastRunEvaluatedCount,
		lastRunPendingCount,
		lastRunErrorCount,
		lastRunRegionBlockedCount,
		timerId: workerTimer ? true : null,
	};
}

function createCoverageBucket() {
	return {
		received: 0,
		eligible: 0,
		evaluated: 0,
		pending: 0,
		unavailable: 0,
	};
}

function createEmptyMetricsSummary() {
	return {
		available: false,
		totalSignalsReceived: 0,
		totalSignalsEligible: 0,
		totalSignalsEvaluated: 0,
		totalSignalsPending: 0,
		totalSignalsUnavailable: 0,
		coveragePercent: 0,
		isCoverageComplete: true,
		targetHitRatePercent: 0,
		stopHitRatePercent: 0,
		expectancyR: null,
		populationNote: 'No outcome measurements found for the requested criteria.',
		exchangeBreakdown: {},
		providerBreakdown: {},
		entryPriceSourceBreakdown: {},
		eligibilityBreakdown: {},
		windows: {},
		drawdownProxy: {
			averageMaxAdverseExcursionPercent: 0,
			absoluteMaxAdverseExcursionPercent: 0,
		},
		falsePositiveCandidatesCount: 0,
		falsePositiveCandidates: [],
		latencyCostMetadata: {
			averageProcessingTimeMs: null,
			tokenUsage: {
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
			},
		},
	};
}

function createWindowAccumulator() {
	return {
		ALL: createWindowBucket(),
		BUY: createWindowBucket(),
		SELL: createWindowBucket(),
	};
}

function createWindowBucket() {
	return {
		totalWinsEvaluated: 0,
		hits: 0,
		targetHits: 0,
		stopHits: 0,
		targetEligibleWindows: 0,
		stopEligibleWindows: 0,
		totalReturn: 0,
		totalMfe: 0,
		totalMae: 0,
		maxMae: 0,
		totalR: 0,
		rCount: 0,
	};
}

function accumulateWindowBucket(accumulator, signal, outcome, key) {
	if (!accumulator[key]) {
		accumulator[key] = createWindowBucket();
	}
	const bucket = accumulator[key];
	bucket.totalWinsEvaluated++;
	if (outcome.return > 0) {
		bucket.hits++;
	}
	const hasTargetBarrier = typeof signal.target === 'number' && Number.isFinite(signal.target) && signal.target > 0;
	const hasStopBarrier = typeof signal.stop === 'number' && Number.isFinite(signal.stop) && signal.stop > 0;
	if (hasTargetBarrier) {
		bucket.targetEligibleWindows++;
	}
	if (hasStopBarrier) {
		bucket.stopEligibleWindows++;
	}
	if (outcome.targetHit === true || outcome.firstHit === 'target') {
		bucket.targetHits++;
	}
	if (outcome.stopHit === true || outcome.firstHit === 'stop') {
		bucket.stopHits++;
	}
	if (typeof outcome.rMultiple === 'number' && Number.isFinite(outcome.rMultiple)) {
		bucket.totalR += outcome.rMultiple;
		bucket.rCount++;
	}
	bucket.totalReturn += outcome.return;
	bucket.totalMfe += outcome.maxFavorableExcursion;
	bucket.totalMae += outcome.maxAdverseExcursion;
	if (outcome.maxAdverseExcursion < bucket.maxMae) {
		bucket.maxMae = outcome.maxAdverseExcursion;
	}
}

function buildWindowStatsShape(bucket) {
	const total = bucket.totalWinsEvaluated;
	return {
		totalSignals: total,
		hitRatePercent: parseFloat(((bucket.hits / total) * 100).toFixed(2)),
		targetEligibleWindows: bucket.targetEligibleWindows,
		stopEligibleWindows: bucket.stopEligibleWindows,
		targetHitRatePercent: bucket.targetEligibleWindows > 0
			? parseFloat(((bucket.targetHits / bucket.targetEligibleWindows) * 100).toFixed(2))
			: 0,
		stopHitRatePercent: bucket.stopEligibleWindows > 0
			? parseFloat(((bucket.stopHits / bucket.stopEligibleWindows) * 100).toFixed(2))
			: 0,
		expectancyR: bucket.rCount > 0 ? parseFloat((bucket.totalR / bucket.rCount).toFixed(4)) : null,
		averageReturnPercent: parseFloat((bucket.totalReturn / total).toFixed(4)),
		averageMfePercent: parseFloat((bucket.totalMfe / total).toFixed(4)),
		averageMaePercent: parseFloat((bucket.totalMae / total).toFixed(4)),
		maxAdverseExcursionPercent: parseFloat(bucket.maxMae.toFixed(4)),
	};
}

/**
 * Compute aggregated metrics.
 */
async function summarizeOutcomes({ from, to, limit, symbol, exchange, status, window } = {}) {
	const firestore = AlertStorageService.getFirestore();
	if (!firestore) {
		throw createStorageUnavailableError();
	}

		const parsedFrom = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const parsedTo = to ? new Date(to) : new Date();

		const retentionDays = getSignalOutcomeRetentionDays();
		const retentionCutoffMs = Date.now() - (retentionDays * DAY_MS);
		const effectiveFromMs = Math.max(parsedFrom.getTime(), retentionCutoffMs);
		if (effectiveFromMs > parsedTo.getTime()) {
			return createEmptyMetricsSummary();
		}
		const effectiveFrom = new Date(effectiveFromMs);

		const targetLimit = limit || 1000;
		const batchSize = Math.min(targetLimit, 100);
		const activeDocs = [];
		let lastDoc = null;

		while (activeDocs.length < targetLimit) {
			let query = firestore
				.collection(COLLECTION_NAME)
				.where('receivedAt', '>=', admin.firestore.Timestamp.fromDate(effectiveFrom))
				.where('receivedAt', '<=', admin.firestore.Timestamp.fromDate(parsedTo))
				.limit(batchSize);

			if (lastDoc) {
				query = query.startAfter(lastDoc);
			}

			let snapshot;
			try {
				snapshot = await query.get();
			} catch (error) {
				throw createStorageUnavailableError(error);
			}

			if (!snapshot || snapshot.empty) {
				break;
			}

			for (const doc of snapshot.docs) {
				if (!isRetentionExpired(doc.data() || {})) {
					activeDocs.push(doc);
					if (activeDocs.length >= targetLimit) {
						break;
					}
				}
			}

			if (snapshot.docs.length < batchSize) {
				break;
			}
			lastDoc = snapshot.docs[snapshot.docs.length - 1];
		}

		if (activeDocs.length === 0) {
			return createEmptyMetricsSummary();
		}

	let docs = activeDocs.map(doc => ({
		...doc.data(),
		id: doc.id,
		receivedAt: getDocTimestamp(doc.data()),
	}));

	if (symbol || exchange || status || window) {
		docs = docs.filter(doc => matchesOutcomeFilters(doc, { symbol, exchange, status, window, from, to }));
	}

	if (docs.length === 0) {
		return createEmptyMetricsSummary();
	}

	let totalSignalsReceived = docs.length;
	let totalSignalsEligible = 0;
	let totalSignalsEvaluated = 0;
	let totalSignalsPending = 0;
	let totalSignalsUnavailable = 0;

	const exchangeBreakdown = {};
	const providerBreakdown = {};
	const entryPriceSourceBreakdown = {};
	const eligibilityBreakdown = {};

	const evaluatedSignals = [];

	for (const doc of docs) {
		const docExchange = doc.exchange || 'UNKNOWN';
		const docSymbol = doc.symbol || 'UNKNOWN';
		const marketDataProvider = doc.marketDataProvider || (docExchange === 'BINANCE' ? 'binance' : 'none');
		const entryPriceSource = doc.entryPriceSource || (doc.price !== null && doc.price !== undefined ? (doc.marketDataProvider || 'unknown') : 'none');

		let eligibilityState = doc.eligibilityState;
		if (!eligibilityState) {
			if (docSymbol === 'UNKNOWN' || docExchange === 'UNKNOWN') {
				eligibilityState = 'unparseable_symbol';
			} else if (docExchange !== 'BINANCE' && !equityMarketDataService.isSupportedExchange(docExchange)) {
				eligibilityState = 'unsupported_exchange';
			} else if (doc.price === null || doc.price === undefined) {
				eligibilityState = 'missing_entry_price';
			} else {
				eligibilityState = 'supported_provider';
			}
		}

		const isEligible = eligibilityState === 'supported_provider';
		if (isEligible) {
			totalSignalsEligible++;
		}

		eligibilityBreakdown[eligibilityState] = (eligibilityBreakdown[eligibilityState] || 0) + 1;
		entryPriceSourceBreakdown[entryPriceSource] = (entryPriceSourceBreakdown[entryPriceSource] || 0) + 1;

		if (!exchangeBreakdown[docExchange]) {
			exchangeBreakdown[docExchange] = createCoverageBucket();
		}
		if (!providerBreakdown[marketDataProvider]) {
			providerBreakdown[marketDataProvider] = createCoverageBucket();
		}
		exchangeBreakdown[docExchange].received++;
		providerBreakdown[marketDataProvider].received++;
		if (isEligible) {
			exchangeBreakdown[docExchange].eligible++;
			providerBreakdown[marketDataProvider].eligible++;
		}

		const outcomesValues = doc.outcomes ? Object.values(doc.outcomes) : [];
		const hasEvaluated = outcomesValues.some(o => o.status === 'evaluated');
		const hasPending = doc.outcomeEvaluated === false && outcomesValues.some(o => o.status === 'pending');

		if (hasEvaluated) {
			totalSignalsEvaluated++;
			exchangeBreakdown[docExchange].evaluated++;
			providerBreakdown[marketDataProvider].evaluated++;
			evaluatedSignals.push(doc);
		} else if (hasPending) {
			totalSignalsPending++;
			exchangeBreakdown[docExchange].pending++;
			providerBreakdown[marketDataProvider].pending++;
		} else {
			totalSignalsUnavailable++;
			exchangeBreakdown[docExchange].unavailable++;
			providerBreakdown[marketDataProvider].unavailable++;
		}
	}

	const windowStats = {};
	if (evaluatedSignals.length > 0) {
		for (const winKey of Object.keys(WINDOW_CONFIGS)) {
			const accumulator = createWindowAccumulator();

			for (const signal of evaluatedSignals) {
				const outcome = signal.outcomes ? signal.outcomes[winKey] : null;
				if (outcome && outcome.status === 'evaluated') {
					accumulateWindowBucket(accumulator, signal, outcome, 'ALL');
					const side = signal.side === 'SELL' ? 'SELL' : 'BUY';
					accumulateWindowBucket(accumulator, signal, outcome, side);
					const setupKey = typeof signal.setupType === 'string' && signal.setupType.trim()
						? signal.setupType.trim().toLowerCase()
						: null;
					if (setupKey) {
						accumulateWindowBucket(accumulator, signal, outcome, setupKey);
					}
				}
			}

			if (accumulator.ALL.totalWinsEvaluated > 0) {
				const built = buildWindowStatsShape(accumulator.ALL);
				const bySide = {};
				if (accumulator.BUY.totalWinsEvaluated > 0) {
					bySide.BUY = buildWindowStatsShape(accumulator.BUY);
				}
				if (accumulator.SELL.totalWinsEvaluated > 0) {
					bySide.SELL = buildWindowStatsShape(accumulator.SELL);
				}
				const bySetupType = {};
				for (const [setupKey, bucket] of Object.entries(accumulator)) {
					if (setupKey === 'ALL' || setupKey === 'BUY' || setupKey === 'SELL') continue;
					if (bucket.totalWinsEvaluated > 0) {
						bySetupType[setupKey] = buildWindowStatsShape(bucket);
					}
				}
				windowStats[winKey] = {
					...built,
					...(Object.keys(bySide).length > 0 ? { bySide } : {}),
					...(Object.keys(bySetupType).length > 0 ? { bySetupType } : {}),
				};
			}
		}
	}

	let totalAllMae = 0;
	let maeCount = 0;
	let absoluteMaxMae = 0;
	let totalTokenCost = 0;
	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let totalProcessingTime = 0;
	let processingTimeCount = 0;

	const falsePositiveCandidates = [];

	for (const signal of evaluatedSignals) {
		if (signal.tokenUsage) {
			totalTokenCost += signal.tokenUsage.totalCost || 0;
			totalInputTokens += signal.tokenUsage.inputTokens || signal.tokenUsage.promptTokens || 0;
			totalOutputTokens += signal.tokenUsage.outputTokens || signal.tokenUsage.completionTokens || 0;
		}
		if (typeof signal.processingTimeMs === 'number') {
			totalProcessingTime += signal.processingTimeMs;
			processingTimeCount++;
		}

		let worstMae = 0;
		let bestReturn = -Infinity;
		let resolvedReturn = null;

		for (const outcome of Object.values(signal.outcomes || {})) {
			if (outcome && outcome.status === 'evaluated') {
				if (outcome.maxAdverseExcursion < worstMae) {
					worstMae = outcome.maxAdverseExcursion;
				}
				if (outcome.return > bestReturn) {
					bestReturn = outcome.return;
				}
				resolvedReturn = outcome.return;
			}
		}

		totalAllMae += worstMae;
		maeCount++;
		if (worstMae < absoluteMaxMae) {
			absoluteMaxMae = worstMae;
		}

		const isHighConfidence = (Math.abs(signal.score) >= 0.75 || (signal.source === 'news-monitor' && Math.abs(signal.score) >= 0.7));
		if (isHighConfidence && (resolvedReturn < -1 || worstMae < -3)) {
			falsePositiveCandidates.push({
				symbol: signal.symbol,
				source: signal.source,
				side: signal.side,
				score: signal.score,
				price: signal.price,
				worstReturn: resolvedReturn,
				worstMae,
			});
		}
	}

	const averageWorstMae = maeCount > 0 ? parseFloat((totalAllMae / maeCount).toFixed(4)) : 0;
	const averageProcessingTimeMs = processingTimeCount > 0 ? Math.round(totalProcessingTime / processingTimeCount) : null;
	const coveragePercent = totalSignalsReceived > 0 ? parseFloat(((totalSignalsEvaluated / totalSignalsReceived) * 100).toFixed(2)) : 0;
	const isCoverageComplete = totalSignalsEvaluated === totalSignalsReceived;

	let allTargetHits = 0;
	let allStopHits = 0;
	let allEvaluatedWindows = 0;
	let allTargetEligible = 0;
	let allStopEligible = 0;
	let allTotalR = 0;
	let allRCount = 0;

	for (const signal of evaluatedSignals) {
		const hasTargetBarrier = typeof signal.target === 'number' && Number.isFinite(signal.target) && signal.target > 0;
		const hasStopBarrier = typeof signal.stop === 'number' && Number.isFinite(signal.stop) && signal.stop > 0;
		for (const outcome of Object.values(signal.outcomes || {})) {
			if (outcome && outcome.status === 'evaluated') {
				allEvaluatedWindows++;
				if (hasTargetBarrier) {
					allTargetEligible++;
				}
				if (hasStopBarrier) {
					allStopEligible++;
				}
				if (outcome.targetHit === true || outcome.firstHit === 'target') {
					allTargetHits++;
				}
				if (outcome.stopHit === true || outcome.firstHit === 'stop') {
					allStopHits++;
				}
				if (typeof outcome.rMultiple === 'number' && Number.isFinite(outcome.rMultiple)) {
					allTotalR += outcome.rMultiple;
					allRCount++;
				}
			}
		}
	}

	const overallTargetHitRatePercent = allTargetEligible > 0
		? parseFloat(((allTargetHits / allTargetEligible) * 100).toFixed(2))
		: 0;
	const overallStopHitRatePercent = allStopEligible > 0
		? parseFloat(((allStopHits / allStopEligible) * 100).toFixed(2))
		: 0;
	const overallExpectancyR = allRCount > 0
		? parseFloat((allTotalR / allRCount).toFixed(4))
		: null;

	return {
		available: true,
		totalSignalsReceived,
		totalSignalsEligible,
		totalSignalsEvaluated,
		totalSignalsPending,
		totalSignalsUnavailable,
		coveragePercent,
		isCoverageComplete,
		targetHitRatePercent: overallTargetHitRatePercent,
		stopHitRatePercent: overallStopHitRatePercent,
		expectancyR: overallExpectancyR,
		populationNote: !isCoverageComplete
			? `Metrics represent ${totalSignalsEvaluated} evaluated signals out of ${totalSignalsReceived} total received signals (${coveragePercent}% coverage).`
			: 'Metrics represent 100% of received signals.',
		exchangeBreakdown,
		providerBreakdown,
		entryPriceSourceBreakdown,
		eligibilityBreakdown,
		windows: windowStats,
		drawdownProxy: {
			averageMaxAdverseExcursionPercent: averageWorstMae,
			absoluteMaxAdverseExcursionPercent: parseFloat(absoluteMaxMae.toFixed(4)),
		},
		falsePositiveCandidatesCount: falsePositiveCandidates.length,
		falsePositiveCandidates: falsePositiveCandidates.slice(0, 5),
		latencyCostMetadata: {
			averageProcessingTimeMs,
			tokenUsage: {
				inputTokens: totalInputTokens,
				outputTokens: totalOutputTokens,
				totalCost: parseFloat(totalTokenCost.toFixed(6)),
			},
		},
	};
}

async function getMetricsSummary({ from, to, limit } = {}) {
	if (!isEnabled()) {
		return 'No measurements found';
	}

	try {
		const summary = await summarizeOutcomes({ from, to, limit });
		if (!summary || !summary.available || summary.totalSignalsReceived === 0) {
			return 'No measurements found';
		}
		const { available, ...rest } = summary;
		return rest;
	} catch (error) {
		console.warn('[SignalOutcomeService] Failed to compute metrics summary:', error.message);
		return 'No measurements found';
	}
}

function createStorageUnavailableError(cause) {
	const error = new Error('Signal outcome tracking is enabled but Firestore is unavailable. Check Firestore credentials and project configuration.');
	error.code = STORAGE_UNAVAILABLE_CODE;
	if (cause) {
		error.cause = cause;
	}
	return error;
}

function clampOutcomeLimit(limit) {
	if (!Number.isInteger(limit) || limit < 1) {
		return DEFAULT_LIMIT;
	}
	return Math.min(limit, MAX_LIMIT);
}

function getNumericValue(value) {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function summarizeTokenUsage(tokenUsage) {
	if (!tokenUsage || typeof tokenUsage !== 'object') {
		return null;
	}

	return {
		inputTokens: getNumericValue(tokenUsage.inputTokens || tokenUsage.promptTokens),
		outputTokens: getNumericValue(tokenUsage.outputTokens || tokenUsage.completionTokens),
		totalTokens: getNumericValue(tokenUsage.totalTokens || tokenUsage.total),
		totalCost: getNumericValue(tokenUsage.totalCost),
	};
}

function getDocTimestamp(data) {
	if (!data || typeof data !== 'object') {
		return null;
	}

	if (data.receivedAt && typeof data.receivedAt.toDate === 'function') {
		return data.receivedAt.toDate().toISOString();
	}

	if (data.receivedAt instanceof Date) {
		return data.receivedAt.toISOString();
	}

	if (typeof data.receivedAt === 'string' && !Number.isNaN(Date.parse(data.receivedAt))) {
		return new Date(data.receivedAt).toISOString();
	}

	return null;
}

function getDocCursorValues(doc) {
	if (!doc || typeof doc.data !== 'function') {
		return null;
	}

	const data = doc.data() || {};
	const receivedAt = getDocTimestamp(data);
	if (!receivedAt || typeof doc.id !== 'string' || !doc.id) {
		return null;
	}

	return {
		receivedAt,
		documentId: doc.id,
	};
}

function buildParsedCursorTimestamp(parsedCursor) {
	return admin.firestore.Timestamp.fromDate(new Date(parsedCursor.receivedAt));
}

function formatOutcomeDocument(doc) {
	const data = doc.data() || {};
	const receivedAt = getDocTimestamp(data);

	return {
		id: doc.id,
		receivedAt,
		requestId: typeof data.requestId === 'string' ? data.requestId : 'unknown',
		source: typeof data.source === 'string' ? data.source : 'unknown',
		symbol: typeof data.symbol === 'string' ? data.symbol : 'UNKNOWN',
		exchange: typeof data.exchange === 'string' ? data.exchange : 'UNKNOWN',
		assetClass: typeof data.assetClass === 'string' ? data.assetClass : null,
		timeframe: typeof data.timeframe === 'string' ? data.timeframe : null,
		setupType: typeof data.setupType === 'string' ? data.setupType : null,
		score: typeof data.score === 'number' && Number.isFinite(data.score) ? data.score : null,
		side: data.side === 'SELL' ? 'SELL' : 'BUY',
		price: typeof data.price === 'number' && Number.isFinite(data.price) ? data.price : null,
		entryPriceSource: typeof data.entryPriceSource === 'string' ? data.entryPriceSource : null,
		stop: typeof data.stop === 'number' && Number.isFinite(data.stop) ? data.stop : null,
		target: typeof data.target === 'number' && Number.isFinite(data.target) ? data.target : null,
		marketDataProvider: typeof data.marketDataProvider === 'string' ? data.marketDataProvider : null,
		eligibilityState: typeof data.eligibilityState === 'string' ? data.eligibilityState : null,
		eligibilityReason: typeof data.eligibilityReason === 'string' ? data.eligibilityReason : null,
		outcomeEvaluated: Boolean(data.outcomeEvaluated),
		outcomes: data.outcomes && typeof data.outcomes === 'object' ? data.outcomes : {},
		sources: Array.isArray(data.sources) ? data.sources : [],
		tokenUsage: summarizeTokenUsage(data.tokenUsage),
		processingTimeMs: typeof data.processingTimeMs === 'number' && Number.isFinite(data.processingTimeMs) ? data.processingTimeMs : null,
	};
}

function matchesOutcomeFilters(outcome, { symbol, exchange, status, window, from, to }) {
	if (from && outcome.receivedAt && new Date(outcome.receivedAt) < new Date(from)) {
		return false;
	}
	if (to && outcome.receivedAt && new Date(outcome.receivedAt) > new Date(to)) {
		return false;
	}
	if (symbol) {
		const targetSymbol = symbol.includes(':') ? symbol.split(':')[1].toUpperCase() : symbol.toUpperCase();
		if ((outcome.symbol || '').toUpperCase() !== targetSymbol) {
			return false;
		}
		if (symbol.includes(':') && !exchange) {
			const inferredExchange = symbol.split(':')[0].toUpperCase();
			if ((outcome.exchange || '').toUpperCase() !== inferredExchange) {
				return false;
			}
		}
	}
	if (exchange) {
		if ((outcome.exchange || '').toUpperCase() !== exchange.toUpperCase()) {
			return false;
		}
	}
	if (window && status) {
		const winKey = Object.keys(WINDOW_CONFIGS).find(k => k.toLowerCase() === window.toLowerCase()) || window;
		const winOutcome = outcome.outcomes && outcome.outcomes[winKey];
		if (!winOutcome || winOutcome.status !== status) {
			return false;
		}
	} else if (window) {
		const winKey = Object.keys(WINDOW_CONFIGS).find(k => k.toLowerCase() === window.toLowerCase()) || window;
		if (!outcome.outcomes || !outcome.outcomes[winKey]) {
			return false;
		}
	} else if (status) {
		const outcomesList = Object.values(outcome.outcomes || {});
		if (status === 'evaluated') {
			const hasEvaluated = outcomesList.some(o => o.status === 'evaluated');
			if (!hasEvaluated) return false;
		} else if (status === 'pending') {
			const hasPending = outcome.outcomeEvaluated === false && outcomesList.some(o => o.status === 'pending');
			if (!hasPending) return false;
		} else if (status === 'unavailable') {
			const hasEvaluated = outcomesList.some(o => o.status === 'evaluated');
			const hasPending = outcome.outcomeEvaluated === false && outcomesList.some(o => o.status === 'pending');
			if (hasEvaluated || hasPending) return false;
		}
	}
	return true;
}

async function listOutcomes({
	before,
	limit = DEFAULT_LIMIT,
	symbol,
	exchange,
	status,
	window,
	from,
	to,
	signal,
	maxScanDocs,
} = {}) {
	if (!isEnabled()) {
		return null;
	}

	const firestore = AlertStorageService.getFirestore();
	if (!firestore) {
		throw createStorageUnavailableError();
	}

	const pageSize = clampOutcomeLimit(limit);
	const targetCount = pageSize + 1;
	const scanLimit = Math.max(targetCount, MAX_LIMIT);
	const matches = [];
	const parsedBeforeCursor = before
		? parseAlertPaginationCursor(before)
		: null;
	if (before && !parsedBeforeCursor) {
		const error = new Error(INVALID_CURSOR_MESSAGE);
		error.code = 'INVALID_REQUEST';
		throw error;
	}

	let pageCursor = parsedBeforeCursor
		? {
			receivedAt: parsedBeforeCursor.receivedAt,
			documentId: parsedBeforeCursor.documentId,
		}
		: null;

	let totalScanned = 0;

	while (matches.length < targetCount) {
		if (signal && signal.aborted) {
			const abortErr = new Error('Signal outcome listing query was aborted');
			abortErr.name = 'AbortError';
			abortErr.code = 'ABORTED';
			throw abortErr;
		}

		let query = firestore
			.collection(COLLECTION_NAME)
			.orderBy('receivedAt', 'desc')
			.orderBy(admin.firestore.FieldPath.documentId(), 'desc')
			.limit(scanLimit);

		if (pageCursor) {
			const cursorTimestamp = buildParsedCursorTimestamp(pageCursor);
			if (pageCursor.documentId) {
				query = query.startAfter(cursorTimestamp, pageCursor.documentId);
			} else {
				query = query.where('receivedAt', '<', cursorTimestamp);
			}
		}

		let snapshot;
		try {
			snapshot = await query.get();
		} catch (error) {
			console.warn('[SignalOutcomeService] Failed to read signal outcomes from Firestore:', error.message);
			throw createStorageUnavailableError(error);
		}

		if (signal && signal.aborted) {
			const abortErr = new Error('Signal outcome listing query was aborted');
			abortErr.name = 'AbortError';
			abortErr.code = 'ABORTED';
			throw abortErr;
		}

		if (!snapshot || snapshot.empty || !Array.isArray(snapshot.docs) || snapshot.docs.length === 0) {
			break;
		}

		totalScanned += snapshot.docs.length;

		for (const doc of snapshot.docs) {
			if (isRetentionExpired(doc.data() || {})) {
				continue;
			}
			const formatted = formatOutcomeDocument(doc);
			if (matchesOutcomeFilters(formatted, { symbol, exchange, status, window, from, to })) {
				matches.push(formatted);
				if (matches.length >= targetCount) {
					break;
				}
			}
		}

		const lastDocCursor = getDocCursorValues(snapshot.docs[snapshot.docs.length - 1]);
		if (!lastDocCursor) {
			break;
		}

		pageCursor = lastDocCursor;
		if (snapshot.docs.length < scanLimit || (maxScanDocs && totalScanned >= maxScanDocs)) {
			break;
		}
	}

	const outcomes = matches.slice(0, pageSize);
	return {
		outcomes,
		hasMore: matches.length > pageSize,
		nextBefore: outcomes.length > 0
			? encodeAlertPaginationCursor(outcomes[outcomes.length - 1])
			: null,
	};
}

function _resetForTesting() {
	lastRetentionWarningValue = null;
	binanceClient = null;
	lastEvaluatedDoc = null;
	isEvaluating = false;
	shutdownRequested = false;
	activeIntervalMs = null;
	lastRunAt = null;
	lastRunDurationMs = null;
	lastRunScannedCount = 0;
	lastRunEvaluatedCount = 0;
	lastRunPendingCount = 0;
	lastRunErrorCount = 0;
	lastRunRegionBlockedCount = 0;
}

module.exports = {
	isEnabled,
	recordSignal,
	evaluatePendingOutcomes,
	getMetricsSummary,
	summarizeOutcomes,
	listOutcomes,
	normalizeSide,
	normalizeSymbolAndExchange,
	startWorker,
	stopWorker,
	getWorkerStatus,
	getWorkerRole,
	COLLECTION_NAME,
	HEARTBEAT_COLLECTION_NAME,
	STORAGE_UNAVAILABLE_CODE,
	INVALID_CURSOR_MESSAGE,
	_resetForTesting,
};
