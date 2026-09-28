'use strict';

/**
 * Publishes `firebase-remote-config-template.json` to the Firebase **server**
 * Remote Config namespace.
 *
 * Namespace contract (issue #598):
 *   The runtime loader uses `admin.remoteConfig().initServerTemplate()`, which
 *   reads the `firebase-server` namespace. Every publish must therefore target
 *     projects/{projectId}/namespaces/firebase-server/serverRemoteConfig
 *   Publishing to the default (client) namespace `/remoteConfig` is a silent
 *   no-op for the server loader: the template appears in the console but the
 *   service keeps reading an empty server template forever.
 *
 * Bootstrap contract:
 *   The `firebase-server` namespace does not exist until the first publish, so
 *   the pre-publish `getServerTemplate()` read rejects with
 *   `remote-config/not-found`. Treating that as fatal means the very first
 *   publish can never happen, which deadlocks the feature. We therefore fall
 *   back to `If-Match: *` (the documented forced-update form) to create the
 *   namespace, and only treat a real non-2xx PUT as a failure.
 *
 * Credentials come from the same resolution order the application uses
 * (FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS / ADC). No
 * credential value is ever logged.
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

/**
 * Resolved lazily so a fully injected publish (tests, or a caller supplying
 * every collaborator) never touches the real SDK module graph.
 */
function resolveDependencies(overrides) {
	if (overrides.admin && overrides.AuthorizedHttpClient) {
		return { admin: overrides.admin, AuthorizedHttpClient: overrides.AuthorizedHttpClient };
	}
	return loadDependencies();
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

function resolveProjectId(configuredProjectId, app) {
	const fromApp = app && app.options ? app.options.projectId : undefined;
	return fromApp || configuredProjectId || undefined;
}

async function publishServerTemplate(overrides = {}) {
	const needsSdk = !overrides.app || !overrides.client || !overrides.remoteConfig;
	const deps = needsSdk ? resolveDependencies(overrides) : { admin: null, AuthorizedHttpClient: null };
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

	const projectId = resolveProjectId(configuredProjectId, app);
	if (!projectId) {
		throw new Error('Firebase project ID is not configured (set FIREBASE_PROJECT_ID)');
	}

	const remoteConfig = overrides.remoteConfig || admin.remoteConfig(app);

	let ifMatch = '*';
	let currentTemplate = { conditions: [] };
	if (overrides.getServerTemplate) {
		const fetched = await overrides.getServerTemplate(remoteConfig);
		if (fetched) {
			currentTemplate = fetched;
			ifMatch = currentTemplate.etag;
		}
	} else {
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

module.exports = {
	SERVER_NAMESPACE,
	TEMPLATE_PATH,
	buildServerTemplate,
	isNamespaceMissing,
	publishServerTemplate,
	readTemplate,
};
