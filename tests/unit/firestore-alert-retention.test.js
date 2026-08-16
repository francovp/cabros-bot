'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
	backfillCollection,
	buildRetentionExpiry,
	getRetentionDays,
} = require('../../ops/backfill-firestore-alert-retention');

function timestamp(value) {
	return admin.firestore.Timestamp.fromDate(new Date(value));
}

describe('Firestore alert retention backfill', () => {
	afterEach(() => {
		delete process.env.ALERT_STORAGE_RETENTION_DAYS;
	});

	it('calculates expiry from a legacy event timestamp', () => {
		const expiry = buildRetentionExpiry(
			{ receivedAt: timestamp('2026-05-01T00:00:00.000Z') },
			'receivedAt',
			90,
		);

		expect(expiry.toDate()).toEqual(new Date('2026-07-30T00:00:00.000Z'));
	});

	it('uses the validated retention default', () => {
		process.env.ALERT_STORAGE_RETENTION_DAYS = 'invalid';

		expect(getRetentionDays()).toBe(90);
	});

	it('passes the resolved project to the backfill process', () => {
		const script = fs.readFileSync(
			path.join(__dirname, '../../ops/configure-firestore-alert-retention.sh'),
			'utf8',
		);

		expect(script).toContain('FIREBASE_PROJECT_ID="$project" node ops/backfill-firestore-alert-retention.js');
	});

	it('backfills only terminal TradingView jobs with the one-hour expiry', async () => {
		const terminalRef = { id: 'terminal-job' };
		const activeRef = { id: 'active-job' };
		const createdAt = timestamp('2026-05-01T00:00:00.000Z');
		const docs = [
			{
				id: terminalRef.id,
				ref: terminalRef,
				data: () => ({ status: 'completed', createdAt }),
			},
			{
				id: activeRef.id,
				ref: activeRef,
				data: () => ({ status: 'processing', createdAt }),
			},
		];
		const batch = {
			update: jest.fn(),
			commit: jest.fn().mockResolvedValue(undefined),
		};
		const query = {
			orderBy: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			get: jest.fn().mockResolvedValue({ docs }),
		};
		const firestore = {
			collection: jest.fn().mockReturnValue(query),
			batch: jest.fn().mockReturnValue(batch),
		};

		const result = await backfillCollection(firestore, 'tradingviewJobs', 'createdAt', {
			retentionDays: 1 / 24,
			shouldBackfill: (data) => ['completed', 'failed', 'cancelled', 'timed_out'].includes(data.status),
		});

		expect(batch.update).toHaveBeenCalledWith(
			terminalRef,
			expect.objectContaining({ expiresAt: expect.anything() }),
		);
		expect(batch.update).not.toHaveBeenCalledWith(activeRef, expect.anything());
		expect(batch.update.mock.calls[0][1].expiresAt.toDate()).toEqual(
			new Date('2026-05-01T01:00:00.000Z'),
		);
		expect(result).toEqual({ scanned: 2, updated: 1, skipped: 0, existing: 0 });
	});

	it('updates only legacy documents with a usable event timestamp', async () => {
		const legacyRef = { id: 'legacy' };
		const currentRef = { id: 'current' };
		const missingTimestampRef = { id: 'missing-timestamp' };
		const docs = [
			{
				id: 'legacy',
				ref: legacyRef,
				data: () => ({ receivedAt: timestamp('2026-05-01T00:00:00.000Z') }),
			},
			{
				id: 'current',
				ref: currentRef,
				data: () => ({ expiresAt: timestamp('2026-11-11T00:00:00.000Z') }),
			},
			{
				id: 'missing-timestamp',
				ref: missingTimestampRef,
				data: () => ({}),
			},
		];
		const batch = {
			update: jest.fn(),
			commit: jest.fn().mockResolvedValue(undefined),
		};
		const query = {
			orderBy: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			get: jest.fn().mockResolvedValue({ docs }),
		};
		const firestore = {
			collection: jest.fn().mockReturnValue(query),
			batch: jest.fn().mockReturnValue(batch),
		};

		const result = await backfillCollection(firestore, 'alerts', 'receivedAt');

		expect(query.orderBy).toHaveBeenCalledWith('__name__');
		expect(batch.update).toHaveBeenCalledWith(
			legacyRef,
			expect.objectContaining({ expiresAt: expect.anything() }),
		);
		expect(batch.update).not.toHaveBeenCalledWith(currentRef, expect.anything());
		expect(batch.update).not.toHaveBeenCalledWith(missingTimestampRef, expect.anything());
		expect(batch.commit).toHaveBeenCalledTimes(1);
		expect(result).toEqual({ scanned: 3, updated: 1, skipped: 1, existing: 1 });
	});

	it('shortens existing expiries when the configured retention deadline is earlier', async () => {
		const currentRef = { id: 'current' };
		const docs = [{
			id: 'current',
			ref: currentRef,
			data: () => ({
				receivedAt: timestamp('2026-05-01T00:00:00.000Z'),
				expiresAt: timestamp('2026-12-31T00:00:00.000Z'),
			}),
		}];
		const batch = {
			update: jest.fn(),
			commit: jest.fn().mockResolvedValue(undefined),
		};
		const query = {
			orderBy: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			get: jest.fn().mockResolvedValue({ docs }),
		};
		const firestore = {
			collection: jest.fn().mockReturnValue(query),
			batch: jest.fn().mockReturnValue(batch),
		};

		const result = await backfillCollection(firestore, 'alerts', 'receivedAt', { retentionDays: 30 });

		expect(batch.update).toHaveBeenCalledWith(
			currentRef,
			expect.objectContaining({
				expiresAt: expect.objectContaining({
					toDate: expect.any(Function),
				}),
			}),
		);
		expect(batch.update.mock.calls[0][1].expiresAt.toDate()).toEqual(new Date('2026-05-31T00:00:00.000Z'));
		expect(result).toEqual({ scanned: 1, updated: 1, skipped: 0, existing: 0 });
	});

	it('hashes and removes raw replay idempotency keys during backfill', async () => {
		const replayRef = { id: 'replay' };
		const rawKey = 'legacy-replay-key';
		const docs = [{
			id: 'replay',
			ref: replayRef,
			data: () => ({
				replayedAt: timestamp('2026-05-01T00:00:00.000Z'),
				idempotencyKey: rawKey,
			}),
		}];
		const batch = {
			update: jest.fn(),
			commit: jest.fn().mockResolvedValue(undefined),
		};
		const query = {
			orderBy: jest.fn().mockReturnThis(),
			limit: jest.fn().mockReturnThis(),
			get: jest.fn().mockResolvedValue({ docs }),
		};
		const firestore = {
			collection: jest.fn().mockReturnValue(query),
			batch: jest.fn().mockReturnValue(batch),
		};

		await backfillCollection(firestore, 'alertReplays', 'replayedAt');

		const update = batch.update.mock.calls[0][1];
		expect(update.idempotencyKeyHash).toBe(crypto.createHash('sha256').update(rawKey).digest('hex'));
		expect(update.idempotencyKey).toEqual(admin.firestore.FieldValue.delete());
		expect(JSON.stringify(update)).not.toContain(rawKey);
	});
});
