'use strict';

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const DEFAULT_COLLECTIONS = ['alerts', 'alertReplays', 'signalOutcomes', 'scannerPresets'];
const PAGE_SIZE = 400;

function parseArgs(args = process.argv.slice(2)) {
	const options = {
		collections: DEFAULT_COLLECTIONS,
		outputDir: null,
		pageSize: PAGE_SIZE,
		dryRun: false,
		format: 'jsonl',
		projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
	};

	for (const arg of args) {
		if (arg.startsWith('--collections=')) {
			const raw = arg.split('=')[1];
			options.collections = raw.split(',').map((s) => s.trim()).filter(Boolean);
		} else if (arg.startsWith('--output-dir=')) {
			options.outputDir = arg.split('=')[1].trim();
		} else if (arg.startsWith('--page-size=')) {
			const size = Number(arg.split('=')[1]);
			if (Number.isSafeInteger(size) && size > 0) {
				options.pageSize = Math.min(size, 1000);
			}
		} else if (arg === '--dry-run') {
			options.dryRun = true;
		} else if (arg.startsWith('--format=')) {
			options.format = arg.split('=')[1].trim().toLowerCase();
		} else if (arg.startsWith('--project=')) {
			options.projectId = arg.split('=')[1].trim();
		}
	}

	if (!options.outputDir) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
		options.outputDir = path.join(process.cwd(), 'backups', `firestore-export-${timestamp}`);
	}

	return options;
}

function serializeValue(val) {
	if (val === null || val === undefined) {
		return val;
	}

	// Firestore Timestamp
	if (typeof val.toMillis === 'function' || (typeof val.seconds === 'number' && typeof val.nanoseconds === 'number') || (val instanceof Date)) {
		const seconds = typeof val.seconds === 'number'
			? val.seconds
			: (typeof val.toMillis === 'function' ? Math.floor(val.toMillis() / 1000) : Math.floor(val.getTime() / 1000));
		const nanoseconds = typeof val.nanoseconds === 'number'
			? val.nanoseconds
			: (typeof val.toMillis === 'function' ? (val.toMillis() % 1000) * 1000000 : (val.getTime() % 1000) * 1000000);
		const iso = typeof val.toDate === 'function'
			? val.toDate().toISOString()
			: (val instanceof Date ? val.toISOString() : new Date(seconds * 1000 + Math.floor(nanoseconds / 1000000)).toISOString());
		return {
			__type: 'Timestamp',
			iso,
			seconds,
			nanoseconds,
		};
	}

	// Firestore GeoPoint
	if (typeof val.latitude === 'number' && typeof val.longitude === 'number' && typeof val.isEqual === 'function') {
		return {
			__type: 'GeoPoint',
			latitude: val.latitude,
			longitude: val.longitude,
		};
	}

	// Firestore DocumentReference
	if (typeof val.path === 'string' && typeof val.id === 'string' && typeof val.collection === 'function') {
		return {
			__type: 'DocumentReference',
			path: val.path,
		};
	}

	// Array
	if (Array.isArray(val)) {
		return val.map((item) => serializeValue(item));
	}

	// Plain Object
	if (typeof val === 'object' && val.constructor === Object) {
		const result = {};
		for (const [key, value] of Object.entries(val)) {
			result[key] = serializeValue(value);
		}
		return result;
	}

	return val;
}

function serializeDocument(doc) {
	const rawData = doc.data() || {};
	const data = serializeValue(rawData);
	return {
		_id: doc.id,
		...data,
	};
}

async function exportCollection(firestore, collectionName, options = {}) {
	const pageSize = options.pageSize || PAGE_SIZE;
	const isDryRun = Boolean(options.dryRun);
	const outputFilePath = options.outputFilePath;

	let count = 0;
	let lastDocument = null;
	let writeStream = null;

	if (!isDryRun && outputFilePath) {
		const dir = path.dirname(outputFilePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		writeStream = fs.createWriteStream(outputFilePath, { flags: 'w', encoding: 'utf8' });
	}

	try {
		while (true) {
			let query = firestore.collection(collectionName).orderBy('__name__').limit(pageSize);
			if (lastDocument) {
				query = query.startAfter(lastDocument);
			}

			const snapshot = await query.get();
			if (snapshot.empty) {
				break;
			}

			for (const doc of snapshot.docs) {
				count += 1;
				if (writeStream) {
					const record = serializeDocument(doc);
					writeStream.write(JSON.stringify(record) + '\n');
				}
			}

			if (snapshot.docs.length < pageSize) {
				break;
			}
			lastDocument = snapshot.docs.at(-1);
		}
	} finally {
		if (writeStream) {
			await new Promise((resolve) => writeStream.end(resolve));
		}
	}

	return {
		collection: collectionName,
		documentCount: count,
		file: outputFilePath || null,
	};
}

function initializeFirestore(projectId = null) {
	let credential;
	if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
		try {
			credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
		} catch (err) {
			console.warn(JSON.stringify({
				event: 'firestore_export_invalid_service_account_json',
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

async function runExport(options = {}) {
	const opts = {
		collections: DEFAULT_COLLECTIONS,
		outputDir: path.join(process.cwd(), 'backups', `firestore-export-${Date.now()}`),
		pageSize: PAGE_SIZE,
		dryRun: false,
		projectId: null,
		...options,
	};

	const firestore = opts.firestore || initializeFirestore(opts.projectId);
	const results = {
		exportedAt: new Date().toISOString(),
		projectId: opts.projectId || process.env.FIREBASE_PROJECT_ID || 'unknown',
		dryRun: opts.dryRun,
		outputDir: opts.outputDir,
		collections: {},
		totalDocuments: 0,
	};

	if (!opts.dryRun && !fs.existsSync(opts.outputDir)) {
		fs.mkdirSync(opts.outputDir, { recursive: true });
	}

	for (const collectionName of opts.collections) {
		const outputFilePath = opts.dryRun ? null : path.join(opts.outputDir, `${collectionName}.jsonl`);
		const colResult = await exportCollection(firestore, collectionName, {
			pageSize: opts.pageSize,
			dryRun: opts.dryRun,
			outputFilePath,
		});

		results.collections[collectionName] = colResult;
		results.totalDocuments += colResult.documentCount;
	}

	if (!opts.dryRun) {
		const manifestPath = path.join(opts.outputDir, 'manifest.json');
		fs.writeFileSync(manifestPath, JSON.stringify(results, null, 2), 'utf8');
	}

	return results;
}

async function main() {
	const options = parseArgs();
	console.log(JSON.stringify({
		event: 'firestore_export_started',
		collections: options.collections,
		outputDir: options.outputDir,
		dryRun: options.dryRun,
		projectId: options.projectId || 'default',
	}));

	const results = await runExport(options);

	console.log(JSON.stringify({
		event: 'firestore_export_completed',
		totalDocuments: results.totalDocuments,
		collections: Object.keys(results.collections).map((k) => ({
			name: k,
			count: results.collections[k].documentCount,
		})),
		outputDir: results.outputDir,
		dryRun: results.dryRun,
	}));
}

if (require.main === module) {
	main().catch((err) => {
		console.error(JSON.stringify({
			event: 'firestore_export_failed',
			error: err.message,
			stack: err.stack,
		}));
		process.exitCode = 1;
	});
}

module.exports = {
	DEFAULT_COLLECTIONS,
	exportCollection,
	initializeFirestore,
	parseArgs,
	runExport,
	serializeDocument,
	serializeValue,
};
