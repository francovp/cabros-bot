'use strict';

jest.mock('../../src/services/remoteConfig/RemoteConfigService', () => ({
	getRuntimeConfig: jest.fn(() => ({})),
}));

const priceQuoteCache = require('../../src/services/cache/PriceQuoteCache');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('PriceQuoteCache', () => {
	beforeEach(() => {
		priceQuoteCache._resetForTesting();
		remoteConfigService.getRuntimeConfig.mockImplementation(() => ({}));
	});

	afterAll(() => {
		priceQuoteCache._resetForTesting();
	});

	describe('get / set', () => {
		it('returns null for missing crypto entries and increments misses', () => {
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBeNull();
			const stats = priceQuoteCache.getStats();
			expect(stats.crypto.misses).toBe(1);
			expect(stats.crypto.hits).toBe(0);
		});

		it('returns cached value for repeated crypto lookups and counts hits', () => {
			const quote = { symbol: 'BTCUSDT', price: 65000, assetClass: 'crypto', message: 'Precio de BTCUSDT es 65000' };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', quote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toEqual(quote);
			const stats = priceQuoteCache.getStats();
			expect(stats.crypto.sets).toBe(1);
			expect(stats.crypto.hits).toBe(1);
		});

		it('normalizes symbol keys to uppercase', () => {
			const quote = { symbol: 'BTCUSDT', price: 65000 };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'btcusdt', quote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toEqual(quote);
		});

		it('keeps crypto and equity buckets independent', () => {
			const cryptoQuote = { symbol: 'BTCUSDT', price: 65000, assetClass: 'crypto' };
			const equityQuote = { symbol: 'NVDA', price: 100, assetClass: 'equity' };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', cryptoQuote);
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA', equityQuote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toEqual(cryptoQuote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA')).toEqual(equityQuote);
		});

		it('treats equity cache keys as exchange-scoped', () => {
			const nasdaqQuote = { symbol: 'NVDA', price: 100, assetClass: 'equity', exchange: 'NASDAQ' };
			const nyseQuote = { symbol: 'NVDA', price: 110, assetClass: 'equity', exchange: 'NYSE' };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:NASDAQ', nasdaqQuote);
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:NYSE', nyseQuote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:NASDAQ')).toEqual(nasdaqQuote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:NYSE')).toEqual(nyseQuote);
		});

		it('rejects empty or invalid keys without throwing', () => {
			expect(priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, '', { x: 1 })).toBe(false);
			expect(priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, null, { x: 1 })).toBe(false);
			expect(priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, undefined, { x: 1 })).toBe(false);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, '')).toBeNull();
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, null)).toBeNull();
		});

		it('does not store nullish values', () => {
			expect(priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', null)).toBe(false);
			expect(priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', undefined)).toBe(false);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBeNull();
		});
	});

	describe('TTL expiry', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('returns cached value before expiry and null after expiry', () => {
			const quote = { symbol: 'BTCUSDT', price: 65000 };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', quote);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toEqual(quote);

			jest.advanceTimersByTime(priceQuoteCache.DEFAULT_TTL_MS_CRYPTO);

			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBeNull();
		});

		it('uses separate TTLs for crypto vs equity buckets', () => {
			const cryptoQuote = { symbol: 'BTCUSDT', price: 65000 };
			const equityQuote = { symbol: 'NVDA', price: 100 };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', cryptoQuote);
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:default', equityQuote);

			jest.advanceTimersByTime(priceQuoteCache.DEFAULT_TTL_MS_CRYPTO + 1);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBeNull();
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:default')).toEqual(equityQuote);

			jest.advanceTimersByTime(priceQuoteCache.DEFAULT_TTL_MS_EQUITY);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA:default')).toBeNull();
		});
	});

	describe('bounded LRU eviction', () => {
		beforeEach(() => {
			jest.useFakeTimers();
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('evicts the oldest entries when the bucket exceeds its configured size', () => {
			const maxEntries = 3;
			const cache = require('../../src/services/cache/PriceQuoteCache');
			// Override getRuntimeConfig to enforce a small bucket size
			remoteConfigService.getRuntimeConfig.mockImplementation(() => ({
				PRICE_CACHE_TTL_MS_CRYPTO: 60000,
				PRICE_CACHE_MAX_ENTRIES_PER_BUCKET: maxEntries,
			}));
			// bust module cache by re-requiring (resolveBucketConfig reads runtimeConfig lazily)
			cache._resetForTesting();

			for (let i = 0; i < maxEntries + 2; i += 1) {
				cache.set(cache.PROVIDERS.CRYPTO, `SYM${i}`, { price: i });
			}

			expect(cache.getStats().crypto.evictions).toBe(2);
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM0')).toBeNull();
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM1')).toBeNull();
			expect(cache.get(cache.PROVIDERS.CRYPTO, `SYM${maxEntries + 1}`)).toEqual({ price: maxEntries + 1 });
		});

		it('refreshes LRU order on cache hit', () => {
			const maxEntries = 3;
			remoteConfigService.getRuntimeConfig.mockImplementation(() => ({
				PRICE_CACHE_TTL_MS_CRYPTO: 60000,
				PRICE_CACHE_MAX_ENTRIES_PER_BUCKET: maxEntries,
			}));
			const cache = require('../../src/services/cache/PriceQuoteCache');
			cache._resetForTesting();

			cache.set(cache.PROVIDERS.CRYPTO, 'SYM0', { price: 0 });
			cache.set(cache.PROVIDERS.CRYPTO, 'SYM1', { price: 1 });
			cache.set(cache.PROVIDERS.CRYPTO, 'SYM2', { price: 2 });

			// touch SYM0 so it becomes the most-recent
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM0')).toEqual({ price: 0 });

			// Inserting two more entries must evict the older tail entries, not SYM0
			cache.set(cache.PROVIDERS.CRYPTO, 'SYM3', { price: 3 });
			cache.set(cache.PROVIDERS.CRYPTO, 'SYM4', { price: 4 });

			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM0')).toEqual({ price: 0 });
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM1')).toBeNull();
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM2')).toBeNull();
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM3')).toEqual({ price: 3 });
			expect(cache.get(cache.PROVIDERS.CRYPTO, 'SYM4')).toEqual({ price: 4 });
		});
	});

	describe('disabled mode', () => {
		it('drops entries and short-circuits reads when disabled', () => {
			const quote = { symbol: 'BTCUSDT', price: 65000 };
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', quote);
			priceQuoteCache.setDisabled(true);
			expect(priceQuoteCache.isEnabled()).toBe(false);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBeNull();
			expect(priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', quote)).toBe(false);
			priceQuoteCache.setDisabled(false);
		});

		it('exposes enabled/disabled flag in status', () => {
			const before = priceQuoteCache.getStatus();
			expect(before.enabled).toBe(true);
			expect(before.disabled).toBe(false);
			expect(before.storage).toBe('memory');
			expect(before.ttlMs.crypto).toBe(priceQuoteCache.DEFAULT_TTL_MS_CRYPTO);
			expect(before.ttlMs.equity).toBe(priceQuoteCache.DEFAULT_TTL_MS_EQUITY);

			priceQuoteCache.setDisabled(true);
			const after = priceQuoteCache.getStatus();
			expect(after.enabled).toBe(false);
			expect(after.disabled).toBe(true);
			priceQuoteCache.setDisabled(false);
		});
	});

	describe('invalidate / clear', () => {
		it('invalidate removes a single key without affecting siblings', () => {
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', { price: 1 });
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'ETHUSDT', { price: 2 });

			expect(priceQuoteCache.invalidate(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBe(true);
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT')).toBeNull();
			expect(priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'ETHUSDT')).toEqual({ price: 2 });
		});

		it('clear() resets counters and removes all entries', () => {
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', { price: 1 });
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA', { price: 2 });
			priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT'); // hit
			priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'ETHUSDT'); // miss

			priceQuoteCache.clear();
			const stats = priceQuoteCache.getStats();
			expect(stats.crypto.size).toBe(0);
			expect(stats.equity.size).toBe(0);
			expect(stats.crypto.hits).toBe(0);
			expect(stats.crypto.misses).toBe(0);
		});
	});

	describe('status exposure', () => {
		it('reports per-bucket counters and configured TTLs', () => {
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT', { price: 1 });
			priceQuoteCache.set(priceQuoteCache.PROVIDERS.EQUITY, 'NVDA', { price: 2 });
			priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'BTCUSDT');
			priceQuoteCache.get(priceQuoteCache.PROVIDERS.CRYPTO, 'ETHUSDT');

			const status = priceQuoteCache.getStatus();
			expect(status.buckets.crypto.size).toBe(1);
			expect(status.buckets.crypto.hits).toBe(1);
			expect(status.buckets.crypto.misses).toBe(1);
			expect(status.buckets.crypto.sets).toBe(1);
			expect(status.buckets.equity.size).toBe(1);
			expect(status.buckets.equity.sets).toBe(1);
			expect(status.ttlMs).toEqual({
				crypto: priceQuoteCache.DEFAULT_TTL_MS_CRYPTO,
				equity: priceQuoteCache.DEFAULT_TTL_MS_EQUITY,
			});
			expect(status.maxEntriesPerBucket).toBe(priceQuoteCache.MAX_ENTRIES_PER_BUCKET);
		});
	});
});