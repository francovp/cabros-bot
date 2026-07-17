/**
 * Unit Tests for Persistent News Monitor Dedup Cache (Issue #120)
 * Tests: NewsCache integration with Firestore dedup backend, claim, and readiness.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Mock NewsDedupStorageService BEFORE importing the cache module
// ─────────────────────────────────────────────────────────────────────────────
const mockIsEnabled = jest.fn().mockReturnValue(false);
const mockIsReady = jest.fn().mockReturnValue(true);
const mockHasEntry = jest.fn().mockResolvedValue(false);
const mockGetEntry = jest.fn().mockResolvedValue(null);
const mockClaimEntry = jest.fn().mockResolvedValue(true);
const mockSetEntry = jest.fn().mockResolvedValue(undefined);
const mockDeleteEntry = jest.fn().mockResolvedValue(undefined);
const admin = require('firebase-admin');

jest.mock('../../src/services/storage/NewsDedupStorageService', () => ({
	isEnabled: mockIsEnabled,
	isReady: mockIsReady,
	hasEntry: mockHasEntry,
	getEntry: mockGetEntry,
	claimEntry: mockClaimEntry,
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
		mockIsReady.mockReturnValue(true);
		mockHasEntry.mockResolvedValue(false);
		mockGetEntry.mockResolvedValue(null);
		mockClaimEntry.mockResolvedValue(true);
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

		it('reports persistent mode with firestore backend when enabled and ready', () => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(true);
			expect(cache.dedupMode).toEqual({ mode: 'persistent', backend: 'firestore' });
		});

		it('reports in-memory mode when enabled but not ready (invalid credentials)', () => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(false);
			expect(cache.dedupMode).toEqual({ mode: 'in-memory', backend: null });
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

		it('includes deduplication mode in stats when enabled and ready', () => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(true);
			const stats = cache.getStats();
			expect(stats.deduplication).toEqual({ mode: 'persistent', backend: 'firestore' });
		});
	});

	// ─────────────────────────────────────────
	// claim() method
	// ─────────────────────────────────────────
	describe('claim() method', () => {
		it('claims locally when in-memory mode is active', async () => {
			mockIsEnabled.mockReturnValue(false);

			const first = await cache.claim('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(first).toBe(true);

			const second = await cache.claim('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(second).toBe(false);

			expect(mockClaimEntry).not.toHaveBeenCalled();
		});

		it('delegates to Firestore when persistent mode is active', async () => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(true);
			mockClaimEntry.mockResolvedValue(true);

			const result = await cache.claim('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBe(true);
			expect(mockClaimEntry).toHaveBeenCalledWith('BTCUSDT:price_surge', cache.ttlMs);
		});

		it('returns false when Firestore claim fails', async () => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(true);
			mockClaimEntry.mockResolvedValue(false);

			const result = await cache.claim('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBe(false);
		});

		it('falls back to local claim when Firestore claim throws (fail-open)', async () => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(true);
			mockClaimEntry.mockRejectedValue(new Error('Firestore timeout'));

			const result = await cache.claim('BTCUSDT', EventCategory.PRICE_SURGE);
			// Fail-open allows the local claim to succeed
			expect(result).toBe(true);
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
			expect(mockGetEntry).not.toHaveBeenCalled();
		});

		it('returns null for a cache miss without consulting Firestore', async () => {
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
			expect(mockGetEntry).not.toHaveBeenCalled();
		});

		it('returns null after TTL expiry without touching Firestore', async () => {
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: {} });
			await new Promise(resolve => setTimeout(resolve, 1100));
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
			expect(mockGetEntry).not.toHaveBeenCalled();
		});
	});

	// ─────────────────────────────────────────
	// Persistent mode (enabled)
	// ─────────────────────────────────────────
	describe('persistent mode (ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP=true)', () => {
		beforeEach(() => {
			mockIsEnabled.mockReturnValue(true);
			mockIsReady.mockReturnValue(true);
			mockSetEntry.mockResolvedValue(undefined);
			mockGetEntry.mockResolvedValue(null);
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
			expect(mockSetEntry).toHaveBeenCalledWith('BTCUSDT:price_surge', cache.ttlMs, data);
		});

		it('returns in-memory hit immediately without checking Firestore', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);
			mockGetEntry.mockClear();

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toEqual(data);
			expect(mockGetEntry).not.toHaveBeenCalled();
		});

		it('falls back to Firestore when local cache misses (cross-replica scenario)', async () => {
			const data = { alert: { symbol: 'BTCUSDT' }, deliveryResults: [] };
			mockGetEntry.mockResolvedValue(data);

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(mockGetEntry).toHaveBeenCalledWith('BTCUSDT:price_surge');
			expect(result).toEqual(data);
		});

		it('warms local in-memory cache after a Firestore hit to avoid repeated lookups', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			mockGetEntry.mockResolvedValue(data);

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toEqual(data);
			// Local cache should now contain the warmed entry
			expect(cache.cache.has('BTCUSDT:price_surge')).toBe(true);
			expect(cache.cache.get('BTCUSDT:price_surge').data).toEqual(data);
		});

		it('returns null and allows the alert when both local and Firestore miss', async () => {
			mockGetEntry.mockResolvedValue(null);
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
		});

		it('falls back gracefully when Firestore getEntry throws (fail-open)', async () => {
			mockGetEntry.mockRejectedValue(new Error('Firestore timeout'));

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

			const firestoreData = { alert: { symbol: 'BTCUSDT' }, _dedupSource: 'firestore' };
			mockGetEntry.mockResolvedValue(firestoreData);
			mockGetEntry.mockClear();

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(mockGetEntry).toHaveBeenCalledWith('BTCUSDT:price_surge');
			expect(result).toEqual(firestoreData);
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

describe('NewsDedupStorageService — claimEntry()', () => {
	const originalNow = admin.firestore.Timestamp.now;
	const originalFromMillis = admin.firestore.Timestamp.fromMillis;

	afterEach(() => {
		jest.clearAllMocks();
		admin.firestore.mockClear();
		admin.firestore.Timestamp.now = originalNow;
		admin.firestore.Timestamp.fromMillis = originalFromMillis;
		delete process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
	});

	it('replaces an expired Firestore claim atomically', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const now = { toMillis: () => 10_000 };
		const expiresAt = { toMillis: () => 15_000 };
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({ expiresAt: { toMillis: () => 9_999 } }),
			}),
			set: jest.fn(),
		};
		const runTransaction = jest.fn(async callback => callback(transaction));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => docRef }),
			runTransaction,
		});
		admin.firestore.Timestamp.now = jest.fn(() => now);
		admin.firestore.Timestamp.fromMillis = jest.fn(() => expiresAt);

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.claimEntry('BTCUSDT:price_surge', 5_000)).resolves.toBe(true);
		expect(runTransaction).toHaveBeenCalledTimes(1);
		expect(transaction.set).toHaveBeenCalledWith(docRef, {
			key: 'BTCUSDT:price_surge',
			createdAt: now,
			expiresAt,
			data: { status: 'claiming' },
		});
	});
});
