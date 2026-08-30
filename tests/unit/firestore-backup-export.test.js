'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const admin = require('firebase-admin');

const {
	DEFAULT_COLLECTIONS,
	exportCollection,
	parseArgs: parseExportArgs,
	runExport,
	serializeDocument,
	serializeValue,
} = require('../../ops/export-firestore-collections');

const {
	deserializeDocument,
	deserializeValue,
	refreshCollectionTtls,
	parseArgs: parseRestoreArgs,
	restoreCollectionFile,
	runRestore,
} = require('../../ops/restore-firestore-collections');

function buildMockTimestamp(isoString) {
	const date = new Date(isoString);
	return {
		toDate: () => date,
		toMillis: () => date.getTime(),
		seconds: Math.floor(date.getTime() / 1000),
		nanoseconds: (date.getTime() % 1000) * 1000000,
	};
}

function buildMockGeoPoint(latitude, longitude) {
	return {
		latitude,
		longitude,
		isEqual: (other) => other && other.latitude === latitude && other.longitude === longitude,
	};
}

function buildMockDocRef(refPath) {
	return {
		path: refPath,
		id: path.basename(refPath),
		collection: jest.fn(),
	};
}

describe('Firestore Backup & Export Tooling', () => {
	let tempDir;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firestore-backup-test-'));
	});

	afterEach(() => {
		if (fs.existsSync(tempDir)) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	describe('Serialization & Deserialization', () => {
		it('serializes primitives, null, and undefined correctly', () => {
			expect(serializeValue('test-string')).toBe('test-string');
			expect(serializeValue(12345)).toBe(12345);
			expect(serializeValue(true)).toBe(true);
			expect(serializeValue(null)).toBeNull();
			expect(serializeValue(undefined)).toBeUndefined();
		});

		it('serializes and deserializes Firestore Timestamps with nanosecond precision', () => {
			const tsWithNanos = {
				toDate: () => new Date(1234567890123),
				seconds: 1234567890,
				nanoseconds: 123456789,
			};
			const serialized = serializeValue(tsWithNanos);

			expect(serialized).toEqual({
				__type: 'Timestamp',
				iso: new Date(1234567890123).toISOString(),
				seconds: 1234567890,
				nanoseconds: 123456789,
			});

			const deserialized = deserializeValue(serialized);
			expect(deserialized).toBeDefined();
			expect(deserialized.seconds).toBe(1234567890);
			expect(deserialized.nanoseconds).toBe(123456789);
		});

		it('serializes JavaScript Date objects', () => {
			const date = new Date('2026-05-15T08:30:00.000Z');
			const serialized = serializeValue(date);

			expect(serialized.__type).toBe('Timestamp');
			expect(serialized.iso).toBe('2026-05-15T08:30:00.000Z');
		});

		it('serializes and deserializes Firestore GeoPoints', () => {
			const geo = buildMockGeoPoint(37.7749, -122.4194);
			const serialized = serializeValue(geo);

			expect(serialized).toEqual({
				__type: 'GeoPoint',
				latitude: 37.7749,
				longitude: -122.4194,
			});

			const deserialized = deserializeValue(serialized);
			expect(deserialized.latitude).toBe(37.7749);
			expect(deserialized.longitude).toBe(-122.4194);
		});

		it('serializes and deserializes DocumentReferences', () => {
			const ref = buildMockDocRef('alerts/alert-123');
			const serialized = serializeValue(ref);

			expect(serialized).toEqual({
				__type: 'DocumentReference',
				path: 'alerts/alert-123',
			});

			const mockFirestore = {
				doc: jest.fn((p) => ({ path: p })),
			};
			const deserialized = deserializeValue(serialized, mockFirestore);
			expect(mockFirestore.doc).toHaveBeenCalledWith('alerts/alert-123');
			expect(deserialized.path).toBe('alerts/alert-123');
		});

		it('serializes and deserializes Firestore byte values as base64', () => {
			const original = Buffer.from([0, 1, 2, 255]);
			const serialized = serializeValue(original);

			expect(serialized).toEqual({
				__type: 'Bytes',
				base64: original.toString('base64'),
			});
			expect(Buffer.isBuffer(deserializeValue(serialized))).toBe(true);
			expect(deserializeValue(serialized)).toEqual(original);
		});

		it('serializes and deserializes nested objects and arrays recursively', () => {
			const data = {
				name: 'Alert 1',
				tags: ['crypto', 'binance'],
				metadata: {
					created: buildMockTimestamp('2026-08-30T00:00:00.000Z'),
					location: buildMockGeoPoint(40.7128, -74.0060),
				},
			};

			const serialized = serializeValue(data);
			expect(serialized.tags).toEqual(['crypto', 'binance']);
			expect(serialized.metadata.created.__type).toBe('Timestamp');
			expect(serialized.metadata.location.__type).toBe('GeoPoint');

			const deserialized = deserializeValue(serialized);
			expect(deserialized.name).toBe('Alert 1');
			expect(deserialized.metadata.created.toDate().toISOString()).toBe('2026-08-30T00:00:00.000Z');
			expect(deserialized.metadata.location.latitude).toBe(40.7128);
		});

		it('serializes whole document in envelope separating document id', () => {
			const mockDoc = {
				id: 'doc-xyz',
				data: () => ({
					symbol: 'BTCUSDT',
					receivedAt: buildMockTimestamp('2026-08-30T01:00:00.000Z'),
				}),
			};

			const record = serializeDocument(mockDoc);
			expect(record.__id).toBe('doc-xyz');
			expect(record.data.symbol).toBe('BTCUSDT');
			expect(record.data.receivedAt.__type).toBe('Timestamp');

			const { id, data } = deserializeDocument(record);
			expect(id).toBe('doc-xyz');
			expect(data.symbol).toBe('BTCUSDT');
			expect(data.receivedAt.toDate().toISOString()).toBe('2026-08-30T01:00:00.000Z');
		});

		it('preserves user document _id field without collision with Firestore doc id', () => {
			const mockDoc = {
				id: 'firestore-doc-123',
				data: () => ({
					_id: 'custom-user-id-456',
					name: 'Test Record',
				}),
			};

			const record = serializeDocument(mockDoc);
			expect(record.__id).toBe('firestore-doc-123');
			expect(record.data._id).toBe('custom-user-id-456');

			const { id, data } = deserializeDocument(record);
			expect(id).toBe('firestore-doc-123');
			expect(data._id).toBe('custom-user-id-456');
			expect(data.name).toBe('Test Record');
		});

		it('deserializes legacy flattened JSONL records with backwards-compatibility', () => {
			const legacyRecord = {
				_id: 'legacy-doc-999',
				title: 'Legacy Alert',
				amount: 100,
			};

			const { id, data } = deserializeDocument(legacyRecord);
			expect(id).toBe('legacy-doc-999');
			expect(data.title).toBe('Legacy Alert');
			expect(data.amount).toBe(100);
			expect(data._id).toBeUndefined();
		});
	});

	describe('CLI Argument Parsing', () => {
		it('parses export arguments with defaults', () => {
			const opts = parseExportArgs([]);
			expect(opts.collections).toEqual(DEFAULT_COLLECTIONS);
			expect(opts.pageSize).toBe(400);
			expect(opts.dryRun).toBe(false);
			expect(opts.outputDir).toContain('firestore-export-');
		});

		it('parses custom export CLI arguments', () => {
			const opts = parseExportArgs([
				'--collections=alerts,tradingSignalOutcomes',
				'--output-dir=/tmp/custom-backup',
				'--page-size=250',
				'--dry-run',
				'--project=my-custom-project',
			]);

			expect(opts.collections).toEqual(['alerts', 'tradingSignalOutcomes']);
			expect(opts.outputDir).toBe('/tmp/custom-backup');
			expect(opts.pageSize).toBe(250);
			expect(opts.dryRun).toBe(true);
			expect(opts.projectId).toBe('my-custom-project');
		});

		it('parses restore CLI arguments', () => {
			const opts = parseRestoreArgs([
				'--input-dir=/tmp/test-export',
				'--collections=alerts',
				'--batch-size=300',
				'--dry-run',
				'--no-overwrite',
				'--ttl-policy=preserve',
				'--retention-days=180',
				'--project=custom-proj',
			]);

			expect(opts.inputDir).toBe('/tmp/test-export');
			expect(opts.collections).toEqual(['alerts']);
			expect(opts.batchSize).toBe(300);
			expect(opts.dryRun).toBe(true);
			expect(opts.overwrite).toBe(false);
			expect(opts.ttlPolicy).toBe('preserve');
			expect(opts.retentionDays).toBe(180);
			expect(opts.projectId).toBe('custom-proj');
		});

		it('defaults restore retentionDays from ALERT_STORAGE_RETENTION_DAYS environment variable', () => {
			const origEnv = process.env.ALERT_STORAGE_RETENTION_DAYS;
			try {
				process.env.ALERT_STORAGE_RETENTION_DAYS = '60';
				const opts = parseRestoreArgs(['--input-dir=/tmp/test-export']);
				expect(opts.retentionDays).toBe(60);
			} finally {
				if (origEnv !== undefined) {
					process.env.ALERT_STORAGE_RETENTION_DAYS = origEnv;
				} else {
					delete process.env.ALERT_STORAGE_RETENTION_DAYS;
				}
			}
		});

		it('throws when restore receives invalid --ttl-policy', () => {
			expect(() => parseRestoreArgs([
				'--input-dir=/tmp/test-export',
				'--ttl-policy=preserv',
			])).toThrow('Invalid --ttl-policy');
		});

		it('throws when restore receives an unsupported argument', () => {
			expect(() => parseRestoreArgs([
				'--input-dir=/tmp/test-export',
				'--no-overwite',
			])).toThrow('Unsupported restore argument');
		});

		it('throws when restore receives invalid --retention-days', () => {
			expect(() => parseRestoreArgs([
				'--input-dir=/tmp/test-export',
				'--retention-days=invalid',
			])).toThrow('Invalid --retention-days');

			expect(() => parseRestoreArgs([
				'--input-dir=/tmp/test-export',
				'--retention-days=-5',
			])).toThrow('Invalid --retention-days');
		});

		it('throws when restore is missing --input-dir', () => {
			expect(() => parseRestoreArgs([])).toThrow('Missing required argument: --input-dir');
		});
	});

	describe('Exporting Collections', () => {
		it('exports collection pages to JSONL file', async () => {
			const docs = [
				{ id: 'doc-1', data: () => ({ name: 'Doc 1' }) },
				{ id: 'doc-2', data: () => ({ name: 'Doc 2' }) },
			];

			const query = {
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				startAfter: jest.fn().mockReturnThis(),
				get: jest.fn()
					.mockResolvedValueOnce({ empty: false, docs })
					.mockResolvedValueOnce({ empty: true, docs: [] }),
			};

			const mockFirestore = {
				collection: jest.fn().mockReturnValue(query),
			};

			const targetFile = path.join(tempDir, 'test-col.jsonl');
			const result = await exportCollection(mockFirestore, 'testCol', {
				pageSize: 2,
				outputFilePath: targetFile,
			});

			expect(result.collection).toBe('testCol');
			expect(result.documentCount).toBe(2);
			expect(fs.existsSync(targetFile)).toBe(true);

			const content = fs.readFileSync(targetFile, 'utf8').trim().split('\n');
			expect(content.length).toBe(2);
			expect(JSON.parse(content[0])).toEqual({ __id: 'doc-1', data: { name: 'Doc 1' } });
			expect(JSON.parse(content[1])).toEqual({ __id: 'doc-2', data: { name: 'Doc 2' } });
		});

		it('dry-run counts documents without writing files', async () => {
			const docs = [{ id: 'doc-1', data: () => ({ name: 'Doc 1' }) }];
			const query = {
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				get: jest.fn()
					.mockResolvedValueOnce({ empty: false, docs })
					.mockResolvedValueOnce({ empty: true, docs: [] }),
			};
			const mockFirestore = { collection: jest.fn().mockReturnValue(query) };

			const targetFile = path.join(tempDir, 'dry-run.jsonl');
			const result = await exportCollection(mockFirestore, 'testCol', {
				dryRun: true,
				outputFilePath: targetFile,
			});

			expect(result.documentCount).toBe(1);
			expect(fs.existsSync(targetFile)).toBe(false);
		});

		it('runExport creates manifest.json and exports specified collections', async () => {
			const query = {
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				get: jest.fn().mockResolvedValue({
					empty: false,
					docs: [{ id: 'doc-1', data: () => ({ index: 1 }) }],
				}),
			};

			const mockFirestore = {
				collection: jest.fn().mockReturnValue(query),
			};

			const results = await runExport({
				firestore: mockFirestore,
				collections: ['alerts', 'tradingSignalOutcomes'],
				outputDir: tempDir,
				pageSize: 10,
			});

			expect(results.totalDocuments).toBe(2);
			expect(results.collections.alerts.documentCount).toBe(1);
			expect(results.collections.tradingSignalOutcomes.documentCount).toBe(1);

			const manifestPath = path.join(tempDir, 'manifest.json');
			expect(fs.existsSync(manifestPath)).toBe(true);
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
			expect(manifest.totalDocuments).toBe(2);
			expect(manifest.collections.alerts).toBeDefined();
		});
	});

	describe('Restoring Collections', () => {
		it('reads JSONL file and restores batches to Firestore', async () => {
			const jsonlFile = path.join(tempDir, 'alerts.jsonl');
			const lines = [
				JSON.stringify({ _id: 'a1', text: 'Alert 1' }),
				JSON.stringify({ _id: 'a2', text: 'Alert 2' }),
				JSON.stringify({ _id: 'a3', text: 'Alert 3' }),
			];
			fs.writeFileSync(jsonlFile, lines.join('\n') + '\n', 'utf8');

			const mockBatch = {
				set: jest.fn(),
				commit: jest.fn().mockResolvedValue(undefined),
			};
			const mockCollection = {
				doc: jest.fn((id) => ({ id })),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue(mockCollection),
				batch: jest.fn().mockReturnValue(mockBatch),
			};

			const result = await restoreCollectionFile(mockFirestore, 'alerts', jsonlFile, {
				batchSize: 2,
				overwrite: true,
			});

			expect(result.totalRead).toBe(3);
			expect(result.totalRestored).toBe(3);
			expect(mockCollection.doc).toHaveBeenCalledWith('a1');
			expect(mockCollection.doc).toHaveBeenCalledWith('a2');
			expect(mockCollection.doc).toHaveBeenCalledWith('a3');
			expect(mockBatch.set).toHaveBeenCalledTimes(3);
			// Committed at batchSize 2 + remaining 1 = 2 commits
			expect(mockBatch.commit).toHaveBeenCalledTimes(2);
		});

		it('supports dry-run mode for restoration without calling Firestore', async () => {
			const jsonlFile = path.join(tempDir, 'alerts.jsonl');
			fs.writeFileSync(jsonlFile, JSON.stringify({ _id: 'a1', text: 'Alert' }) + '\n', 'utf8');

			const result = await restoreCollectionFile(null, 'alerts', jsonlFile, {
				dryRun: true,
			});

			expect(result.totalRead).toBe(1);
			expect(result.totalRestored).toBe(1);
		});

		it('applies --ttl-policy=refresh to recompute expiresAt for restored alerts', async () => {
			const jsonlFile = path.join(tempDir, 'alerts.jsonl');
			const expiredTs = {
				__type: 'Timestamp',
				seconds: 100000,
				nanoseconds: 0,
			};
			fs.writeFileSync(jsonlFile, JSON.stringify({ _id: 'old-alert', text: 'Old', expiresAt: expiredTs }) + '\n', 'utf8');

			const mockBatch = {
				set: jest.fn(),
				commit: jest.fn().mockResolvedValue(undefined),
			};
			const mockCollection = {
				doc: jest.fn((id) => ({ id })),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue(mockCollection),
				batch: jest.fn().mockReturnValue(mockBatch),
			};

			const result = await restoreCollectionFile(mockFirestore, 'alerts', jsonlFile, {
				ttlPolicy: 'refresh',
				retentionDays: 90,
			});

			expect(result.totalRestored).toBe(1);
			expect(mockBatch.set).toHaveBeenCalledTimes(1);
			const writtenData = mockBatch.set.mock.calls[0][1];
			expect(writtenData.expiresAt).toBeDefined();
			// Should be future timestamp
			const expiresAtMillis = typeof writtenData.expiresAt.toMillis === 'function'
				? writtenData.expiresAt.toMillis()
				: writtenData.expiresAt.seconds * 1000;
			expect(expiresAtMillis).toBeGreaterThan(Date.now());
		});

		it('applies --ttl-policy=clear to remove expiresAt completely', async () => {
			const jsonlFile = path.join(tempDir, 'alerts.jsonl');
			fs.writeFileSync(jsonlFile, JSON.stringify({ _id: 'old-alert', text: 'Old', expiresAt: { __type: 'Timestamp', seconds: 100 } }) + '\n', 'utf8');

			const mockBatch = {
				set: jest.fn(),
				commit: jest.fn().mockResolvedValue(undefined),
			};
			const mockCollection = {
				doc: jest.fn((id) => ({ id })),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue(mockCollection),
				batch: jest.fn().mockReturnValue(mockBatch),
			};

			await restoreCollectionFile(mockFirestore, 'alerts', jsonlFile, {
				ttlPolicy: 'clear',
			});

			expect(mockBatch.set).toHaveBeenCalledTimes(1);
			const writtenData = mockBatch.set.mock.calls[0][1];
			expect(writtenData.expiresAt).toBeUndefined();
		});

		it('skips existing documents atomically when --no-overwrite is set', async () => {
			const jsonlFile = path.join(tempDir, 'alerts.jsonl');
			const lines = [
				JSON.stringify({ _id: 'doc-exists', text: 'Old Value' }),
				JSON.stringify({ _id: 'doc-new', text: 'New Value' }),
			];
			fs.writeFileSync(jsonlFile, lines.join('\n') + '\n', 'utf8');

			const mockCreate = jest.fn((data) => Promise.resolve(data));
			const mockFirestore = {
				collection: jest.fn().mockReturnValue({
					doc: jest.fn((id) => ({
						id,
						create: id === 'doc-exists'
							? jest.fn().mockRejectedValue(Object.assign(new Error('Document already exists'), { code: 6 }))
							: mockCreate,
					})),
				}),
			};

			const result = await restoreCollectionFile(mockFirestore, 'alerts', jsonlFile, {
				overwrite: false,
			});

			expect(result.totalRead).toBe(2);
			expect(result.totalRestored).toBe(1);
			expect(mockCreate).toHaveBeenCalledTimes(1);
		});

		it('runRestore forwards ttlPolicy and retentionDays to restoreCollectionFile', async () => {
			const jsonlFile = path.join(tempDir, 'alerts.jsonl');
			fs.writeFileSync(jsonlFile, JSON.stringify({ _id: 'a1', text: 'Alert 1' }) + '\n');
			fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({
				totalDocuments: 1,
				collections: { alerts: { documentCount: 1 } },
			}) + '\n');

			const mockBatch = {
				set: jest.fn(),
				commit: jest.fn().mockResolvedValue(undefined),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue({ doc: (id) => ({ id }) }),
				batch: jest.fn().mockReturnValue(mockBatch),
			};

			const result = await runRestore({
				firestore: mockFirestore,
				inputDir: tempDir,
				ttlPolicy: 'refresh',
				retentionDays: 30,
			});

			expect(result.totalDocuments).toBe(1);
			expect(mockBatch.set).toHaveBeenCalledTimes(1);
			const saved = mockBatch.set.mock.calls[0][1];
			expect(saved.expiresAt).toBeDefined();
		});

		it('runRestore throws when an explicitly requested collection file is missing', async () => {
			const mockFirestore = {
				collection: jest.fn(),
			};

			await expect(runRestore({
				firestore: mockFirestore,
				inputDir: tempDir,
				collections: ['nonExistentCollection'],
			})).rejects.toThrow('Requested collection backup file not found');
		});

		it('runRestore discovers .jsonl files in input directory and restores all', async () => {
			fs.writeFileSync(path.join(tempDir, 'alerts.jsonl'), JSON.stringify({ _id: 'a1' }) + '\n');
			fs.writeFileSync(path.join(tempDir, 'tradingSignalOutcomes.jsonl'), JSON.stringify({ _id: 's1' }) + '\n');
			fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({
				totalDocuments: 2,
				collections: {
					alerts: { documentCount: 1 },
					tradingSignalOutcomes: { documentCount: 1 },
				},
			}) + '\n');

			const mockBatch = {
				set: jest.fn(),
				commit: jest.fn().mockResolvedValue(undefined),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue({ doc: (id) => ({ id }) }),
				batch: jest.fn().mockReturnValue(mockBatch),
			};

			const result = await runRestore({
				firestore: mockFirestore,
				inputDir: tempDir,
			});

			expect(result.totalDocuments).toBe(2);
			expect(result.collections.alerts.totalRestored).toBe(1);
			expect(result.collections.tradingSignalOutcomes.totalRestored).toBe(1);
		});

		it('rejects auto-discovered restores without a completed manifest before writes', async () => {
			fs.writeFileSync(path.join(tempDir, 'alerts.jsonl'), JSON.stringify({ _id: 'a1' }) + '\n');
			const mockFirestore = {
				batch: jest.fn(),
				collection: jest.fn(),
			};

			await expect(runRestore({
				firestore: mockFirestore,
				inputDir: tempDir,
			})).rejects.toThrow('manifest.json');
			expect(mockFirestore.batch).not.toHaveBeenCalled();
		});

		it('rejects auto-discovered restores when manifest counts do not match files', async () => {
			fs.writeFileSync(path.join(tempDir, 'alerts.jsonl'), JSON.stringify({ _id: 'a1' }) + '\n');
			fs.writeFileSync(path.join(tempDir, 'manifest.json'), JSON.stringify({
				totalDocuments: 2,
				collections: { alerts: { documentCount: 2 } },
			}) + '\n');
			const mockFirestore = {
				batch: jest.fn(),
				collection: jest.fn(),
			};

			await expect(runRestore({
				firestore: mockFirestore,
				inputDir: tempDir,
			})).rejects.toThrow('document count');
			expect(mockFirestore.batch).not.toHaveBeenCalled();
		});

		it('refreshes TTLs for managed-import collections after import', async () => {
			const docs = [
				{
					id: 'alert-1',
					ref: { id: 'alert-1' },
					data: () => ({ text: 'Alert', expiresAt: { seconds: 1 } }),
				},
			];
			const query = {
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				startAfter: jest.fn().mockReturnThis(),
				get: jest.fn()
					.mockResolvedValueOnce({ empty: false, docs })
					.mockResolvedValueOnce({ empty: true, docs: [] }),
			};
			const batch = {
				update: jest.fn(),
				commit: jest.fn().mockResolvedValue(undefined),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue(query),
				batch: jest.fn().mockReturnValue(batch),
			};

			const result = await refreshCollectionTtls(mockFirestore, ['alerts'], { retentionDays: 30 });

			expect(result.totalUpdated).toBe(1);
			expect(batch.update).toHaveBeenCalledWith(docs[0].ref, { expiresAt: expect.anything() });
			expect(batch.commit).toHaveBeenCalledTimes(1);
		});
	});

	describe('Managed Shell Scripts Validation', () => {
		it('export-firestore-managed.sh requires project and bucket', () => {
			const scriptPath = path.join(__dirname, '../../ops/export-firestore-managed.sh');
			const content = fs.readFileSync(scriptPath, 'utf8');

			expect(content).toContain('FIREBASE_PROJECT_ID');
			expect(content).toContain('GCS_BACKUP_BUCKET');
			expect(content).toContain('gcloud firestore export');
			expect(content).toContain('tradingSignalOutcomes');
		});

		it('restore-firestore-managed.sh requires export URI and defaults to tradingSignalOutcomes', () => {
			const scriptPath = path.join(__dirname, '../../ops/restore-firestore-managed.sh');
			const content = fs.readFileSync(scriptPath, 'utf8');

			expect(content).toContain('FIRESTORE_EXPORT_URI');
			expect(content).toContain('gcloud firestore import');
			expect(content).toContain('tradingSignalOutcomes');
			expect(content).not.toContain('signalOutcomes,');
		});
	});
});
