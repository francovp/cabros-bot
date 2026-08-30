'use strict';

/**
 * Outcome annotation service for webhook alerts.
 *
 * Looks up rolling per-(exchange, symbol, side, setupType) outcome aggregates
 * from SignalOutcomeService and produces a bounded, non-blocking annotation
 * string that can be appended to the notification footer.
 *
 * Behavior:
 * - Opt-in via ENABLE_OUTCOME_INFORMED_DELIVERY (default false).
 * - Bounded lookup with a default 2-second AbortController deadline so a slow
 *   Firestore read never blocks alert delivery.
 * - Fail-open: any lookup error, timeout, disabled state, or insufficient
 *   sample returns null; the alert is delivered unannotated.
 * - Annotations are derived only from evaluated outcomes; pending/unavailable
 *   signals are skipped (no synthetic hit-rate).
 * - Side-aware: BUY and SELL hit-rates/expectancy are looked up separately so
 *   long signals do not get the short-side history attached.
 *
 * @see src/services/storage/SignalOutcomeService.js for aggregate shape
 * @see src/services/tradingview/parseTradingViewSignal.js for signal metadata
 */

const signalOutcomeService = require('../storage/SignalOutcomeService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { awaitWithTimeout } = require('../../lib/asyncTimeout');

const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_LOOKBACK_DAYS = 30;
const DEFAULT_MIN_SAMPLE_SIZE = 5;
const MIN_LOOKBACK_DAYS = 1;
const MAX_LOOKBACK_DAYS = 365;
const MIN_MIN_SAMPLE_SIZE = 1;
const MAX_MIN_SAMPLE_SIZE = 100;
const SIDE_NORMALIZATION = {
	BUY: 'BUY',
	SELL: 'SELL',
	LONG: 'BUY',
	SHORT: 'SELL',
	COMPRA: 'BUY',
	VENTA: 'SELL',
};

function normalizeSide(rawSide) {
	if (!rawSide || typeof rawSide !== 'string') {
		return null;
	}
	const upper = rawSide.trim().toUpperCase();
	return SIDE_NORMALIZATION[upper] || null;
}

function resolveConfig() {
	const runtimeConfig = getRuntimeConfig();
	const enabledFlag = runtimeConfig.ENABLE_OUTCOME_INFORMED_DELIVERY;
	const isEnabled = enabledFlag === true || enabledFlag === 'true';

	const timeoutMs = Number.isFinite(runtimeConfig.OUTCOME_ANNOTATION_TIMEOUT_MS)
		? Math.max(50, Math.min(runtimeConfig.OUTCOME_ANNOTATION_TIMEOUT_MS, 10000))
		: DEFAULT_TIMEOUT_MS;

	const lookbackDays = Number.isFinite(runtimeConfig.OUTCOME_ANNOTATION_LOOKBACK_DAYS)
		? Math.max(MIN_LOOKBACK_DAYS, Math.min(runtimeConfig.OUTCOME_ANNOTATION_LOOKBACK_DAYS, MAX_LOOKBACK_DAYS))
		: DEFAULT_LOOKBACK_DAYS;

	const minSampleSize = Number.isFinite(runtimeConfig.OUTCOME_ANNOTATION_MIN_SAMPLE)
		? Math.max(MIN_MIN_SAMPLE_SIZE, Math.min(runtimeConfig.OUTCOME_ANNOTATION_MIN_SAMPLE, MAX_MIN_SAMPLE_SIZE))
		: DEFAULT_MIN_SAMPLE_SIZE;

	return {
		isEnabled,
		timeoutMs,
		lookbackDays,
		minSampleSize,
	};
}

function pickAggregate(window, side) {
	if (!window || typeof window !== 'object') {
		return null;
	}
	const winKey = Object.keys(window)[0];
	if (!winKey) {
		return null;
	}
	const windowBucket = window[winKey];
	if (!windowBucket || typeof windowBucket !== 'object') {
		return null;
	}

	if (side && windowBucket.bySide && windowBucket.bySide[side]) {
		return windowBucket.bySide[side];
	}
	if (windowBucket.ALL && typeof windowBucket.ALL === 'object') {
		return windowBucket.ALL;
	}
	return null;
}

function buildAnnotationFromAggregate(aggregate, { side, symbol, exchange, setupType, windowLabel, sampleSizeThreshold }) {
	if (!aggregate || typeof aggregate !== 'object') {
		return null;
	}

	const sampleSize = Number.isFinite(aggregate.sampleSize) ? aggregate.sampleSize : 0;
	if (sampleSize <= 0 || sampleSize < sampleSizeThreshold) {
		return null;
	}

	const hitRatePercent = Number.isFinite(aggregate.hitRatePercent) ? aggregate.hitRatePercent : null;
	const expectancyR = Number.isFinite(aggregate.expectancyR) ? aggregate.expectancyR : null;
	const totalWins = Number.isFinite(aggregate.totalWins) ? aggregate.totalWins : null;
	const totalLosses = Number.isFinite(aggregate.totalLosses) ? aggregate.totalLosses : null;

	if (hitRatePercent === null && expectancyR === null) {
		return null;
	}

	const safeExchange = typeof exchange === 'string' && exchange.length > 0 ? exchange.toUpperCase() : 'UNKNOWN';
	const safeSymbol = typeof symbol === 'string' && symbol.length > 0 ? symbol.toUpperCase() : 'UNKNOWN';
	const safeSide = typeof side === 'string' && side.length > 0 ? side.toUpperCase() : 'ALL';
	const setupSuffix = setupType ? ` \u00b7 ${setupType}` : '';

	const pieces = [];
	if (hitRatePercent !== null) {
		pieces.push(`hitRate ${hitRatePercent.toFixed(0)}%`);
	}
	if (expectancyR !== null) {
		const sign = expectancyR >= 0 ? '+' : '';
		pieces.push(`expectancy ${sign}${expectancyR.toFixed(2)}R`);
	}
	if (totalWins !== null && totalLosses !== null) {
		pieces.push(`W${totalWins}/L${totalLosses}`);
	}

	return {
		exchange: safeExchange,
		symbol: safeSymbol,
		side: safeSide,
		setupType: setupType || null,
		windowLabel: windowLabel || null,
		sampleSize,
		hitRatePercent,
		expectancyR,
		totalWins,
		totalLosses,
		suppressed: false,
		suppressionReason: null,
		summary: `\ud83d\udcca Historial ${windowLabel || '30d'} ${safeSide} ${safeExchange}:${safeSymbol}${setupSuffix}: ${pieces.join(', ')} (n=${sampleSize})`,
	};
}

/**
 * Look up a bounded outcome annotation for the supplied signal context.
 */
async function getOutcomeAnnotation(context, options = {}) {
	const config = resolveConfig();
	if (!config.isEnabled) {
		return null;
	}
	if (!context || typeof context !== 'object') {
		return null;
	}
	const exchange = context.exchange && typeof context.exchange === 'string' ? context.exchange : null;
	const symbol = context.symbol && typeof context.symbol === 'string' ? context.symbol : null;
	if (!symbol) {
		return null;
	}
	const side = normalizeSide(context.side);
	if (!side) {
		return null;
	}
	const setupType = typeof context.setupType === 'string' && context.setupType.trim().length > 0
		? context.setupType.trim().toLowerCase()
		: null;

	const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(50, options.timeoutMs) : config.timeoutMs;
	const now = Date.now();
	const fromIso = new Date(now - config.lookbackDays * 24 * 60 * 60 * 1000).toISOString();
	const toIso = new Date(now).toISOString();
	const windowLabel = `${config.lookbackDays}d`;

	const lookup = signalOutcomeService.summarizeOutcomes({
		from: fromIso,
		to: toIso,
		limit: 1000,
		exchange: exchange || undefined,
		symbol,
	});

	let summary;
	try {
		summary = await awaitWithTimeout(lookup, timeoutMs, 'OutcomeAnnotation lookup exceeded timeout');
	} catch (error) {
		// Fail-open: any lookup error (timeout, network, malformed data) returns
		// null without counting as an "unexpected" service error.
		console.warn('[OutcomeAnnotation] Lookup failed, returning null (fail-open):', error && error.message ? error.message : error);
		return null;
	}

	if (!summary || summary.available !== true) {
		return null;
	}

	const aggregate = pickAggregate(summary.windows || {}, side);
	if (!aggregate) {
		return null;
	}

	return buildAnnotationFromAggregate(aggregate, {
		side,
		symbol,
		exchange,
		setupType,
		windowLabel,
		sampleSizeThreshold: config.minSampleSize,
	});
}

function renderAnnotationLine(annotation) {
	if (!annotation) {
		return null;
	}
	return annotation.summary;
}

function createOutcomeAnnotationService(options = {}) {
	const counters = {
		lookups: 0,
		annotated: 0,
		suppressed: 0,
		disabled: 0,
		errors: 0,
		lastAnnotatedAt: null,
	};
	const onError = typeof options.onError === 'function' ? options.onError : null;

	return {
		isEnabled() {
			return resolveConfig().isEnabled;
		},
		async annotate(context, lookupOptions = {}) {
			counters.lookups += 1;
			if (!resolveConfig().isEnabled) {
				counters.disabled += 1;
				return null;
			}
			const onUnexpectedError = typeof onError === 'function'
				? async (error) => {
					counters.errors += 1;
					try {
						await onError(error);
					} catch (cbError) {
						console.warn('[OutcomeAnnotation] onError callback threw:', cbError.message);
					}
				}
				: null;

			try {
				const annotation = await getOutcomeAnnotation(context, lookupOptions);
				if (annotation) {
					counters.annotated += 1;
					counters.lastAnnotatedAt = new Date().toISOString();
				}
				return annotation;
			} catch (error) {
				counters.errors += 1;
				if (onUnexpectedError) {
					await onUnexpectedError(error);
				}
				return null;
			}
		},
		getStats() {
			return { ...counters };
		},
		resetCounters() {
			counters.lookups = 0;
			counters.annotated = 0;
			counters.suppressed = 0;
			counters.disabled = 0;
			counters.errors = 0;
			counters.lastAnnotatedAt = null;
		},
	};
}

const singleton = createOutcomeAnnotationService();

module.exports = {
	createOutcomeAnnotationService,
	getOutcomeAnnotation,
	outcomeAnnotationService: singleton,
	renderAnnotationLine,
	DEFAULT_TIMEOUT_MS,
	DEFAULT_LOOKBACK_DAYS,
	DEFAULT_MIN_SAMPLE_SIZE,
};
