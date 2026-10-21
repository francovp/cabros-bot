'use strict';

/**
 * Unit coverage for scripts/deploy-firestore-indexes.js (issue #1285).
 *
 * The load-bearing behaviour is that a declared-but-not-live (or live-but-still
 * CREATING) composite index is reported as not ready and drives a non-zero exit
 * status. This verifies the repository's index deployment and audit workflow;
 * it does not assert that a missing alerts index caused the read outage linked
 * to issue #1285.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
	DEFAULT_DATABASE_EDITION,
	INDEX_PAGE_SIZE,
	MAX_INDEX_PAGES,
	auditIndexes,
	fetchDatabaseEdition,
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

const OUTCOME_SOURCE_INDEX = {
	collectionGroup: 'tradingSignalOutcomes',
	queryScope: 'COLLECTION',
	fields: [
		{ fieldPath: 'source', order: 'ASCENDING' },
		{ fieldPath: 'receivedAt', order: 'DESCENDING' },
	],
};

function liveIndex(spec, state, project = 'cabros-bot', database = '(default)') {
	const { collectionGroup, ...rest } = spec;
	return {
		...rest,
		name: `projects/${project}/databases/${database}/collectionGroups/${collectionGroup}/indexes/test-index`,
		state,
	};
}

function liveDeclaredIndex(spec, state) {
	const fields = [...spec.fields];
	if (fields.at(-1)?.fieldPath !== '__name__') {
		const lastOrderedField = [...fields].reverse().find((field) => field.order);
		fields.push({
			fieldPath: '__name__',
			order: lastOrderedField ? lastOrderedField.order : 'ASCENDING',
		});
	}
	return { ...spec, fields, state };
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

		it('normalizes the implicit __name__ field before the final vector field', () => {
			const declared = {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: {} } }],
			};
			const live = {
				...declared,
				fields: [
					{ fieldPath: '__name__', order: 'ASCENDING' },
					{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: {} } },
				],
			};

			expect(indexKey(declared)).toBe(indexKey(live));
			expect(indexKey(declared)).not.toBe(indexKey({
				...live,
				fields: [
					{ fieldPath: '__name__', order: 'ASCENDING' },
					{ fieldPath: 'embedding', vectorConfig: { dimension: 256, flat: {} } },
				],
			}));
		});

		it('normalizes default index options and distinguishes non-default options', () => {
			const defaults = indexKey(ALERTS_INDEX);

			expect(indexKey({
				...ALERTS_INDEX,
				apiScope: 'ANY_API',
				density: 'SPARSE_ALL',
				multikey: false,
			})).toBe(defaults);
			for (const option of [
				{ apiScope: 'DATASTORE_MODE_API' },
				{ density: 'DENSE' },
				{ multikey: true },
			]) {
				expect(indexKey({ ...ALERTS_INDEX, ...option })).not.toBe(defaults);
			}

			expect(indexKey({ ...ALERTS_INDEX, density: 'DENSE' }, 'ENTERPRISE'))
				.toBe(indexKey(ALERTS_INDEX, 'ENTERPRISE'));
		});

		it('does not add an implicit __name__ field for Enterprise indexes', () => {
			const declared = {
				collectionGroup: 'alerts',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'receivedAt', order: 'DESCENDING' }],
			};
			const live = liveIndex({
				...declared,
				fields: [
					...declared.fields,
					{ fieldPath: '__name__', order: 'DESCENDING' },
				],
			}, 'READY');

			expect(auditIndexes([declared], [live], 'STANDARD')[0].ready).toBe(true);
			expect(auditIndexes([declared], [live], 'ENTERPRISE')[0].deployed).toBe(false);
		});

		it('accepts a one-field Enterprise vector index from the REST listing', async () => {
			const declared = {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: {} } }],
			};
			const request = jest.fn().mockResolvedValue({
				data: { indexes: [liveIndex(declared, 'READY', 'p')] },
			});
			const live = await fetchLiveIndexes({ project: 'p', database: '(default)', request });

			expect(auditIndexes([declared], live, 'ENTERPRISE')[0])
				.toMatchObject({ deployed: true, state: 'READY', ready: true });
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

		it('reads representative composite indexes declared by the repository', () => {
			const declared = readDeclaredIndexes(
				path.resolve(__dirname, '../../firestore.indexes.json'),
			);

			expect(declared.length).toBeGreaterThan(0);
			expect(declared).toContainEqual(REPLAYS_INDEX);
			expect(declared).toContainEqual(OUTCOME_SOURCE_INDEX);
		});

		it('preserves configured field modes when auditing template indexes', () => {
			const indexes = [
				{
					collectionGroup: 'embeddings',
					queryScope: 'COLLECTION',
					fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: {} } }],
				},
				{
					collectionGroup: 'documents',
					queryScope: 'COLLECTION',
					fields: [{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }],
				},
				{
					collectionGroup: 'documents',
					queryScope: 'COLLECTION',
					fields: [{
						fieldPath: 'content',
						searchConfig: {
							textSpec: {
								indexSpecs: [{ indexType: 'TOKENIZED', matchType: 'MATCH_GLOBALLY' }],
							},
						},
					}],
				},
			];
			const indexesPath = path.join(tempDir, 'indexes.json');
			fs.writeFileSync(indexesPath, JSON.stringify({ indexes }));

			const declared = readDeclaredIndexes(indexesPath);
			const audit = auditIndexes(declared, indexes.map((index) => liveIndex(index, 'READY')));

			expect(declared.map((index) => index.fields[0])).toEqual(indexes.map((index) => index.fields[0]));
			expect(audit.map(({ ready }) => ready)).toEqual([true, true, true]);
		});

		it('preserves index-level API scope, density, and multikey options', () => {
			const index = {
				...ALERTS_INDEX,
				apiScope: 'DATASTORE_MODE_API',
				density: 'SPARSE_ALL',
				multikey: true,
			};
			const indexesPath = path.join(tempDir, 'indexes-with-options.json');
			fs.writeFileSync(indexesPath, JSON.stringify({ indexes: [index] }));

			expect(readDeclaredIndexes(indexesPath)).toEqual([index]);
		});

		it('rejects unique indexes that the pinned Firebase CLI cannot deploy', () => {
			const indexesPath = path.join(tempDir, 'unique-index.json');
			fs.writeFileSync(indexesPath, JSON.stringify({ indexes: [{ ...ALERTS_INDEX, unique: true }] }));

			expect(() => readDeclaredIndexes(indexesPath)).toThrow(/unique/);
		});

		it.each([
			['shardCount', { shardCount: 4 }],
			['searchIndexOptions', { searchIndexOptions: {} }],
		])('rejects declared %s because the deploy comparison cannot represent it', (option, extra) => {
			const indexesPath = path.join(tempDir, `unsupported-${option}.json`);
			fs.writeFileSync(indexesPath, JSON.stringify({ indexes: [{ ...ALERTS_INDEX, ...extra }] }));

			expect(() => readDeclaredIndexes(indexesPath)).toThrow(new RegExp(option));
		});

		it('reports an unreadable template instead of silently auditing nothing', () => {
			expect(() => readDeclaredIndexes(path.join(tempDir, 'missing.json')))
				.toThrow(/Failed to read/);
		});

		it.each([
			['missing indexes', {}],
			['non-array indexes', { indexes: 'alerts' }],
		])('rejects a template with %s', (_description, contents) => {
			const indexesPath = path.join(tempDir, 'malformed.json');
			fs.writeFileSync(indexesPath, JSON.stringify(contents));

			expect(() => readDeclaredIndexes(indexesPath)).toThrow(/must contain an indexes array/);
		});

		it.each([
			['missing collection group', { queryScope: 'COLLECTION', fields: [{ fieldPath: 'x', order: 'ASCENDING' }] }],
			['missing query scope', { collectionGroup: 'alerts', fields: [{ fieldPath: 'x', order: 'ASCENDING' }] }],
			['empty fields', { collectionGroup: 'alerts', queryScope: 'COLLECTION', fields: [] }],
			['unknown index property', { ...ALERTS_INDEX, apiScop: 'ANY_API' }],
			['malformed field', { collectionGroup: 'alerts', queryScope: 'COLLECTION', fields: [{}] }],
			['unknown field property', {
				...ALERTS_INDEX,
				fields: [{ ...ALERTS_INDEX.fields[0], bogus: true }, ALERTS_INDEX.fields[1]],
			}],
			['malformed nested search config', {
				collectionGroup: 'documents',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'content', searchConfig: { textSpec: { indexSpecs: [{}] } } }],
			}],
			['fractional vector dimension', {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128.5, flat: {} } }],
			}],
			['vector dimension above the Firestore limit', {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 2049, flat: {} } }],
			}],
			['unknown vectorConfig property', {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: {}, metric: 'COSINE' } }],
			}],
			['unknown flat index property', {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: { metric: 'COSINE' } } }],
			}],
		])('rejects an index declaration with %s', (_description, index) => {
			const indexesPath = path.join(tempDir, 'malformed-entry.json');
			fs.writeFileSync(indexesPath, JSON.stringify({ indexes: [index] }));

			expect(() => readDeclaredIndexes(indexesPath)).toThrow(/indexes\[0\]/);
		});
	});

	describe('auditIndexes()', () => {
		it('matches a REST index using the collection group encoded in its resource name', () => {
			const live = {
				name: 'projects/cabros-bot/databases/(default)/collectionGroups/alerts/indexes/abc123',
				queryScope: 'COLLECTION',
				fields: ALERTS_INDEX.fields,
				state: 'READY',
			};

			expect(auditIndexes([ALERTS_INDEX], [live])[0])
				.toMatchObject({ deployed: true, state: 'READY', ready: true });
		});

		it('does not match indexes whose API scope, density, or multikey differs', () => {
			const declared = {
				...ALERTS_INDEX,
				apiScope: 'DATASTORE_MODE_API',
				density: 'SPARSE_ALL',
				multikey: true,
			};
			const same = liveIndex(declared, 'READY');

			expect(auditIndexes([declared], [same])[0].ready).toBe(true);
			for (const different of [
				liveIndex({ ...declared, apiScope: 'ANY_API' }, 'READY'),
				liveIndex({ ...declared, density: 'DENSE' }, 'READY'),
				liveIndex({ ...declared, multikey: false }, 'READY'),
			]) {
				expect(auditIndexes([declared], [different])[0].deployed).toBe(false);
			}
		});

		it('reports a declared index as ready only when the live state is READY', () => {
			const audit = auditIndexes([ALERTS_INDEX], [liveIndex(ALERTS_INDEX, 'READY')]);

			expect(audit).toHaveLength(1);
			expect(audit[0]).toMatchObject({ deployed: true, state: 'READY', ready: true });
		});

		it('matches the implicit __name__ suffix returned by Firestore', () => {
			const declared = {
				collectionGroup: 'alerts',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'receivedAt', order: 'DESCENDING' }],
			};
			const live = liveIndex({
				...declared,
				fields: [
					{ fieldPath: 'receivedAt', order: 'DESCENDING' },
					{ fieldPath: '__name__', order: 'DESCENDING' },
				],
			}, 'READY');

			const audit = auditIndexes([declared], [live]);

			expect(audit[0]).toMatchObject({ deployed: true, state: 'READY', ready: true });
		});

		it('reports a still-building index as deployed but not ready', () => {
			const audit = auditIndexes([ALERTS_INDEX], [liveIndex(ALERTS_INDEX, 'CREATING')]);

			expect(audit[0]).toMatchObject({ deployed: true, state: 'CREATING', ready: false });
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
				liveIndex(ALERTS_INDEX, 'CREATING'),
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
				data: { indexes: [liveIndex(ALERTS_INDEX, 'CREATING')] },
			});

			const indexes = await fetchLiveIndexes({
				project: 'cabros-bot',
				database: '(default)',
				request,
			});

			expect(request).toHaveBeenCalledWith(
				'GET',
				`https://firestore.googleapis.com/v1/projects/cabros-bot/databases/(default)/collectionGroups/-/indexes?pageSize=${INDEX_PAGE_SIZE}`,
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
			expect(indexes[0].state).toBe('CREATING');
		});

		it('aborts a stalled REST request at the timeout deadline', async () => {
			let signal;
			const onTimeout = jest.fn();
			const request = jest.fn((method, url, options) => {
				signal = options && options.signal;
				return new Promise(() => {});
			});
			const result = await Promise.race([
				fetchLiveIndexes({ project: 'p', database: '(default)', request, timeoutMs: 10, onTimeout })
					.then(() => 'resolved', () => 'rejected'),
				new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
			]);

			expect(result).toBe('rejected');
			expect(signal).toBeDefined();
			expect(signal.aborted).toBe(true);
			expect(onTimeout).toHaveBeenCalledWith(expect.objectContaining({ code: 'FIRESTORE_INDEX_TIMEOUT' }));
		});

		it('refuses to treat a body with no indexes array as an authoritative empty list', async () => {
			const request = jest.fn().mockResolvedValue({ data: {} });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/could not be read authoritatively/);
		});

		it.each([
			['malformed name', 'not-a-resource-name'],
			['different project', 'projects/other-project/databases/(default)/collectionGroups/alerts/indexes/abc'],
			['different database', 'projects/p/databases/other-db/collectionGroups/alerts/indexes/abc'],
		])('rejects an index listing with a %s', async (_description, name) => {
			const request = jest.fn().mockResolvedValue({ data: { indexes: [{ name }] } });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/could not be read authoritatively/);
		});

		it.each([
			['empty scope', (index) => ({ ...index, queryScope: '' })],
			['missing scope', (index) => {
				const { queryScope: _queryScope, ...rest } = index;
				return rest;
			}],
			['empty fields', (index) => ({ ...index, fields: [] })],
			['missing state', (index) => {
				const { state: _state, ...rest } = index;
				return rest;
			}],
			['invalid state', (index) => ({ ...index, state: 'UNKNOWN' })],
			['unsupported DISABLED state', (index) => ({ ...index, state: 'DISABLED' })],
			['unknown top-level property', (index) => ({ ...index, futureIndexOption: true })],
			['unknown field property', (index) => ({
				...index,
				fields: [{ ...index.fields[0], bogus: true }, ...index.fields.slice(1)],
			})],
			['invalid vector dimension', (index) => ({
				...index,
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 2.5, flat: {} } }],
			})],
		])('rejects a REST index with %s', async (_description, makeInvalid) => {
			const index = makeInvalid(liveIndex(ALERTS_INDEX, 'READY', 'p'));
			const request = jest.fn().mockResolvedValue({ data: { indexes: [index] } });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/could not be read authoritatively/);
		});

		it('accepts STATE_UNSPECIFIED as a valid but not-ready REST state', async () => {
			const index = liveIndex(ALERTS_INDEX, 'STATE_UNSPECIFIED', 'p');
			const request = jest.fn().mockResolvedValue({ data: { indexes: [index] } });
			const live = await fetchLiveIndexes({ project: 'p', database: '(default)', request });

			expect(auditIndexes([ALERTS_INDEX], live)[0])
				.toMatchObject({ deployed: true, state: 'STATE_UNSPECIFIED', ready: false });
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

		// The composite-index listing is paginated; a database with many declared
		// indexes can exceed one page. Stopping at
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
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'READY', 'p')] } });

			return fetchLiveIndexes({ project: 'p', database: '(default)', request })
				.then((live) => {
					expect(summarizeAudit(auditIndexes([ALERTS_INDEX], live)).allReady).toBe(true);
				});
		});

		it('still refuses a truncated later page instead of trusting the pages read so far', async () => {
			const request = jest.fn()
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'READY', 'p')], nextPageToken: 'page-2' } })
				.mockResolvedValueOnce({ data: {} });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/could not be read authoritatively/);
		});

		it('rejects a repeated non-empty pagination token as an incomplete listing', async () => {
			const request = jest.fn()
				.mockResolvedValueOnce({ data: { indexes: [], nextPageToken: 'page-2' } })
				.mockResolvedValueOnce({ data: { indexes: [liveIndex(ALERTS_INDEX, 'READY', 'p')], nextPageToken: 'page-2' } });

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/repeated pagination token|truncated/i);
			expect(request).toHaveBeenCalledTimes(2);
		});

		it.each([
			['number', 17],
			['object', { token: 'page-2' }],
			['null', null],
		])('rejects a non-string nextPageToken (%s) as an indeterminate listing', async (_description, nextPageToken) => {
			const request = jest.fn().mockResolvedValue({
				data: { indexes: [liveIndex(ALERTS_INDEX, 'READY', 'p')], nextPageToken },
			});

			await expect(fetchLiveIndexes({ project: 'p', database: '(default)', request }))
				.rejects.toThrow(/malformed pagination token|could not be read authoritatively/i);
			expect(request).toHaveBeenCalledTimes(1);
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

	describe('fetchDatabaseEdition()', () => {
		it('reads the selected database metadata and returns its edition', async () => {
			const request = jest.fn().mockResolvedValue({
				data: { name: 'projects/cabros-bot/databases/(default)', databaseEdition: 'ENTERPRISE' },
			});

			await expect(fetchDatabaseEdition({ project: 'cabros-bot', database: '(default)', request }))
				.resolves.toBe('ENTERPRISE');
			expect(request).toHaveBeenCalledWith(
				'GET',
				'https://firestore.googleapis.com/v1/projects/cabros-bot/databases/(default)',
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			);
		});

		it('uses the standard edition when the API omits databaseEdition', async () => {
			const request = jest.fn().mockResolvedValue({
				data: { name: 'projects/cabros-bot/databases/(default)' },
			});

			await expect(fetchDatabaseEdition({ project: 'cabros-bot', database: '(default)', request }))
				.resolves.toBe(DEFAULT_DATABASE_EDITION);
		});

		it('rejects a response that is not the selected database resource', async () => {
			const request = jest.fn().mockResolvedValue({ data: {} });

			await expect(fetchDatabaseEdition({ project: 'cabros-bot', database: '(default)', request }))
				.rejects.toThrow(/invalid database metadata/);
		});

		it('aborts a stalled database metadata request at the deadline', async () => {
			let signal;
			const request = jest.fn((_method, _url, options) => {
				signal = options.signal;
				return new Promise(() => {});
			});

			await expect(fetchDatabaseEdition({
				project: 'cabros-bot',
				database: '(default)',
				request,
				timeoutMs: 10,
			})).rejects.toThrow(/Timed out while reading Firestore database metadata/);
			expect(signal.aborted).toBe(true);
		});
	});

	describe('loadAuthenticatedClient()', () => {
		it('caches OAuth tokens and sends the configured quota project', async () => {
			const originalFetch = global.fetch;
			const credential = {
				getAccessToken: jest.fn().mockResolvedValue({ access_token: 'test-access-token', expires_in: 3600 }),
			};
			const app = { options: { credential, projectId: 'quota-project' } };
			const admin = { apps: [app], app: () => app, initializeApp: jest.fn() };
			const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ indexes: [] }) });
			let request;

			global.fetch = fetch;
			try {
				jest.isolateModules(() => {
					jest.doMock('firebase-admin', () => admin);
					request = require('../../scripts/deploy-firestore-indexes').loadAuthenticatedClient().request;
				});

				await request('GET', 'https://firestore.googleapis.com/v1/indexes');
				await request('GET', 'https://firestore.googleapis.com/v1/indexes');

				expect(credential.getAccessToken).toHaveBeenCalledTimes(1);
				expect(fetch).toHaveBeenCalledTimes(2);
				expect(fetch.mock.calls[0][1].headers).toMatchObject({
					authorization: 'Bearer test-access-token',
					'x-goog-user-project': 'quota-project',
				});
			} finally {
				jest.dontMock('firebase-admin');
				global.fetch = originalFetch;
			}
		});

		it('returns at the deadline when OAuth token lookup stalls', async () => {
			const credential = { getAccessToken: jest.fn(() => new Promise(() => {})) };
			const app = { options: { credential, projectId: 'test-project' } };
			const admin = { apps: [app], app: () => app, initializeApp: jest.fn() };
			const onTimeout = jest.fn();
			const networkHandle = setInterval(() => {}, 1000);
			let fetchIndexes;

			try {
				jest.isolateModules(() => {
					jest.doMock('firebase-admin', () => admin);
					fetchIndexes = require('../../scripts/deploy-firestore-indexes').fetchLiveIndexes;
				});

				await expect(fetchIndexes({
					project: 'test-project',
					database: '(default)',
					timeoutMs: 10,
					onTimeout,
				})).rejects.toThrow(/Timed out while listing Firestore indexes/);

				expect(credential.getAccessToken).toHaveBeenCalledTimes(1);
				expect(onTimeout).toHaveBeenCalledTimes(1);
			} finally {
				clearInterval(networkHandle);
				jest.dontMock('firebase-admin');
			}
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
		it('bounds a stalled Firebase CLI child and reports the timeout', () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-index-cli-timeout-'));
			const cliPath = path.join(tempDir, 'firebase.js');
			fs.writeFileSync(cliPath, 'setTimeout(() => {}, 10000);', 'utf8');

			try {
				expect(() => runDeploy({
					project: 'test-project',
					binPath: cliPath,
					cwd: tempDir,
					timeoutMs: 25,
				})).toThrow(/timed out after 25ms/i);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		});

		it('invokes the pinned CLI for the firestore:indexes target only', () => {
			const result = runDeploy({ project: 'cabros-bot', binPath: '/tmp/firebase.js', cwd: '/tmp' });

			expect(result.status).not.toBe(0);
		});

		it('uses the service-account credential for CLI deployment and removes temporary auth files', () => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-index-cli-auth-'));
			const reportPath = path.join(tempDir, 'cli-env.json');
			const cliPath = path.join(tempDir, 'firebase.js');
			const serviceAccount = JSON.stringify({
				type: 'service_account',
				project_id: 'test-project',
				private_key: 'test-private-key',
				client_email: 'test@example.invalid',
			});
			const originalEnv = {
				FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
				FIREBASE_TOKEN: process.env.FIREBASE_TOKEN,
				GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
			};

			fs.writeFileSync(cliPath, [
				'const fs = require("node:fs");',
				'const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;',
				'const report = {',
				'  configDir: process.env.XDG_CONFIG_HOME,',
				'  credentialPath,',
				'  credential: JSON.parse(fs.readFileSync(credentialPath, "utf8")),',
				'  credentialMode: fs.statSync(credentialPath).mode & 0o777,',
				'  firebaseToken: process.env.FIREBASE_TOKEN,',
				'  inlineCredential: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,',
				'};',
				`fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(report));`,
			].join('\n'), 'utf8');

			try {
				process.env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount;
				process.env.FIREBASE_TOKEN = 'deprecated-test-token';
				process.env.GOOGLE_APPLICATION_CREDENTIALS = '/unused/test-credentials.json';

				const result = runDeploy({ project: 'test-project', binPath: cliPath, cwd: tempDir });
				const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

				expect(result.status).toBe(0);
				expect(report.credential).toEqual(JSON.parse(serviceAccount));
				expect(report.credentialMode).toBe(0o600);
				expect(report.firebaseToken).toBeUndefined();
				expect(report.inlineCredential).toBeUndefined();
				expect(report.credentialPath).not.toBe('/unused/test-credentials.json');
				expect(fs.existsSync(report.configDir)).toBe(false);
				expect(fs.existsSync(report.credentialPath)).toBe(false);
			} finally {
				for (const [key, value] of Object.entries(originalEnv)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
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
		const applyArgs = () => ['--log-file', logFile];
		const databaseMetadata = () => ({
			name: 'projects/cabros-bot/databases/(default)',
			databaseEdition: 'STANDARD',
		});
		const withDatabaseMetadata = (requestIndexes) => jest.fn((method, url, options) => (
			url.endsWith('/databases/(default)')
				? Promise.resolve({ data: databaseMetadata() })
				: requestIndexes(method, url, options)
		));

		const readyRequest = () => withDatabaseMetadata(() => Promise.resolve({
			data: { indexes: [liveIndex(ALERTS_INDEX, 'READY')] },
		}));

		const defaultIndexRequest = (state) => withDatabaseMetadata(() => Promise.resolve({
			data: { indexes: readDeclaredIndexes().map((index) => liveIndex(index, state)) },
		}));

		it('exits 0 when every declared index is READY', async () => {
			await expect(main(baseArgs(), { request: readyRequest() })).resolves.toBe(0);
			expect(errorSpy).not.toHaveBeenCalled();
		});

		it('uses the selected database edition to normalize live density defaults', async () => {
			const request = jest.fn((method, url) => {
				if (url.endsWith('/databases/(default)')) {
					return Promise.resolve({
						data: { name: 'projects/cabros-bot/databases/(default)', databaseEdition: 'ENTERPRISE' },
					});
				}
				return Promise.resolve({
					data: { indexes: [liveIndex({ ...ALERTS_INDEX, density: 'DENSE' }, 'READY')] },
				});
			});

			await expect(main(baseArgs(), { request })).resolves.toBe(0);
		});

		it('exits 1 when a declared index is missing, without touching the audit log', async () => {
			const request = withDatabaseMetadata(() => Promise.resolve({ data: { indexes: [] } }));

			await expect(main(baseArgs(), { request })).resolves.toBe(1);
			expect(fs.existsSync(logFile)).toBe(false);
		});

		it('exits 1 when a declared index exists but is still building', async () => {
			const request = withDatabaseMetadata(() => Promise.resolve({
				data: { indexes: [liveIndex(ALERTS_INDEX, 'CREATING')] },
			}));

			await expect(main(baseArgs(), { request })).resolves.toBe(1);
		});

		it('exits 2 on an unparseable option', async () => {
			await expect(main([...baseArgs(), '--nope'], { request: readyRequest() })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/Unknown option/));
		});

		it.each([
			['missing indexes', {}],
			['non-array indexes', { indexes: null }],
		])('exits 2 for a template with %s', async (_description, contents) => {
			fs.writeFileSync(indexesFile, JSON.stringify(contents));

			await expect(main(baseArgs(), { request: readyRequest() })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/must contain an indexes array/));
		});

		it('exits 2 instead of reporting missing when a declaration entry is malformed', async () => {
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [{}] }));
			const request = readyRequest();

			await expect(main(baseArgs(), { request })).resolves.toBe(2);
			expect(request).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/indexes\[0\]/));
		});

		it.each([
			['missing query scope', { collectionGroup: 'alerts', fields: ALERTS_INDEX.fields }],
			['unknown index property', { ...ALERTS_INDEX, apiScop: 'ANY_API' }],
			['unknown field property', {
				...ALERTS_INDEX,
				fields: [{ ...ALERTS_INDEX.fields[0], bogus: true }, ALERTS_INDEX.fields[1]],
			}],
			['malformed nested search config', {
				collectionGroup: 'documents',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'content', searchConfig: { textSpec: { indexSpecs: [{}] } } }],
			}],
			['invalid vector dimension', {
				collectionGroup: 'embeddings',
				queryScope: 'COLLECTION',
				fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 2049, flat: {} } }],
			}],
		])('exits 2 instead of reporting missing for a declaration with %s', async (_description, index) => {
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [index] }));
			const request = readyRequest();

			await expect(main(baseArgs(), { request })).resolves.toBe(2);
			expect(request).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/indexes\[0\]/));
		});

		it('exits 2 when the template declares an unsupported unique index', async () => {
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [{ ...ALERTS_INDEX, unique: true }] }));
			const request = readyRequest();

			await expect(main(baseArgs(), { request })).resolves.toBe(2);
			expect(request).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/unique/));
		});

		it.each([
			['shardCount', { shardCount: 4 }],
			['searchIndexOptions', { searchIndexOptions: {} }],
		])('exits 2 when the template declares unsupported %s', async (option, extra) => {
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [{ ...ALERTS_INDEX, ...extra }] }));
			const request = readyRequest();

			await expect(main(baseArgs(), { request })).resolves.toBe(2);
			expect(request).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(new RegExp(option)));
		});

		it('exits 1 when an index state is STATE_UNSPECIFIED', async () => {
			const request = defaultIndexRequest('STATE_UNSPECIFIED');

			await expect(main(baseArgs(), { request })).resolves.toBe(1);
		});

		it('exits 2 rather than reporting missing indexes when the listing is indeterminate', async () => {
			const request = withDatabaseMetadata(() => Promise.resolve({ data: {} }));

			await expect(main(baseArgs(), { request })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/authoritatively/));
		});

		it('exits 2 when no authenticated client can be built', async () => {
			await expect(main(baseArgs(), { request: null })).resolves.toBe(2);
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/unable to build an authenticated Firestore client/));
		});

		it('exits 2 when the deploy itself fails, before auditing anything', async () => {
			const request = defaultIndexRequest('READY');
			const deploy = jest.fn().mockReturnValue({ status: 1, stdout: '', stderr: 'boom' });

			await expect(main([...applyArgs(), '--apply'], { request, runDeploy: deploy })).resolves.toBe(2);
			expect(request).not.toHaveBeenCalled();
		});

		it('exits 2 when the deploy cannot even be launched', async () => {
			const deploy = jest.fn(() => {
				throw new Error('Unable to locate the firebase-tools CLI entry');
			});

			await expect(main([...applyArgs(), '--apply'], { request: defaultIndexRequest('READY'), runDeploy: deploy }))
				.resolves.toBe(2);
		});

		it('waits through --apply until the build reaches READY instead of exiting on the first poll', async () => {
			const request = jest.fn()
				.mockResolvedValueOnce({ data: databaseMetadata() })
				.mockResolvedValueOnce({ data: { indexes: readDeclaredIndexes().map((index) => liveIndex(index, 'CREATING')) } })
				.mockResolvedValueOnce({ data: { indexes: readDeclaredIndexes().map((index) => liveIndex(index, 'READY')) } });
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });

			await expect(main([...applyArgs(), '--apply'], {
				request,
				runDeploy: deploy,
				pollIntervalMs: 1,
			})).resolves.toBe(0);

			expect(deploy).toHaveBeenCalledTimes(1);
			expect(request).toHaveBeenCalledTimes(3);
			expect(fs.readFileSync(logFile, 'utf8')).toContain('ALL_READY=true');
		});

		it('exits 1 when --apply never reaches READY within the budget', async () => {
			let clock = 0;
			const request = jest.fn().mockImplementation(async (_method, url) => {
				if (url.endsWith('/databases/(default)')) {
					return { data: databaseMetadata() };
				}
				clock += 2000;
				return { data: { indexes: readDeclaredIndexes().map((index) => liveIndex(index, 'CREATING')) } };
			});
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });

			await expect(main([...applyArgs(), '--apply', '--timeout-ms', '1000'], {
				request,
				runDeploy: deploy,
				pollIntervalMs: 1,
				now: () => clock,
			})).resolves.toBe(1);

			expect(request).toHaveBeenCalledTimes(2);
			expect(fs.readFileSync(logFile, 'utf8')).toContain('ALL_READY=false');
		});

		it.each([
			['database override', ['--database', 'other-database']],
			['indexes override', ['--indexes', path.join(os.tmpdir(), 'alternate-firestore-indexes.json')]],
		])('rejects an apply %s before deployment', async (description, targetArgs) => {
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });
			const request = defaultIndexRequest('READY');

			await expect(main([...applyArgs(), '--apply', ...targetArgs], {
				request,
				runDeploy: deploy,
			})).resolves.toBe(2);

			expect(deploy).not.toHaveBeenCalled();
			expect(request).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/--apply/));
		});

		it('keeps stdout as a single JSON document in apply mode', async () => {
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });

			await expect(main([...applyArgs(), '--apply', '--json'], {
				request: defaultIndexRequest('READY'),
				runDeploy: deploy,
			})).resolves.toBe(0);

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
				mode: 'apply',
				summary: { allReady: true },
			});
		});

		it('prints the configured mode for array, vector, and search fields', async () => {
			const indexes = [
				{
					collectionGroup: 'documents',
					queryScope: 'COLLECTION',
					fields: [{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }],
				},
				{
					collectionGroup: 'documents',
					queryScope: 'COLLECTION',
					fields: [{
						fieldPath: 'content',
						searchConfig: {
							textSpec: { indexSpecs: [{ indexType: 'TOKENIZED', matchType: 'MATCH_GLOBALLY' }] },
						},
					}],
				},
				{
					collectionGroup: 'embeddings',
					queryScope: 'COLLECTION',
					fields: [{ fieldPath: 'embedding', vectorConfig: { dimension: 128, flat: {} } }],
				},
			];
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes }));
			const request = withDatabaseMetadata(() => Promise.resolve({
				data: { indexes: indexes.map((index) => liveIndex(index, 'READY')) },
			}));

			await expect(main(baseArgs(), { request })).resolves.toBe(0);

			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('tags CONTAINS'));
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('content SEARCH(TEXT)'));
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('embedding VECTOR(128)'));
			expect(logSpy.mock.calls.flat().join('\n')).not.toContain('undefined');
		});

		it('caps the poll sleep to the remaining readiness budget', async () => {
			let clock = 0;
			const request = jest.fn().mockImplementation(async (_method, url) => {
				if (url.endsWith('/databases/(default)')) {
					return { data: databaseMetadata() };
				}
				clock += 1;
				return { data: { indexes: readDeclaredIndexes().map((index) => liveIndex(index, 'CREATING')) } };
			});
			const wait = jest.fn(async (ms) => { clock += ms; });
			const deploy = jest.fn().mockReturnValue({ status: 0, stdout: '', stderr: '' });

			await expect(main([...applyArgs(), '--apply', '--timeout-ms', '3'], {
				request,
				runDeploy: deploy,
				pollIntervalMs: 100,
				now: () => clock,
				sleep: wait,
			})).resolves.toBe(1);

			expect(wait).toHaveBeenCalledWith(2);
			expect(request).toHaveBeenCalledTimes(2);
		});

		it('exits 0 without any request when the template declares no indexes', async () => {
			fs.writeFileSync(indexesFile, JSON.stringify({ indexes: [] }), 'utf8');
			const request = readyRequest();

			await expect(main(baseArgs(), { request })).resolves.toBe(0);
			expect(request).not.toHaveBeenCalled();
		});
	});
});
