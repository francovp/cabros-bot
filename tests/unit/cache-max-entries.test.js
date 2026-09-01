/**
 * Unit Tests for NewsCache Max Entries / LRU Eviction
 * Covers issue #689: bound in-memory growth via LRU eviction + deliveryLocks bounds
 */

const { NewsCache, getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');

describe('Cache Max Entries / LRU Eviction', () => {
	describe('NewsCache.set LRU eviction', () => {
		let cache;

		beforeEach(() => {
			cache = new NewsCache(undefined, { maxEntries: 3 });
		});

		afterEach(() => {
			cache.shutdown();
		});

		it('respects the configured maxEntries cap', async () => {
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('ETHUSDT', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('BNBUSDT', EventCategory.PRICE_SURGE, { v: 1 });
			expect(cache.cache.size).toBe(3);

			await cache.set('SOLUSDT', EventCategory.PRICE_SURGE, { v: 1 });
			expect(cache.cache.size).toBe(3);
			expect(cache._evictionCount).toBeGreaterThanOrEqual(1);
		});

		it('evicts the oldest inserted entry first', async () => {
			await cache.set('OLD', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('MID', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('NEW', EventCategory.PRICE_SURGE, { v: 1 });

			await cache.set('EVICT', EventCategory.PRICE_SURGE, { v: 1 });

			expect(await cache.get('OLD', EventCategory.PRICE_SURGE)).toBeNull();
			expect(await cache.get('MID', EventCategory.PRICE_SURGE)).not.toBeNull();
			expect(await cache.get('NEW', EventCategory.PRICE_SURGE)).not.toBeNull();
			expect(await cache.get('EVICT', EventCategory.PRICE_SURGE)).not.toBeNull();
		});

		it('re-setting an existing key moves it to the most-recent position', async () => {
			await cache.set('A', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('B', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('C', EventCategory.PRICE_SURGE, { v: 1 });

			// Touch A so it is the most-recent.
			await cache.set('A', EventCategory.PRICE_SURGE, { v: 2 });

			// Insert a new key — should evict B (now the oldest), not A.
			await cache.set('D', EventCategory.PRICE_SURGE, { v: 1 });

			expect(await cache.get('A', EventCategory.PRICE_SURGE)).not.toBeNull();
			expect(await cache.get('B', EventCategory.PRICE_SURGE)).toBeNull();
			expect(await cache.get('C', EventCategory.PRICE_SURGE)).not.toBeNull();
			expect(await cache.get('D', EventCategory.PRICE_SURGE)).not.toBeNull();
		});

		it('exposes maxEntries + evictionCount in getStats()', () => {
			expect(cache.maxEntries).toBe(3);
			const stats = cache.getStats();
			expect(stats.maxEntries).toBe(3);
			expect(stats.evictionCount).toBe(0);
		});
	});

	describe('NewsCache deliveryLocks size bound', () => {
		let cache;

		beforeEach(() => {
			cache = new NewsCache(undefined, { maxEntries: 100, deliveryLockMaxEntries: 2 });
		});

		afterEach(() => {
			cache.shutdown();
		});

		it('respects the configured deliveryLockMaxEntries cap', async () => {
			await cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'telegram');
			await cache.claimDelivery('ETHUSDT', EventCategory.PRICE_SURGE, 'telegram');
			await cache.claimDelivery('BNBUSDT', EventCategory.PRICE_SURGE, 'telegram');
			expect(cache.deliveryLocks.size).toBeLessThanOrEqual(2);
		});

		it('exposes deliveryLocks stats in getStats()', () => {
			const stats = cache.getStats();
			expect(stats.deliveryLockMaxEntries).toBe(2);
			expect(stats.deliveryLockEvictionCount).toBe(0);
			expect(stats.deliveryLocksSize).toBe(0);
		});
	});

	describe('NewsCache maxEntries fallback to env / defaults', () => {
		const originalMax = process.env.NEWS_CACHE_MAX_ENTRIES;
		const originalDelivery = process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES;

		afterEach(() => {
			if (originalMax === undefined) {
				delete process.env.NEWS_CACHE_MAX_ENTRIES;
			} else {
				process.env.NEWS_CACHE_MAX_ENTRIES = originalMax;
			}
			if (originalDelivery === undefined) {
				delete process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES;
			} else {
				process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES = originalDelivery;
			}
		});

		it('falls back to default when env var is missing or malformed', () => {
			delete process.env.NEWS_CACHE_MAX_ENTRIES;
			delete process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES;
			const c = new NewsCache();
			expect(c.maxEntries).toBe(5000);
			expect(c.deliveryLockMaxEntries).toBe(1000);
			c.shutdown();
		});

		it('parses valid env var override', () => {
			process.env.NEWS_CACHE_MAX_ENTRIES = '1234';
			process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES = '256';
			const c = new NewsCache();
			expect(c.maxEntries).toBe(1234);
			expect(c.deliveryLockMaxEntries).toBe(256);
			c.shutdown();
		});

		it('falls back to default on malformed env var', () => {
			process.env.NEWS_CACHE_MAX_ENTRIES = 'not-a-number';
			process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES = '0';
			const c = new NewsCache();
			expect(c.maxEntries).toBe(5000);
			expect(c.deliveryLockMaxEntries).toBe(1000);
			c.shutdown();
		});
	});

	describe('Singleton stays consistent with new options', () => {
		afterEach(() => {
			const instance = getCacheInstance();
			instance.shutdown();
		});

		it('default singleton exposes size metadata', () => {
			const cache = getCacheInstance();
			const stats = cache.getStats();
			expect(typeof stats.maxEntries).toBe('number');
			expect(stats.maxEntries).toBeGreaterThan(0);
			expect(typeof stats.deliveryLockMaxEntries).toBe('number');
			expect(typeof stats.evictionCount).toBe('number');
			expect(typeof stats.deliveryLockEvictionCount).toBe('number');
		});
	});
});