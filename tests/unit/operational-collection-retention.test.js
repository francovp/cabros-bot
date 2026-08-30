'use strict';

/**
 * Unit tests for ops/backfill-operational-collection-retention.js
 *
 * Covers:
 *  - parseIdempotencyTtlMs: valid, invalid (NaN, negative, zero, too large)
 *  - parseDedupTtlMs: valid, zero/zero-hour no-cache, decimal, invalid values
 *  - isDeliveryLease: doc ID and data key pattern matching
 *  - backfillCollection:
 *      - delivery leases (30s TTL) vs general news entries (6h TTL)
 *      - zero-hour retention (dedupTtlMs = 0)
 *      - completed idempotency responses (active skipped, expired updated)
 *      - legacy documents (Date object, missing timestamp fallback)
 *      - dryRun mode
 *      - active-pending claims protection
 *      - documents already having a future expiresAt (skipped)
 *      - empty collection
 */

const admin = require('firebase-admin');
jest.mock('firebase-admin');

const {
	backfillCollection,
	getOperationalCollectionConfigs,
	parseIdempotencyTtlMs,
	parseDedupTtlMs,
	parseNotificationRedriveTtlMs,
	isDeliveryLease,
	DELIVERY_LOCK_TTL_MS,
	PENDING_STALE_TIMEOUT_MS,
} = require('../../ops/backfill-operational-collection-retention');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeTimestamp(ms) {
	return {
		toMillis: () => ms,
		toDate: () => new Date(ms),
	};
}

function makeFakeDoc(overrides = {}) {
	const base = {
		id: 'doc-id',
		createTime: makeFakeTimestamp(Date.now() - 10_000),
		data: () => ({
			createdAt: makeFakeTimestamp(Date.now() - 10_000),
			...overrides,
		}),
		ref: { id: 'doc-id' },
	};
	return base;
}

function buildFirestoreMock(docs) {
	const batchUpdateMock = jest.fn();
	const batchCommitMock = jest.fn().mockResolvedValue(undefined);
	const batchMock = {
		update: batchUpdateMock,
		commit: batchCommitMock,
	};

	const queryMock = {
		orderBy: jest.fn().mockReturnThis(),
		limit: jest.fn().mockReturnThis(),
		startAfter: jest.fn().mockReturnThis(),
		get: jest.fn()
			.mockResolvedValueOnce({ empty: docs.length === 0, docs })
			.mockResolvedValueOnce({ empty: true, docs: [] }),
	};

	const collectionMock = jest.fn().mockReturnValue(queryMock);

	const firestoreMock = {
		collection: collectionMock,
		batch: jest.fn().mockReturnValue(batchMock),
	};

	return { firestoreMock, batchUpdateMock, batchCommitMock, queryMock };
}

// ─── parseIdempotencyTtlMs ───────────────────────────────────────────────────

describe('parseIdempotencyTtlMs', () => {
	test('returns parsed value for a valid TTL', () => {
		expect(parseIdempotencyTtlMs('600000')).toBe(600_000);
	});

	test('returns default for NaN', () => {
		expect(parseIdempotencyTtlMs('not-a-number')).toBe(300_000);
	});

	test('returns default for zero', () => {
		expect(parseIdempotencyTtlMs('0')).toBe(300_000);
	});

	test('returns default for negative', () => {
		expect(parseIdempotencyTtlMs('-1000')).toBe(300_000);
	});

	test('returns default for value exceeding 24h hard cap', () => {
		expect(parseIdempotencyTtlMs(String(25 * 60 * 60 * 1000))).toBe(300_000);
	});

	test('returns default when no argument given (undefined)', () => {
		const originalEnv = process.env.WEBHOOK_IDEMPOTENCY_TTL_MS;
		delete process.env.WEBHOOK_IDEMPOTENCY_TTL_MS;
		expect(parseIdempotencyTtlMs(undefined)).toBe(300_000);
		if (originalEnv !== undefined) process.env.WEBHOOK_IDEMPOTENCY_TTL_MS = originalEnv;
	});
});

// ─── parseDedupTtlMs ─────────────────────────────────────────────────────────

describe('parseDedupTtlMs', () => {
	test('returns parsed hours → ms for valid input', () => {
		expect(parseDedupTtlMs('12')).toBe(12 * 60 * 60 * 1000);
	});

	test('returns 0 for zero string (preserving no-cache behavior)', () => {
		expect(parseDedupTtlMs('0')).toBe(0);
		expect(parseDedupTtlMs('0.0')).toBe(0);
	});

	test('returns 0 for numeric 0', () => {
		expect(parseDedupTtlMs(0)).toBe(0);
	});

	test('returns parsed ms for decimal hours', () => {
		expect(parseDedupTtlMs('0.5')).toBe(30 * 60 * 1000);
	});

	test('returns 0 when NEWS_CACHE_TTL_HOURS is set to "0"', () => {
		const originalEnv = process.env.NEWS_CACHE_TTL_HOURS;
		process.env.NEWS_CACHE_TTL_HOURS = '0';
		expect(parseDedupTtlMs()).toBe(0);
		if (originalEnv !== undefined) process.env.NEWS_CACHE_TTL_HOURS = originalEnv;
		else delete process.env.NEWS_CACHE_TTL_HOURS;
	});

	test('returns default for NaN', () => {
		expect(parseDedupTtlMs('bad')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default for empty string', () => {
		expect(parseDedupTtlMs('')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default for negative', () => {
		expect(parseDedupTtlMs('-1')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default for value exceeding 720h hard cap', () => {
		expect(parseDedupTtlMs('721')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default when no argument given (undefined)', () => {
		const originalEnv = process.env.NEWS_CACHE_TTL_HOURS;
		delete process.env.NEWS_CACHE_TTL_HOURS;
		expect(parseDedupTtlMs(undefined)).toBe(6 * 60 * 60 * 1000);
		if (originalEnv !== undefined) process.env.NEWS_CACHE_TTL_HOURS = originalEnv;
	});
});

describe('getOperationalCollectionConfigs', () => {
	test('includes notification dead letters with the configured redrive max age', () => {
		const originalEnv = process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS;
		process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS = '7200000';

		expect(getOperationalCollectionConfigs()).toEqual(expect.arrayContaining([
			expect.objectContaining({
				collectionName: 'notificationDeadLetters',
				ttlMs: 7_200_000,
			}),
		]));
		expect(parseNotificationRedriveTtlMs()).toBe(7_200_000);

		if (originalEnv !== undefined) process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS = originalEnv;
		else delete process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS;
	});
});

// ─── isDeliveryLease ─────────────────────────────────────────────────────────

describe('isDeliveryLease', () => {
	test('returns true when docId contains :delivery:', () => {
		expect(isDeliveryLease('BTCUSDT:price_surge:delivery:whatsapp')).toBe(true);
		expect(isDeliveryLease('ETHUSDT:breakout:delivery:telegram')).toBe(true);
	});

	test('returns true when data.key contains :delivery:', () => {
		expect(isDeliveryLease('some-custom-doc-id', { key: 'SOLUSDT:news:delivery:discord' })).toBe(true);
	});

	test('returns false for standard dedup entries', () => {
		expect(isDeliveryLease('BTCUSDT:price_surge')).toBe(false);
		expect(isDeliveryLease('ETHUSDT:breakout', { key: 'ETHUSDT:breakout' })).toBe(false);
	});

	test('returns false for null/undefined inputs', () => {
		expect(isDeliveryLease(null, null)).toBe(false);
		expect(isDeliveryLease(undefined, undefined)).toBe(false);
	});
});

// ─── backfillCollection ──────────────────────────────────────────────────────

describe('backfillCollection', () => {
	beforeEach(() => {
		jest.clearAllMocks();

		// Mock admin.firestore.Timestamp.fromMillis used in the backfill
		admin.firestore = {
			Timestamp: {
				fromMillis: jest.fn((ms) => ({ _ms: ms, toMillis: () => ms })),
			},
		};
	});

	test('updates documents missing expiresAt', async () => {
		const nowMs = Date.now();
		const doc = makeFakeDoc({ createdAt: makeFakeTimestamp(nowMs - 5000) });
		doc.data = () => ({ createdAt: makeFakeTimestamp(nowMs - 5000) }); // no expiresAt

		const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);

		const result = await backfillCollection(firestoreMock, 'idempotency_keys', 300_000);

		expect(result.scanned).toBe(1);
		expect(result.updated).toBe(1);
		expect(result.existing).toBe(0);
		expect(batchUpdateMock).toHaveBeenCalledTimes(1);
		expect(batchCommitMock).toHaveBeenCalledTimes(1);
	});

	test('skips documents with a future expiresAt', async () => {
		const nowMs = Date.now();
		const futureMs = nowMs + 60_000;
		const doc = makeFakeDoc({ expiresAt: makeFakeTimestamp(futureMs) });

		const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);

		const result = await backfillCollection(firestoreMock, 'idempotency_keys', 300_000);

		expect(result.scanned).toBe(1);
		expect(result.updated).toBe(0);
		expect(result.existing).toBe(1);
		expect(batchUpdateMock).not.toHaveBeenCalled();
		expect(batchCommitMock).not.toHaveBeenCalled();
	});

	test('updates documents with a past/expired expiresAt', async () => {
		const nowMs = Date.now();
		const pastMs = nowMs - 60_000;
		const doc = makeFakeDoc({ expiresAt: makeFakeTimestamp(pastMs) });

		const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);

		const result = await backfillCollection(firestoreMock, 'idempotency_keys', 300_000);

		expect(result.updated).toBe(1);
		expect(batchUpdateMock).toHaveBeenCalledTimes(1);
		expect(batchCommitMock).toHaveBeenCalledTimes(1);
	});

	test('protects active pending idempotency claims when protectActivePending=true', async () => {
		const nowMs = Date.now();
		// Active pending claim — created 30s ago, within 180s stale window
		const doc = makeFakeDoc({
			state: 'pending',
			createdAt: makeFakeTimestamp(nowMs - 30_000),
		});

		const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);

		const result = await backfillCollection(
			firestoreMock,
			'idempotency_keys',
			300_000,
			{ protectActivePending: true },
		);

		expect(result.skipped).toBe(1);
		expect(result.updated).toBe(0);
		expect(batchUpdateMock).not.toHaveBeenCalled();
	});

	test('does NOT protect stale pending claims (createdAt older than PENDING_STALE_TIMEOUT_MS)', async () => {
		const nowMs = Date.now();
		// Stale pending — created 4 min ago, beyond 180s window
		const doc = makeFakeDoc({
			state: 'pending',
			createdAt: makeFakeTimestamp(nowMs - 240_000),
		});

		const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);

		const result = await backfillCollection(
			firestoreMock,
			'idempotency_keys',
			300_000,
			{ protectActivePending: true },
		);

		expect(result.updated).toBe(1);
		expect(batchUpdateMock).toHaveBeenCalledTimes(1);
		expect(batchCommitMock).toHaveBeenCalledTimes(1);
	});

	test('does NOT protect pending claims when protectActivePending=false', async () => {
		const nowMs = Date.now();
		const doc = makeFakeDoc({
			state: 'pending',
			createdAt: makeFakeTimestamp(nowMs - 30_000),
		});

		const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);

		// Default: protectActivePending=false (news-dedup path)
		const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

		expect(result.updated).toBe(1);
		expect(batchUpdateMock).toHaveBeenCalledTimes(1);
		expect(batchCommitMock).toHaveBeenCalledTimes(1);
	});

	test('uses doc.createTime as fallback when createdAt is missing', async () => {
		const nowMs = Date.now();
		const doc = {
			id: 'legacy-doc',
			createTime: makeFakeTimestamp(nowMs - 5000),
			data: () => ({}), // no createdAt, no expiresAt
			ref: { id: 'legacy-doc' },
		};

		const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);

		const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

		expect(result.updated).toBe(1);
		expect(batchUpdateMock).toHaveBeenCalledTimes(1);
		expect(batchCommitMock).toHaveBeenCalledTimes(1);

		const call = batchUpdateMock.mock.calls[0];
		const update = call[1];
		expect(update).toHaveProperty('expiresAt');
	});

	test('handles empty collection gracefully', async () => {
		const firestoreMock = {
			collection: jest.fn().mockReturnValue({
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				startAfter: jest.fn().mockReturnThis(),
				get: jest.fn().mockResolvedValueOnce({ empty: true, docs: [] }),
			}),
			batch: jest.fn(),
		};

		const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

		expect(result.scanned).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.existing).toBe(0);
	});

	// ── Delivery Leases vs General News Entries ───────────────────────────────

	describe('delivery leases vs general news entries in news-monitor-dedup', () => {
		test('applies 30-second TTL to delivery lease documents missing expiresAt', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'BTCUSDT:price_surge:delivery:whatsapp',
				ref: { id: 'BTCUSDT:price_surge:delivery:whatsapp' },
				data: () => ({
					key: 'BTCUSDT:price_surge:delivery:whatsapp',
					createdAt: makeFakeTimestamp(nowMs - 5000),
					data: { status: 'claiming', claimToken: 'token-123' },
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

			expect(result.updated).toBe(1);
			expect(batchUpdateMock).toHaveBeenCalledWith(
				doc.ref,
				expect.objectContaining({
					expiresAt: expect.objectContaining({ _ms: nowMs - 5000 + DELIVERY_LOCK_TTL_MS }),
				}),
			);
		});

		test('applies 30-second TTL to expired delivery lease documents instead of 6 hours', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'BTCUSDT:price_surge:delivery:telegram',
				ref: { id: 'BTCUSDT:price_surge:delivery:telegram' },
				data: () => ({
					key: 'BTCUSDT:price_surge:delivery:telegram',
					createdAt: makeFakeTimestamp(nowMs - 40_000),
					expiresAt: makeFakeTimestamp(nowMs - 10_000),
					data: { status: 'claiming', claimToken: 'token-456' },
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

			expect(result.updated).toBe(1);
			// Base (nowMs - 40_000) + 30_000 = nowMs - 10_000 (remains expired for TTL cleanup, not locked for 6 hours)
			expect(batchUpdateMock).toHaveBeenCalledWith(
				doc.ref,
				expect.objectContaining({
					expiresAt: expect.objectContaining({ _ms: nowMs - 40_000 + DELIVERY_LOCK_TTL_MS }),
				}),
			);
		});

		test('skips active delivery lease documents with future expiresAt', async () => {
			const nowMs = Date.now();
			const doc = {
				id: 'BTCUSDT:price_surge:delivery:whatsapp',
				ref: { id: 'BTCUSDT:price_surge:delivery:whatsapp' },
				data: () => ({
					key: 'BTCUSDT:price_surge:delivery:whatsapp',
					createdAt: makeFakeTimestamp(nowMs - 5000),
					expiresAt: makeFakeTimestamp(nowMs + 25_000),
					data: { status: 'claiming', claimToken: 'token-789' },
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

			expect(result.existing).toBe(1);
			expect(result.updated).toBe(0);
			expect(batchUpdateMock).not.toHaveBeenCalled();
		});

		test('applies general dedup TTL (6h) to standard news entries', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'BTCUSDT:price_surge',
				ref: { id: 'BTCUSDT:price_surge' },
				data: () => ({
					key: 'BTCUSDT:price_surge',
					createdAt: makeFakeTimestamp(nowMs - 60_000),
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 6 * 3600_000);

			expect(result.updated).toBe(1);
			expect(batchUpdateMock).toHaveBeenCalledWith(
				doc.ref,
				expect.objectContaining({
					expiresAt: expect.objectContaining({ _ms: nowMs - 60_000 + 6 * 3600_000 }),
				}),
			);
		});
	});

	// ── Zero-Hour Retention ───────────────────────────────────────────────────

	describe('zero-hour news retention (dedupTtlMs = 0)', () => {
		test('sets expiresAt to baseMs + 0 when dedupTtlMs is 0', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'BTCUSDT:price_surge',
				ref: { id: 'BTCUSDT:price_surge' },
				data: () => ({
					key: 'BTCUSDT:price_surge',
					createdAt: makeFakeTimestamp(nowMs - 10_000),
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'news-monitor-dedup', 0);

			expect(result.updated).toBe(1);
			expect(batchUpdateMock).toHaveBeenCalledWith(
				doc.ref,
				expect.objectContaining({
					expiresAt: expect.objectContaining({ _ms: nowMs - 10_000 }),
				}),
			);
		});
	});

	// ── Completed Idempotency Responses ───────────────────────────────────────

	describe('completed idempotency responses', () => {
		test('skips active completed idempotency responses with a future expiresAt', async () => {
			const nowMs = Date.now();
			const doc = {
				id: 'completed-active',
				ref: { id: 'completed-active' },
				data: () => ({
					state: 'completed',
					statusCode: 200,
					responseBody: { success: true },
					createdAt: makeFakeTimestamp(nowMs - 60_000),
					expiresAt: makeFakeTimestamp(nowMs + 240_000),
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(
				firestoreMock,
				'idempotency_keys',
				300_000,
				{ protectActivePending: true },
			);

			expect(result.existing).toBe(1);
			expect(result.updated).toBe(0);
			expect(batchUpdateMock).not.toHaveBeenCalled();
		});

		test('updates expired completed idempotency responses', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'completed-expired',
				ref: { id: 'completed-expired' },
				data: () => ({
					state: 'completed',
					statusCode: 200,
					responseBody: { success: true },
					createdAt: makeFakeTimestamp(nowMs - 400_000),
					expiresAt: makeFakeTimestamp(nowMs - 100_000),
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(
				firestoreMock,
				'idempotency_keys',
				300_000,
				{ protectActivePending: true },
			);

			expect(result.updated).toBe(1);
			expect(batchUpdateMock).toHaveBeenCalledWith(
				doc.ref,
				expect.objectContaining({
					expiresAt: expect.objectContaining({ _ms: nowMs - 400_000 + 300_000 }),
				}),
			);
		});
	});

	// ── Legacy Document Timestamp Parsing ─────────────────────────────────────

	describe('legacy document timestamp parsing', () => {
		test('parses createdAt as JavaScript Date object', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'date-object-doc',
				ref: { id: 'date-object-doc' },
				data: () => ({
					createdAt: new Date(nowMs - 5000),
				}),
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'idempotency_keys', 300_000);

			expect(result.updated).toBe(1);
			expect(batchUpdateMock).toHaveBeenCalledWith(
				doc.ref,
				expect.objectContaining({
					expiresAt: expect.objectContaining({ _ms: nowMs - 5000 + 300_000 }),
				}),
			);
		});

		test('falls back to nowMs when both createdAt and doc.createTime are missing', async () => {
			const before = Date.now();
			const doc = {
				id: 'no-timestamps-doc',
				data: () => ({}),
				ref: { id: 'no-timestamps-doc' },
			};

			const { firestoreMock, batchUpdateMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(firestoreMock, 'idempotency_keys', 300_000);
			const after = Date.now();

			expect(result.updated).toBe(1);
			expect(batchUpdateMock).toHaveBeenCalled();
			const call = batchUpdateMock.mock.calls[0];
			const assignedMs = call[1].expiresAt._ms;
			expect(assignedMs).toBeGreaterThanOrEqual(before + 300_000);
			expect(assignedMs).toBeLessThanOrEqual(after + 300_000);
		});
	});

	// ── Dry Run Mode ──────────────────────────────────────────────────────────

	describe('dryRun mode', () => {
		test('scans and calculates updates without executing batch writes or commits', async () => {
			const nowMs = 1_000_000;
			const doc = {
				id: 'BTCUSDT:price_surge',
				ref: { id: 'BTCUSDT:price_surge' },
				data: () => ({
					createdAt: makeFakeTimestamp(nowMs - 10_000),
				}),
			};

			const { firestoreMock, batchUpdateMock, batchCommitMock } = buildFirestoreMock([doc]);
			const result = await backfillCollection(
				firestoreMock,
				'news-monitor-dedup',
				6 * 3600_000,
				{ dryRun: true },
			);

			expect(result.scanned).toBe(1);
			expect(result.updated).toBe(1);
			expect(result.skipped).toBe(0);
			expect(result.existing).toBe(0);
			expect(firestoreMock.batch).not.toHaveBeenCalled();
			expect(batchUpdateMock).not.toHaveBeenCalled();
			expect(batchCommitMock).not.toHaveBeenCalled();
		});
	});
});
