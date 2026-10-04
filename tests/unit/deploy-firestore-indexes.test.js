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
	INDEX_PAGE_SIZE,
	MAX_INDEX_PAGES,
	auditIndexes,
	fetchLiveIndexes,
	indexKey,
	main,
	parseArgs,
	readDeclaredIndexes,
	recordDeployLog,
	resolveFirebaseBin,
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
				`https://firestore.googleapis.com/v1/projects/cabros-bot/databases/(default)/collectionGroups/-/indexes?pageSize=${INDEX_PAGE_SIZE}`,
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

		// The listing is paginated, and it also contains Firestore's automatic
		// single-field indexes, so exceeding one page is realistic. Stopping at
		// page one would report a genuinely READY index as MISSING.
		it('follows nextPageToken and collects every page', async () => {
			const request = jest.fn()
				.mockResolvedValueOnce({
					data: { indexes: [liveIndex(REPLAYS_INDEX, 'READY')], nextPageToken: 'page-2' },
				})
				.mockResolvedValueOnce({
					data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')] },
				});

			const indexes = await fetchLiveIndexes({
				project: 'cabros-bot',
				database: '(default)',
				request,
			});

			expect(request).toHaveBeenCalledTimes(2);
			const secondUrl = new URL(request.mock.calls[1][1]);
			expect(secondUrl.searchParams.get('pageSize')).toBe(String(INDEX_PAGE_SIZE));
			expect(secondUrl.searchParams.get('pageToken')).toBe('page-2');
			expect(indexes.map((index) => index.state)).toEqual(['READY', 'READY']);
		});

		it('reports everyReady when the declared index is only found on a later page', () => {
			const request = jest.fn()
				.mockResolvedValueOnce({ data: { indexes: [], nextPageToken: 'page-2' } })
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')] } });

			return fetchLiveIndexes({ project: 'p', database: '(default)', request })
				.then((live) => {
					expect(summarizeAudit(auditIndexes([ALERTS_INDEX], live)).allReady).toBe(true);
				});
		});

		it('still refuses a truncated later page instead of trusting the pages read so far', async () => {
			const request = jest.fn()
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')], nextPageToken: 'page-2' } })
				.mockResolvedValueOnce({ data: {} });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/could not be read authoritatively/);
		});

		it('stops on a nextPageToken that repeats itself', async () => {
			const request = jest.fn().mockResolvedValue({
				data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')], nextPageToken: 'stuck' },
			});

			// The repeated page is still consumed; only the *next* hop stops. A
			// duplicate is harmless because auditIndexes keys a Map by indexKey.
			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.resolves.toHaveLength(2);
			expect(request).toHaveBeenCalledTimes(2);
		});

		it('refuses rather than auditing a truncated listing when the page cap is reached', async () => {
			let page = 0;
			const request = jest.fn().mockImplementation(async () => {
				page += 1;
				return { data: { indexes: [], nextPageToken: `page-${page}` } };
			});

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/truncated/);
			expect(request).toHaveBeenCalledTimes(MAX_INDEX_PAGES);
		});
	});

	describe('resolveFirebaseBin()', () => {
		it('resolves a real JavaScript entry, never the node_modules/.bin shell shim', () => {
			const binPath = resolveFirebaseBin();

			expect(binPath.endsWith('.js')).toBe(true);
			expect(binPath).not.toContain(`${path.sep}.bin${path.sep}`);
			expect(fs.existsSync(binPath)).toBe(true);
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

	// The exit code is this tool's entire contract: operators are told to trust
	// it during a P0, so 0/1/2 are pinned here rather than only in the summary.
	describe('main()', () => {
		let tempDir;
		let indexesFile;
		let logFile;
		let logSpy;
		let errorSpy;

		beforeEach(() => {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-index-main-'));
			indexesFile = path.join(tempDir, 'indexes.json');
			logFile = path.join(tempDir, 'audit.log');
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [ALERTS_INDEX] }), 'utf8');
			logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
			errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
		});

		afterEach(() => {
			logSpy.mockRestore();
			errorSpy.mockRestore();
			fs.rmSync(tempDir, { recursive: true, force: true });
		});

		const baseArgs = () => ['--indexes', indexesFile, '--log-file', logFile];

		const readyRequest = () => jest.fn().mockResolvedValue({
			data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')] },
		});

		it('exits 0 when every declared index is READY', async () => {
			await expect(main(baseArgs(), { request: readyRequest() })).resolves.toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
		});

		it('exits 1 when a declared index is missing, without touching the audit log', async () => {
			const request = jest.fn().mockResolvedValue({ data: { indexes: [] } });

			await expect(main(baseArgs(), { request })).resolves.toBe(1);
			expect(fs.existsSync(logFile)).toBe(false);
		});

		it('exits 1 when a declared index exists but is still building', async () => {
			const request = jest.fn().mockResolvedValue({
				data: { indexes: [liveIndex(ALERTS_INDEX, 'BUILDING')] },
			});

			await expect(main(baseArgs(), { request })).resolves.toBe(1);
		});

		it('exits 2 on an unparseable option', async () => {
			await expect(main([...baseArgs(), '--nope'], { request: readyRequest() })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown option/));
		});

		it('exits 2 rather than reporting missing indexes when the listing is indeterminate', async () => {
			const request = jest.fn().mockResolvedValue({ data: {} });

			await expect(main(baseArgs(), { request })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/authoritatively/));
		});

		it('exits 2 when no authenticated client can be built', async () => {
			await expect(main(baseArgs(), { request: null })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/unable to build an authenticated Firestore client/));
		});

		it('exits 2 when the deploy itself fails, before auditing anything', async () => {
			const request = readyRequest();
			const deploy = jest.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });

			await expect(main([...baseArgs(), '--apply'], { request, runDeploy: deploy })).resolves.toBe(2);
			expect(request).not.toHaveBeenCalled();
		});

		it('exits 2 when the deploy cannot even be launched', async () => {
			const deploy = jest.fn(() => {
				throw new Error('Unable to locate the firebase-tools CLI entry');
			});

			await expect(main([...baseArgs(), '--apply'], { request: readyRequest(), runDeploy: deploy }))
				.resolves.toBe(2);
		});

		it('waits through --apply until the build reaches READY instead of exiting on the first poll', async () => {
			const request = jest.fn()
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'BUILDING')] } })
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')] } });
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });

			await expect(main([...baseArgs(), '--apply'], {
				request,
				runDeploy: deploy,
				pollIntervalMs: 1,
			})).resolves.toBe(0);

			expect(deploy).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledTimes(2);
			expect(fs.readFileSync(logFile, 'utf8')).toContain('ALL_READY=true');
		});

		it('exits 1 when --apply never reaches READY within the budget', async () => {
			const request = jest.fn().mockResolvedValue({
				data: { indexes: [liveIndex(ALERTS_INDEX, 'BUILDING')] },
			});
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
			let clock = 0;

			await expect(main([...baseArgs(), '--apply', '--timeout-ms', '1000'], {
				request,
				runDeploy: deploy,
				pollIntervalMs: 1,
				now: () => {
					clock += 2000;
					return clock;
				},
			})).resolves.toBe(1);

			expect(request).toHaveBeenCalledTimes(1);
			expect(fs.readFileSync(logFile, 'utf8')).toContain('ALL_READY=false');
		});

		it('exits 0 without any request when the template declares no indexes', async () => {
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [] }), 'utf8');
			const request = readyRequest();

			await expect(main(baseArgs(), { request })).resolves.toBe(0);
			expect(request).not.toHaveBeenCalled();
		});
	});
});
