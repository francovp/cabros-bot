const {
	DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS,
	SPREAD_COLLAPSE_REASON,
	TOP_BAND_CONCENTRATION_REASON,
	INSUFFICIENT_SAMPLE_REASON,
	NO_SAMPLE_REASON,
	normalizeSentimentMagnitude,
	analyzeSentimentScoreDistribution,
	createSentimentScoreWindow,
} = require('../../src/services/grounding/sentimentDistribution');

/**
 * The exact shape reported in issue #1031:
 * 0.85x42, 0.80x33, 0.75x10, 0.70x3, 0.65x4, 0.60x4, 0.55x1 (97 enriched alerts).
 *
 * Two properties of this fixture are load-bearing and are pinned by the tests
 * below so the guard cannot be silently narrowed back to a rule that misses the
 * incident it was filed for:
 *
 *  1. `p90 - p10` is 0.15, which is ABOVE the 0.1 spread floor. A pure
 *     "p90 - p10 < 0.1" guard therefore does NOT catch this distribution: the
 *     pathology is top-band concentration, not a narrow total range.
 *  2. 85 of the 97 samples (87.6%) are at or above 0.75. The issue prose says
 *     "96 of them are >= 0.75", which does not reconcile with the histogram it
 *     publishes; the histogram is the concrete evidence, so the assertions use
 *     it. 96 would be the count at or above 0.60.
 */
function productionSaturatedScores() {
	return [
		...Array(42).fill(0.85),
		...Array(33).fill(0.8),
		...Array(10).fill(0.75),
		...Array(3).fill(0.7),
		...Array(4).fill(0.65),
		...Array(4).fill(0.6),
		...Array(1).fill(0.55),
	];
}

describe('sentimentDistribution', () => {
	describe('normalizeSentimentMagnitude', () => {
		it('returns the absolute magnitude of a signed score', () => {
			expect(normalizeSentimentMagnitude(0.85)).toBeCloseTo(0.85, 10);
			expect(normalizeSentimentMagnitude(-0.4)).toBeCloseTo(0.4, 10);
		});

		it('clamps out-of-range magnitudes into [0, 1]', () => {
			expect(normalizeSentimentMagnitude(1.4)).toBe(1);
			expect(normalizeSentimentMagnitude(-9)).toBe(1);
		});

		it('returns null for values that are not finite numbers', () => {
			for (const value of [null, undefined, NaN, Infinity, -Infinity, '0.8', '', {}, [], true, false]) {
				expect(normalizeSentimentMagnitude(value)).toBeNull();
			}
		});

		it('preserves a zero magnitude rather than treating it as missing', () => {
			expect(normalizeSentimentMagnitude(0)).toBe(0);
			expect(normalizeSentimentMagnitude(-0)).toBe(0);
		});
	});

	describe('analyzeSentimentScoreDistribution', () => {
		it('flags the reported production distribution via top-band concentration', () => {
			const report = analyzeSentimentScoreDistribution(productionSaturatedScores());

			expect(report.sampleCount).toBe(97);
			expect(report.saturated).toBe(true);
			expect(report.reason).toBe(TOP_BAND_CONCENTRATION_REASON);
			expect(report.topBandCount).toBe(85);
			expect(report.topBandShare).toBeCloseTo(85 / 97, 6);
			expect(report.evaluated).toBe(true);
		});

		it('reports the production distribution spread honestly even while saturated', () => {
			const report = analyzeSentimentScoreDistribution(productionSaturatedScores());

			expect(report.p10).toBeCloseTo(0.7, 6);
			expect(report.p90).toBeCloseTo(0.85, 6);
			expect(report.spread).toBeCloseTo(0.15, 6);
			// Spread is above the floor here, so only the top-band rule can fire.
			expect(report.spread).toBeGreaterThanOrEqual(DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS.minSpread);
		});

		it('flags a perfectly constant score series via spread collapse', () => {
			const report = analyzeSentimentScoreDistribution(Array(50).fill(0.8));

			expect(report.saturated).toBe(true);
			expect(report.reason).toBe(SPREAD_COLLAPSE_REASON);
			expect(report.spread).toBe(0);
			expect(report.min).toBeCloseTo(0.8, 6);
			expect(report.max).toBeCloseTo(0.8, 6);
			expect(report.distinctValueCount).toBe(1);
			expect(report.bucketCount).toBe(1);
			expect(report.buckets).toEqual([{ lowerBound: 0.8, upperBound: 0.9, count: 50 }]);
		});

		it('prefers the spread-collapse reason when both rules would fire', () => {
			// Every sample is both identical (spread 0) and inside the top band.
			const report = analyzeSentimentScoreDistribution(Array(50).fill(0.85));

			expect(report.reason).toBe(SPREAD_COLLAPSE_REASON);
		});

		it('stays silent on a well-spread distribution', () => {
			const scores = [];
			for (let i = 0; i < 100; i += 1) {
				scores.push((i % 10) / 10);
			}

			const report = analyzeSentimentScoreDistribution(scores);

			expect(report.saturated).toBe(false);
			expect(report.reason).toBeNull();
			expect(report.evaluated).toBe(true);
			expect(report.spread).toBeGreaterThanOrEqual(DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS.minSpread);
			expect(report.bucketCount).toBeGreaterThanOrEqual(4);
		});

		it('stays silent when scores span the range but avoid the top band', () => {
			// Same total range as the production set, spread downward instead of
			// bunched upward: a healthy low-conviction window must not warn.
			const scores = [];
			for (let i = 0; i < 100; i += 1) {
				scores.push(0.05 + (i % 10) / 12);
			}

			const report = analyzeSentimentScoreDistribution(scores);

			expect(report.saturated).toBe(false);
			expect(report.reason).toBeNull();
			expect(report.topBandShare).toBeLessThan(DEFAULT_SENTIMENT_DISTRIBUTION_OPTIONS.topBandMinShare);
		});

		it('does not declare saturation below the minimum sample size', () => {
			const report = analyzeSentimentScoreDistribution(Array(10).fill(0.8));

			expect(report.saturated).toBe(false);
			expect(report.reason).toBe(INSUFFICIENT_SAMPLE_REASON);
			expect(report.sampleCount).toBe(10);
			expect(report.evaluated).toBe(false);
			expect(report.bucketCount).toBe(1);
		});

		it('reports an explicit empty reason with no samples', () => {
			const report = analyzeSentimentScoreDistribution([]);

			expect(report.saturated).toBe(false);
			expect(report.reason).toBe(NO_SAMPLE_REASON);
			expect(report.sampleCount).toBe(0);
			expect(report.evaluated).toBe(false);
			expect(report.buckets).toEqual([]);
			expect(report.p10).toBeNull();
			expect(report.p50).toBeNull();
			expect(report.p90).toBeNull();
			expect(report.spread).toBeNull();
			expect(report.min).toBeNull();
			expect(report.max).toBeNull();
			expect(report.topBandCount).toBe(0);
			expect(report.topBandShare).toBeNull();
		});

		it('ignores malformed entries instead of failing closed', () => {
			const report = analyzeSentimentScoreDistribution([
				0.2, null, undefined, NaN, '0.9', {}, 0.9, 1.5, -0.9, [], false,
			]);

			// 0.2, 0.9, 1.5 (clamped to 1) and -0.9 are the only finite numbers.
			expect(report.sampleCount).toBe(4);
			expect(report.saturated).toBe(false);
		});

		it('treats a non-array input as an empty distribution', () => {
			for (const value of [null, undefined, 42, 'scores', {}, () => {}]) {
				const report = analyzeSentimentScoreDistribution(value);
				expect(report.sampleCount).toBe(0);
				expect(report.reason).toBe(NO_SAMPLE_REASON);
			}
		});

		it('honours overridden sample and top-band floors', () => {
			// Spread here is 0.6, comfortably above the 0.1 default, so only the
			// top-band share can fire. The override lowers that bar to 0.5.
			const report = analyzeSentimentScoreDistribution([0.2, 0.3, 0.75, 0.8], {
				minSamples: 2,
				topBandMinShare: 0.5,
			});

			expect(report.sampleCount).toBe(4);
			expect(report.evaluated).toBe(true);
			expect(report.saturated).toBe(true);
			expect(report.reason).toBe(TOP_BAND_CONCENTRATION_REASON);
		});

		it('honours an overridden spread floor', () => {
			const report = analyzeSentimentScoreDistribution([0.7, 0.71, 0.72, 0.73], {
				minSamples: 2,
				minSpread: 0.5,
			});

			expect(report.spread).toBeCloseTo(0.03, 6);
			expect(report.saturated).toBe(true);
			expect(report.reason).toBe(SPREAD_COLLAPSE_REASON);
		});

		it('ignores non-positive option overrides rather than dividing by zero', () => {
			const report = analyzeSentimentScoreDistribution([0.5, 0.6], {
				bucketWidth: 0,
				minSamples: -1,
				minSpread: -5,
				topBandFloor: 5,
				topBandMinShare: -1,
			});

			expect(report.sampleCount).toBe(2);
			expect(Number.isFinite(report.p50)).toBe(true);
			expect(report.buckets.length).toBeGreaterThan(0);
			expect(report.saturated).toBe(false);
		});

		it('buckets magnitudes into 0.1-wide bands without floating point noise', () => {
			const report = analyzeSentimentScoreDistribution([0.02, 0.05, 0.12, 0.95, -0.31]);

			expect(report.buckets).toEqual([
				{ lowerBound: 0, upperBound: 0.1, count: 2 },
				{ lowerBound: 0.1, upperBound: 0.2, count: 1 },
				{ lowerBound: 0.3, upperBound: 0.4, count: 1 },
				{ lowerBound: 0.9, upperBound: 1, count: 1 },
			]);
			expect(report.buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(report.sampleCount);
			expect(report.bucketCount).toBe(4);
		});

		it('keeps the top boundary in the 0.9-1.0 band instead of a 1.0-1.1 overflow band', () => {
			const report = analyzeSentimentScoreDistribution([1]);

			expect(report.buckets).toEqual([{ lowerBound: 0.9, upperBound: 1, count: 1 }]);
		});

		it('never mutates the caller array', () => {
			const scores = [0.5, 0.9, 0.1];
			const snapshot = [...scores];

			analyzeSentimentScoreDistribution(scores);

			expect(scores).toEqual(snapshot);
		});
	});

	describe('createSentimentScoreWindow', () => {
		it('reports an empty window before anything is recorded', () => {
			const window = createSentimentScoreWindow();

			const report = window.snapshot(1000);

			expect(report.sampleCount).toBe(0);
			expect(report.saturated).toBe(false);
			expect(report.reason).toBe(NO_SAMPLE_REASON);
		});

		it('saturates once enough constant scores accumulate inside the window', () => {
			const window = createSentimentScoreWindow();

			for (let i = 0; i < 40; i += 1) {
				expect(window.record(0.8, i * 1000)).toBe(true);
			}

			const report = window.snapshot(39 * 1000);
			expect(report.sampleCount).toBe(40);
			expect(report.saturated).toBe(true);
			expect(report.reason).toBe(SPREAD_COLLAPSE_REASON);
		});

		it('evicts samples older than the configured window', () => {
			const window = createSentimentScoreWindow({ windowMs: 1000, minSamples: 2, minSpread: 0.5 });

			window.record(0.2, 0);
			window.record(0.9, 5000);

			const report = window.snapshot(5000);

			expect(report.sampleCount).toBe(1);
			expect(report.evaluated).toBe(false);
			expect(report.reason).toBe(INSUFFICIENT_SAMPLE_REASON);
		});

		it('bounds retained samples by dropping the oldest entries', () => {
			const window = createSentimentScoreWindow({ maxSamples: 3, minSamples: 1, minSpread: 0.5 });

			for (const score of [0.1, 0.2, 0.3, 0.4, 0.9]) {
				window.record(score, 0);
			}

			const report = window.snapshot(0);

			expect(report.sampleCount).toBe(3);
			expect(report.min).toBeCloseTo(0.3, 6);
			expect(report.max).toBeCloseTo(0.9, 6);
		});

		it('ignores malformed recorded values without growing the window', () => {
			const window = createSentimentScoreWindow();

			expect(window.record(undefined, 0)).toBe(false);
			expect(window.record(NaN, 0)).toBe(false);
			expect(window.record('0.9', 0)).toBe(false);
			expect(window.record({}, 0)).toBe(false);

			expect(window.snapshot(0).sampleCount).toBe(0);
		});

		it('defaults recordedAt to now and stays valid without a snapshot argument', () => {
			const window = createSentimentScoreWindow();

			window.record(0.42);

			expect(window.snapshot().sampleCount).toBe(1);
		});

		it('substitutes now for a non-finite timestamp instead of poisoning eviction', () => {
			const window = createSentimentScoreWindow({ windowMs: 100, minSamples: 2, minSpread: 0.5 });

			window.record(0.3, NaN);
			window.record(0.9, undefined);

			const report = window.snapshot();
			expect(report.sampleCount).toBe(2);
			expect(report.spread).toBeCloseTo(0.6, 6);
		});

		it('falls back to now for a non-finite snapshot timestamp', () => {
			const window = createSentimentScoreWindow();
			window.record(0.5, Date.now());

			expect(window.snapshot(NaN).sampleCount).toBe(1);
		});

		it('clears every retained sample on reset', () => {
			const window = createSentimentScoreWindow();
			window.record(0.8, 0);

			window.reset();

			expect(window.snapshot(0).sampleCount).toBe(0);
		});

		it('is snapshot-safe: mutating a returned report cannot corrupt the window', () => {
			const window = createSentimentScoreWindow();
			window.record(0.8, 0);

			const report = window.snapshot(0);
			report.sampleCount = 999;
			report.buckets.push({ lowerBound: 9, upperBound: 10, count: 1 });

			expect(window.snapshot(0).sampleCount).toBe(1);
			expect(window.snapshot(0).buckets).toHaveLength(1);
		});
	});
});
