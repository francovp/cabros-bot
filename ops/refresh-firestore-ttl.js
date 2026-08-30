'use strict';

const { initializeFirestore, refreshCollectionTtls } = require('./restore-firestore-collections');

const DEFAULT_COLLECTIONS = ['alerts', 'alertReplays', 'tradingSignalOutcomes', 'scannerPresets'];

function parseArgs(args = process.argv.slice(2)) {
	const options = {
		collections: DEFAULT_COLLECTIONS,
		projectId: process.env.FIREBASE_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT,
	};

	for (const arg of args) {
		if (arg.startsWith('--collections=')) {
			options.collections = arg.split('=')[1].split(',').map((value) => value.trim()).filter(Boolean);
		} else if (arg.startsWith('--project=')) {
			options.projectId = arg.split('=')[1].trim();
		} else {
			throw new Error(`Unsupported TTL refresh argument: "${arg}"`);
		}
	}

	return options;
}

async function main() {
	const options = parseArgs();
	const result = await refreshCollectionTtls(
		initializeFirestore(options.projectId),
		options.collections,
	);
	console.log(JSON.stringify({ event: 'firestore_ttl_refresh_completed', ...result }));
}

if (require.main === module) {
	main().catch((err) => {
		console.error(JSON.stringify({ event: 'firestore_ttl_refresh_failed', error: err.message }));
		process.exitCode = 1;
	});
}

module.exports = { parseArgs };
