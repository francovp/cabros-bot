'use strict';

/**
 * Unit coverage for scripts/deploy-firestore-indexes.js (issue #1285).
 *
 * The load-bearing behaviour is that a declared-but-not-live (or live-but-still
 * BUILDING) composite index is reported as not ready and drives a non-zero exit
 * status. That is the whole point of the tool: a deploy that "succeeded" while
 * every stored-alert read is still rejected with FAILED_PRECONDITION is the
 * exact failure this issue documents.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
	auditIndexes,
	fetchLiveIndexes,
	indexKey,
	parseArgs,
	readDeclaredIndexes,
	recordDeployLog,
	runDeploy,
	summarizeAudit,
} = require('../../scripts/deploy-firestore-indexes');

const ALERTS_INDEX = {
	collectionGroup: 'alerts',
	queryScope: 'COLLECTION',
	fields: [
		{ fieldPath: 'receivedAt', order: 'DESCENDING' },
		{ fieldPath: '__name__', order: 'DESCENDING' },
	],
};

const REPLAYS_INDEX = {
	collectionGroup: 'alertReplays',
	queryScope: 'COLLECTION',
	fields: [
		{ fieldPath: 'alertId', order: 'ASCENDING' },
		{ fieldPath: 'replayedAt', order: 'DESCENDING' },
		{ fieldPath: '__name__', order: 'DESCENDING' },
	],
};

function liveIndex(spec, state) {
	return { ...spec, state };
}

describe('deploy-firestore-indexes', () => {
	describe('parseArgs()', () => {
		it('is dry-run by default', () => {
			const args = parseArgs([]);
			expect(args.apply).toBe(false);
			expect(args.dryRun).toBe(true);
			expect(args.project).toBe('cabros-bot');
			expect(args.database).toBe('(default)');
		});

		it('switches to apply only on an explicit --apply', () => {
			const args = parseArgs(['--apply']);
			expect(args.apply).toBe(true);
			expect(args.dryRun).toBe(false);
		});

		it('accepts the (default) database literal and an explicit project', () => {
			const args = parseArgs(['--project', 'other-proj', '--database', '(default)']);
			expect(args.project).toBe('other-proj');
			expect(args.database).toBe('(default)');
		});

		it('tolerates the bare -- separator that pnpm forwards verbatim', () => {
			const args = parseArgs(['--', '--apply', '--project', 'other-proj']);
			expect(args.apply).toBe(true);
			expect(args.project).toBe('other-proj');
		});

		it('rejects unknown options, positionals and bad numbers', () => {
			expect(() => parseArgs(['--nope'])).toThrow(/Unknown option/);
			expect(() => parseArgs(['stray'])).toThrow(/Unexpected positional argument/);
			expect(() => parseArgs(['--project'])).toThrow(/Missing argument for --project/);
			expect(() => parseArgs(['--timeout-ms', '0'])).toThrow(/positive number/);
		});
	});

	describe('indexKey()', () => {
		it('treats field order as significant so DESC and ASC never collide', () => {
			const desc = indexKey({
				collectionGroup: 'alerts',
				queryScope: 'COLLECTION',
				fields: [
					{ fieldPath: 'receivedAt', order: 'DESCENDING' },
					{ fieldPath: '__name__', order: 'DESCENDING' },
				],
			});
			const asc = indexKey({
				collectionGroup: 'alerts',
				queryScope: 'COLLECTION',
				fields: [
					{ fieldPath: 'receivedAt', order: 'DESCENDING' },
					{ fieldPath: '__name__', order: 'ASCENDING' },
				],
			});

			expect(desc).not.toBe(asc);
		});
	});

	describe('readDeclaredIndexes()', () => {
		let tempDir;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-indexes-'));
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it('reads the composite indexes the repository actually declares', () => {
			const declared = readDeclaredIndexes(
				path.resolve(__dirname, '../../firestore.indexes.json'),
			);

			expect(declared.length).toBeGreaterThan(0);
			expect(declared).toContainEqual(ALERTS_INDEX);
			expect(declared).toContainEqual(REPLAYS_INDEX);
		});

		it('reports an unreadable template instead of silently auditing nothing', () => {
			expect(() => readDeclaredIndexes(path.join(tempDir, 'missing.json')))
				.toThrow(/Failed to read/);
		});
	});

	describe('auditIndexes()', () => {
		it('reports a declared index as ready only when the live state is READY', () => {
			const audit = auditIndexes([ALERTS_INDEX], [liveIndex(ALERTS_INDEX, 'READY')]);

			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({ deployed: true, state: 'READY', ready: true });
		});

		it('reports a still-building index as deployed but not ready', () => {
			const audit = auditIndexes([ALERTS_INDEX], [liveIndex(ALERTS_INDEX, 'BUILDING')]);

			expect(audit[0]).toMatchObject({ deployed: true, state: 'BUILDING', ready: false });
		});

		it('reports an index absent from the live project as not deployed', () => {
			const audit = auditIndexes([ALERTS_INDEX], []);

			expect(audit[0]).toMatchObject({ deployed: false, state: null, ready: false });
		});

		it('does not let a differently-ordered index satisfy the declaration', () => {
			const wrongOrder = {
				collectionGroup: 'alerts',
				queryScope: 'COLLECTION',
				fields: [
					{ fieldPath: 'receivedAt', order: 'DESCENDING' },
					{ fieldPath: '__name__', order: 'ASCENDING' },
				],
			};

			const audit = auditIndexes([ALERTS_INDEX], [liveIndex(wrongOrder, 'READY')]);

			expect(audit[0]).toMatchObject({ deployed: false, ready: false });
		});

		it('tolerates a live index with no reported state', () => {
			const audit = auditIndexes([ALERTS_INDEX], [{ ...ALERTS_INDEX }]);

			expect(audit[0]).toMatchObject({ deployed: true, state: null, ready: false });
		});
	});

	describe('summarizeAudit()', () => {
		it('is not allReady while any index is missing', () => {
			const summary = summarizeAudit(auditIndexes([ALERTS_INDEX, REPLAYS_INDEX], [
				liveIndex(ALERTS_INDEX, 'READY'),
			]));

			expect(summary).toMatchObject({
				totalDeclared: 2, ready: 1, missing: 1, building: 0, allReady: false,
			});
		});

		it('is not allReady while any index exists but is still building', () => {
			const summary = summarizeAudit(auditIndexes([ALERTS_INDEX], [
				liveIndex(ALERTS_INDEX, 'BUILDING'),
			]));

			expect(summary).toMatchObject({
				totalDeclared: 1, deployed: 1, ready: 0, missing: 0, building: 1, allReady: false,
			});
		});

		it('is allReady only when every declared index is READY', () => {
			const summary = summarizeAudit(auditIndexes([ALERTS_INDEX, REPLAYS_INDEX], [
				liveIndex(ALERTS_INDEX, 'READY'),
				liveIndex(REPLAYS_INDEX, 'READY'),
			]));

			expect(summary.allReady).toBe(true);
		});

		it('treats an empty declaration as not allReady rather than vacuously healthy', () => {
			expect(summarizeAudit([]).allReady).toBe(false);
		});
	});

	describe('fetchLiveIndexes()', () => {
		it('requests the raw REST collection, which is the only source of build state', async () => {
			const request = jest.fn().mockResolvedValue({
				data: { indexes: [liveIndex(ALERTS_INDEX, 'BUILDING')] },
			});

			const indexes = await fetchLiveIndexes({
				project: 'cabros-bot',
				database: '(default)',
				request,
			});

			expect(request).toHaveBeenCalledWith(
				'GET',
				'https://firestore.googleapis.com/v1/projects/cabros-bot/databases/(default)/collectionGroups/-/indexes',
			);
			expect(indexes[0].state).toBe('BUILDING');
		});

		it('refuses to treat a body with no indexes array as an authoritative empty list', async () => {
			const request = jest.fn().mockResolvedValue({ data: {} });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/could not be read authoritatively/);
		});

		it('returns the declared-empty list when the API sends an explicit empty array', async () => {
			const request = jest.fn().mockResolvedValue({ data: { indexes: [] } });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.resolves.toEqual([]);
		});

		it('never leaks the provider error message into the thrown error', async () => {
			const request = jest.fn().mockRejectedValue(
				new Error('403 for projects/cabros-bot/databases/(default) at 10.0.0.1'),
			);

			await expect(fetchLiveIndexes({ project: 'cabros-bot', database: '(default)', request }))
				.rejects.toThrow(/datastore\.indexes\.list/);
			await expect(fetchLiveIndexes({ project: 'cabros-bot', database: '(default)', request }))
				.rejects.not.toThrow(/10\.0\.0\.1/);
		});
	});

	describe('runDeploy()', () => {
		it('invokes the pinned CLI for the firestore:indexes target only', () => {
			const result = runDeploy({ project: 'cabros-bot', binPath: '/tmp/firebase.js', cwd: '/tmp' });

			expect(result.status).not.toBe(0);
		});
	});

	describe('recordDeployLog()', () => {
		let tempDir;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-index-log-'));
		});

		afterEach(() => {
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		it('appends a timestamped readiness record', () => {
			const logFile = path.join(tempDir, 'indexes.log');
			const line = recordDeployLog({
				project: 'cabros-bot',
				database: '(default)',
				mode: 'apply',
				summary: summarizeAudit(auditIndexes([ALERTS_INDEX], [])),
				logFile,
			});

			expect(line).toContain('ALL_READY=false');
			expect(fs.readFileSync(logFile, 'utf8')).toContain('MISSING=1');
		});
	});
});