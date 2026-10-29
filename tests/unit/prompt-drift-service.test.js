/* global describe, it, expect, jest */

const { PromptDriftService } = require('../../src/services/prompts/PromptDriftService');
const { firestoreWriteMetricsService } = require('../../src/services/storage/FirestoreWriteMetricsService');

describe('PromptDriftService', () => {
	it('counts each drifted prompt version once and reloads the 24-hour count after restart', async () => {
		const documents = new Map();
		const db = {
			collection: jest.fn(() => ({
				doc: id => ({ create: async data => {
					if (documents.has(id)) throw Object.assign(new Error('exists'), { code: 6 });
					documents.set(id, data);
				} }),
				where: () => ({ orderBy: () => ({ limit: () => ({
					get: async () => ({ docs: [...documents].map(([id, data]) => ({ id, data: () => data })) }),
				}) }) }),
			})),
		};
		const now = () => new Date('2026-10-28T08:00:00.000Z');
		const first = new PromptDriftService({ getFirestore: () => db, now });
		await first.record('alert-enrichment', 7);
		await first.record('alert-enrichment', 7);
		expect(documents.size).toBe(1);

		const restarted = new PromptDriftService({ getFirestore: () => db, now });
		await restarted.refresh();
		expect(restarted.getStatus()).toMatchObject({
			durableReadReady: true,
			driftCount24h: 1,
			lastDriftPromptName: 'alert-enrichment',
			lastDriftDetectedAt: '2026-10-28T08:00:00.000Z',
		});
		expect([...documents.values()][0].expiresAt).toEqual(new Date('2026-11-27T08:00:00.000Z'));
	});

	it('deduplicates a status refresh that overlaps a drift write acknowledgement', async () => {
		const documents = new Map();
		let acknowledgeWrite;
		const db = { collection: () => ({
			doc: id => ({ create: data => {
				documents.set(id, data);
				return new Promise(resolve => { acknowledgeWrite = resolve; });
			} }),
			where: () => ({ orderBy: () => ({ limit: () => ({
				get: async () => ({ docs: [...documents].map(([id, data]) => ({ id, data: () => data })) }),
			}) }) }),
		}) };
		const service = new PromptDriftService({ getFirestore: () => db, now: () => new Date('2026-10-28T08:00:00.000Z') });
		const write = service.record('alert-enrichment', 7);
		await service.refresh();
		acknowledgeWrite();
		await write;
		expect(service.getStatus()).toMatchObject({ durableReadReady: true, driftCount24h: 1 });
	});

	it('preserves a confirmed write when an older status refresh finishes afterward', async () => {
		const documents = new Map();
		let finishRead;
		const db = { collection: () => ({
			doc: id => ({ create: async data => { documents.set(id, data); } }),
			where: () => ({ orderBy: () => ({ limit: () => ({ get: () => {
				const docs = [...documents].map(([id, data]) => ({ id, data: () => data }));
				return new Promise(resolve => { finishRead = () => resolve({ docs }); });
			} }) }) }),
		}) };
		const service = new PromptDriftService({ getFirestore: () => db, now: () => new Date('2026-10-28T08:00:00.000Z') });
		const read = service.refresh();
		await service.record('alert-enrichment', 7);
		finishRead();
		await read;
		expect(service.getStatus()).toMatchObject({ durableReadReady: true, driftCount24h: 1 });
	});

	it('keeps drift telemetry fail open when Firestore is unavailable', async () => {
		const service = new PromptDriftService({ getFirestore: () => { throw new Error('offline'); } });
		await expect(service.record('alert-enrichment', 3)).resolves.toBe(false);
		await expect(service.refresh()).resolves.toBe(false);
		expect(service.getStatus().durableReadReady).toBe(false);
	});

	it('distinguishes unconfigured Firestore from a transient write failure', async () => {
		const service = new PromptDriftService({ getFirestore: () => null });
		await expect(service.record('alert-enrichment', 3)).resolves.toBe(null);
	});

	it('bounds a stalled Firestore status read', async () => {
		const db = { collection: () => ({
			where: () => ({ orderBy: () => ({ limit: () => ({ get: () => new Promise(() => {}) }) }) }),
		}) };
		const service = new PromptDriftService({ getFirestore: () => db, readTimeoutMs: 20 });
		const started = Date.now();
		await expect(service.refresh()).resolves.toBe(false);
		expect(Date.now() - started).toBeLessThan(200);
	});

	it('records successful and failed drift queries in shared Firestore read health', async () => {
		const success = jest.spyOn(firestoreWriteMetricsService, 'recordReadSuccess').mockImplementation(() => {});
		const failure = jest.spyOn(firestoreWriteMetricsService, 'recordReadFailure').mockImplementation(() => {});
		try {
			const now = () => new Date('2026-10-28T08:00:00.000Z');
			const healthy = new PromptDriftService({ getFirestore: () => ({ collection: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }) }) }) }), now });
			await healthy.refresh();
			expect(success).toHaveBeenCalledWith('promptDrift');
			const broken = new PromptDriftService({ getFirestore: () => ({ collection: () => ({ where: () => ({ orderBy: () => ({ limit: () => ({ get: async () => { throw Object.assign(new Error('private details'), { code: 7 }); } }) }) }) }) }), now });
			await broken.refresh();
			expect(failure).toHaveBeenCalledWith('promptDrift', 'permission_denied');
		} finally {
			success.mockRestore();
			failure.mockRestore();
		}
	});

	it('bounds a stalled Firestore drift write', async () => {
		const db = { collection: () => ({ doc: () => ({ create: () => new Promise(() => {}) }) }) };
		const service = new PromptDriftService({ getFirestore: () => db, writeTimeoutMs: 20 });
		const started = Date.now();
		await expect(service.record('alert-enrichment', 8)).resolves.toBe(false);
		expect(Date.now() - started).toBeLessThan(200);
	});
});
