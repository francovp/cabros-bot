'use strict';

/**
 * Issue #871 — persistent news-dedup persistence state must be race-safe.
 *
 * Three failure modes are covered:
 *   1. a concurrent full-payload write erasing another replica's channel deltas,
 *   2. a terminal owned/none state regressed by a late pending write,
 *   3. a crashed `claimed` usage-ownership record stranded until the dedup TTL.
 */

const mockFirestoreDouble = {
	docs: new Map(),
	conflictsToInject: 0,
	onConflict: null,
	transactionAttempts: 0,
	transactionCommits: 0,
	reset() {
		this.docs = new Map();
		this.conflictsToInject = 0;
		this.onConflict = null;
		this.transactionAttempts = 0;
		this.transactionCommits = 0;
	},
	read(key) {
		return this.docs.get(key) || null;
	},
};

const mockRunTransaction = jest.fn(async (callback) => {
	for (let attempt = 0; attempt < 5; attempt += 1) {
		mockFirestoreDouble.transactionAttempts += 1;
		const writes = new Map();
		const transaction = {
			get: async (docRef) => {
				const data = mockFirestoreDouble.docs.get(docRef.id) || null;
				return { exists: Boolean(data), data: () => data };
			},
			set: (docRef, data) => {
				writes.set(docRef.id, data);
			},
		};

		const result = await callback(transaction);

		if (mockFirestoreDouble.conflictsToInject > 0 && attempt < 4) {
			// Firestore aborts and re-runs the whole callback when another writer
			// touched the document, so the retry must observe the newer snapshot.
			mockFirestoreDouble.conflictsToInject -= 1;
			if (typeof mockFirestoreDouble.onConflict === 'function') {
				mockFirestoreDouble.onConflict();
			}
			continue;
		}

		for (const [id, data] of writes) {
			mockFirestoreDouble.docs.set(id, data);
		}
		mockFirestoreDouble.transactionCommits += 1;
		return result;
	}
	throw new Error('transaction retries exhausted');
});

jest.mock('firebase-admin', () => {
	const Timestamp = {
		now: () => ({ toMillis: () => Date.now() }),
		fromMillis: (ms) => ({ toMillis: () => ms }),
	};
	return {
		initializeApp: jest.fn(),
		credential: { cert: jest.fn(), applicationDefault: jest.fn() },
		firestore: Object.assign(jest.fn(() => ({
			collection: () => ({ doc: (id) => ({ id }) }),
			runTransaction: mockRunTransaction,
		})), { Timestamp }),
	};
});

jest.mock('../../src/services/storage/firebaseAdminCredentials', () => ({
	initializeFirebaseAdminApp: jest.fn(() => ({ ok: true })),
}));

jest.mock('../../src/services/remoteConfig/RemoteConfigService', () => ({
	getRuntimeConfig: () => ({
		ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: true,
		NEWS_CACHE_TTL_HOURS: 6,
		NEWS_CACHE_MAX_ENTRIES: 5000,
		NEWS_DELIVERY_LOCK_MAX_ENTRIES: 1000,
	}),
}));

const storage = require('../../src/services/storage/NewsDedupStorageService');
const { NewsCache, USAGE_CLAIM_LEASE_MS } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');
const { waitForBackgroundTasks, resetForTesting } = require('../../src/lib/backgroundTaskTracker');

const KEY = 'BTCUSDT:price_surge';
const TTL_MS = 6 * 60 * 60 * 1000;

const telegramResult = { channel: 'telegram', success: true, messageId: 'tg-1' };
const whatsappResult = { channel: 'whatsapp', success: true, messageId: 'wa-1' };

function deliveredByChannel(key = KEY) {
	const doc = mockFirestoreDouble.read(key);
	const results = doc?.data?.deliveryResults || [];
	return Object.fromEntries(results.map((result) => [result.channel, result]));
}

function durableData(key = KEY) {
	return mockFirestoreDouble.read(key)?.data;
}

describe('News dedup persistence state — race safety (issue #871)', () => {
	let cache;

	beforeEach(() => {
		mockFirestoreDouble.reset();
		mockRunTransaction.mockClear();
		resetForTesting();
		storage._resetForTesting();
		cache = new NewsCache(6);
	});

	afterEach(() => {
		cache.clear();
	});

	describe('concurrent setEntry() keeps channel-scoped delivery and routing deltas', () => {
		it('does not drop another replica\'s successful channel', async () => {
			await storage.setEntry(KEY, TTL_MS, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [telegramResult],
				routing: { channels: ['telegram'], telegramChatId: 'tg-a' },
			});

			// Replica B lands a whatsapp delivery for the same key.
			await storage.updateEntry(
				KEY,
				{ deliveryResults: [whatsappResult], routing: { channels: ['whatsapp'], whatsappChatId: 'wa-a' } },
				{ deliveryChannels: ['whatsapp'] },
			);

			// Replica A retries with its own stale full payload: telegram only.
			await storage.setEntry(KEY, TTL_MS, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'telegram', success: false }],
				routing: { channels: ['telegram'], telegramChatId: 'tg-a' },
			});

			const delivered = deliveredByChannel();
			expect(Object.keys(delivered).sort()).toEqual(['telegram', 'whatsapp']);
			expect(delivered.telegram.success).toBe(false);
			expect(delivered.whatsapp).toEqual(whatsappResult);
			expect(durableData().routing.telegramChatId).toBe('tg-a');
			expect(durableData().routing.whatsappChatId).toBe('wa-a');
		});

		it('writes the payload untouched when no other replica has touched the key', async () => {
			await storage.setEntry(KEY, TTL_MS, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [telegramResult],
				routing: { channels: ['telegram'], telegramChatId: 'tg-a' },
			});

			expect(deliveredByChannel()).toEqual({ telegram: telegramResult });
			expect(durableData().routing).toEqual({ channels: ['telegram'], telegramChatId: 'tg-a' });
			expect(durableData().originalPersistedState).toBeUndefined();
		});

		it('merges the concurrent write after a Firestore transaction retry', async () => {
			await storage.setEntry(KEY, TTL_MS, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [telegramResult],
				routing: { channels: ['telegram'], telegramChatId: 'tg-a' },
			});

			mockFirestoreDouble.conflictsToInject = 1;
			mockFirestoreDouble.onConflict = () => {
				mockFirestoreDouble.docs.set(KEY, {
					key: KEY,
					data: {
						alert: { symbol: 'BTCUSDT' },
						deliveryResults: [telegramResult, whatsappResult],
						routing: { channels: ['telegram', 'whatsapp'], telegramChatId: 'tg-a', whatsappChatId: 'wa-a' },
					},
				});
			};

			await storage.setEntry(KEY, TTL_MS, {
				alert: { symbol: 'BTCUSDT' },
				deliveryResults: [{ channel: 'telegram', success: false }],
				routing: { channels: ['telegram'], telegramChatId: 'tg-a' },
			});

			expect(mockFirestoreDouble.transactionAttempts).toBeGreaterThan(1);
			const delivered = deliveredByChannel();
			expect(delivered.telegram.success).toBe(false);
			expect(delivered.whatsapp).toEqual(whatsappResult);
			expect(durableData().routing.whatsappChatId).toBe('wa-a');
		});
	});

	describe('originalPersistedState transitions are expected-state guarded', () => {
		const writeState = (state, expectedValues) => storage.updateEntry(
			KEY,
			{ originalPersistedState: state },
			{ mergeFields: ['originalPersistedState'], expectedField: 'originalPersistedState', expectedValues },
		);

		it('refuses a late pending write once a terminal state was committed', async () => {
			await storage.setEntry(KEY, TTL_MS, { alert: { symbol: 'BTCUSDT' } });
			await writeState('owned', ['pending', 'none']);
			expect(durableData().originalPersistedState).toBe('owned');

			const committed = await writeState('pending', ['none', 'pending']);

			expect(committed).toBe(false);
			expect(durableData().originalPersistedState).toBe('owned');
		});

		it('refuses a terminal write that does not follow the state it owns', async () => {
			await storage.setEntry(KEY, TTL_MS, { alert: { symbol: 'BTCUSDT' } });
			await writeState('claimed', ['none']);
			expect(durableData().originalPersistedState).toBe('claimed');

			// A fresh-path terminal write only follows 'pending'/'none'.
			const committed = await writeState('owned', ['pending', 'none']);

			expect(committed).toBe(false);
			expect(durableData().originalPersistedState).toBe('claimed');
		});

		it('refuses a terminal write pinned to a usage claim owned by another replica', async () => {
			await storage.setEntry(KEY, TTL_MS, { alert: { symbol: 'BTCUSDT' } });
			await storage.updateEntry(
				KEY,
				{ originalPersistedState: 'claimed', usageClaimToken: 'owner-1', usageClaimExpiresAt: Date.now() - 1 },
				{ mergeFields: ['originalPersistedState', 'usageClaimToken', 'usageClaimExpiresAt'] },
			);

			const refused = await storage.updateEntry(
				KEY,
				{ originalPersistedState: 'owned' },
				{
					mergeFields: ['originalPersistedState'],
					expectedField: 'originalPersistedState',
					expectedValues: ['claimed'],
					expectedTokenField: 'usageClaimToken',
					expectedToken: 'owner-2',
				},
			);
			expect(refused).toBe(false);
			expect(durableData().originalPersistedState).toBe('claimed');

			const committed = await storage.updateEntry(
				KEY,
				{ originalPersistedState: 'owned' },
				{
					mergeFields: ['originalPersistedState'],
					expectedField: 'originalPersistedState',
					expectedValues: ['claimed'],
					expectedTokenField: 'usageClaimToken',
					expectedToken: 'owner-1',
				},
			);
			expect(committed).toBe(true);
			expect(durableData().originalPersistedState).toBe('owned');
		});
	});

	describe('claim recovery is bounded rather than stranded until the dedup TTL', () => {
		const claimOptions = (token, expiresAt) => ({
			mergeFields: ['originalPersistedState', 'usageClaimToken', 'usageClaimExpiresAt'],
			expectedField: 'originalPersistedState',
			expectedValues: ['none'],
			reclaimStale: { states: ['claimed'], expiresField: 'usageClaimExpiresAt' },
		});

		const claimPayload = (token, expiresAt) => ({
			originalPersistedState: 'claimed',
			usageClaimToken: token,
			usageClaimExpiresAt: expiresAt,
		});

		beforeEach(async () => {
			await storage.setEntry(KEY, TTL_MS, { alert: { symbol: 'BTCUSDT' } });
		});

		it('reclaims a claim whose owner crashed once the lease elapsed', async () => {
			await storage.updateEntry(KEY, claimPayload('crashed-owner', Date.now() - 1), {
				mergeFields: ['originalPersistedState', 'usageClaimToken', 'usageClaimExpiresAt'],
			});

			const committed = await storage.updateEntry(KEY, claimPayload('new-owner', Date.now() + 1000), claimOptions());

			expect(committed).toBe(true);
			expect(durableData().usageClaimToken).toBe('new-owner');
		});

		it('reclaims a pre-lease claim record that carries no deadline', async () => {
			await storage.updateEntry(KEY, { originalPersistedState: 'claimed' }, {
				mergeFields: ['originalPersistedState'],
			});

			const committed = await storage.updateEntry(KEY, claimPayload('new-owner', Date.now() + 1000), claimOptions());

			expect(committed).toBe(true);
			expect(durableData().usageClaimToken).toBe('new-owner');
		});

		it('refuses a second claim while the first lease is still valid', async () => {
			await storage.updateEntry(KEY, claimPayload('live-owner', Date.now() + 60_000), {
				mergeFields: ['originalPersistedState', 'usageClaimToken', 'usageClaimExpiresAt'],
			});

			const committed = await storage.updateEntry(KEY, claimPayload('thief', Date.now() + 60_000), claimOptions());

			expect(committed).toBe(false);
			expect(durableData().usageClaimToken).toBe('live-owner');
		});
	});

	describe('NewsCache usage-ownership claims', () => {
		const primeCacheEntry = async () => {
			await cache.set('BTCUSDT', EventCategory.PRICE_SURGE, {
				alert: { symbol: 'BTCUSDT', eventCategory: EventCategory.PRICE_SURGE },
				deliveryResults: [telegramResult],
				routing: { channels: ['telegram'], telegramChatId: 'tg-a' },
			});
			await waitForBackgroundTasks();
		};

		it('stamps a bounded lease deadline rather than holding the claim forever', async () => {
			await primeCacheEntry();
			await cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'none');

			const token = await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(typeof token).toBe('string');
			const deadline = durableData().usageClaimExpiresAt;
			expect(deadline).toBeGreaterThan(Date.now());
			expect(deadline).toBeLessThanOrEqual(Date.now() + USAGE_CLAIM_LEASE_MS);
			expect(USAGE_CLAIM_LEASE_MS).toBeLessThan(TTL_MS);
		});

		it('reclaims a crashed claim after the lease instead of waiting for the dedup TTL', async () => {
			await primeCacheEntry();
			await cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'none');
			const crashedToken = await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE);
			expect(crashedToken).not.toBeNull();

			// The owning process died before recording a terminal state.
			await storage.updateEntry(KEY, {
				usageClaimExpiresAt: Date.now() - 1,
			}, { mergeFields: ['usageClaimExpiresAt'] });
			cache.cache.get(KEY).data.usageClaimExpiresAt = Date.now() - 1;

			const reclaimedToken = await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(reclaimedToken).not.toBeNull();
			expect(reclaimedToken).not.toBe(crashedToken);
			expect(durableData().originalPersistedState).toBe('claimed');
			expect(durableData().usageClaimToken).toBe(reclaimedToken);
		});

		it('refuses a second claim while the lease is live', async () => {
			await primeCacheEntry();
			await cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'none');

			const first = await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE);

			expect(first).not.toBeNull();
			expect(await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE)).toBeNull();
			expect(durableData().usageClaimToken).toBe(first);
		});

		it('releases the claim back to none when the claimed record fails to persist', async () => {
			await primeCacheEntry();
			await cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'none');
			const token = await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE);

			await cache.releaseUsageOwnershipClaim('BTCUSDT', EventCategory.PRICE_SURGE, token);

			expect(durableData().originalPersistedState).toBe('none');
			expect(durableData().usageClaimToken).toBeNull();
			expect(durableData().usageClaimExpiresAt).toBeNull();
			expect(await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE)).not.toBeNull();
		});

		it('leaves a claim owned by another replica untouched on release', async () => {
			await primeCacheEntry();
			await cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'none');
			await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE);

			// Another replica reclaimed the expired claim with its own token.
			const otherToken = 'replica-b-token';
			await storage.updateEntry(KEY, {
				usageClaimToken: otherToken,
				usageClaimExpiresAt: Date.now() + 60_000,
			}, { mergeFields: ['usageClaimToken', 'usageClaimExpiresAt'] });

			await cache.releaseUsageOwnershipClaim('BTCUSDT', EventCategory.PRICE_SURGE, 'stale-token');

			expect(durableData().originalPersistedState).toBe('claimed');
			expect(durableData().usageClaimToken).toBe(otherToken);
		});

		it('never lets a guarded write fail the surrounding alert delivery', async () => {
			await primeCacheEntry();
			await cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'none');
			mockRunTransaction.mockImplementationOnce(async () => {
				throw new Error('firestore unavailable');
			});

			await expect(
				cache.markOriginalPersistState('BTCUSDT', EventCategory.PRICE_SURGE, 'pending', {
					allowedCurrentStates: ['none', 'pending'],
				}),
			).resolves.toBeUndefined();
			expect(await cache.claimUsageOwnership('BTCUSDT', EventCategory.PRICE_SURGE)).toBeNull();
		});
	});
});
