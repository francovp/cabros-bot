'use strict';

const admin = require('firebase-admin');
const AlertStorageService = require('./AlertStorageService');
const equityMarketDataService = require('./EquityMarketDataService');
const geminiPriceService = require('../grounding/geminiPriceService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
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
let lastEvaluatedDoc = null;

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
	if (!binanceClient || (requestOptions && Object.keys(requestOptions).length > 0)) {
		return new MainClient({
			beautifyResponses: true,
		}, requestOptions);
	}
	return binanceClient;
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
			|| entryPriceReason === 'binance_unavailable'
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
				const isTransient = !err.message.includes('400')
					&& !err.message.includes('UNKNOWN_SYMBOL')
					&& !err.message.includes('Invalid symbol');
				entryPriceReason = isTransient ? 'binance_unavailable' : 'binance_invalid_symbol';
				console.warn('[SignalOutcomeService] Failed to fetch entry price from Binance:', err.message);
			} finally {
				if (timerId) clearTimeout(timerId);
			}

			if (entryPrice === null && entryPriceReason !== 'binance_invalid_symbol') {
				try {
					const geminiResult = await geminiPriceService.fetchGeminiPrice(normSymbolInfo.symbol, {
						timeoutMs: 5000,
						tokenUsage,
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
			const data = doc.data();
			let entryPrice = data.price;
			const side = data.side;
			const receivedAtMs = data.receivedAt.toDate().getTime();
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

					if (!resolvedPrice) {
						const remainingAfterBinance = effectiveMaxDurationMs - (Date.now() - startTime);
						const isStructural = entryPriceError && entryPriceError.message && (
							entryPriceError.message.includes('400')
							|| entryPriceError.message.includes('Invalid symbol')
							|| entryPriceError.message.includes('UNKNOWN_SYMBOL')
						);
						if (remainingAfterBinance > 0 && !isStructural) {
							try {
								const tertiaryPrice = await geminiPriceService.fetchGeminiPrice(data.symbol, {
									timeoutMs: Math.min(5000, remainingAfterBinance),
								});
								if (tertiaryPrice && typeof tertiaryPrice.price === 'number' && Number.isFinite(tertiaryPrice.price) && tertiaryPrice.price > 0) {
									resolvedPrice = tertiaryPrice.price;
									resolvedPriceSource = 'gemini-grounding';
									entryPriceError = null;
								}
							} catch (geminiErr) {
								console.warn('[SignalOutcomeService] Sweep failed to fetch tertiary entry price from Gemini:', geminiErr.message);
							}
						}
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
						const isBinanceStructural = Boolean(error.message && (
							error.message.includes('400') ||
							error.message.includes('Invalid symbol') ||
							error.message.includes('UNKNOWN_SYMBOL')
						));
						isStructural = isBinanceStructural;
						reason = isBinanceStructural ? 'binance_invalid_symbol' : 'binance_unavailable';
						errorIdentifier = reason;
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

	// Trigger initial sweep non-blockingly after server readiness
	Promise.resolve().then(() => {
		runScheduledSweep();
	});

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

/**
 * Compute aggregated metrics.
 */
async function summarizeOutcomes({ from, to, limit, symbol, exchange, status, window } = {}) {
	const firestore = AlertStorageService.getFirestore();
	if (!firestore) {
		throw createStorageUnavailableError();
	}

	let snapshot;
	try {
		const parsedFrom = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const parsedTo = to ? new Date(to) : new Date();

		snapshot = await firestore
			.collection(COLLECTION_NAME)
			.where('receivedAt', '>=', admin.firestore.Timestamp.fromDate(parsedFrom))
			.where('receivedAt', '<=', admin.firestore.Timestamp.fromDate(parsedTo))
			.limit(limit || 1000)
			.get();
	} catch (error) {
		throw createStorageUnavailableError(error);
	}

	if (snapshot.empty) {
		return createEmptyMetricsSummary();
	}

	let docs = snapshot.docs.map(doc => ({
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
			let totalWinsEvaluated = 0;
			let hits = 0;
			let targetHits = 0;
			let stopHits = 0;
			let targetEligibleWindows = 0;
			let stopEligibleWindows = 0;
			let totalReturn = 0;
			let totalMfe = 0;
			let totalMae = 0;
			let maxMae = 0;
			let totalR = 0;
			let rCount = 0;

			for (const signal of evaluatedSignals) {
				const outcome = signal.outcomes ? signal.outcomes[winKey] : null;
				if (outcome && outcome.status === 'evaluated') {
					totalWinsEvaluated++;
					if (outcome.return > 0) {
						hits++;
					}
					const hasTargetBarrier = typeof signal.target === 'number' && Number.isFinite(signal.target) && signal.target > 0;
					const hasStopBarrier = typeof signal.stop === 'number' && Number.isFinite(signal.stop) && signal.stop > 0;
					if (hasTargetBarrier) {
						targetEligibleWindows++;
					}
					if (hasStopBarrier) {
						stopEligibleWindows++;
					}
					if (outcome.targetHit === true || outcome.firstHit === 'target') {
						targetHits++;
					}
					if (outcome.stopHit === true || outcome.firstHit === 'stop') {
						stopHits++;
					}
					if (typeof outcome.rMultiple === 'number' && Number.isFinite(outcome.rMultiple)) {
						totalR += outcome.rMultiple;
						rCount++;
					}
					totalReturn += outcome.return;
					totalMfe += outcome.maxFavorableExcursion;
					totalMae += outcome.maxAdverseExcursion;
					if (outcome.maxAdverseExcursion < maxMae) {
						maxMae = outcome.maxAdverseExcursion;
					}
				}
			}

			if (totalWinsEvaluated > 0) {
				windowStats[winKey] = {
					totalSignals: totalWinsEvaluated,
					hitRatePercent: parseFloat(((hits / totalWinsEvaluated) * 100).toFixed(2)),
					targetEligibleWindows,
					stopEligibleWindows,
					targetHitRatePercent: targetEligibleWindows > 0
						? parseFloat(((targetHits / targetEligibleWindows) * 100).toFixed(2))
						: 0,
					stopHitRatePercent: stopEligibleWindows > 0
						? parseFloat(((stopHits / stopEligibleWindows) * 100).toFixed(2))
						: 0,
					expectancyR: rCount > 0 ? parseFloat((totalR / rCount).toFixed(4)) : null,
					averageReturnPercent: parseFloat((totalReturn / totalWinsEvaluated).toFixed(4)),
					averageMfePercent: parseFloat((totalMfe / totalWinsEvaluated).toFixed(4)),
					averageMaePercent: parseFloat((totalMae / totalWinsEvaluated).toFixed(4)),
					maxAdverseExcursionPercent: parseFloat(maxMae.toFixed(4)),
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

	while (matches.length < targetCount) {
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

		if (!snapshot || snapshot.empty || !Array.isArray(snapshot.docs) || snapshot.docs.length === 0) {
			break;
		}

		for (const doc of snapshot.docs) {
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
		if (snapshot.docs.length < scanLimit) {
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
};
