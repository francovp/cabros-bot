'use strict';

/**
 * Unit tests for ops/backfill-operational-collection-retention.js
 *
 * Covers:
 *  - parseIdempotencyTtlMs: valid, invalid (NaN, negative, zero, too large)
 *  - parseDedupTtlMs: valid, invalid values
 *  - backfillCollection: expired, active-pending (protected), legacy docs,
 *    documents already having a future expiresAt (skipped)
 */

const admin = require('firebase-admin');
jest.mock('firebase-admin');

const {
	backfillCollection,
	parseIdempotencyTtlMs,
	parseDedupTtlMs,
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
	// Allow overrides of top-level doc properties
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
			.mockResolvedValueOnce({ empty: false, docs })
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

	test('returns default for NaN', () => {
		expect(parseDedupTtlMs('bad')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default for zero', () => {
		expect(parseDedupTtlMs('0')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default for negative', () => {
		expect(parseDedupTtlMs('-1')).toBe(6 * 60 * 60 * 1000);
	});

	test('returns default for value exceeding 720h hard cap', () => {
		expect(parseDedupTtlMs('721')).toBe(6 * 60 * 60 * 1000);
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
		// Document with no expiresAt
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

		// Verify the expiresAt timestamp was set approximately correctly
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
});
