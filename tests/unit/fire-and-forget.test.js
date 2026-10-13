'use strict';

const { fireAndForget } = require('../../src/lib/fireAndForget');
const { firestoreWriteMetricsService } = require('../../src/services/storage/FirestoreWriteMetricsService');

describe('fireAndForget', () => {
	beforeEach(() => {
		firestoreWriteMetricsService.resetForTesting();
	});

	afterAll(() => {
		firestoreWriteMetricsService.resetForTesting();
	});

	it('preserves a successful write value and records success', async () => {
		const result = await fireAndForget('alertStorage', async () => 'document-id');

		expect(result).toEqual({ ok: true, value: 'document-id' });
		expect(firestoreWriteMetricsService.getPersistentWriteHealthSnapshot().byDomain.alertStorage.success).toBe(1);
	});

	it('resolves a synchronous throw as a failure envelope', async () => {
		const error = new Error('sync failure');
		const result = await fireAndForget('signalOutcomes', () => { throw error; });

		expect(result).toEqual({ ok: false, error });
		expect(firestoreWriteMetricsService.getPersistentWriteHealthSnapshot().byDomain.signalOutcomes.failure).toBe(1);
	});

	it('resolves a rejected promise as a failure envelope', async () => {
		const error = new Error('async failure');
		const result = await fireAndForget('notificationRedrive', () => Promise.reject(error));

		expect(result).toEqual({ ok: false, error });
		expect(firestoreWriteMetricsService.getPersistentWriteHealthSnapshot().byDomain.notificationRedrive.failure).toBe(1);
	});

	it('executes unknown domains without creating an unbounded metric key', async () => {
		const result = await fireAndForget('futureDomain', async () => 'kept');

		expect(result).toEqual({ ok: true, value: 'kept' });
		expect(Object.keys(firestoreWriteMetricsService.getPersistentWriteHealthSnapshot().byDomain))
			.toEqual(['alertStorage', 'signalOutcomes', 'notificationRedrive', 'newsDedup']);
	});

	it('returns a resolved failure envelope for invalid functions', async () => {
		await expect(fireAndForget('alertStorage', null)).resolves.toMatchObject({ ok: false });
		expect(firestoreWriteMetricsService.getPersistentWriteHealthSnapshot().byDomain.alertStorage.success).toBe(0);
	});
});
