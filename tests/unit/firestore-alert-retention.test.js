'use strict';

const admin = require('firebase-admin');
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
});
