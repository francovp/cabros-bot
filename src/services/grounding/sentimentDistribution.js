/**
 * Sentiment score distribution telemetry (issue #1031).
 *
 * Production evidence: 97 enriched alerts produced only 7 distinct
 * `sentiment_score` magnitudes and 96 of them sat at or above 0.75. A channel
 * that emits a near-constant ~0.8 cannot rank alerts, tune thresholds, or
 * compare signal quality over time, so the saturation has to be *measured*
 * rather than inferred from a single stored score.
 *
 * Two independent saturation rules are applied, because the reported production
 * failure is NOT caught by a spread rule alone:
 *
 *  1. `spread_collapse` — `p90 - p10 < minSpread`. This is the classic
 *     "everything reads 0.8" signature.
 *  2. `top_band_concentration` — at least `topBandMinShare` of samples at or
 *     above `topBandFloor`. For the reported distribution `p90 - p10` is 0.15,
 *     which is comfortably ABOVE a 0.1 floor, yet 96 of 97 samples are at or
 *     above 0.75. The pathology is upward bunching, not a narrow total range,
 *     so a spread-only guard would have stayed silent on the exact incident
 *     this module was written for.
 *
 * `distinctValueCount` and `bucketCount` are reported as diagnostics but are
 * deliberately NOT saturation triggers. The `alert-enrichment` prompt now asks
 * the model to score against reference anchor bands, which intentionally
 * concentrates output onto band centres. A low distinct-value count therefore
 * measures anchor adherence, not calibration failure, and treating it as a
 * warning would fire on a healthy anchored prompt.
 *
 * Everything here is pure and fail-open: a malformed input yields an empty
 * report, never a throw. Alert enrichment must never be blocked by telemetry.
 */

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bucket bounds and percentiles are rounded to this many decimals so a
 * `0.1`-wide bucket is reported as `0.3`, not `0.30000000000000004`. JSON
 * consumers and equality assertions both depend on the clean value.
 */
const REPORT_PRECISION = 6;

const SPREAD_COLLAPSE_REASON = 'spread_collapse';
const TOP_BAND_CONCENTRATION_REASON = 'top_band_concentration';
const INSUFFICIENT_SAMPLE_REASON = 'insufficient_sample';
const NO_SAMPLE_REASON = 'no_samples';

const DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS = Object.freeze({
	/** Minimum samples before saturation can be declared at all. */
	minSamples: 20,
	/** p90 - p10 below this value is a collapsed distribution. */
	minSpread: 0.1,
	/** Fraction of samples at or above `topBandFloor` that indicates bunching. */
	topBandMinShare: 0.75,
	/** Magnitude at or above which a score counts as "top band". */
	topBandFloor: 0.75,
	/** Width of each reported histogram bucket. */
	bucketWidth: 0.1,
});

function round(value) {
	if (!Number.isFinite(value)) {
		return null;
	}
	return Number(value.toFixed(REPORT_PRECISION));
}

/**
 * Resolve a positive finite option, falling back to the default when the
 * override is missing, non-numeric, or non-positive. A zero or negative
 * `bucketWidth` would otherwise divide by zero and produce `NaN` bounds.
 */
function positiveOption(value, fallback) {
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveOptions(options) {
	const overrides = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
	const defaults = DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS;
	const topBandFloor = Number.isFinite(overrides.topBandFloor)
		? Math.min(1, Math.max(0, overrides.topBandFloor))
		: defaults.topBandFloor;
	// A share threshold outside [0, 1] cannot express "a fraction of samples";
	// clamping keeps an override from silently disabling the rule entirely.
	const topBandMinShare = Number.isFinite(overrides.topBandMinShare)
		? Math.min(1, Math.max(0, overrides.topBandMinShare))
		: defaults.topBandMinShare;

	return {
		minSamples: Math.max(1, Math.floor(positiveOption(overrides.minSamples, defaults.minSamples))),
		minSpread: positiveOption(overrides.minSpread, defaults.minSpread),
		topBandFloor,
		topBandMinShare,
		bucketWidth: positiveOption(overrides.bucketWidth, defaults.bucketWidth),
	};
}

/**
 * Normalize a signed sentiment score into a bounded [0, 1] magnitude.
 *
 * Returns `null` for anything that is not a finite number so a malformed
 * stored value is excluded from the sample instead of skewing the
 * distribution. A legitimate zero is preserved: `NEUTRAL` alerts carry
 * `sentiment_score: 0` and are part of the distribution.
 */
function normalizeSentimentMagnitude(value) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}
	return Math.min(1, Math.abs(value));
}

/**
 * Nearest-rank percentile over an already-ascending array.
 *
 * Nearest-rank (rather than interpolation) is used deliberately: it always
 * returns an observed value, so `p90` of a constant window is that constant
 * and `p90 - p10` is exactly 0 instead of a float artefact.
 */
function percentile(sortedAscending, fraction) {
	if (!Array.isArray(sortedAscending) || sortedAscending.length === 0) {
		return null;
	}
	const rank = Math.ceil(fraction * sortedAscending.length);
	const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
	return sortedAscending[index];
}

function buildBuckets(magnitudes, bucketWidth) {
	const counts = new Map();
	for (const magnitude of magnitudes) {
		const index = Math.min(Math.floor(magnitude / bucketWidth), Math.ceil(1 / bucketWidth) - 1);
		counts.set(index, (counts.get(index) || 0) + 1);
	}

	return [...counts.keys()]
		.sort((a, b) => a - b)
		.map(index => ({
			lowerBound: round(index * bucketWidth),
			upperBound: round(Math.min(1, (index + 1) * bucketWidth)),
			count: counts.get(index),
		}));
}

function createEmptyReport(reason) {
	return {
		sampleCount: 0,
		evaluated: false,
		saturated: false,
		reason,
		min: null,
		max: null,
		p10: null,
		p50: null,
		p90: null,
		spread: null,
		distinctValueCount: 0,
		bucketCount: 0,
		buckets: [],
		topBandCount: 0,
		topBandShare: null,
	};
}

/**
 * Analyze a set of sentiment scores and decide whether the distribution looks
 * saturated.
 *
 * @param {Array<number>} scores Signed or unsigned sentiment scores. Malformed
 *   entries are skipped.
 * @param {Object} [options] Overrides for the detection thresholds.
 * @returns {Object} A plain, JSON-serializable distribution report.
 */
function analyzeSentimentScoreDistribution(scores, options = {}) {
	if (!Array.isArray(scores)) {
		return createEmptyReport(NO_SAMPLE_REASON);
	}

	const {
		minSamples,
		minSpread,
		topBandFloor,
		topBandMinShare,
		bucketWidth,
	} = resolveOptions(options);

	const magnitudes = [];
	for (const score of scores) {
		const magnitude = normalizeSentimentMagnitude(score);
		if (magnitude !== null) {
			magnitudes.push(magnitude);
		}
	}

	if (magnitudes.length === 0) {
		return createEmptyReport(NO_SAMPLE_REASON);
	}

	magnitudes.sort((a, b) => a - b);

	const report = createEmptyReport(null);
	report.sampleCount = magnitudes.length;
	report.min = round(magnitudes[0]);
	report.max = round(magnitudes[magnitudes.length - 1]);
	report.p10 = round(percentile(magnitudes, 0.1));
	report.p50 = round(percentile(magnitudes, 0.5));
	report.p90 = round(percentile(magnitudes, 0.9));
	report.spread = round(report.p90 - report.p10);
	report.buckets = buildBuckets(magnitudes, bucketWidth);
	report.bucketCount = report.buckets.length;
	report.distinctValueCount = new Set(magnitudes).size;
	report.topBandCount = magnitudes.filter(magnitude => magnitude >= topBandFloor).length;
	report.topBandShare = round(report.topBandCount / magnitudes.length);

	if (report.sampleCount < minSamples) {
		// Too few observations to say anything honest. A cold process must not
		// be able to declare saturation off three alerts.
		report.reason = INSUFFICIENT_SAMPLE_REASON;
		return report;
	}

	report.evaluated = true;

	// Spread collapse is reported first: a constant window is the more severe
	// diagnosis and the more actionable one.
	if (report.spread !== null && report.spread < minSpread) {
		report.saturated = true;
		report.reason = SPREAD_COLLAPSE_REASON;
		return report;
	}

	if (report.topBandShare !== null && report.topBandShare >= topBandMinShare) {
		report.saturated = true;
		report.reason = TOP_BAND_CONCENTRATION_REASON;
	}

	return report;
}

/**
 * Create a bounded, age-limited rolling window of sentiment score magnitudes.
 *
 * Bounded twice on purpose: by age (`windowMs`) so the window reflects recent
 * behaviour, and by count (`maxSamples`) so a busy process cannot grow memory
 * without limit. Eviction is oldest-first, which is what keeps the surviving
 * samples the most recent ones.
 *
 * State is process-local. A restart resets the window, which is precisely why
 * `minSamples` exists: after a restart the guard stays silent until it has
 * enough fresh observations to judge. The durable view of the same signal is
 * `enrichment.sentimentCalibration` in `GET /api/alerts/summary`, which is
 * computed from stored alerts and survives restarts.
 */
function createSentimentScoreWindow(options = {}) {
	const overrides = options && typeof options === 'object' && !Array.isArray(options) ? options : {};
	const windowMs = positiveOption(overrides.windowMs, SEVEN_DAYS_MS);
	const maxSamples = Math.max(
		1,
		Math.floor(positiveOption(overrides.maxSamples, 2000)),
	);
	const analysisOptions = resolveOptions(overrides);

	let samples = [];

	function resolveNow(nowMs) {
		return Number.isFinite(nowMs) ? nowMs : Date.now();
	}

	function evictStale(now) {
		const cutoff = now - windowMs;
		// A stored timestamp is always finite (record() substitutes now), so
		// this comparison is safe; samples[] stays sorted by insertion time.
		let staleCount = 0;
		while (staleCount < samples.length && samples[staleCount][0] < cutoff) {
			staleCount += 1;
		}
		if (staleCount > 0) {
			samples = samples.slice(staleCount);
		}
		if (samples.length > maxSamples) {
			samples = samples.slice(samples.length - maxSamples);
		}
	}

	return {
		record(value, recordedAtMs) {
			const magnitude = normalizeSentimentMagnitude(value);
			if (magnitude === null) {
				return false;
			}
			// A non-finite timestamp is replaced with now rather than stored:
			// a NaN stamp would make every later age comparison false and pin a
			// sample in the window forever.
			samples.push([resolveNow(recordedAtMs), magnitude]);
			evictStale(resolveNow(recordedAtMs));
			return true;
		},
		snapshot(nowMs) {
			const now = resolveNow(nowMs);
			evictStale(now);
			return analyzeSentimentScoreDistribution(samples.map(sample => sample[1]), analysisOptions);
		},
		reset() {
			samples = [];
		},
		get size() {
			return samples.length;
		},
	};
}

module.exports = {
	DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS,
	SPREAD_COLLAPSE_REASON,
	TOP_BAND_CONCENTRATION_REASON,
	INSUFFICIENT_SAMPLE_REASON,
	NO_SAMPLE_REASON,
	normalizeSentimentMagnitude,
	analyzeSentimentScoreDistribution,
	createSentimentScoreWindow,
};
