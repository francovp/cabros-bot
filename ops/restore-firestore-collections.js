'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const admin = require('firebase-admin');

const BATCH_SIZE = 400;

function parseArgs(args = process.argv.slice(2)) {
	const options = {
		inputDir: null,
		collections: null,
		batchSize: BATCH_SIZE,
		dryRun: false,
		overwrite: true,
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
		} else if (arg.startsWith('--project=')) {
			options.projectId = arg.split('=')[1].trim();
		}
	}

	if (!options.inputDir) {
		throw new Error('Missing required argument: --input-dir=<path_to_export_directory>');
	}

	return options;
}

function deserializeValue(val, firestore) {
	if (val === null || val === undefined) {
		return val;
	}

	if (typeof val === 'object') {
		if (val.__type === 'Timestamp') {
			if (typeof admin.firestore.Timestamp?.fromMillis === 'function' && typeof val.seconds === 'number') {
				const millis = (val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000);
				return admin.firestore.Timestamp.fromMillis(millis);
			}
			if (typeof admin.firestore.Timestamp?.fromDate === 'function') {
				const date = val.iso ? new Date(val.iso) : new Date((val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000));
				return admin.firestore.Timestamp.fromDate(date);
			}
			if (typeof admin.firestore.Timestamp === 'function') {
				try {
					return new admin.firestore.Timestamp(val.seconds || 0, val.nanoseconds || 0);
				} catch {
					// Fallback below
				}
			}
			const millis = val.iso ? new Date(val.iso).getTime() : ((val.seconds * 1000) + Math.floor((val.nanoseconds || 0) / 1000000));
			return {
				toDate: () => new Date(millis),
				toMillis: () => millis,
			};
		}

		if (val.__type === 'GeoPoint') {
			if (typeof admin.firestore.GeoPoint === 'function') {
				try {
					return new admin.firestore.GeoPoint(val.latitude, val.longitude);
				} catch {
					// Fallback below
				}
			}
			return {
				latitude: val.latitude,
				longitude: val.longitude,
			};
		}

		if (val.__type === 'DocumentReference' && typeof val.path === 'string' && firestore) {
			return firestore.doc(val.path);
		}

		if (Array.isArray(val)) {
			return val.map((item) => deserializeValue(item, firestore));
		}

		const result = {};
		for (const [key, value] of Object.entries(val)) {
			result[key] = deserializeValue(value, firestore);
		}
		return result;
	}

	return val;
}

function deserializeDocument(record, firestore) {
	const { _id, ...rest } = record;
	const deserialized = deserializeValue(rest, firestore);
	return {
		id: _id,
		data: deserialized,
	};
}

async function restoreCollectionFile(firestore, collectionName, filePath, options = {}) {
	const batchSize = options.batchSize || BATCH_SIZE;
	const isDryRun = Boolean(options.dryRun);
	const overwrite = options.overwrite !== false;

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
	let currentBatch = firestore ? firestore.batch() : null;
	let batchCount = 0;

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

		if (!isDryRun && firestore && currentBatch) {
			const docRef = firestore.collection(collectionName).doc(id);
			if (overwrite) {
				currentBatch.set(docRef, data);
			} else {
				currentBatch.set(docRef, data, { merge: true });
			}
			batchCount += 1;

			if (batchCount >= batchSize) {
				await currentBatch.commit();
				totalRestored += batchCount;
				currentBatch = firestore.batch();
				batchCount = 0;
			}
		} else {
			totalRestored += 1;
		}
	}

	if (!isDryRun && firestore && currentBatch && batchCount > 0) {
		await currentBatch.commit();
		totalRestored += batchCount;
	}

	return {
		collection: collectionName,
		totalRead,
		totalRestored,
		file: filePath,
	};
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

	const isDryRun = Boolean(options.dryRun);
	const firestore = isDryRun && !options.firestore ? null : (options.firestore || initializeFirestore(options.projectId));

	let targetCollections = options.collections;
	if (!targetCollections || targetCollections.length === 0) {
		// Discover from files in inputDir
		const files = fs.readdirSync(inputDir);
		targetCollections = files
			.filter((f) => f.endsWith('.jsonl'))
			.map((f) => f.slice(0, -6));
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
	restoreCollectionFile,
	runRestore,
};
