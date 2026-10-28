/* global describe, it, expect, jest */

const { PromptDriftService } = require('../../src/services/prompts/PromptDriftService');

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
					get: async () => ({ docs: [...documents.values()].map(data => ({ data: () => data })) }),
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

	it('keeps drift telemetry fail open when Firestore is unavailable', async () => {
		const service = new PromptDriftService({ getFirestore: () => { throw new Error('offline'); } });
		await expect(service.record('alert-enrichment', 3)).resolves.toBe(false);
		await expect(service.refresh()).resolves.toBe(false);
		expect(service.getStatus().durableReadReady).toBe(false);
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

	it('bounds a stalled Firestore drift write', async () => {
		const db = { collection: () => ({ doc: () => ({ create: () => new Promise(() => {}) }) }) };
		const service = new PromptDriftService({ getFirestore: () => db, writeTimeoutMs: 20 });
		const started = Date.now();
		await expect(service.record('alert-enrichment', 8)).resolves.toBe(false);
		expect(Date.now() - started).toBeLessThan(200);
	});
});
