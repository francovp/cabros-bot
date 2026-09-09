/* global describe, it, expect */

const {
	normalizeDomain,
	getTierForDomain,
	tierToScore,
	deriveSourceAgeHours,
	scoreQuality,
	scoreFreshness,
	DEFAULT_MAX_AGE_HOURS,
} = require('../../src/services/grounding/domainQuality');
const { SourceQualityTier } = require('../../src/services/grounding/qualityTiers');

describe('domainQuality', () => {
	describe('constants', () => {
		it('exports DEFAULT_MAX_AGE_HOURS as 72', () => {
			expect(DEFAULT_MAX_AGE_HOURS).toBe(72);
		});
	});

	describe('normalizeDomain', () => {
		it('returns null for falsy or invalid inputs', () => {
			expect(normalizeDomain(null)).toBeNull();
			expect(normalizeDomain(undefined)).toBeNull();
			expect(normalizeDomain('')).toBeNull();
			expect(normalizeDomain(123)).toBeNull();
			expect(normalizeDomain(true)).toBeNull();
			expect(normalizeDomain(false)).toBeNull();
			expect(normalizeDomain([])).toBeNull();
		});

		it('normalizes string URLs with http/https protocols and paths', () => {
			expect(normalizeDomain('https://www.reuters.com/markets/asia')).toBe('reuters.com');
			expect(normalizeDomain('http://bloomberg.com/news/articles/123')).toBe('bloomberg.com');
			expect(normalizeDomain('https://WWW.COINDESK.COM/policy/')).toBe('coindesk.com');
			expect(normalizeDomain('https://finance.yahoo.com/quote/BTC-USD')).toBe('finance.yahoo.com');
		});

		it('normalizes bare string domain names', () => {
			expect(normalizeDomain('reuters.com')).toBe('reuters.com');
			expect(normalizeDomain('www.reuters.com')).toBe('reuters.com');
			expect(normalizeDomain('WWW.COINBASE.COM')).toBe('coinbase.com');
			expect(normalizeDomain('SEC.GOV')).toBe('sec.gov');
		});

		it('handles strings where new URL throws by stripping www. and lowercasing', () => {
			expect(normalizeDomain('www.example.org/test')).toBe('example.org/test');
			expect(normalizeDomain('WWW.TEST.XYZ')).toBe('test.xyz');
		});

		it('normalizes object sources with sourceDomain', () => {
			expect(normalizeDomain({ sourceDomain: 'www.sec.gov' })).toBe('sec.gov');
			expect(normalizeDomain({ sourceDomain: 'Reuters.com' })).toBe('reuters.com');
			expect(normalizeDomain({ sourceDomain: 'www.coindesk.com' })).toBe('coindesk.com');
		});

		it('normalizes object sources with domain property', () => {
			expect(normalizeDomain({ domain: 'www.coindesk.com' })).toBe('coindesk.com');
			expect(normalizeDomain({ domain: 'Coinbase.com' })).toBe('coinbase.com');
		});

		it('normalizes object sources with url property', () => {
			expect(normalizeDomain({ url: 'https://www.wsj.com/articles/markets-today' })).toBe('wsj.com');
			expect(normalizeDomain({ url: 'http://ft.com' })).toBe('ft.com');
			expect(normalizeDomain({ url: 'https://WWW.THEBLOCK.CO/post/123' })).toBe('theblock.co');
		});

		it('respects object candidate property priority (sourceDomain > domain > url)', () => {
			expect(normalizeDomain({
				sourceDomain: 'reuters.com',
				domain: 'forbes.com',
				url: 'https://cnn.com',
			})).toBe('reuters.com');

			expect(normalizeDomain({
				domain: 'forbes.com',
				url: 'https://cnn.com',
			})).toBe('forbes.com');
		});

		it('returns null for object sources without recognizable domain properties', () => {
			expect(normalizeDomain({})).toBeNull();
			expect(normalizeDomain({ title: 'Bitcoin surges', snippet: 'text' })).toBeNull();
			expect(normalizeDomain({ sourceDomain: '' })).toBeNull();
			expect(normalizeDomain({ url: 'not-a-valid-url' })).toBeNull();
		});
	});

	describe('getTierForDomain', () => {
		it('returns UNKNOWN for falsy or empty domain', () => {
			expect(getTierForDomain(null)).toBe(SourceQualityTier.UNKNOWN);
			expect(getTierForDomain(undefined)).toBe(SourceQualityTier.UNKNOWN);
			expect(getTierForDomain('')).toBe(SourceQualityTier.UNKNOWN);
		});

		it('correctly classifies HIGH tier domains', () => {
			const highDomains = [
				'reuters.com',
				'bloomberg.com',
				'wsj.com',
				'ft.com',
				'sec.gov',
				'cftc.gov',
				'federalreserve.gov',
				'coinbase.com',
				'binance.com',
				'coindesk.com',
			];
			for (const domain of highDomains) {
				expect(getTierForDomain(domain)).toBe(SourceQualityTier.HIGH);
			}
		});

		it('correctly classifies MEDIUM tier domains', () => {
			const mediumDomains = [
				'forbes.com',
				'cnn.com',
				'guardian.com',
				'marketwatch.com',
				'decrypt.co',
				'cryptonews.com',
				'bitcoinmagazine.com',
				'finance.yahoo.com',
			];
			for (const domain of mediumDomains) {
				expect(getTierForDomain(domain)).toBe(SourceQualityTier.MEDIUM);
			}
		});

		it('correctly classifies LOW tier domains', () => {
			const lowDomains = [
				'medium.com',
				'substack.com',
				'reddit.com',
				'twitter.com',
				'x.com',
			];
			for (const domain of lowDomains) {
				expect(getTierForDomain(domain)).toBe(SourceQualityTier.LOW);
			}
		});

		it('infers LOW tier for domains with low-quality TLD suffixes', () => {
			const lowTldDomains = [
				'cryptonews.xyz',
				'airdrop-alert.top',
				'bitcoinpump.buzz',
				'instant-crypto.click',
				'marketreview.blog',
				'fastmoney.loan',
				'tokens.review',
				'wallet-app.download',
			];
			for (const domain of lowTldDomains) {
				expect(getTierForDomain(domain)).toBe(SourceQualityTier.LOW);
			}
		});

		it('returns UNKNOWN for unrecognized domains with standard TLDs', () => {
			expect(getTierForDomain('randomblog.org')).toBe(SourceQualityTier.UNKNOWN);
			expect(getTierForDomain('example.net')).toBe(SourceQualityTier.UNKNOWN);
			expect(getTierForDomain('newcryptoproject.io')).toBe(SourceQualityTier.UNKNOWN);
		});
	});

	describe('tierToScore', () => {
		it('maps HIGH tier to 0.9', () => {
			expect(tierToScore(SourceQualityTier.HIGH)).toBe(0.9);
		});

		it('maps MEDIUM tier to 0.65', () => {
			expect(tierToScore(SourceQualityTier.MEDIUM)).toBe(0.65);
		});

		it('maps LOW tier to 0.3', () => {
			expect(tierToScore(SourceQualityTier.LOW)).toBe(0.3);
		});

		it('maps UNKNOWN tier to 0.5', () => {
			expect(tierToScore(SourceQualityTier.UNKNOWN)).toBe(0.5);
		});

		it('defaults unmapped or invalid tier strings to 0.5', () => {
			expect(tierToScore('custom_tier')).toBe(0.5);
			expect(tierToScore(null)).toBe(0.5);
			expect(tierToScore(undefined)).toBe(0.5);
		});
	});

	describe('deriveSourceAgeHours', () => {
		const now = new Date('2026-09-04T12:00:00.000Z');

		it('derives age from publishedAt', () => {
			const source = { publishedAt: '2026-09-04T10:00:00.000Z' };
			expect(deriveSourceAgeHours(source, now)).toBe(2);
		});

		it('derives age from published_at', () => {
			const source = { published_at: '2026-09-04T06:00:00.000Z' };
			expect(deriveSourceAgeHours(source, now)).toBe(6);
		});

		it('derives age from datePublished', () => {
			const source = { datePublished: '2026-09-04T00:00:00.000Z' };
			expect(deriveSourceAgeHours(source, now)).toBe(12);
		});

		it('derives age from date property', () => {
			const source = { date: '2026-09-03T12:00:00.000Z' };
			expect(deriveSourceAgeHours(source, now)).toBe(24);
		});

		it('derives age from metadata.date property', () => {
			const source = { metadata: { date: '2026-09-02T12:00:00.000Z' } };
			expect(deriveSourceAgeHours(source, now)).toBe(48);
		});

		it('accepts Date objects as timestamp values', () => {
			const source = { publishedAt: new Date('2026-09-04T11:00:00.000Z') };
			expect(deriveSourceAgeHours(source, now)).toBe(1);
		});

		it('respects candidate field priority order (publishedAt > published_at > datePublished > date > metadata.date)', () => {
			const source = {
				publishedAt: '2026-09-04T11:00:00.000Z', // 1h ago
				published_at: '2026-09-04T06:00:00.000Z', // 6h ago
			};
			expect(deriveSourceAgeHours(source, now)).toBe(1);
		});

		it('returns null when no valid date fields are present or source is null', () => {
			expect(deriveSourceAgeHours(null, now)).toBeNull();
			expect(deriveSourceAgeHours({}, now)).toBeNull();
			expect(deriveSourceAgeHours({ title: 'No date' }, now)).toBeNull();
			expect(deriveSourceAgeHours({ publishedAt: 'invalid-date-format' }, now)).toBeNull();
		});
	});

	describe('scoreQuality', () => {
		it('handles empty, null, or undefined sources', () => {
			const emptyResult = {
				count: 0,
				domains: [],
				tierCounts: {
					[SourceQualityTier.HIGH]: 0,
					[SourceQualityTier.MEDIUM]: 0,
					[SourceQualityTier.LOW]: 0,
					[SourceQualityTier.UNKNOWN]: 0,
				},
				qualityScore: 0,
				knownDomains: 0,
				unknownDomains: 0,
			};

			expect(scoreQuality([])).toEqual(emptyResult);
			expect(scoreQuality(null)).toEqual(emptyResult);
			expect(scoreQuality(undefined)).toEqual(emptyResult);
		});

		it('handles a single source passed as an object', () => {
			const result = scoreQuality({ sourceDomain: 'bloomberg.com' });
			expect(result.count).toBe(1);
			expect(result.domains).toEqual(['bloomberg.com']);
			expect(result.tierCounts[SourceQualityTier.HIGH]).toBe(1);
			expect(result.qualityScore).toBe(0.9);
			expect(result.knownDomains).toBe(1);
			expect(result.unknownDomains).toBe(0);
		});

		it('scores a mixed list of sources across tiers correctly', () => {
			const sources = [
				{ sourceDomain: 'bloomberg.com' }, // HIGH: 0.9
				{ sourceDomain: 'forbes.com' }, // MEDIUM: 0.65
				{ sourceDomain: 'reddit.com' }, // LOW: 0.3
				{ sourceDomain: 'unregistered-site.org' }, // UNKNOWN: 0.5
			];

			const result = scoreQuality(sources);
			expect(result.count).toBe(4);
			expect(result.domains).toEqual([
				'bloomberg.com',
				'forbes.com',
				'reddit.com',
				'unregistered-site.org',
			]);
			expect(result.tierCounts).toEqual({
				[SourceQualityTier.HIGH]: 1,
				[SourceQualityTier.MEDIUM]: 1,
				[SourceQualityTier.LOW]: 1,
				[SourceQualityTier.UNKNOWN]: 1,
			});
			// (0.9 + 0.65 + 0.3 + 0.5) / 4 = 2.35 / 4 = 0.5875
			expect(result.qualityScore).toBeCloseTo(0.5875, 4);
			expect(result.knownDomains).toBe(3);
			expect(result.unknownDomains).toBe(1);
		});

		it('correctly categorizes TLD-inferred low-quality sources', () => {
			const sources = [
				{ sourceDomain: 'crypto-scam.xyz' },
				{ url: 'https://daily-buzz.top/article' },
			];
			const result = scoreQuality(sources);
			expect(result.tierCounts[SourceQualityTier.LOW]).toBe(2);
			expect(result.qualityScore).toBeCloseTo(0.3, 4);
			expect(result.knownDomains).toBe(2);
			expect(result.unknownDomains).toBe(0);
		});

		it('handles sources with unparseable or missing domains', () => {
			const sources = [
				{ sourceDomain: 'reuters.com' }, // HIGH: 0.9
				{ title: 'Article without domain or url' }, // unparseable -> UNKNOWN (0.5)
			];
			const result = scoreQuality(sources);
			expect(result.count).toBe(2);
			expect(result.domains).toEqual(['reuters.com']);
			expect(result.tierCounts[SourceQualityTier.HIGH]).toBe(1);
			expect(result.tierCounts[SourceQualityTier.UNKNOWN]).toBe(1);
			expect(result.knownDomains).toBe(1);
			expect(result.unknownDomains).toBe(1);
			// reuters gives 0.9, unparseable gives UNKNOWN score 0.5, total score (0.9 + 0.5) / 2 = 0.7
			expect(result.qualityScore).toBe(0.7);
		});
	});

	describe('scoreFreshness', () => {
		const fixedNow = new Date('2026-09-04T12:00:00.000Z');

		it('handles empty or null sources', () => {
			const expected = {
				freshness: 0,
				freshnessReason: 'no grounding sources returned',
				hasExplicitDates: false,
				staleSources: 0,
				totalDated: 0,
			};
			expect(scoreFreshness([], { now: fixedNow })).toEqual(expected);
			expect(scoreFreshness(null, { now: fixedNow })).toEqual(expected);
			expect(scoreFreshness(undefined, { now: fixedNow })).toEqual(expected);
		});

		it('handles sources with no explicit dates', () => {
			const sources = [
				{ sourceDomain: 'reuters.com' },
				{ domain: 'bloomberg.com' },
			];
			const result = scoreFreshness(sources, { now: fixedNow });
			expect(result).toEqual({
				freshness: 0,
				freshnessReason: 'unknown freshness (no dates on grounding sources)',
				hasExplicitDates: false,
				staleSources: 0,
				totalDated: 0,
			});
		});

		it('scores completely fresh sources (0 hours old) with freshness 1.0', () => {
			const sources = [
				{ publishedAt: '2026-09-04T12:00:00.000Z' },
			];
			const result = scoreFreshness(sources, { now: fixedNow });
			expect(result.freshness).toBe(1);
			expect(result.freshnessReason).toBe('fresh');
			expect(result.hasExplicitDates).toBe(true);
			expect(result.staleSources).toBe(0);
			expect(result.totalDated).toBe(1);
		});

		it('scores partially aged sources proportionally based on maxAgeHours', () => {
			// 36 hours old with default 72h maxAge: 1 - (36/72) = 0.5
			const sources = [
				{ publishedAt: '2026-09-03T00:00:00.000Z' },
			];
			const result = scoreFreshness(sources, { now: fixedNow });
			expect(result.freshness).toBe(0.5);
			expect(result.freshnessReason).toBe('fresh');
			expect(result.staleSources).toBe(0);
		});

		it('flags sources older than maxAgeHours as stale', () => {
			// 80 hours old (> 72 maxAgeHours)
			const sources = [
				{ publishedAt: '2026-09-01T04:00:00.000Z' },
			];
			const result = scoreFreshness(sources, { now: fixedNow });
			expect(result.freshness).toBe(0);
			expect(result.freshnessReason).toBe('some sources are stale');
			expect(result.staleSources).toBe(1);
			expect(result.totalDated).toBe(1);
		});

		it('handles mixed fresh and stale sources', () => {
			const sources = [
				{ publishedAt: '2026-09-04T12:00:00.000Z' }, // 0h old -> freshness 1.0
				{ publishedAt: '2026-08-30T12:00:00.000Z' }, // 120h old -> stale (0.0)
				{ sourceDomain: 'undated.com' }, // no date -> skipped from datedCount
			];
			const result = scoreFreshness(sources, { now: fixedNow });
			// (1.0 + 0.0) / 2 dated sources = 0.5
			expect(result.freshness).toBe(0.5);
			expect(result.freshnessReason).toBe('some sources are stale');
			expect(result.staleSources).toBe(1);
			expect(result.totalDated).toBe(2);
			expect(result.hasExplicitDates).toBe(true);
		});

		it('respects custom maxAgeHours option', () => {
			// 12 hours old with custom maxAgeHours=24: 1 - (12/24) = 0.5
			const sources = [
				{ publishedAt: '2026-09-04T00:00:00.000Z' },
			];
			const result = scoreFreshness(sources, { now: fixedNow, maxAgeHours: 24 });
			expect(result.freshness).toBe(0.5);
			expect(result.freshnessReason).toBe('fresh');
			expect(result.staleSources).toBe(0);
		});

		it('bounds future-dated sources to max freshness (1.0)', () => {
			// Future timestamp due to clock skew
			const sources = [
				{ publishedAt: '2026-09-04T14:00:00.000Z' }, // 2h in the future
			];
			const result = scoreFreshness(sources, { now: fixedNow });
			expect(result.freshness).toBe(1);
			expect(result.freshnessReason).toBe('fresh');
			expect(result.staleSources).toBe(0);
		});

		it('handles a single source passed as an object', () => {
			const source = { publishedAt: '2026-09-04T12:00:00.000Z' };
			const result = scoreFreshness(source, { now: fixedNow });
			expect(result.freshness).toBe(1);
			expect(result.freshnessReason).toBe('fresh');
			expect(result.totalDated).toBe(1);
		});

		it('defaults now to current date when options.now is omitted', () => {
			const recentSource = [
				{ publishedAt: new Date().toISOString() },
			];
			const result = scoreFreshness(recentSource);
			expect(result.hasExplicitDates).toBe(true);
			expect(result.freshness).toBeGreaterThan(0.95);
		});

		it('falls back safely when options.now is an invalid Date', () => {
			const recentSource = [
				{ publishedAt: new Date().toISOString() },
			];
			const result = scoreFreshness(recentSource, { now: new Date('invalid') });
			expect(result.hasExplicitDates).toBe(true);
			expect(result.freshness).toBeGreaterThan(0.95);
		});
	});
});
