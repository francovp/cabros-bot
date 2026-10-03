/* global describe, it, expect */

const {
	SourceQualityTier,
	HIGH_TIER_DOMAINS,
	MEDIUM_TIER_DOMAINS,
	LOW_TIER_DOMAINS,
	LOW_TLD_SUFFIXES,
	DOMAIN_TIER_MAP,
} = require('../../src/services/grounding/qualityTiers');

describe('qualityTiers', () => {
	describe('SourceQualityTier', () => {
		it('defines expected tier constants', () => {
			expect(SourceQualityTier).toEqual({
				HIGH: 'high',
				MEDIUM: 'medium',
				LOW: 'low',
				UNKNOWN: 'unknown',
			});
		});

		it('is immutable (frozen)', () => {
			expect(Object.isFrozen(SourceQualityTier)).toBe(true);
			expect(() => {
				'use strict';
				SourceQualityTier.NEW_TIER = 'new_tier';
			}).toThrow();
			expect(SourceQualityTier.NEW_TIER).toBeUndefined();
		});
	});

	describe('HIGH_TIER_DOMAINS', () => {
		it('is a non-empty Set of normalized domain strings', () => {
			expect(HIGH_TIER_DOMAINS).toBeInstanceOf(Set);
			expect(HIGH_TIER_DOMAINS.size).toBeGreaterThan(0);

			for (const domain of HIGH_TIER_DOMAINS) {
				expect(typeof domain).toBe('string');
				expect(domain.length).toBeGreaterThan(0);
				expect(domain).toBe(domain.toLowerCase());
				expect(domain.startsWith('www.')).toBe(false);
				expect(domain.startsWith('http://')).toBe(false);
				expect(domain.startsWith('https://')).toBe(false);
				expect(domain.includes('/')).toBe(false);
			}
		});

		it('contains wire services and major financial press', () => {
			const expectedPress = [
				'reuters.com',
				'bloomberg.com',
				'apnews.com',
				'wsj.com',
				'ft.com',
				'cnbc.com',
				'bbc.com',
				'economist.com',
			];
			for (const domain of expectedPress) {
				expect(HIGH_TIER_DOMAINS.has(domain)).toBe(true);
			}
		});

		it('contains crypto-specific authoritative outlets', () => {
			const expectedCrypto = [
				'coindesk.com',
				'cointelegraph.com',
				'coingecko.com',
				'coinmarketcap.com',
				'theblock.co',
			];
			for (const domain of expectedCrypto) {
				expect(HIGH_TIER_DOMAINS.has(domain)).toBe(true);
			}
		});

		it('contains financial regulators and primary filing sources', () => {
			const expectedRegulators = [
				'sec.gov',
				'cftc.gov',
				'federalreserve.gov',
				'ecb.europa.eu',
				'esma.europa.eu',
				'fca.org.uk',
				'finra.org',
			];
			for (const domain of expectedRegulators) {
				expect(HIGH_TIER_DOMAINS.has(domain)).toBe(true);
			}
		});

		it('contains major crypto exchanges', () => {
			const expectedExchanges = [
				'binance.com',
				'binance.us',
				'coinbase.com',
				'kraken.com',
				'okx.com',
			];
			for (const domain of expectedExchanges) {
				expect(HIGH_TIER_DOMAINS.has(domain)).toBe(true);
			}
		});
	});

	describe('MEDIUM_TIER_DOMAINS', () => {
		it('is a non-empty Set of normalized domain strings', () => {
			expect(MEDIUM_TIER_DOMAINS).toBeInstanceOf(Set);
			expect(MEDIUM_TIER_DOMAINS.size).toBeGreaterThan(0);

			for (const domain of MEDIUM_TIER_DOMAINS) {
				expect(typeof domain).toBe('string');
				expect(domain.length).toBeGreaterThan(0);
				expect(domain).toBe(domain.toLowerCase());
				expect(domain.startsWith('www.')).toBe(false);
				expect(domain.startsWith('http://')).toBe(false);
				expect(domain.startsWith('https://')).toBe(false);
				expect(domain.includes('/')).toBe(false);
			}
		});

		it('contains recognized finance and crypto news outlets', () => {
			const expectedDomains = [
				'forbes.com',
				'cnn.com',
				'guardian.com',
				'marketwatch.com',
				'nasdaq.com',
				'decrypt.co',
				'cryptonews.com',
				'bitcoinmagazine.com',
				'finance.yahoo.com',
			];
			for (const domain of expectedDomains) {
				expect(MEDIUM_TIER_DOMAINS.has(domain)).toBe(true);
			}
		});
	});

	describe('LOW_TIER_DOMAINS', () => {
		it('is a non-empty Set of normalized domain strings', () => {
			expect(LOW_TIER_DOMAINS).toBeInstanceOf(Set);
			expect(LOW_TIER_DOMAINS.size).toBeGreaterThan(0);

			for (const domain of LOW_TIER_DOMAINS) {
				expect(typeof domain).toBe('string');
				expect(domain.length).toBeGreaterThan(0);
				expect(domain).toBe(domain.toLowerCase());
				expect(domain.startsWith('www.')).toBe(false);
				expect(domain.startsWith('http://')).toBe(false);
				expect(domain.startsWith('https://')).toBe(false);
				expect(domain.includes('/')).toBe(false);
			}
		});

		it('contains user-generated and social media platforms', () => {
			const expectedDomains = [
				'medium.com',
				'substack.com',
				'reddit.com',
				'twitter.com',
				'x.com',
			];
			for (const domain of expectedDomains) {
				expect(LOW_TIER_DOMAINS.has(domain)).toBe(true);
			}
		});
	});

	describe('Domain Tier Disjointness', () => {
		it('ensures no domain exists in multiple tiers', () => {
			const highMediumOverlap = [...HIGH_TIER_DOMAINS].filter((d) => MEDIUM_TIER_DOMAINS.has(d));
			const highLowOverlap = [...HIGH_TIER_DOMAINS].filter((d) => LOW_TIER_DOMAINS.has(d));
			const mediumLowOverlap = [...MEDIUM_TIER_DOMAINS].filter((d) => LOW_TIER_DOMAINS.has(d));

			expect(highMediumOverlap).toEqual([]);
			expect(highLowOverlap).toEqual([]);
			expect(mediumLowOverlap).toEqual([]);
		});
	});

	describe('LOW_TLD_SUFFIXES', () => {
		it('is an array of non-empty strings starting with a dot', () => {
			expect(Array.isArray(LOW_TLD_SUFFIXES)).toBe(true);
			expect(LOW_TLD_SUFFIXES.length).toBeGreaterThan(0);

			for (const suffix of LOW_TLD_SUFFIXES) {
				expect(typeof suffix).toBe('string');
				expect(suffix.startsWith('.')).toBe(true);
				expect(suffix).toBe(suffix.toLowerCase());
			}
		});

		it('contains known low-quality / high-spam TLDs', () => {
			const expectedSuffixes = [
				'.blog',
				'.buzz',
				'.click',
				'.info',
				'.xyz',
				'.top',
				'.loan',
				'.review',
				'.download',
			];
			for (const suffix of expectedSuffixes) {
				expect(LOW_TLD_SUFFIXES).toContain(suffix);
			}
		});

		it('contains no duplicate suffixes', () => {
			const unique = new Set(LOW_TLD_SUFFIXES);
			expect(unique.size).toBe(LOW_TLD_SUFFIXES.length);
		});
	});

	describe('DOMAIN_TIER_MAP', () => {
		it('maps HIGH, MEDIUM, and LOW tiers to their respective Sets', () => {
			expect(DOMAIN_TIER_MAP[SourceQualityTier.HIGH]).toBe(HIGH_TIER_DOMAINS);
			expect(DOMAIN_TIER_MAP[SourceQualityTier.MEDIUM]).toBe(MEDIUM_TIER_DOMAINS);
			expect(DOMAIN_TIER_MAP[SourceQualityTier.LOW]).toBe(LOW_TIER_DOMAINS);
		});

		it('does not map UNKNOWN tier to a domain set', () => {
			expect(DOMAIN_TIER_MAP[SourceQualityTier.UNKNOWN]).toBeUndefined();
		});
	});
});
