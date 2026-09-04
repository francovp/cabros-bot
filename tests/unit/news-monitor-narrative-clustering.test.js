/**
 * News-monitor narrative clustering tests.
 *
 * Verifies the in-process clustering pass that collapses
 * multi-article, multi-symbol bursts into a single "story" alert
 * without changing the existing per-symbol dedup behavior. The
 * service is opt-in via ENABLE_NEWS_NARRATIVE_CLUSTERING and fails
 * open when the clustering pass errors.
 */

const {
	extractEntities,
	computeShingleOverlap,
	buildClusterKey,
	clusterAlerts,
	summarizeClusters,
	DEFAULT_CLUSTER_WINDOW_MS,
} = require('../../src/services/newsMonitor/narrativeClustering');

describe('News Monitor - Narrative Clustering', () => {
	describe('extractEntities', () => {
		it('extracts explicit tickers and dedupes them in upper case', () => {
			const entities = extractEntities('SEC sues bnb and BNB.USDT after BNB pump.');
			expect(entities.tickers).toEqual(expect.arrayContaining(['BNB', 'BNB.USDT']));
			expect(new Set(entities.tickers).size).toBe(entities.tickers.length);
		});

		it('returns empty arrays for an empty input', () => {
			expect(extractEntities('')).toEqual({ tickers: [], organizations: [], regulators: [] });
		});

		it('matches a small static regulator name set case-insensitively', () => {
			const entities = extractEntities('The sec announced new rules; the CFTC followed.');
			expect(entities.regulators).toEqual(expect.arrayContaining(['SEC', 'CFTC']));
		});

		it('normalizes whitespace and ignores non-text inputs', () => {
			expect(extractEntities(null)).toEqual({ tickers: [], organizations: [], regulators: [] });
			expect(extractEntities(undefined)).toEqual({ tickers: [], organizations: [], regulators: [] });
		});
	});

	describe('computeShingleOverlap', () => {
		it('returns 1.0 for two identical strings', () => {
			expect(computeShingleOverlap('SEC sues BNB', 'SEC sues BNB')).toBe(1);
		});

		it('returns 0.0 for two disjoint strings', () => {
			expect(computeShingleOverlap('apple banana cherry', 'dog elephant fox')).toBe(0);
		});

		it('returns 0.6 or higher for high-overlap sentences', () => {
			const overlap = computeShingleOverlap(
				'SEC sues BNB exchange for fraud',
				'SEC sues BNB exchange for fraud today',
			);
			expect(overlap).toBeGreaterThanOrEqual(0.6);
		});

		it('returns 0 for an empty or whitespace input', () => {
			expect(computeShingleOverlap('', 'foo bar')).toBe(0);
			expect(computeShingleOverlap('foo bar', '   ')).toBe(0);
		});
	});

	describe('buildClusterKey', () => {
		it('produces a stable hash for the same headline', () => {
			const a = buildClusterKey({ headline: 'SEC sues BNB for fraud' });
			const b = buildClusterKey({ headline: 'sec sues bnb for FRAUD' });
			expect(a).toBe(b);
		});

		it('produces a different hash for clearly different stories', () => {
			const a = buildClusterKey({ headline: 'SEC sues BNB for fraud' });
			const b = buildClusterKey({ headline: 'CFTC fines Tether for stablecoin issues' });
			expect(a).not.toBe(b);
		});

		it('returns null when headline is empty or not a string', () => {
			expect(buildClusterKey({ headline: '' })).toBeNull();
			expect(buildClusterKey({ headline: null })).toBeNull();
			expect(buildClusterKey({})).toBeNull();
		});
	});

	describe('clusterAlerts', () => {
		const now = Date.parse('2026-08-30T12:00:00Z');
		const baseAlert = (overrides) => ({
			symbol: 'BINANCE:BNBUSDT',
			eventCategory: 'regulatory',
			headline: 'SEC sues BNB for fraud',
			enriched: null,
			deliveryResults: [{ channel: 'telegram', success: true }],
			confidence: 0.9,
			sentimentScore: -0.3,
			timestamp: now,
			...overrides,
		});

		it('returns a single cluster when two alerts share a cluster key within the window', () => {
			const alerts = [
				baseAlert({ symbol: 'BINANCE:BNBUSDT' }),
				baseAlert({ symbol: 'BINANCE:BUSDUSDT' }),
			];
			const clusters = clusterAlerts(alerts, { now });
			expect(clusters).toHaveLength(1);
			expect(clusters[0].articleCount).toBe(2);
			expect(clusters[0].symbols).toEqual(expect.arrayContaining(['BINANCE:BNBUSDT', 'BINANCE:BUSDUSDT']));
		});

		it('returns two clusters when the cluster window has elapsed', () => {
			const alerts = [
				baseAlert({ symbol: 'BINANCE:BNBUSDT', timestamp: now - DEFAULT_CLUSTER_WINDOW_MS - 1000 }),
				baseAlert({ symbol: 'BINANCE:BUSDUSDT', timestamp: now }),
			];
			const clusters = clusterAlerts(alerts, { now });
			expect(clusters).toHaveLength(2);
		});

		it('returns one cluster per article when stories are clearly distinct', () => {
			const alerts = [
				baseAlert({ headline: 'SEC sues BNB for fraud', symbol: 'BINANCE:BNBUSDT' }),
				baseAlert({ headline: 'CFTC fines Tether for stablecoin issues', symbol: 'BINANCE:USDTUSD' }),
			];
			const clusters = clusterAlerts(alerts, { now });
			expect(clusters).toHaveLength(2);
			expect(clusters[0].articleCount).toBe(1);
		});

		it('skips alerts that do not have a cluster key (no headline)', () => {
			const alerts = [
				baseAlert({ headline: null, symbol: 'BINANCE:BNBUSDT' }),
				baseAlert({ symbol: 'BINANCE:BUSDUSDT' }),
			];
			const clusters = clusterAlerts(alerts, { now });
			expect(clusters).toHaveLength(1);
			expect(clusters[0].articleCount).toBe(1);
		});

		it('fails open: returns individual clusters when entity extraction throws', () => {
			const clusterModule = require('../../src/services/newsMonitor/narrativeClustering');
			const original = clusterModule.__setExtractEntitiesForTest(() => { throw new Error('boom'); });
			try {
				const alerts = [
					baseAlert({ symbol: 'BINANCE:BNBUSDT' }),
					baseAlert({ symbol: 'BINANCE:BUSDUSDT' }),
				];
				const clusters = clusterAlerts(alerts, { now });
				expect(clusters).toHaveLength(2);
			} finally {
				clusterModule.__setExtractEntitiesForTest(original);
			}
		});
	});

	describe('summarizeClusters', () => {
		it('counts clusters and articles correctly', () => {
			const summary = summarizeClusters([
				{ articleCount: 3 },
				{ articleCount: 1 },
				{ articleCount: 2 },
			]);
			expect(summary.clusterCount).toBe(3);
			expect(summary.articleCount).toBe(6);
			expect(summary.collapsedCount).toBe(3);
		});

		it('returns zeros for an empty input', () => {
			expect(summarizeClusters([])).toEqual({ clusterCount: 0, articleCount: 0, collapsedCount: 0 });
		});
	});
});
