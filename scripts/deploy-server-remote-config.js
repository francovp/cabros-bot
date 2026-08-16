'use strict';

const fs = require('node:fs');
const path = require('node:path');
const admin = require('firebase-admin');
const { AuthorizedHttpClient } = require(path.join(path.dirname(require.resolve('firebase-admin')), 'utils/api-request'));

const TEMPLATE_PATH = path.resolve(__dirname, '..', 'firebase-remote-config-template.json');
const REMOTE_CONFIG_API = 'https://firebaseremoteconfig.googleapis.com/v1';

function readTemplate() {
	return JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
}

function buildServerTemplate(template, currentTemplate) {
	return {
		conditions: currentTemplate.conditions || [],
		parameters: template.parameters,
	};
}

async function publishServerTemplate() {
	const app = admin.initializeApp();
	const projectId = app.options.projectId || process.env.GCLOUD_PROJECT || process.env.FIREBASE_PROJECT_ID;
	if (!projectId) {
		throw new Error('Firebase project ID is not configured');
	}

	const remoteConfig = admin.remoteConfig(app);
	const currentTemplate = await remoteConfig.getServerTemplate();
	const client = new AuthorizedHttpClient(app);
	const response = await client.send({
		method: 'PUT',
		url: `${REMOTE_CONFIG_API}/projects/${projectId}/namespaces/firebase-server/serverRemoteConfig`,
		headers: {
			'Accept-Encoding': 'gzip',
			'Content-Type': 'application/json',
			'If-Match': currentTemplate.etag,
		},
		data: buildServerTemplate(readTemplate(), currentTemplate),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Firebase server Remote Config publish failed with HTTP ${response.status}`);
	}

	console.log(`Published server Remote Config template for ${projectId}`);
}

if (require.main === module) {
	publishServerTemplate().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}

module.exports = { buildServerTemplate, readTemplate };
