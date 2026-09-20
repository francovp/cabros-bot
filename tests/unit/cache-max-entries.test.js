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

		it('preserves in-flight claiming entries when evicting for a new claim', async () => {
			const claiming = new NewsCache(undefined, { maxEntries: 2 });
			try {
				await claiming.claim('ACTIVE', EventCategory.PRICE_SURGE);
				await claiming.set('COLD', EventCategory.PRICE_SURGE, { v: 1 });

				expect(await claiming.claim('NEW', EventCategory.PRICE_SURGE)).toBe(true);
				expect(claiming.cache.has('ACTIVE:price_surge')).toBe(true);
				expect(claiming.cache.has('COLD:price_surge')).toBe(false);
			} finally {
				claiming.shutdown();
			}
		});

		it('rejects a new claim when every capacity slot is an active claim', async () => {
			const claiming = new NewsCache(undefined, { maxEntries: 2 });
			try {
				await claiming.claim('ACTIVE_A', EventCategory.PRICE_SURGE);
				await claiming.claim('ACTIVE_B', EventCategory.PRICE_SURGE);

				expect(await claiming.claim('NEW', EventCategory.PRICE_SURGE)).toBe(false);
				expect(claiming.cache.size).toBe(2);
				expect(claiming.cache.get('ACTIVE_A:price_surge')?.data.status).toBe('claiming');
				expect(claiming.cache.get('ACTIVE_B:price_surge')?.data.status).toBe('claiming');
			} finally {
				claiming.shutdown();
			}
		});

		it('evicts multiple over-capacity entries in a single pass while preserving active claims', async () => {
			const c = new NewsCache(undefined, { maxEntries: 5 });
			try {
				await c.set('E1', EventCategory.PRICE_SURGE, { data: '1' });
				await c.claim('CLAIM1', EventCategory.PRICE_SURGE);
				await c.set('E2', EventCategory.PRICE_SURGE, { data: '2' });
				await c.set('E3', EventCategory.PRICE_SURGE, { data: '3' });
				await c.set('E4', EventCategory.PRICE_SURGE, { data: '4' });
				expect(c.cache.size).toBe(5);

				// Manually reduce maxEntries to 2 and trigger eviction
				c.maxEntries = 2;
				c._evictIfOverCapacity();

				// Size should now be 2, CLAIM1 preserved, oldest evictables (E1, E2, E3) evicted, newest (E4) kept
				expect(c.cache.size).toBe(2);
				expect(c.cache.has('CLAIM1:price_surge')).toBe(true);
				expect(c.cache.has('E4:price_surge')).toBe(true);
				expect(c.cache.has('E1:price_surge')).toBe(false);
				expect(c.cache.has('E2:price_surge')).toBe(false);
				expect(c.cache.has('E3:price_surge')).toBe(false);
			} finally {
				c.shutdown();
			}
		});

		it('evicts over-capacity entries when read via get() after capacity is reduced', async () => {
			const c = new NewsCache(undefined, { maxEntries: 4 });
			try {
				await c.set('K1', EventCategory.PRICE_SURGE, { data: '1' });
				await c.set('K2', EventCategory.PRICE_SURGE, { data: '2' });
				await c.set('K3', EventCategory.PRICE_SURGE, { data: '3' });
				expect(c.cache.size).toBe(3);

				// Lower maxEntries to 2 without calling set()
				c.maxEntries = 2;

				// Calling get() on an existing key should refresh recency and evict oldest to enforce maxEntries = 2
				const val = await c.get('K3', EventCategory.PRICE_SURGE);
				expect(val).toEqual({ data: '3' });
				expect(c.cache.size).toBe(2);
				expect(await c.get('K1', EventCategory.PRICE_SURGE)).toBeNull();
				expect(await c.get('K2', EventCategory.PRICE_SURGE)).not.toBeNull();
			} finally {
				c.shutdown();
			}
		});

		it('evicts over-capacity entries during periodic cleanup()', async () => {
			const c = new NewsCache(undefined, { maxEntries: 4 });
			try {
				await c.set('K1', EventCategory.PRICE_SURGE, { data: '1' });
				await c.set('K2', EventCategory.PRICE_SURGE, { data: '2' });
				await c.set('K3', EventCategory.PRICE_SURGE, { data: '3' });
				expect(c.cache.size).toBe(3);

				// Lower maxEntries directly
				c._explicitMaxEntries = 1;

				c.cleanup();
				expect(c.cache.size).toBe(1);
				expect(await c.get('K3', EventCategory.PRICE_SURGE)).not.toBeNull();
			} finally {
				c.shutdown();
			}
		});

		it('immediately evicts over-capacity entries upon setting maxEntries', async () => {
			const c = new NewsCache(undefined, { maxEntries: 5 });
			try {
				await c.set('A', EventCategory.PRICE_SURGE, { v: 1 });
				await c.set('B', EventCategory.PRICE_SURGE, { v: 2 });
				await c.set('C', EventCategory.PRICE_SURGE, { v: 3 });
				expect(c.cache.size).toBe(3);

				// Setting maxEntries property should trigger immediate eviction
				c.maxEntries = 1;
				expect(c.cache.size).toBe(1);
				expect(await c.get('C', EventCategory.PRICE_SURGE)).not.toBeNull();
			} finally {
				c.shutdown();
			}
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

		it('evicts an inactive lease before rejecting a claim at capacity', async () => {
			cache.deliveryLocks.set('inactive', {
				active: false,
				persistentUntil: Date.now() + 10_000,
			});
			cache.deliveryLocks.set('active', {
				active: true,
				persistentUntil: Date.now() + 10_000,
			});

			const claimed = await cache.claimDelivery('BNBUSDT', EventCategory.PRICE_SURGE, 'telegram');

			expect(claimed).toBe(true);
			expect(cache.deliveryLocks.size).toBe(2);
			expect(cache.deliveryLocks.has('inactive')).toBe(false);
			expect(cache.deliveryLocks.get('active')?.active).toBe(true);
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

		it('falls back to default when env var exceeds upper bound', () => {
			process.env.NEWS_CACHE_MAX_ENTRIES = '1000001';
			process.env.NEWS_DELIVERY_LOCK_MAX_ENTRIES = '100001';
			const c = new NewsCache();
			expect(c.maxEntries).toBe(5000);
			expect(c.deliveryLockMaxEntries).toBe(1000);
			c.shutdown();
		});

		it('immediately evicts over-capacity deliveryLocks upon setting deliveryLockMaxEntries', () => {
			const c = new NewsCache(undefined, { deliveryLockMaxEntries: 5 });
			try {
				c.deliveryLocks.set('lock1', { active: false, persistentUntil: Date.now() + 60000 });
				c.deliveryLocks.set('lock2', { active: false, persistentUntil: Date.now() + 60000 });
				expect(c.deliveryLocks.size).toBe(2);

				c.deliveryLockMaxEntries = 1;
				expect(c.deliveryLocks.size).toBe(1);
			} finally {
				c.shutdown();
			}
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
