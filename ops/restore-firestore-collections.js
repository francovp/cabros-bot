'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const admin = require('firebase-admin');

const DEFAULT_COLLECTIONS = ['alerts', 'alertReplays', 'tradingSignalOutcomes', 'scannerPresets'];
const BATCH_SIZE = 400;
const DEFAULT_RETENTION_DAYS = 90;
const MAX_RETENTION_DAYS = 3650;
const VALID_TTL_POLICIES = ['refresh', 'clear', 'preserve'];

function getDefaultRetentionDays() {
	const rawValue = process.env.ALERT_STORAGE_RETENTION_DAYS;
	if (rawValue === undefined) {
		return DEFAULT_RETENTION_DAYS;
	}
	const normalized = rawValue.trim();
	const parsed = Number(normalized);
	if (/^\d+$/.test(normalized) && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_RETENTION_DAYS) {
		return parsed;
	}
	return DEFAULT_RETENTION_DAYS;
}

function parseArgs(args = process.argv.slice(2)) {
	const defaultRetention = getDefaultRetentionDays();
	const options = {
		inputDir: null,
		collections: null,
		batchSize: BATCH_SIZE,
		dryRun: false,
		overwrite: true,
		ttlPolicy: 'refresh',
		retentionDays: defaultRetention,
		projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
	};

	for (const arg of args) {
		if (arg.startsWith('--input-dir=')) {
			options.inputDir = arg.split('=')[1].trim();
		} else if (arg.startsWith('--collections=')) {
			const raw = arg.split('=')[1];
			options.collections = raw.split(',').map((s) => s.trim()).filter(Boolean);
		} else if (arg.startsWith('--batch-size=')) {
			const size = Number(arg.split('=')[1]);
			if (Number.isSafeInteger(size) && size > 0) {
				options.batchSize = Math.min(size, 500);
			}
		} else if (arg === '--dry-run') {
			options.dryRun = true;
		} else if (arg === '--no-overwrite') {
			options.overwrite = false;
		} else if (arg.startsWith('--ttl-policy=')) {
			const policy = arg.split('=')[1].trim();
			if (VALID_TTL_POLICIES.includes(policy)) {
				options.ttlPolicy = policy;
			} else {
				throw new Error(`Invalid --ttl-policy: "${policy}". Supported values: ${VALID_TTL_POLICIES.join(', ')}`);
			}
		} else if (arg.startsWith('--retention-days=')) {
			const rawDays = arg.split('=')[1].trim();
			const days = Number(rawDays);
			if (/^\d+$/.test(rawDays) && Number.isSafeInteger(days) && days >= 1 && days <= MAX_RETENTION_DAYS) {
				options.retentionDays = days;
			} else {
				throw new Error(`Invalid --retention-days: "${rawDays}". Must be an integer between 1 and ${MAX_RETENTION_DAYS}.`);
			}
		} else if (arg.startsWith('--project=')) {
			options.projectId = arg.split('=')[1].trim();
		} else {
			throw new Error(`Unsupported restore argument: "${arg}"`);
		}
	}

	if (!options.inputDir) {
		throw new Error('Missing required argument: --input-dir=<path_to_export_directory>');
	}

	return options;
}

function applyTtlPolicy(data, collectionName, ttlPolicy = 'refresh', retentionDays = 90) {
	if (!data || typeof data !== 'object') {
		return data;
	}

	if (ttlPolicy === 'clear') {
		if ('expiresAt' in data) {
			delete data.expiresAt;
		}
		return data;
	}

	if (ttlPolicy === 'refresh') {
		if (data.expiresAt !== undefined || collectionName === 'alerts' || collectionName === 'alertReplays') {
			const safeDays = (typeof retentionDays === 'number' && retentionDays >= 1) ? retentionDays : getDefaultRetentionDays();
			const refreshDate = new Date(Date.now() + (safeDays * 86400000));
			let ts;
			if (typeof admin.firestore.Timestamp?.fromDate === 'function') {
				ts = admin.firestore.Timestamp.fromDate(refreshDate);
			} else {
				ts = {
					toDate: () => refreshDate,
					toMillis: () => refreshDate.getTime(),
					seconds: Math.floor(refreshDate.getTime() / 1000),
					nanoseconds: (refreshDate.getTime() % 1000) * 1000000,
				};
			}
			if (ts && typeof ts.toDate === 'function') {
				if (typeof ts.toMillis !== 'function') {
					ts.toMillis = () => ts.toDate().getTime();
				}
				if (typeof ts.seconds !== 'number') {
					ts.seconds = Math.floor(ts.toDate().getTime() / 1000);
				}
				if (typeof ts.nanoseconds !== 'number') {
					ts.nanoseconds = (ts.toDate().getTime() % 1000) * 1000000;
				}
			}
			data.expiresAt = ts;
		}
		return data;
	}

	// 'preserve' keeps data.expiresAt unchanged
	return data;
}

function deserializeValue(val, firestore) {
	if (val === null || val === undefined) {
		return val;
	}

	if (typeof val === 'object') {
		if (val.__type === 'Bytes' && typeof val.base64 === 'string') {
			return Buffer.from(val.base64, 'base64');
		}

		if (val.__type === 'Timestamp') {
			let result;
			if (typeof admin.firestore.Timestamp === 'function' && typeof val.seconds === 'number') {
				try {
					result = new admin.firestore.Timestamp(val.seconds, val.nanoseconds || 0);
				} catch {
					// Fallback below
				}
			}
			if (!result && typeof admin.firestore.Timestamp?.fromMillis === 'function' && typeof val.seconds === 'number') {
				const millis = (val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000);
				result = admin.firestore.Timestamp.fromMillis(millis);
			}
			if (!result && typeof admin.firestore.Timestamp?.fromDate === 'function') {
				const date = val.iso ? new Date(val.iso) : new Date((val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000));
				result = admin.firestore.Timestamp.fromDate(date);
			}
			if (!result) {
				const millis = val.iso ? new Date(val.iso).getTime() : ((val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000));
				result = {
					toDate: () => new Date(millis),
					toMillis: () => millis,
				};
			}

			const date = typeof result.toDate === 'function' ? result.toDate() : new Date((val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000));
			if (typeof result.seconds !== 'number') {
				result.seconds = val.seconds ?? Math.floor(date.getTime() / 1000);
			}
			if (typeof result.nanoseconds !== 'number') {
				result.nanoseconds = val.nanoseconds ?? ((date.getTime() % 1000) * 1000000);
			}
			if (typeof result.toMillis !== 'function') {
				result.toMillis = () => (result.seconds * 1000) + Math.floor(result.nanoseconds / 1000000);
			}
			if (typeof result.toDate !== 'function') {
				result.toDate = () => new Date(result.toMillis());
			}

			return result;
		}

		if (val.__type === 'GeoPoint') {
			if (typeof admin.firestore.GeoPoint === 'function') {
				try {
					return new admin.firestore.GeoPoint(val.latitude, val.longitude);
				} catch {
					// Fallback
				}
			}
			return {
				latitude: val.latitude,
				longitude: val.longitude,
			};
		}

		if (val.__type === 'DocumentReference') {
			if (firestore && typeof firestore.doc === 'function') {
				return firestore.doc(val.path);
			}
			return { path: val.path };
		}

		if (Array.isArray(val)) {
			return val.map((item) => deserializeValue(item, firestore));
		}

		const deserialized = {};
		for (const [key, value] of Object.entries(val)) {
			deserialized[key] = deserializeValue(value, firestore);
		}
		return deserialized;
	}

	return val;
}

function deserializeDocument(record, firestore) {
	if (!record || typeof record !== 'object') {
		return { id: null, data: {} };
	}

	// Envelope format: { __id: 'docId', data: { ... } }
	if ('__id' in record && 'data' in record && record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
		return {
			id: record.__id,
			data: deserializeValue(record.data, firestore),
		};
	}

	// Envelope format with _id: { _id: 'docId', data: { ... } } (when keys are strictly _id and data)
	if ('_id' in record && 'data' in record && Object.keys(record).length === 2 && record.data && typeof record.data === 'object' && !Array.isArray(record.data)) {
		return {
			id: record._id,
			data: deserializeValue(record.data, firestore),
		};
	}

	// Legacy flattened format: { _id, ...fields }
	const id = record._id || record.id || null;
	const data = {};

	for (const [key, value] of Object.entries(record)) {
		if (key === '_id' || (key === 'id' && !record._id)) continue;
		data[key] = deserializeValue(value, firestore);
	}

	return { id, data };
}

async function writeBatchChunk(firestore, collectionName, chunk, options = {}) {
	const { isDryRun, overwrite, ttlPolicy, retentionDays } = options;
	if (!chunk || chunk.length === 0) return 0;

	if (isDryRun || !firestore) {
		return chunk.length;
	}

	if (!overwrite) {
		// Atomic create per document: ensures concurrency-safe, non-destructive restore
		let writeCount = 0;
		const results = await Promise.allSettled(chunk.map(async (item) => {
			const finalData = applyTtlPolicy(item.data, collectionName, ttlPolicy, retentionDays);
			const docRef = firestore.collection(collectionName).doc(item.id);
			if (typeof docRef.create === 'function') {
				return await docRef.create(finalData);
			}
			if (typeof docRef.get === 'function') {
				const snap = await docRef.get();
				if (snap && snap.exists) {
					const existsErr = new Error(`Document ${item.id} already exists`);
					existsErr.code = 6;
					throw existsErr;
				}
			}
			return await docRef.set(finalData);
		}));

		for (const res of results) {
			if (res.status === 'fulfilled') {
				writeCount += 1;
			} else {
				const err = res.reason;
				const isAlreadyExists = err?.code === 6 || err?.code === 'ALREADY_EXISTS' || err?.message?.includes('already exists') || err?.message?.includes('ALREADY_EXISTS');
				if (isAlreadyExists) {
					// Document already exists, skipped atomically
					continue;
				}
				throw err;
			}
		}

		return writeCount;
	}

	const batch = firestore.batch();
	let writeCount = 0;

	for (const item of chunk) {
		const finalData = applyTtlPolicy(item.data, collectionName, ttlPolicy, retentionDays);
		const docRef = firestore.collection(collectionName).doc(item.id);
		batch.set(docRef, finalData);
		writeCount += 1;
	}

	if (writeCount > 0) {
		await batch.commit();
	}

	return writeCount;
}

async function restoreCollectionFile(firestore, collectionName, filePath, options = {}) {
	const batchSize = options.batchSize || BATCH_SIZE;
	const isDryRun = Boolean(options.dryRun);
	const overwrite = options.overwrite !== false;
	const ttlPolicy = options.ttlPolicy || 'refresh';
	const retentionDays = options.retentionDays || getDefaultRetentionDays();

	if (!VALID_TTL_POLICIES.includes(ttlPolicy)) {
		throw new Error(`Invalid ttlPolicy: "${ttlPolicy}". Supported values: ${VALID_TTL_POLICIES.join(', ')}`);
	}

	if (!fs.existsSync(filePath)) {
		throw new Error(`Collection file not found: ${filePath}`);
	}

	const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
	const rl = readline.createInterface({
		input: fileStream,
		crlfDelay: Infinity,
	});

	let totalRead = 0;
	let totalRestored = 0;
	let currentChunk = [];

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) {
			continue;
		}

		totalRead += 1;
		const parsed = JSON.parse(trimmed);
		const { id, data } = deserializeDocument(parsed, firestore);

		if (!id) {
			continue;
		}

		currentChunk.push({ id, data });

		if (currentChunk.length >= batchSize) {
			const count = await writeBatchChunk(firestore, collectionName, currentChunk, {
				isDryRun,
				overwrite,
				ttlPolicy,
				retentionDays,
			});
			totalRestored += count;
			currentChunk = [];
		}
	}

	if (currentChunk.length > 0) {
		const count = await writeBatchChunk(firestore, collectionName, currentChunk, {
			isDryRun,
			overwrite,
			ttlPolicy,
			retentionDays,
		});
		totalRestored += count;
	}

	return {
		collection: collectionName,
		totalRead,
		totalRestored,
		file: filePath,
	};
}

async function validateManifest(inputDir) {
	const manifestPath = path.join(inputDir, 'manifest.json');
	if (!fs.existsSync(manifestPath)) {
		throw new Error(`Completed manifest.json is required for auto-discovered restores: ${manifestPath}`);
	}

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch (err) {
		throw new Error(`Invalid manifest.json: ${err.message}`);
	}

	if (!manifest.collections || typeof manifest.collections !== 'object' || Array.isArray(manifest.collections)) {
		throw new Error('Invalid manifest.json: collections must be an object');
	}

	const entries = Object.entries(manifest.collections);
	if (entries.length === 0) {
		throw new Error('Invalid manifest.json: collections must not be empty');
	}

	let expectedTotal = 0;
	for (const [collectionName, metadata] of entries) {
		const expectedCount = metadata?.documentCount;
		if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) {
			throw new Error(`Invalid manifest document count for ${collectionName}`);
		}

		const filePath = path.join(inputDir, `${collectionName}.jsonl`);
		if (!fs.existsSync(filePath)) {
			throw new Error(`Manifest collection file not found: ${filePath}`);
		}

		let actualCount = 0;
		const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
		const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
		try {
			for await (const line of rl) {
				const trimmed = line.trim();
				if (!trimmed) continue;
				try {
					JSON.parse(trimmed);
				} catch (err) {
					throw new Error(`Invalid JSON in ${filePath}: ${err.message}`);
				}
				actualCount += 1;
			}
		} finally {
			rl.close();
		}

		if (actualCount !== expectedCount) {
			throw new Error(`Manifest document count mismatch for ${collectionName}: expected ${expectedCount}, found ${actualCount}`);
		}
		expectedTotal += expectedCount;
	}

	if (!Number.isSafeInteger(manifest.totalDocuments) || manifest.totalDocuments !== expectedTotal) {
		throw new Error(`Manifest document count mismatch: expected total ${manifest.totalDocuments}, found ${expectedTotal}`);
	}

	return entries.map(([collectionName]) => collectionName);
}

async function refreshCollectionTtls(firestore, collectionNames, options = {}) {
	const pageSize = options.pageSize || BATCH_SIZE;
	const retentionDays = options.retentionDays || getDefaultRetentionDays();
	const results = { totalUpdated: 0, collections: {} };

	for (const collectionName of collectionNames) {
		let lastDocument = null;
		let updated = 0;
		while (true) {
			let query = firestore.collection(collectionName).orderBy('__name__').limit(pageSize);
			if (lastDocument) query = query.startAfter(lastDocument);
			const snapshot = await query.get();
			if (snapshot.empty) break;

			const batch = firestore.batch();
			let pending = 0;
			for (const doc of snapshot.docs) {
				const data = typeof doc.data === 'function' ? (doc.data() || {}) : {};
				if (data.expiresAt === undefined && collectionName !== 'alerts' && collectionName !== 'alertReplays') {
					continue;
				}
				const expiresAt = applyTtlPolicy({}, collectionName, 'refresh', retentionDays).expiresAt;
				const docRef = doc.ref || firestore.collection(collectionName).doc(doc.id);
				batch.update(docRef, { expiresAt });
				pending += 1;
			}

			if (pending > 0) {
				await batch.commit();
				updated += pending;
			}

			if (snapshot.docs.length < pageSize) break;
			lastDocument = snapshot.docs.at(-1);
		}

		results.collections[collectionName] = updated;
		results.totalUpdated += updated;
	}

	return results;
}

function initializeFirestore(projectId = null) {
	let credential;
	if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
		try {
			credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
		} catch (err) {
			console.warn(JSON.stringify({
				event: 'firestore_restore_invalid_service_account_json',
				error: err.message,
			}));
		}
	}

	const resolvedProject = projectId || process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
	const appOptions = {};
	if (credential) {
		appOptions.credential = credential;
	}
	if (resolvedProject) {
		appOptions.projectId = resolvedProject;
	}

	if (!admin.apps.length) {
		admin.initializeApp(appOptions);
	}

	return admin.firestore();
}

async function runRestore(options = {}) {
	if (!options.inputDir) {
		throw new Error('inputDir is required');
	}

	const inputDir = path.resolve(options.inputDir);
	if (!fs.existsSync(inputDir)) {
		throw new Error(`Input directory does not exist: ${inputDir}`);
	}

	const ttlPolicy = options.ttlPolicy || 'refresh';
	const retentionDays = options.retentionDays || getDefaultRetentionDays();

	if (!VALID_TTL_POLICIES.includes(ttlPolicy)) {
		throw new Error(`Invalid ttlPolicy: "${ttlPolicy}". Supported values: ${VALID_TTL_POLICIES.join(', ')}`);
	}

	const isDryRun = Boolean(options.dryRun);
	const firestore = isDryRun && !options.firestore ? null : (options.firestore || initializeFirestore(options.projectId));
	const hasExplicitCollections = Array.isArray(options.collections) && options.collections.length > 0;

	let targetCollections = options.collections;
	if (!hasExplicitCollections) {
		targetCollections = await validateManifest(inputDir);
	}

	const results = {
		restoredAt: new Date().toISOString(),
		inputDir,
		dryRun: isDryRun,
		collections: {},
		totalDocuments: 0,
	};

	for (const colName of targetCollections) {
		const filePath = path.join(inputDir, `${colName}.jsonl`);
		if (!fs.existsSync(filePath)) {
			if (hasExplicitCollections) {
				throw new Error(`Requested collection backup file not found: ${filePath}`);
			}
			console.warn(JSON.stringify({
				event: 'firestore_restore_collection_file_missing',
				collection: colName,
				filePath,
			}));
			continue;
		}

		const colResult = await restoreCollectionFile(firestore, colName, filePath, {
			batchSize: options.batchSize || BATCH_SIZE,
			dryRun: isDryRun,
			overwrite: options.overwrite !== false,
			ttlPolicy,
			retentionDays,
		});

		results.collections[colName] = colResult;
		results.totalDocuments += colResult.totalRestored;
	}

	return results;
}

async function main() {
	const options = parseArgs();
	console.log(JSON.stringify({
		event: 'firestore_restore_started',
		inputDir: options.inputDir,
		collections: options.collections,
		dryRun: options.dryRun,
		overwrite: options.overwrite,
		projectId: options.projectId || 'default',
	}));

	const results = await runRestore(options);

	console.log(JSON.stringify({
		event: 'firestore_restore_completed',
		totalDocuments: results.totalDocuments,
		collections: Object.keys(results.collections).map((k) => ({
			name: k,
			count: results.collections[k].totalRestored,
		})),
		inputDir: results.inputDir,
		dryRun: results.dryRun,
	}));
}

if (require.main === module) {
	main().catch((err) => {
		console.error(JSON.stringify({
			event: 'firestore_restore_failed',
			error: err.message,
			stack: err.stack,
		}));
		process.exitCode = 1;
	});
}

module.exports = {
	deserializeDocument,
	deserializeValue,
	initializeFirestore,
	parseArgs,
	refreshCollectionTtls,
	restoreCollectionFile,
	runRestore,
};
