'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');

function createTempChangelog(entries) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-it-'));
	const file = path.join(dir, 'changelog.json');
	fs.writeFileSync(
		file,
		JSON.stringify({
			version: '0.1.0',
			generatedAt: '2026-09-01T00:00:00.000Z',
			branch: 'master',
			sinceTag: 'v0.1.0',
			sinceDate: null,
			entries,
		}),
	);
	return { dir, file };
}

describe('Release Notes API Integration Tests', () => {
	let savedEnv;
	let tempDir;
	let releaseNotesModule;

	beforeAll(() => {
		// Configure the env once.
		process.env.WEBHOOK_API_KEY = 'test-key';

		// Create the changelog fixture.
		const created = createTempChangelog([
			{
				type: 'feat',
				scope: 'webhook',
				summary: 'add alert enrichment (#100)',
				breaking: false,
				pr: 100,
				author: 'alice',
				mergedAt: '2026-09-03T00:00:00Z',
				commitSha: 'aaa',
				shortSha: 'aaa',
				issues: [100],
			},
			{
				type: 'fix',
				summary: 'fix webhook 401 (#101)',
				breaking: false,
				pr: 101,
				author: 'bob',
				mergedAt: '2026-09-02T00:00:00Z',
				commitSha: 'bbb',
				shortSha: 'bbb',
				issues: [101],
			},
			{
				type: 'chore',
				summary: 'bump deps (#102)',
				breaking: false,
				pr: 102,
				author: 'carol',
				mergedAt: '2026-08-15T00:00:00Z',
				commitSha: 'ccc',
				shortSha: 'ccc',
				issues: [102],
			},
		]);
		tempDir = created.dir;

		// Mock the service to return our fixture-backed singleton.
		jest.doMock('../../src/services/releaseNotes/ReleaseNotesService', () => {
			const actual = jest.requireActual('../../src/services/releaseNotes/ReleaseNotesService');
			return {
				...actual,
				releaseNotesService: new actual.ReleaseNotesService({ changelogPath: created.file }),
			};
		});

		// Add the API routes to the app exactly once.
		app.use('/api', getRoutes(null));
	});

	afterAll(() => {
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('returns 401 when GET /api/release-notes lacks an api key', async () => {
		await request(app).get('/api/release-notes').expect(401);
	});

	it('returns summary entries with counts and day buckets', async () => {
		const res = await request(app)
			.get('/api/release-notes')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.success).toBe(true);
		expect(res.body.summary.total).toBe(3);
		expect(res.body.summary.entries).toHaveLength(3);
		expect(res.body.summary.entries[0].commitSha).toBe('aaa');
		expect(res.body.summary.counts.feat).toBe(1);
		expect(res.body.summary.counts.fix).toBe(1);
		expect(res.body.summary.counts.chore).toBe(1);
	});

	it('filters by type and limits results', async () => {
		const res = await request(app)
			.get('/api/release-notes?type=feat,fix&limit=1')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.summary.total).toBe(1);
		expect(res.body.summary.entries[0].type).toBe('feat');
	});

	it('returns 400 for an invalid limit', async () => {
		const res = await request(app)
			.get('/api/release-notes?limit=9999')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 for invalid types', async () => {
		const res = await request(app)
			.get('/api/release-notes?type=feat,bogus')
			.set('x-api-key', 'test-key')
			.expect(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('filters by since date', async () => {
		const res = await request(app)
			.get('/api/release-notes?since=2026-09-01')
			.set('x-api-key', 'test-key')
			.expect(200);
		expect(res.body.summary.entries).toHaveLength(2);
	});

	it('returns the version snapshot by date string', async () => {
		const res = await request(app)
			.get('/api/release-notes/2026-09-01')
			.set('x-api-key', 'test-key')
			.expect(200);
		expect(res.body.snapshot.entries).toHaveLength(2);
		expect(res.body.snapshot.entries[0].commitSha).toBe('aaa');
	});
});
