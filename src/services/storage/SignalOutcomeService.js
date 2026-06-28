'use strict';

const admin = require('firebase-admin');
const { getFirestore } = require('./AlertStorageService');
const { MainClient } = require('binance');

const COLLECTION_NAME = 'tradingSignalOutcomes';
let binanceClient = null;

function getBinanceClient() {
	if (!binanceClient) {
		binanceClient = new MainClient({
			beautifyResponses: true,
		});
	}
	return binanceClient;
}

function isEnabled() {
	return process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING === 'true';
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
	if (!rawSymbol || typeof rawSymbol !== 'string') {
		return { symbol: 'UNKNOWN', exchange: 'UNKNOWN' };
	}
	const parts = rawSymbol.trim().toUpperCase().split(':');
	if (parts.length === 2) {
		return { exchange: parts[0], symbol: parts[1] };
	}
	const exchange = rawExchange ? String(rawExchange).trim().toUpperCase() : 'BINANCE';
	return { exchange, symbol: parts[0] };
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
} = {}) {
	if (!isEnabled()) {
		return null;
	}

	const firestore = getFirestore();
	if (!firestore) {
		return null;
	}

	try {
		const normSymbolInfo = normalizeSymbolAndExchange(symbol, exchange);
		const normSide = normalizeSide(side);
		const now = new Date();

		let entryPrice = typeof price === 'number' ? price : null;
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
		}

		const outcomes = {};
		for (const [winKey, config] of Object.entries(WINDOW_CONFIGS)) {
			outcomes[winKey] = {
				status: 'pending',
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
			outcomeEvaluated: false,
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
 */
async function evaluatePendingOutcomes() {
	if (!isEnabled()) {
		return;
	}

	const firestore = getFirestore();
	if (!firestore) {
		return;
	}

	try {
		const snapshot = await firestore
			.collection(COLLECTION_NAME)
			.where('outcomeEvaluated', '==', false)
			.get();

		if (snapshot.empty) {
			return;
		}

		const now = Date.now();
		const client = getBinanceClient();

		for (const doc of snapshot.docs) {
			const data = doc.data();
			const entryPrice = data.price;
			const side = data.side;
			const receivedAtMs = data.receivedAt.toDate().getTime();

			if (!entryPrice || typeof entryPrice !== 'number') {
				// Mark evaluated if entry price is invalid/missing
				await doc.ref.update({ outcomeEvaluated: true });
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

				const config = WINDOW_CONFIGS[winKey];
				// For non-Binance symbols, we treat historical price data as unavailable
				if (data.exchange !== 'BINANCE') {
					outcome.status = 'unavailable';
					docUpdated = true;
					continue;
				}

				try {
					const klines = await client.getKlines({
						symbol: data.symbol,
						interval: config.interval,
						startTime: receivedAtMs,
						endTime: targetTimeMs,
						limit: 1000,
					});

					if (!Array.isArray(klines) || klines.length === 0) {
						outcome.status = 'unavailable';
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
					console.warn(`[SignalOutcomeService] Error evaluating window ${winKey} for ${data.symbol}:`, error.message);
					// Mark as failed or let it retry? If it's a code/network failure, let it retry, otherwise unavailable
					if (error.message.includes('400') || error.message.includes('Invalid symbol') || error.message.includes('UNKNOWN_SYMBOL')) {
						outcome.status = 'unavailable';
						docUpdated = true;
					} else {
						allResolved = false; // retry on network/rate-limit error
					}
				}
			}

			if (docUpdated) {
				const updateFields = { outcomes };
				if (allResolved) {
					updateFields.outcomeEvaluated = true;
				}
				await doc.ref.update(updateFields);
			}
		}
	} catch (error) {
		console.warn('[SignalOutcomeService] Failed to evaluate pending outcomes:', error.message);
	}
}

/**
 * Compute aggregated metrics.
 */
async function getMetricsSummary({ from, to, limit } = {}) {
	if (!isEnabled()) {
		return 'No measurements found';
	}

	const firestore = getFirestore();
	if (!firestore) {
		return 'No measurements found';
	}

	try {
		// Trigger evaluation in the background without blocking the query response
		void evaluatePendingOutcomes().catch(error => {
			console.warn('[SignalOutcomeService] Background pending outcomes evaluation failed:', error.message);
		});

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

		// Filter for evaluated signals
		const docs = snapshot.docs.map(doc => doc.data());
		const evaluatedSignals = docs.filter(doc =>
			Object.values(doc.outcomes).some(o => o.status === 'evaluated')
		);

		if (evaluatedSignals.length === 0) {
			return 'No measurements found';
		}

		const totalEvaluated = evaluatedSignals.length;
		const windowStats = {};

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

		return {
			totalSignalsEvaluated: totalEvaluated,
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
	COLLECTION_NAME,
};
