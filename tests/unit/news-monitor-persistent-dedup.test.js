/**
 * Unit Tests for Persistent News Monitor Dedup Cache (Issue #120)
 * Tests: NewsCache integration with Firestore dedup backend
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock NewsDedupStorageService BEFORE importing the cache module
// ─────────────────────────────────────────────────────────────────────────────
const mockIsEnabled = jest.fn().mockReturnValue(false);
const mockHasEntry = jest.fn().mockResolvedValue(false);
const mockSetEntry = jest.fn().mockResolvedValue(undefined);
const mockDeleteEntry = jest.fn().mockResolvedValue(undefined);

jest.mock('../../src/services/storage/NewsDedupStorageService', () => ({
	isEnabled: mockIsEnabled,
	hasEntry: mockHasEntry,
	setEntry: mockSetEntry,
	deleteEntry: mockDeleteEntry,
	_resetForTesting: jest.fn(),
	COLLECTION_NAME: 'news-monitor-dedup',
}));

const { NewsCache } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');

describe('NewsCache — Persistent Dedup Backend (Issue #120)', () => {
	let cache;

	beforeEach(() => {
		jest.clearAllMocks();
		mockIsEnabled.mockReturnValue(false);
		mockHasEntry.mockResolvedValue(false);
		mockSetEntry.mockResolvedValue(undefined);
		cache = new NewsCache();
		cache.ttlMs = 1000; // 1 second for fast tests
	});

	afterEach(() => {
		cache.shutdown();
	});

	// ─────────────────────────────────────────
	// dedupMode property
	// ─────────────────────────────────────────
	describe('dedupMode property', () => {
		it('reports in-memory mode when persistent dedup is disabled', () => {
			mockIsEnabled.mockReturnValue(false);
			expect(cache.dedupMode).toEqual({ mode: 'in-memory', backend: null });
		});

		it('reports persistent mode with firestore backend when enabled', () => {
			mockIsEnabled.mockReturnValue(true);
			expect(cache.dedupMode).toEqual({ mode: 'persistent', backend: 'firestore' });
		});
	});

	// ─────────────────────────────────────────
	// getStats includes deduplication info
	// ─────────────────────────────────────────
	describe('getStats', () => {
		it('includes deduplication mode in stats when disabled', () => {
			mockIsEnabled.mockReturnValue(false);
			const stats = cache.getStats();
			expect(stats.deduplication).toEqual({ mode: 'in-memory', backend: null });
		});

		it('includes deduplication mode in stats when enabled', () => {
			mockIsEnabled.mockReturnValue(true);
			const stats = cache.getStats();
			expect(stats.deduplication).toEqual({ mode: 'persistent', backend: 'firestore' });
		});
	});

	// ─────────────────────────────────────────
	// In-memory-only behaviour (disabled)
	// ─────────────────────────────────────────
	describe('in-memory mode (ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP=false)', () => {
		beforeEach(() => {
			mockIsEnabled.mockReturnValue(false);
		});

		it('stores and retrieves data from in-memory cache without touching Firestore', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(result).toEqual(data);
			expect(mockSetEntry).not.toHaveBeenCalled();
			expect(mockHasEntry).not.toHaveBeenCalled();
		});

		it('returns null for a cache miss without consulting Firestore', async () => {
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
			expect(mockHasEntry).not.toHaveBeenCalled();
		});

		it('returns null after TTL expiry without touching Firestore', async () => {
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			await new Promise(resolve => setTimeout(resolve, 1100));
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
			expect(mockHasEntry).not.toHaveBeenCalled();
		});

		it('generates correct dedup key format', () => {
			expect(cache.generateKey('BTCUSDT', 'price_surge')).toBe('BTCUSDT:price_surge');
		});
	});

	// ─────────────────────────────────────────
	// Persistent mode (enabled)
	// ─────────────────────────────────────────
	describe('persistent mode (ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP=true)', () => {
		beforeEach(() => {
			mockIsEnabled.mockReturnValue(true);
			mockSetEntry.mockResolvedValue(undefined);
			mockHasEntry.mockResolvedValue(false);
		});

		it('writes to both in-memory and Firestore on set()', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			// In-memory should have it
			const inMemoryEntry = cache.cache.get('BTCUSDT:price_surge');
			expect(inMemoryEntry).toBeDefined();
			expect(inMemoryEntry.data).toEqual(data);

			// Firestore write should have been called (fire-and-forget)
			await new Promise(resolve => setImmediate(resolve));
			expect(mockSetEntry).toHaveBeenCalledWith('BTCUSDT:price_surge', cache.ttlMs);
		});

		it('returns in-memory hit immediately without checking Firestore', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);
			mockHasEntry.mockClear();

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toEqual(data);
			expect(mockHasEntry).not.toHaveBeenCalled();
		});

		it('falls back to Firestore when local cache misses (cross-replica scenario)', async () => {
			// Local in-memory is empty — simulates a fresh replica
			mockHasEntry.mockResolvedValue(true); // Firestore has the entry

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(mockHasEntry).toHaveBeenCalledWith('BTCUSDT:price_surge');
			expect(result).toEqual({ _dedupSource: 'firestore' });
		});

		it('warms local in-memory cache after a Firestore hit to avoid repeated lookups', async () => {
			mockHasEntry.mockResolvedValue(true);

			await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			// Local cache should now contain the warmed entry
			expect(cache.cache.has('BTCUSDT:price_surge')).toBe(true);
		});

		it('returns null and allows the alert when both local and Firestore miss', async () => {
			mockHasEntry.mockResolvedValue(false);
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
		});

		it('falls back gracefully when Firestore hasEntry throws (fail-open)', async () => {
			mockHasEntry.mockRejectedValue(new Error('Firestore timeout'));

			// Should resolve to null (fail-open), not throw
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
		});

		it('does not fail the set() call if Firestore setEntry throws (fail-open)', async () => {
			mockSetEntry.mockRejectedValue(new Error('Firestore unavailable'));

			const data = { alert: { symbol: 'BTCUSDT' } };
			// Should not throw
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			// Allow a tick for the fire-and-forget rejection handler
			await new Promise(resolve => setImmediate(resolve));

			// In-memory should still have the entry
			expect(cache.cache.has('BTCUSDT:price_surge')).toBe(true);
		});

		it('checks Firestore after local TTL expiry (restart/eviction simulation)', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			// Wait for in-memory TTL to expire
			await new Promise(resolve => setTimeout(resolve, 1100));

			// Firestore still has the entry (persistent across restart)
			mockHasEntry.mockResolvedValue(true);
			mockHasEntry.mockClear(); // clear call count from set() above

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(mockHasEntry).toHaveBeenCalledWith('BTCUSDT:price_surge');
			expect(result).toEqual({ _dedupSource: 'firestore' });
		});

		it('TTL contract: uses cache.ttlMs when writing to Firestore', async () => {
			const customTtlMs = 3600000; // 1 hour
			cache.ttlMs = customTtlMs;
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			await new Promise(resolve => setImmediate(resolve));
			expect(mockSetEntry).toHaveBeenCalledWith('BTCUSDT:price_surge', customTtlMs);
		});
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// NewsDedupStorageService unit tests (isolated, no Firestore required)
// ─────────────────────────────────────────────────────────────────────────────
describe('NewsDedupStorageService — isEnabled()', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
	});

	afterEach(() => {
		if (savedEnv === undefined) {
			delete process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
		} else {
			process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = savedEnv;
		}
	});

	it('isEnabled returns false when env var is absent (default)', () => {
		delete process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
		// Re-evaluate through the mock which is backed by real env checks
		// Use the real module directly (bypass the jest.mock for this suite)
		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		expect(realService.isEnabled()).toBe(false);
	});

	it('isEnabled returns false when env var is "false"', () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'false';
		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		expect(realService.isEnabled()).toBe(false);
	});

	it('isEnabled returns true when env var is "true"', () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		expect(realService.isEnabled()).toBe(true);
	});
});
