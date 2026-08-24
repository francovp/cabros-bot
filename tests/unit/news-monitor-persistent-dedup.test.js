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
const mockGetEntryRecord = jest.fn().mockResolvedValue(null);
const mockClaimEntry = jest.fn().mockResolvedValue(true);
const mockSetEntry = jest.fn().mockResolvedValue(undefined);
const mockUpdateEntry = jest.fn().mockResolvedValue(true);
const mockRenewEntry = jest.fn().mockResolvedValue(true);
const mockDeleteEntry = jest.fn().mockResolvedValue(undefined);
const admin = require('firebase-admin');

jest.mock('../../src/services/storage/NewsDedupStorageService', () => ({
	isEnabled: mockIsEnabled,
	isReady: mockIsReady,
	hasEntry: mockHasEntry,
	getEntry: mockGetEntry,
	getEntryRecord: mockGetEntryRecord,
	claimEntry: mockClaimEntry,
	setEntry: mockSetEntry,
	updateEntry: mockUpdateEntry,
	renewEntry: mockRenewEntry,
	deleteEntry: mockDeleteEntry,
	_resetForTesting: jest.fn(),
	COLLECTION_NAME: 'news-monitor-dedup',
}));

const { NewsCache } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');
const { waitForBackgroundTasks, resetForTesting } = require('../../src/lib/backgroundTaskTracker');

describe('NewsCache — Persistent Dedup Backend (Issue #120)', () => {
	let cache;

	beforeEach(() => {
		jest.clearAllMocks();
		resetForTesting();
		mockIsEnabled.mockReturnValue(false);
		mockIsReady.mockReturnValue(true);
		mockHasEntry.mockResolvedValue(false);
		mockGetEntry.mockResolvedValue(null);
		mockGetEntryRecord.mockResolvedValue(null);
		mockClaimEntry.mockResolvedValue(true);
		mockSetEntry.mockResolvedValue(undefined);
		mockUpdateEntry.mockResolvedValue(true);
		mockRenewEntry.mockResolvedValue(true);
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

		it('preserves a local-only finalized result when Firestore refresh is stale', async () => {
			const failedData = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'telegram', success: false }],
			};
			const recoveredData = {
				...failedData,
				deliveryResults: [{ channel: 'telegram', success: true, messageId: 'telegram-recovered' }],
			};

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, failedData);
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, recoveredData, {
				preserveTtl: true,
				deliveryChannels: [],
				localDeliveryChannels: ['telegram'],
				skipPersistence: true,
			});
			mockGetEntryRecord.mockResolvedValue({
				data: failedData,
				expiresAtMs: Date.now() + cache.ttlMs,
			});

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(result.deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true, messageId: 'telegram-recovered' }),
			]);
			expect(cache.cache.get('BTCUSDT:price_surge').localOnlyChannels).toEqual(['telegram']);
		});

		it('preserves only the non-durable channel across a mixed persistent refresh', async () => {
			const failedData = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [
					{ channel: 'telegram', success: false },
					{ channel: 'whatsapp', success: false },
				],
			};
			const recoveredData = {
				...failedData,
				deliveryResults: [
					{ channel: 'telegram', success: true, messageId: 'telegram-recovered' },
					{ channel: 'whatsapp', success: true, messageId: 'whatsapp-recovered' },
				],
			};

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, failedData);
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, recoveredData, {
				preserveTtl: true,
				deliveryChannels: ['telegram'],
				localDeliveryChannels: ['telegram', 'whatsapp'],
				localOnlyChannels: ['whatsapp'],
			});
			mockGetEntryRecord.mockResolvedValue({
				data: {
					...failedData,
					deliveryResults: [{ channel: 'telegram', success: true, messageId: 'telegram-recovered' }],
				},
				expiresAtMs: Date.now() + cache.ttlMs,
			});

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(result.deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true, messageId: 'telegram-recovered' }),
				expect.objectContaining({ channel: 'whatsapp', success: true, messageId: 'whatsapp-recovered' }),
			]);
			expect(cache.cache.get('BTCUSDT:price_surge').localOnlyChannels).toEqual(['whatsapp']);
		});

		it('clears a local-only marker when a later retry replaces that channel with failure', async () => {
			const failedData = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'telegram', success: false }],
			};
			const recoveredData = {
				...failedData,
				deliveryResults: [{ channel: 'telegram', success: true, messageId: 'telegram-recovered' }],
			};

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, failedData);
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, recoveredData, {
				preserveTtl: true,
				deliveryChannels: [],
				localDeliveryChannels: ['telegram'],
				localOnlyChannels: ['telegram'],
				skipPersistence: true,
			});
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, failedData, {
				preserveTtl: true,
				deliveryChannels: [],
				localDeliveryChannels: ['telegram'],
				localOnlyChannels: [],
				skipPersistence: true,
			});
			mockGetEntryRecord.mockResolvedValue({
				data: recoveredData,
				expiresAtMs: Date.now() + cache.ttlMs,
			});

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(result.deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true, messageId: 'telegram-recovered' }),
			]);
			expect(cache.cache.get('BTCUSDT:price_surge').localOnlyChannels).toEqual([]);
		});

		it('prefers a persistent successful channel state over an older local-only success', async () => {
			const failedData = {
				alert: { symbol: 'BTCUSDT' },
				routing: { channels: ['telegram'], telegramChatId: 'destination-a' },
				deliveryResults: [{ channel: 'telegram', success: false }],
			};
			const localData = {
				...failedData,
				deliveryResults: [{ channel: 'telegram', success: true, messageId: 'telegram-local' }],
			};
			const persistentData = {
				...failedData,
				routing: { channels: ['telegram'], telegramChatId: 'destination-b' },
				deliveryResults: [{ channel: 'telegram', success: true, messageId: 'telegram-persistent' }],
			};

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, failedData);
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, localData, {
				preserveTtl: true,
				deliveryChannels: [],
				localDeliveryChannels: ['telegram'],
				localOnlyChannels: ['telegram'],
				skipPersistence: true,
			});
			mockGetEntryRecord.mockResolvedValue({
				data: persistentData,
				expiresAtMs: Date.now() + cache.ttlMs,
			});

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(result.deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true, messageId: 'telegram-persistent' }),
			]);
			expect(cache.cache.get('BTCUSDT:price_surge').localOnlyChannels).toEqual([]);
		});

		it('rechecks local state after a concurrent persistent refresh await', async () => {
			const failedData = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'telegram', success: false }],
			};
			const recoveredData = {
				...failedData,
				deliveryResults: [{ channel: 'telegram', success: true, messageId: 'telegram-concurrent' }],
			};
			let releaseRefresh;
			mockGetEntryRecord.mockReturnValue(new Promise(resolve => { releaseRefresh = resolve; }));

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, failedData);
			const refreshPromise = cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			await Promise.resolve();
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, recoveredData, {
				preserveTtl: true,
				deliveryChannels: [],
				localDeliveryChannels: ['telegram'],
				localOnlyChannels: ['telegram'],
				skipPersistence: true,
			});
			releaseRefresh({ data: failedData, expiresAtMs: Date.now() + cache.ttlMs });

			const result = await refreshPromise;

			expect(result.deliveryResults).toEqual([
				expect.objectContaining({ channel: 'telegram', success: true, messageId: 'telegram-concurrent' }),
			]);
		});

		it('preserves the cache TTL when updating cached delivery results', async () => {
			const firstData = { alert: { symbol: 'BTCUSDT' }, deliveryResults: [{ channel: 'telegram', success: true }] };
			const retryData = { ...firstData, deliveryResults: [{ channel: 'telegram', success: true }, { channel: 'whatsapp', success: true }] };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, firstData);
			const originalTimestamp = cache.cache.get('BTCUSDT:price_surge').timestamp;

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, retryData, { preserveTtl: true });

			expect(cache.cache.get('BTCUSDT:price_surge').timestamp).toBe(originalTimestamp);
			expect(mockSetEntry).toHaveBeenCalledTimes(1);
			expect(mockUpdateEntry).toHaveBeenCalledWith('BTCUSDT:price_surge', retryData);
		});

		it('persists only claimed channel data during a cached retry', async () => {
			const firstData = {
				alert: { symbol: 'BTCUSDT' },
				routing: {
					channels: ['telegram', 'whatsapp'],
					telegramChatId: 'telegram-a',
					whatsappChatId: 'whatsapp-a',
				},
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: false },
				],
			};
			const retryData = {
				...firstData,
				routing: {
					channels: ['whatsapp'],
					telegramChatId: 'telegram-a',
					whatsappChatId: 'whatsapp-b',
				},
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: true },
				],
			};

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, firstData);
			mockUpdateEntry.mockClear();
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, retryData, {
				preserveTtl: true,
				deliveryChannels: ['whatsapp'],
			});

			await new Promise(resolve => setImmediate(resolve));
			expect(mockUpdateEntry).toHaveBeenCalledWith(
				'BTCUSDT:price_surge',
				{
					deliveryResults: [{ channel: 'whatsapp', success: true }],
					routing: {
						channels: ['whatsapp'],
						whatsappChatId: 'whatsapp-b',
					},
				},
				{ deliveryChannels: ['whatsapp'] },
			);
		});

		it('waits for persistent delivery updates when explicitly requested', async () => {
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'whatsapp', success: false }],
			});

			let resolveUpdate;
			mockUpdateEntry.mockReturnValue(new Promise((resolve) => { resolveUpdate = resolve; }));
			let settled = false;
			const persistence = cache.set('BTCUSDT', EventCategory.PRICE_SURGE, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'whatsapp', success: true }],
			}, {
				preserveTtl: true,
				deliveryChannels: ['whatsapp'],
				awaitPersistence: true,
			}).then(() => { settled = true; });

			await new Promise(resolve => setImmediate(resolve));
			expect(settled).toBe(false);

			resolveUpdate(true);
			await persistence;
			expect(settled).toBe(true);
		});

		it('merges only claimed channel data in memory during a cached retry', async () => {
			const firstData = {
				alert: { symbol: 'BTCUSDT' },
				routing: {
					channels: ['telegram', 'whatsapp'],
					telegramChatId: 'telegram-a',
					whatsappChatId: 'whatsapp-a',
				},
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: false },
				],
			};
			const retryData = {
				...firstData,
				routing: {
					channels: ['whatsapp'],
					whatsappChatId: 'whatsapp-b',
				},
				deliveryResults: [
					{ channel: 'telegram', success: false },
					{ channel: 'whatsapp', success: true },
				],
			};

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, firstData);
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, retryData, {
				preserveTtl: true,
				deliveryChannels: ['whatsapp'],
			});

			expect(cache.cache.get('BTCUSDT:price_surge').data).toEqual(expect.objectContaining({
				routing: {
					channels: ['whatsapp'],
					telegramChatId: 'telegram-a',
					whatsappChatId: 'whatsapp-b',
				},
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: true },
				],
			}));
		});

		it('does not recreate a retry entry after local cache eviction', async () => {
			const data = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'whatsapp', success: false }],
			};
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);
			cache.cache.delete('BTCUSDT:price_surge');
			mockUpdateEntry.mockClear();

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, {
				...data,
				deliveryResults: [{ channel: 'whatsapp', success: true }],
			}, {
				preserveTtl: true,
				deliveryChannels: ['whatsapp'],
			});

			expect(cache.cache.has('BTCUSDT:price_surge')).toBe(false);
			expect(mockUpdateEntry).not.toHaveBeenCalled();
		});

		it('uses an atomic persistent lease for concurrent channel retries', async () => {
			const first = await cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp');
			const concurrent = await cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp');

			expect(first).toBe(true);
			expect(concurrent).toBe(false);
			expect(mockClaimEntry).toHaveBeenCalledWith(
				'BTCUSDT:price_surge:delivery:whatsapp',
				30_000,
				expect.any(String),
			);

			cache.releaseDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp');
			await expect(cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp')).resolves.toBe(true);
			expect(mockClaimEntry).toHaveBeenCalledTimes(1);
		});

		it('renews an active persistent channel lease', async () => {
			await cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp');

			await expect(cache.renewDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp')).resolves.toBe(true);
			expect(mockRenewEntry).toHaveBeenCalledWith(
				'BTCUSDT:price_surge:delivery:whatsapp',
				30_000,
				expect.any(String),
			);
		});

		it('returns an indeterminate result when persistent lease renewal fails', async () => {
			mockRenewEntry.mockResolvedValue(null);
			await cache.claimDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp');

			await expect(cache.renewDelivery('BTCUSDT', EventCategory.PRICE_SURGE, 'whatsapp')).resolves.toBeNull();
		});

		it('tracks persistent cache writes until shutdown drain observes them', async () => {
			let releaseWrite;
			mockSetEntry.mockReturnValue(new Promise((resolve) => { releaseWrite = resolve; }));

			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, { alert: { symbol: 'BTCUSDT' } });
			const drain = waitForBackgroundTasks();
			let drained = false;
			drain.then(() => { drained = true; });
			await Promise.resolve();

			expect(drained).toBe(false);

			releaseWrite();
			await drain;
			expect(drained).toBe(true);
		});

		it('falls back to valid local data when Firestore has no entry', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, data);

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toEqual(data);
			expect(mockGetEntryRecord).toHaveBeenCalledWith('BTCUSDT:price_surge');
		});

		it('refreshes local delivery state from Firestore before returning a persistent hit', async () => {
			const staleData = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'whatsapp', success: false }],
			};
			const freshData = {
				...staleData,
				deliveryResults: [{ channel: 'whatsapp', success: true, messageId: 'remote-success' }],
			};
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, staleData);
			mockGetEntryRecord.mockResolvedValue({ data: freshData, expiresAtMs: Date.now() + cache.ttlMs });

			await expect(cache.get('BTCUSDT', EventCategory.PRICE_SURGE)).resolves.toEqual(freshData);
			expect(mockGetEntryRecord).toHaveBeenCalledWith('BTCUSDT:price_surge');
			expect(cache.cache.get('BTCUSDT:price_surge').data).toEqual(freshData);
		});

		it('preserves finalized local data over a stale claiming record', async () => {
			const finalizedData = {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'whatsapp', success: true }],
			};
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, finalizedData);
			mockGetEntryRecord.mockResolvedValue({
				data: { status: 'claiming', claimToken: 'stale-claim' },
				expiresAtMs: Date.now() + cache.ttlMs,
			});

			await expect(cache.get('BTCUSDT', EventCategory.PRICE_SURGE)).resolves.toEqual(finalizedData);
			expect(cache.cache.get('BTCUSDT:price_surge').data).toEqual(finalizedData);
		});

		it('falls back to Firestore when local cache misses (cross-replica scenario)', async () => {
			const data = { alert: { symbol: 'BTCUSDT' }, deliveryResults: [] };
			mockGetEntryRecord.mockResolvedValue({ data, expiresAtMs: Date.now() + cache.ttlMs });

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(mockGetEntryRecord).toHaveBeenCalledWith('BTCUSDT:price_surge');
			expect(result).toEqual(data);
		});

		it('warms local in-memory cache after a Firestore hit to avoid repeated lookups', async () => {
			const data = { alert: { symbol: 'BTCUSDT' } };
			mockGetEntryRecord.mockResolvedValue({ data, expiresAtMs: Date.now() + cache.ttlMs });

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toEqual(data);
			// Local cache should now contain the warmed entry
			expect(cache.cache.has('BTCUSDT:price_surge')).toBe(true);
			expect(cache.cache.get('BTCUSDT:price_surge').data).toEqual(data);
		});

		it('caps a warmed local entry at the persistent Firestore expiry', async () => {
			const now = 100_000;
			const expiresAtMs = now + 500;
			const data = { alert: { symbol: 'BTCUSDT' } };
			mockGetEntryRecord
				.mockResolvedValueOnce({ data, expiresAtMs })
				.mockResolvedValueOnce(null);
			const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(now);

			try {
				expect(await cache.get('BTCUSDT', EventCategory.PRICE_SURGE)).toEqual(data);
				expect(cache.cache.get('BTCUSDT:price_surge').expiresAt).toBe(expiresAtMs);

				nowSpy.mockReturnValue(expiresAtMs + 1);
				expect(await cache.get('BTCUSDT', EventCategory.PRICE_SURGE)).toBeNull();
				expect(mockGetEntryRecord).toHaveBeenCalledTimes(2);
			} finally {
				nowSpy.mockRestore();
			}
		});

		it('returns null and allows the alert when both local and Firestore miss', async () => {
			mockGetEntryRecord.mockResolvedValue(null);
			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(result).toBeNull();
		});

		it('falls back gracefully when Firestore getEntry throws (fail-open)', async () => {
			mockGetEntryRecord.mockRejectedValue(new Error('Firestore timeout'));

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
			mockGetEntryRecord.mockResolvedValue({ data: firestoreData, expiresAtMs: Date.now() + cache.ttlMs });
			mockGetEntryRecord.mockClear();

			const result = await cache.get('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(mockGetEntryRecord).toHaveBeenCalledWith('BTCUSDT:price_surge');
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

	it('treats a malformed existing expiry as an already claimed entry', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({ expiresAt: 'invalid' }),
			}),
			set: jest.fn(),
		};
		const runTransaction = jest.fn(async callback => callback(transaction));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => ({}) }),
			runTransaction,
		});
		admin.firestore.Timestamp.now = jest.fn(() => ({ toMillis: () => 10_000 }));
		admin.firestore.Timestamp.fromMillis = jest.fn(() => ({ toMillis: () => 15_000 }));

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.claimEntry('BTCUSDT:price_surge', 5_000)).resolves.toBe(false);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('stores a claim token for persistent lease ownership', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const now = { toMillis: () => 10_000 };
		const expiresAt = { toMillis: () => 15_000 };
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({ exists: false }),
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

		await expect(realService.claimEntry('BTCUSDT:price_surge:delivery:whatsapp', 5_000, 'owner-a')).resolves.toBe(true);
		expect(transaction.set).toHaveBeenCalledWith(docRef, expect.objectContaining({
			data: { status: 'claiming', claimToken: 'owner-a' },
		}));
	});

	it('rejects renewal from a different persistent lease owner', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const now = { toMillis: () => 10_000 };
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({
					expiresAt: { toMillis: () => 15_000 },
					data: { status: 'claiming', claimToken: 'owner-b' },
				}),
			}),
			set: jest.fn(),
		};
		const runTransaction = jest.fn(async callback => callback(transaction));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => docRef }),
			runTransaction,
		});
		admin.firestore.Timestamp.now = jest.fn(() => now);
		admin.firestore.Timestamp.fromMillis = jest.fn(() => ({ toMillis: () => 40_000 }));

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.renewEntry('BTCUSDT:price_surge:delivery:whatsapp', 30_000, 'owner-a')).resolves.toBe(false);
		expect(transaction.set).not.toHaveBeenCalled();
	});

	it('returns an indeterminate result when Firestore renewal fails', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const docRef = {};
		const runTransaction = jest.fn().mockRejectedValue(new Error('Firestore unavailable'));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => docRef }),
			runTransaction,
		});

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.renewEntry('BTCUSDT:price_surge:delivery:whatsapp', 30_000, 'owner-a')).resolves.toBeNull();
	});
});

describe('NewsDedupStorageService — updateEntry()', () => {
	const originalNow = admin.firestore.Timestamp.now;

	afterEach(() => {
		jest.clearAllMocks();
		admin.firestore.mockClear();
		admin.firestore.Timestamp.now = originalNow;
		delete process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP;
	});

	it('updates data while preserving the existing TTL timestamps', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const now = { toMillis: () => 10_000 };
		const createdAt = { toMillis: () => 1_000 };
		const expiresAt = { toMillis: () => 15_000 };
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({
					createdAt,
					expiresAt,
					data: { deliveryResults: [{ channel: 'telegram', success: false }] },
				}),
			}),
			set: jest.fn(),
		};
		const runTransaction = jest.fn(async callback => callback(transaction));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => docRef }),
			runTransaction,
		});
		admin.firestore.Timestamp.now = jest.fn(() => now);

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.updateEntry('BTCUSDT:price_surge', {
			deliveryResults: [{ channel: 'whatsapp', success: true }],
		}))
			.resolves.toBe(true);
		expect(transaction.set).toHaveBeenCalledWith(docRef, {
			key: 'BTCUSDT:price_surge',
			createdAt,
			expiresAt,
			data: {
				deliveryResults: [
					{ channel: 'telegram', success: false },
					{ channel: 'whatsapp', success: true },
				],
			},
		});
	});

	it('merges only claimed-channel deltas with the latest routing state', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const now = { toMillis: () => 10_000 };
		const createdAt = { toMillis: () => 1_000 };
		const expiresAt = { toMillis: () => 15_000 };
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({
					createdAt,
					expiresAt,
					data: {
						deliveryResults: [
							{ channel: 'telegram', success: true },
							{ channel: 'whatsapp', success: false },
						],
						routing: {
							channels: ['telegram', 'whatsapp'],
							telegramChatId: 'telegram-a',
							whatsappChatId: 'whatsapp-a',
						},
					},
				}),
			}),
			set: jest.fn(),
		};
		const runTransaction = jest.fn(async callback => callback(transaction));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => docRef }),
			runTransaction,
		});
		admin.firestore.Timestamp.now = jest.fn(() => now);

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.updateEntry('BTCUSDT:price_surge', {
			deliveryResults: [{ channel: 'whatsapp', success: true }],
			routing: {
				channels: ['whatsapp'],
				whatsappChatId: 'whatsapp-b',
			},
		}, { deliveryChannels: ['whatsapp'] })).resolves.toBe(true);

		expect(transaction.set).toHaveBeenCalledWith(docRef, expect.objectContaining({
			data: {
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: true },
				],
				routing: {
					channels: ['whatsapp'],
					telegramChatId: 'telegram-a',
					whatsappChatId: 'whatsapp-b',
				},
			},
		}));
	});

	it('persists a claimed Discord fingerprint in the routing delta', async () => {
		process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
		const now = { toMillis: () => 10_000 };
		const createdAt = { toMillis: () => 1_000 };
		const expiresAt = { toMillis: () => 15_000 };
		const docRef = {};
		const transaction = {
			get: jest.fn().mockResolvedValue({
				exists: true,
				data: () => ({
					createdAt,
					expiresAt,
					data: {
						deliveryResults: [{ channel: 'discord', success: false }],
						routing: {
							channels: ['discord'],
							discordWebhookFingerprint: 'old-fingerprint',
						},
					},
				}),
			}),
			set: jest.fn(),
		};
		const runTransaction = jest.fn(async callback => callback(transaction));

		admin.firestore.mockReturnValue({
			collection: () => ({ doc: () => docRef }),
			runTransaction,
		});
		admin.firestore.Timestamp.now = jest.fn(() => now);

		const realService = jest.requireActual('../../src/services/storage/NewsDedupStorageService');
		realService._resetForTesting();

		await expect(realService.updateEntry('BTCUSDT:price_surge', {
			deliveryResults: [{ channel: 'discord', success: true }],
			routing: {
				channels: ['discord'],
				discordWebhookFingerprint: 'new-fingerprint',
			},
		}, { deliveryChannels: ['discord'] })).resolves.toBe(true);

		expect(transaction.set).toHaveBeenCalledWith(docRef, expect.objectContaining({
			data: {
				deliveryResults: [{ channel: 'discord', success: true }],
				routing: {
					channels: ['discord'],
					discordWebhookFingerprint: 'new-fingerprint',
				},
			},
		}));
	});
});
