'use strict';

const admin = require('firebase-admin');
const AlertStorageService = require('./AlertStorageService');
const equityMarketDataService = require('./EquityMarketDataService');
const { MainClient } = require('binance');

const COLLECTION_NAME = 'tradingSignalOutcomes';
const HEARTBEAT_COLLECTION_NAME = 'workerHeartbeats';
const HEARTBEAT_DOCUMENT_ID = 'signal-outcome';
const HEARTBEAT_WRITE_TIMEOUT_MS = 5000;
const MAX_WORKER_DRAIN_TIMEOUT_MS = 30000;
const MAX_TIMER_DELAY_MS = 2147483647;
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
	return process.env.ENABLE_SIGNAL_OUTCOME_TRACKING === 'true'
		|| process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING === 'true';
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
		return { exchange: parts[0], symbol: parts[1] };
	}
	const exchange = rawExchange ? String(rawExchange).trim().toUpperCase() : 'BINANCE';
	return { exchange, symbol: parts[0] };
}

function normalizeAssetClass(rawAssetClass) {
	const assetClass = String(rawAssetClass || '').trim().toLowerCase();
	return ['crypto', 'stock'].includes(assetClass) ? assetClass : null;
}

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
async function recordSignal({
	requestId,
	source,
	symbol,
	exchange,
	timeframe,
	setupType,
	score,
	side,
	price,
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

		let entryPrice = typeof price === 'number' ? price : null;
		let entryPriceReason = null;
		if (entryPrice === null && normSymbolInfo.exchange === 'BINANCE') {
			try {
				const client = getBinanceClient();
				const avgPriceResult = await client.getAvgPrice({ symbol: normSymbolInfo.symbol });
				if (avgPriceResult && avgPriceResult.price) {
					entryPrice = parseFloat(avgPriceResult.price);
				}
			} catch (err) {
				console.warn('[SignalOutcomeService] Failed to fetch entry price from Binance:', err.message);
			}
		} else if (entryPrice === null && equityProviderName) {
			try {
				entryPrice = await equityMarketDataService.getEntryPrice({
					symbol: normSymbolInfo.symbol,
					exchange: normSymbolInfo.exchange === 'UNKNOWN' ? undefined : normSymbolInfo.exchange,
				});
			} catch (err) {
				entryPriceReason = err.reason || equityMarketDataService.REASONS.UNAVAILABLE;
				console.warn('[SignalOutcomeService] Failed to fetch equity entry price:', entryPriceReason);
			}
		}

		const eligibility = determineEligibility(normSymbolInfo, normAssetClass, entryPrice, equityProviderName, entryPriceReason);
		const isEligible = eligibility.state === 'supported_provider';

		const outcomes = {};
		for (const [winKey, config] of Object.entries(WINDOW_CONFIGS)) {
			outcomes[winKey] = {
				status: isEligible ? 'pending' : 'unavailable',
				reason: isEligible ? undefined : eligibility.state,
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
			assetClass: normAssetClass,
			timeframe: timeframe ? String(timeframe).toLowerCase() : null,
			setupType: setupType ? String(setupType).toLowerCase() : null,
			score: typeof score === 'number' ? score : null,
			side: normSide,
			price: entryPrice,
			stop: typeof stop === 'number' ? stop : null,
			target: typeof target === 'number' ? target : null,
			sources: Array.isArray(sources) ? sources : [],
			tokenUsage: tokenUsage || null,
			processingTimeMs: typeof processingTimeMs === 'number' ? processingTimeMs : null,
			marketDataProvider: normSymbolInfo.exchange === 'BINANCE' ? 'binance' : equityProviderName,
			eligibilityState: eligibility.state,
			eligibilityReason: eligibility.reason,
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
			options.limit !== undefined ? options.limit : process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT,
			50
		);

		const effectiveMaxDurationMs = parseTimerInterval(
			options.maxDurationMs !== undefined ? options.maxDurationMs : process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS,
			30000
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
			const entryPrice = data.price;
			const side = data.side;
			const receivedAtMs = data.receivedAt.toDate().getTime();
			const equityProviderName = data.exchange === 'BINANCE'
				? null
				: equityMarketDataService.getProviderName(data.exchange, data.assetClass);

			if (!entryPrice || typeof entryPrice !== 'number') {
				// Mark evaluated if entry price is invalid/missing
				const outcomes = { ...data.outcomes };
				for (const winKey of Object.keys(outcomes)) {
					if (outcomes[winKey].status === 'pending') {
						outcomes[winKey].status = 'unavailable';
						outcomes[winKey].reason = 'missing_entry_price';
					}
				}
				await doc.ref.update({
					outcomeEvaluated: true,
					eligibilityState: 'missing_entry_price',
					eligibilityReason: 'Entry price unavailable for symbol',
					outcomes,
				});
				evaluatedCount++;
				lastEvaluatedDoc = doc;
				continue;
			}

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

			let docUpdated = false;
			let allResolved = true;
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
						outcome.status = 'unavailable';
						outcome.reason = 'market_data_unavailable';
						docUpdated = true;
						continue;
					}

					const lastKline = klines[klines.length - 1];
					const exitPrice = parseFloat(lastKline[4]); // close price of last kline

					let highestHigh = -Infinity;
					let lowestLow = Infinity;
					for (const kline of klines) {
						const high = parseFloat(kline[2]);
						const low = parseFloat(kline[3]);
						if (high > highestHigh) highestHigh = high;
						if (low < lowestLow) lowestLow = low;
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

					outcome.status = 'evaluated';
					outcome.price = exitPrice;
					outcome.return = parseFloat(returnVal.toFixed(4));
					outcome.maxFavorableExcursion = parseFloat(Math.max(0, mfe).toFixed(4));
					outcome.maxAdverseExcursion = parseFloat(Math.min(0, mae).toFixed(4));
					docUpdated = true;
				} catch (error) {
					if (abortController) {
						abortController.abort();
					}
					errorCount++;
					console.warn(`[SignalOutcomeService] Error evaluating window ${winKey} for ${data.symbol}:`, error.message);
					if (error instanceof equityMarketDataService.EquityMarketDataError) {
						outcome.status = 'unavailable';
						outcome.reason = error.reason;
						docUpdated = true;
					} else if (error.message.includes('deadline exceeded') || error.name === 'AbortError') {
						allResolved = false;
						sweepDeadlineExceeded = true;
						break;
					} else if (error.message.includes('400') || error.message.includes('Invalid symbol') || error.message.includes('UNKNOWN_SYMBOL')) {
						outcome.status = 'unavailable';
						outcome.reason = 'market_data_unavailable';
						docUpdated = true;
					} else {
						allResolved = false; // retry on network/rate-limit error
					}
				} finally {
					if (timerId) {
						clearTimeout(timerId);
					}
				}
			}

			if (docUpdated) {
				const updateFields = { outcomes };
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
	} else if (process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS) {
		intervalMs = parseTimerInterval(process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS, DEFAULT_INTERVAL_MS);
	} else if (process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS) {
		intervalMs = parseTimerInterval(process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS, DEFAULT_INTERVAL_MS);
	} else {
		intervalMs = DEFAULT_INTERVAL_MS;
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
	const intervalMs = activeIntervalMs || (
		process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS
			? parseTimerInterval(process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS, DEFAULT_INTERVAL_MS)
			: (process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS
				? parseTimerInterval(process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS, DEFAULT_INTERVAL_MS)
				: DEFAULT_INTERVAL_MS)
	);

	const batchLimit = parsePositiveInteger(process.env.SIGNAL_OUTCOME_EVALUATION_BATCH_LIMIT, 50);

	const maxDurationMs = parseTimerInterval(process.env.SIGNAL_OUTCOME_EVALUATION_MAX_DURATION_MS, 30000);

	return {
		enabled: isEnabled(),
		role: getWorkerRole(),
		running: workerTimer !== null,
		shutdownRequested,
		intervalMs,
		batchLimit,
		maxDurationMs,
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

/**
 * Compute aggregated metrics.
 */
async function getMetricsSummary({ from, to, limit } = {}) {
	if (!isEnabled()) {
		return 'No measurements found';
	}

	const firestore = AlertStorageService.getFirestore();
	if (!firestore) {
		return 'No measurements found';
	}

	try {
		const parsedFrom = from ? new Date(from) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		const parsedTo = to ? new Date(to) : new Date();

		const snapshot = await firestore
			.collection(COLLECTION_NAME)
			.where('receivedAt', '>=', admin.firestore.Timestamp.fromDate(parsedFrom))
			.where('receivedAt', '<=', admin.firestore.Timestamp.fromDate(parsedTo))
			.limit(limit || 1000)
			.get();

		if (snapshot.empty) {
			return 'No measurements found';
		}

		const docs = snapshot.docs.map(doc => doc.data());

		let totalSignalsReceived = docs.length;
		let totalSignalsEligible = 0;
		let totalSignalsEvaluated = 0;
		let totalSignalsPending = 0;
		let totalSignalsUnavailable = 0;

		const exchangeBreakdown = {};
		const providerBreakdown = {};
		const eligibilityBreakdown = {};

		const evaluatedSignals = [];

		for (const doc of docs) {
			const exchange = doc.exchange || 'UNKNOWN';
			const symbol = doc.symbol || 'UNKNOWN';
			const marketDataProvider = doc.marketDataProvider || (exchange === 'BINANCE' ? 'binance' : 'none');

			let eligibilityState = doc.eligibilityState;
			if (!eligibilityState) {
				if (symbol === 'UNKNOWN' || exchange === 'UNKNOWN') {
					eligibilityState = 'unparseable_symbol';
				} else if (exchange !== 'BINANCE') {
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

			if (!exchangeBreakdown[exchange]) {
				exchangeBreakdown[exchange] = createCoverageBucket();
			}
			if (!providerBreakdown[marketDataProvider]) {
				providerBreakdown[marketDataProvider] = createCoverageBucket();
			}
			exchangeBreakdown[exchange].received++;
			providerBreakdown[marketDataProvider].received++;
			if (isEligible) {
				exchangeBreakdown[exchange].eligible++;
				providerBreakdown[marketDataProvider].eligible++;
			}

			const outcomesValues = doc.outcomes ? Object.values(doc.outcomes) : [];
			const hasEvaluated = outcomesValues.some(o => o.status === 'evaluated');
			const hasPending = doc.outcomeEvaluated === false && outcomesValues.some(o => o.status === 'pending');

			if (hasEvaluated) {
				totalSignalsEvaluated++;
				exchangeBreakdown[exchange].evaluated++;
				providerBreakdown[marketDataProvider].evaluated++;
				evaluatedSignals.push(doc);
			} else if (hasPending) {
				totalSignalsPending++;
				exchangeBreakdown[exchange].pending++;
				providerBreakdown[marketDataProvider].pending++;
			} else {
				totalSignalsUnavailable++;
				exchangeBreakdown[exchange].unavailable++;
				providerBreakdown[marketDataProvider].unavailable++;
			}
		}

		const windowStats = {};
		if (evaluatedSignals.length > 0) {
			for (const winKey of Object.keys(WINDOW_CONFIGS)) {
				let totalWinsEvaluated = 0;
				let hits = 0;
				let totalReturn = 0;
				let totalMfe = 0;
				let totalMae = 0;
				let maxMae = 0; // absolute maximum drawdown seen

				for (const signal of evaluatedSignals) {
					const outcome = signal.outcomes[winKey];
					if (outcome && outcome.status === 'evaluated') {
						totalWinsEvaluated++;
						if (outcome.return > 0) {
							hits++;
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
						averageReturnPercent: parseFloat((totalReturn / totalWinsEvaluated).toFixed(4)),
						averageMfePercent: parseFloat((totalMfe / totalWinsEvaluated).toFixed(4)),
						averageMaePercent: parseFloat((totalMae / totalWinsEvaluated).toFixed(4)),
						maxAdverseExcursionPercent: parseFloat(maxMae.toFixed(4)), // drawdown proxy
					};
				}
			}
		}

		// Drawdown proxy across all evaluated windows
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

			// Gather excursions for drawdown proxy and detect false positive candidates
			let worstMae = 0;
			let bestReturn = -Infinity;
			let resolvedReturn = null;

			for (const outcome of Object.values(signal.outcomes)) {
				if (outcome.status === 'evaluated') {
					if (outcome.maxAdverseExcursion < worstMae) {
						worstMae = outcome.maxAdverseExcursion;
					}
					if (outcome.return > bestReturn) {
						bestReturn = outcome.return;
					}
					resolvedReturn = outcome.return; // last resolved window return
				}
			}

			totalAllMae += worstMae;
			maeCount++;
			if (worstMae < absoluteMaxMae) {
				absoluteMaxMae = worstMae;
			}

			// False positive candidate: high confidence/score but poor performance (e.g. return < -2% or worstMae < -5%)
			const isHighConfidence = (signal.score >= 0.75 || (signal.source === 'news-monitor' && signal.score >= 0.7));
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

		return {
			totalSignalsReceived,
			totalSignalsEligible,
			totalSignalsEvaluated,
			totalSignalsPending,
			totalSignalsUnavailable,
			coveragePercent,
			isCoverageComplete,
			populationNote: !isCoverageComplete
				? `Metrics represent ${totalSignalsEvaluated} evaluated signals out of ${totalSignalsReceived} total received signals (${coveragePercent}% coverage).`
				: 'Metrics represent 100% of received signals.',
			exchangeBreakdown,
			providerBreakdown,
			eligibilityBreakdown,
			windows: windowStats,
			drawdownProxy: {
				averageMaxAdverseExcursionPercent: averageWorstMae,
				absoluteMaxAdverseExcursionPercent: parseFloat(absoluteMaxMae.toFixed(4)),
			},
			falsePositiveCandidatesCount: falsePositiveCandidates.length,
			falsePositiveCandidates: falsePositiveCandidates.slice(0, 5), // top 5 examples
			latencyCostMetadata: {
				averageProcessingTimeMs,
				tokenUsage: {
					inputTokens: totalInputTokens,
					outputTokens: totalOutputTokens,
					totalCost: parseFloat(totalTokenCost.toFixed(6)),
				},
			},
		};
	} catch (error) {
		console.warn('[SignalOutcomeService] Failed to compute metrics summary:', error.message);
		return 'No measurements found';
	}
}

module.exports = {
	isEnabled,
	recordSignal,
	evaluatePendingOutcomes,
	getMetricsSummary,
	normalizeSide,
	normalizeSymbolAndExchange,
	startWorker,
	stopWorker,
	getWorkerStatus,
	getWorkerRole,
	COLLECTION_NAME,
	HEARTBEAT_COLLECTION_NAME,
};
