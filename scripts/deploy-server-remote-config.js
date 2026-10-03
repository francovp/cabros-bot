'use strict';

/**
 * Publishes `firebase-remote-config-template.json` to the Firebase **server**
 * Remote Config namespace (`namespaces/firebase-server/serverRemoteConfig`),
 * which is what `admin.remoteConfig().initServerTemplate()` reads. Publishing to
 * the default client namespace is a silent no-op for the server loader.
 *
 * That namespace does not exist until the first publish, so the pre-publish read
 * rejects `remote-config/not-found`. That is the expected bootstrap state, not a
 * failure: we fall back to `If-Match: *` to create it. Treating it as fatal
 * deadlocked the very first publish (issue #598). Full contract in AGENTS.md.
 */

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_PATH = path.resolve(__dirname, '..', 'firebase-remote-config-template.json');
const REMOTE_CONFIG_API = 'https://firebaseremoteconfig.googleapis.com/v1';
const SERVER_NAMESPACE = 'firebase-server';

function loadDependencies() {
	const admin = require('firebase-admin');
	const { AuthorizedHttpClient } = require(
		path.join(path.dirname(require.resolve('firebase-admin')), 'utils/api-request'),
	);
	return { admin, AuthorizedHttpClient };
}

function readTemplate(templatePath = TEMPLATE_PATH) {
	return JSON.parse(fs.readFileSync(templatePath, 'utf8'));
}

function buildServerTemplate(template, currentTemplate = {}) {
	return {
		conditions: currentTemplate.conditions || [],
		parameters: template.parameters,
	};
}

/**
 * The server namespace does not exist before the first publish, so a
 * not-found read is the expected bootstrap state rather than an error.
 */
function isNamespaceMissing(error) {
	if (!error) {
		return false;
	}
	if (error.code === 'remote-config/not-found') {
		return true;
	}
	return typeof error.hasCode === 'function' && error.hasCode('not-found');
}

async function publishServerTemplate(overrides = {}) {
	// `admin` and `AuthorizedHttpClient` are only needed when the caller did not
	// supply a ready `client` (and, for `admin`, an `app`). Loading the real SDK
	// unconditionally drags the whole firebase-admin module graph into any process
	// that only wants to inject a client - including the publish tests.
	const needsSdk = !overrides.client || !overrides.app;
	const deps = needsSdk ? loadDependencies() : { admin: null, AuthorizedHttpClient: null };
	const admin = overrides.admin || deps.admin;
	const AuthorizedHttpClient = overrides.AuthorizedHttpClient || deps.AuthorizedHttpClient;
	const templatePath = overrides.templatePath || TEMPLATE_PATH;

	const configuredProjectId = process.env.FIREBASE_PROJECT_ID
		|| process.env.GCLOUD_PROJECT
		|| process.env.GOOGLE_CLOUD_PROJECT;

	let app = overrides.app;
	if (!app) {
		const appOptions = {};
		if (configuredProjectId) {
			appOptions.projectId = configuredProjectId;
		}
		if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
			appOptions.credential = admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON));
		} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
			appOptions.credential = admin.credential.applicationDefault();
		}
		app = admin.initializeApp(appOptions);
	}

	const projectId = (app.options && app.options.projectId) || configuredProjectId;
	if (!projectId) {
		throw new Error('Firebase project ID is not configured (set FIREBASE_PROJECT_ID)');
	}

	const remoteConfig = overrides.remoteConfig || admin.remoteConfig(app);

	// Single read path: a caller that needs to intercept this should mock
	// `remoteConfig.getServerTemplate`, exactly as production invokes it. A separate
	// injection seam here was a second, divergent code path with different If-Match
	// fallback behaviour - i.e. a second thing to keep correct.
	let ifMatch = '*';
	let currentTemplate = { conditions: [] };
	try {
		const fetched = (await remoteConfig.getServerTemplate()).toJSON();
		currentTemplate = fetched || { conditions: [] };
		ifMatch = currentTemplate.etag || '*';
	} catch (error) {
		if (!isNamespaceMissing(error)) {
			throw error;
		}
		// Namespace absent: bootstrap it with a forced update.
		console.warn(`No existing ${SERVER_NAMESPACE} template found; creating it (If-Match: *).`);
	}

	const client = overrides.client || new AuthorizedHttpClient(app);
	const response = await client.send({
		method: 'PUT',
		url: `${REMOTE_CONFIG_API}/projects/${projectId}/namespaces/${SERVER_NAMESPACE}/serverRemoteConfig`,
		headers: {
			'Accept-Encoding': 'gzip',
			'Content-Type': 'application/json',
			'If-Match': ifMatch,
		},
		data: buildServerTemplate(readTemplate(templatePath), currentTemplate),
	});

	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Firebase server Remote Config publish failed with HTTP ${response.status}`);
	}

	console.log(`Published ${SERVER_NAMESPACE} Remote Config template for ${projectId}`);
	return true;
}

if (require.main === module) {
	publishServerTemplate().catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}

// Only what the tests actually consume; the rest stays module-private.
module.exports = {
	buildServerTemplate,
	publishServerTemplate,
};
