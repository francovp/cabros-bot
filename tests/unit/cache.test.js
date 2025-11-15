/**
 * Unit Tests for News Monitor Cache Module (Phase 5 - US3)
 * Tests: TTL enforcement, cleanup, key generation, deduplication
 */

const { NewsCache, getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');

describe('Cache Module - Unit Tests', () => {
	let cache;

	beforeEach(() => {
		// Create fresh cache instance for each test
		cache = new NewsCache();
		// Set short TTL for testing
		cache.ttlMs = 1000; // 1 second
	});

	afterEach(() => {
		cache.shutdown();
	});

	describe('Cache Key Generation', () => {
		it('should generate correct cache key format', () => {
			const key = cache.generateKey('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(key).toBe('BTCUSDT:price_surge');
		});

		it('should generate different keys for different event categories', () => {
			const key1 = cache.generateKey('BTCUSDT', EventCategory.PRICE_SURGE);
			const key2 = cache.generateKey('BTCUSDT', EventCategory.PRICE_DECLINE);
			expect(key1).not.toBe(key2);
		});

		it('should generate different keys for different symbols', () => {
			const key1 = cache.generateKey('BTCUSDT', EventCategory.PRICE_SURGE);
			const key2 = cache.generateKey('ETHUSD', EventCategory.PRICE_SURGE);
			expect(key1).not.toBe(key2);
		});
	});

	describe('Cache Set and Get', () => {
		it('should store and retrieve cache entry', () => {
			const data = {
				alert: { symbol: 'BTCUSDT', confidence: 0.8 },
				analysisResult: { status: 'analyzed' },
			};

			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);
			const retrieved = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(retrieved).toEqual(data);
		});

		it('should return null for non-existent cache entry', () => {
			const retrieved = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(retrieved).toBeNull();
		});

		it('should independently cache different event categories for same symbol', () => {
			const data1 = { alert: { eventCategory: 'price_surge' } };
			const data2 = { alert: { eventCategory: 'price_decline' } };

			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data1);
			cache.set('BTCUSDT', EventCategory.PRICE_DECLINE, data2);

			const retrieved1 = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			const retrieved2 = cache.get('BTCUSDT', EventCategory.PRICE_DECLINE);

			expect(retrieved1).toEqual(data1);
			expect(retrieved2).toEqual(data2);
		});
	});

	describe('TTL Enforcement', () => {
		it('should return cached entry before TTL expiry', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			// Wait 500ms (less than 1s TTL)
			await new Promise(resolve => setTimeout(resolve, 500));

			const retrieved = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(retrieved).toEqual(data);
		});

		it('should return null after TTL expiry', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			// Wait for TTL to expire (1.1 seconds with 1s TTL)
			await new Promise(resolve => setTimeout(resolve, 1100));

			const retrieved = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(retrieved).toBeNull();
		});

		it('should remove expired entry on retrieval', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			expect(cache.cache.size).toBe(1);

			// Wait for TTL to expire
			await new Promise(resolve => setTimeout(resolve, 1100));

			// Retrieval should remove expired entry
			cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(cache.cache.size).toBe(0);
		});
	});

	describe('Cache Cleanup', () => {
		it('should remove expired entries during cleanup', async () => {
			// Add two entries
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			cache.set('ETHUSD', EventCategory.PRICE_SURGE, { alert: {} });
			expect(cache.cache.size).toBe(2);

			// Wait for TTL to expire
			await new Promise(resolve => setTimeout(resolve, 1100));

			// Run cleanup
			cache.cleanup();

			// All expired entries should be removed
			expect(cache.cache.size).toBe(0);
		});

		it('should preserve non-expired entries during cleanup', async () => {
			// Add first entry
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: { symbol: 'BTCUSDT' } });

			// Wait 500ms (less than TTL)
			await new Promise(resolve => setTimeout(resolve, 500));

			// Add second entry
			cache.set('ETHUSD', EventCategory.PRICE_SURGE, { alert: { symbol: 'ETHUSD' } });

			expect(cache.cache.size).toBe(2);

			// Wait another 500ms (total 1s from first entry - should expire)
			// But second entry should still be fresh (only 500ms old)
			await new Promise(resolve => setTimeout(resolve, 500));

			cache.cleanup();

			// First entry expired, second preserved
			expect(cache.cache.size).toBe(1);

			// Verify correct entry was preserved
			const remaining = cache.get('ETHUSD', EventCategory.PRICE_SURGE);
			expect(remaining).not.toBeNull();
		});
	});

	describe('Cache Statistics', () => {
		it('should return correct cache statistics', () => {
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			cache.set('ETHUSD', EventCategory.PRICE_DECLINE, { alert: {} });

			const stats = cache.getStats();

			expect(stats.size).toBe(2);
			expect(stats.ttlHours).toBe(1 / 3600); // 1000ms converted to hours
			expect(stats.entries).toContain('BTCUSDT:price_surge');
			expect(stats.entries).toContain('ETHUSD:price_decline');
		});

		it('should reflect cache size after operations', () => {
			let stats = cache.getStats();
			expect(stats.size).toBe(0);

			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			stats = cache.getStats();
			expect(stats.size).toBe(1);

			cache.clear();
			stats = cache.getStats();
			expect(stats.size).toBe(0);
		});
	});

	describe('Cache Clear', () => {
		it('should remove all cache entries', () => {
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			cache.set('ETHUSD', EventCategory.PRICE_DECLINE, { alert: {} });
			expect(cache.cache.size).toBe(2);

			cache.clear();
			expect(cache.cache.size).toBe(0);
		});

		it('should remove all entries even after multiple sets', () => {
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			cache.set('ETHUSD', EventCategory.PRICE_DECLINE, { alert: {} });
			cache.set('AAPL', EventCategory.PUBLIC_FIGURE, { alert: {} });

			cache.clear();

			const s1 = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			const s2 = cache.get('ETHUSD', EventCategory.PRICE_DECLINE);
			const s3 = cache.get('AAPL', EventCategory.PUBLIC_FIGURE);

			expect(s1).toBeNull();
			expect(s2).toBeNull();
			expect(s3).toBeNull();
		});
	});

	describe('Singleton Pattern', () => {
		it('should return same instance on multiple calls', () => {
			const instance1 = getCacheInstance();
			const instance2 = getCacheInstance();
			expect(instance1).toBe(instance2);
		});
	});

	describe('Deduplication Scenario', () => {
		it('should prevent duplicate alerts for same symbol+category within TTL', () => {
			const alert1 = {
				alert: { symbol: 'BTCUSDT', eventCategory: 'price_surge', confidence: 0.8 },
				deliveryResults: [{ channel: 'telegram', success: true }],
			};

			// First analysis
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, alert1);
			const cached1 = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(cached1).toEqual(alert1);

			// Second analysis (within TTL)
			const cached2 = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(cached2).toEqual(cached1); // Same as first
		});

		it('should allow new alerts for same symbol after different event category', () => {
			const alert1 = { alert: { eventCategory: 'price_surge' } };
			const alert2 = { alert: { eventCategory: 'price_decline' } };

			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, alert1);
			cache.set('BTCUSDT', EventCategory.PRICE_DECLINE, alert2);

			const cached1 = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			const cached2 = cache.get('BTCUSDT', EventCategory.PRICE_DECLINE);

			expect(cached1).toEqual(alert1);
			expect(cached2).toEqual(alert2);
		});

		it('should allow new alerts after TTL expiry', async () => {
			const alert1 = { alert: { version: 1 } };
			const alert2 = { alert: { version: 2 } };

			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, alert1);
			const first = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(first).toEqual(alert1);

			// Wait for expiry
			await new Promise(resolve => setTimeout(resolve, 1100));

			// Old entry should be gone
			const expired = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(expired).toBeNull();

			// New entry can be added
			cache.set('BTCUSDT', EventCategory.PRICE_SURGE, alert2);
			const second = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(second).toEqual(alert2);
		});
	});
});
