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

		it('reading an existing key via get() refreshes LRU recency', async () => {
			await cache.set('A', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('B', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('C', EventCategory.PRICE_SURGE, { v: 1 });

			// Read A via get() — should move A to most-recently used
			const hit = await cache.get('A', EventCategory.PRICE_SURGE);
			expect(hit).toEqual({ v: 1 });

			// Insert D — should evict B (oldest unread), keeping A, C, and D
			await cache.set('D', EventCategory.PRICE_SURGE, { v: 1 });

			expect(await cache.get('A', EventCategory.PRICE_SURGE)).not.toBeNull();
			expect(await cache.get('B', EventCategory.PRICE_SURGE)).toBeNull();
			expect(await cache.get('C', EventCategory.PRICE_SURGE)).not.toBeNull();
			expect(await cache.get('D', EventCategory.PRICE_SURGE)).not.toBeNull();
		});

		it('enforces maxEntries cap on claim()', async () => {
			await cache.set('A', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('B', EventCategory.PRICE_SURGE, { v: 1 });
			await cache.set('C', EventCategory.PRICE_SURGE, { v: 1 });

			const claimed = await cache.claim('D', EventCategory.PRICE_SURGE);
			expect(claimed).toBe(true);
			expect(cache.cache.size).toBe(3);
			expect(await cache.get('A', EventCategory.PRICE_SURGE)).toBeNull();
			expect(await cache.get('B', EventCategory.PRICE_SURGE)).not.toBeNull();
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
			cache.releaseDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'telegram');
			await cache.claimDelivery('ETHUSDT', EventCategory.PRICE_SURGE, 'telegram');
			cache.releaseDelivery('ETHUSDT', EventCategory.PRICE_SURGE, 'telegram');
			await cache.claimDelivery('BNBUSDT', EventCategory.PRICE_SURGE, 'telegram');
			expect(cache.deliveryLocks.size).toBeLessThanOrEqual(2);
		});

		it('preserves active delivery leases and rejects new claims when saturated', async () => {
			const claimed1 = await cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'telegram');
			const claimed2 = await cache.claimDelivery('ETHUSDT', EventCategory.PRICE_SURGE, 'telegram');
			expect(claimed1).toBe(true);
			expect(claimed2).toBe(true);
			expect(cache.deliveryLocks.size).toBe(2);

			// Both leases are currently active. A third claim should NOT evict active leases,
			// and should be rejected (returns false).
			const claimed3 = await cache.claimDelivery('BNBUSDT', EventCategory.PRICE_SURGE, 'telegram');
			expect(claimed3).toBe(false);
			expect(cache.deliveryLocks.size).toBe(2);

			// Verify both active leases were preserved
			const btcLease = cache.deliveryLocks.get('BTCUSDT:price_surge:delivery:telegram');
			const ethLease = cache.deliveryLocks.get('ETHUSDT:price_surge:delivery:telegram');
			expect(btcLease?.active).toBe(true);
			expect(ethLease?.active).toBe(true);

			// Now release BTC lease
			cache.releaseDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'telegram');

			// Now claiming BNB should succeed because the inactive BTC lease can be evicted
			const claimed3Retry = await cache.claimDelivery('BNBUSDT', EventCategory.PRICE_SURGE, 'telegram');
			expect(claimed3Retry).toBe(true);
			expect(cache.deliveryLocks.size).toBe(2);
			expect(cache.deliveryLocks.has('BTCUSDT:price_surge:delivery:telegram')).toBe(false);
			expect(cache.deliveryLocks.has('ETHUSDT:price_surge:delivery:telegram')).toBe(true);
			expect(cache.deliveryLocks.has('BNBUSDT:price_surge:delivery:telegram')).toBe(true);
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