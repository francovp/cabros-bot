'use strict';

/**
 * Centralized Firebase Admin credential loader.
 *
 * Single source of truth for parsing and validating Firebase service-account
 * credentials from environment variables. Previously, 4 call sites
 * (adminAuth.js, AlertStorageService.js, IdempotencyStorageService.js,
 * NewsDedupStorageService.js) duplicated the same JSON.parse + cert +
 * initializeApp boilerplate; this file replaces all of them.
 *
 * Credential resolution order (matches firebase-admin defaults):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON env var (inline JSON string, preferred
 *      for Render/Railway secret env vars)
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to a service-account
 *      JSON file)
 *   3. Application Default Credentials (GCP / Cloud Run managed identity)
 *
 * Returns `null` (fail-open) when no credentials are configured so callers
 * keep their existing "skip Firebase, run in-memory" behavior. Throws a
 * typed `FirebaseAdminCredentialsError` when credentials are configured but
 * malformed — `loadFirebaseAdminCredentialsOrNull()` swallows the throw and
 * returns null for the common storage call sites that already fail-open.
 *
 * @module services/storage/firebaseAdminCredentials
 */

const { createPrivateKey } = require('crypto');
const { accessSync, constants, readFileSync, statSync } = require('fs');

const REQUIRED_FIELDS = ['project_id', 'private_key', 'client_email'];

class FirebaseAdminCredentialsError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = 'FirebaseAdminCredentialsError';
		if (options.cause) {
			this.cause = options.cause;
		}
		this.code = options.code || 'FIREBASE_CREDENTIALS_INVALID';
	}
}

function hasStringValue(value) {
	return typeof value === 'string' ? value.trim().length > 0 : value != null;
}

function readField(record, camelName) {
	if (!record || typeof record !== 'object') return undefined;
	return record[camelName] !== undefined
		? record[camelName]
		: record[camelName.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase())];
}

function validateServiceAccount(record) {
	const projectId = readField(record, 'project_id');
	const privateKey = readField(record, 'private_key');
	const clientEmail = readField(record, 'client_email');

	const missing = [];
	if (!hasStringValue(projectId)) missing.push('project_id');
	if (!hasStringValue(privateKey)) missing.push('private_key');
	if (!hasStringValue(clientEmail)) missing.push('client_email');

	if (missing.length > 0) {
		throw new FirebaseAdminCredentialsError(
			`FIREBASE_SERVICE_ACCOUNT_JSON is missing required field(s): ${missing.join(', ')}`,
			{ code: 'FIREBASE_CREDENTIALS_MISSING_FIELDS' }
		);
	}

	try {
		createPrivateKey({ key: privateKey, format: 'pem' });
	} catch (error) {
		throw new FirebaseAdminCredentialsError(
			'FIREBASE_SERVICE_ACCOUNT_JSON private_key is not a valid PEM key',
			{ code: 'FIREBASE_CREDENTIALS_INVALID_KEY', cause: error }
		);
	}

	return { projectId, privateKey, clientEmail };
}

function readAndValidateFile(filePath) {
	const contents = readFileSync(filePath, 'utf8');
	const parsed = JSON.parse(contents);
	const { projectId } = softValidateServiceAccount(parsed);
	return { parsed, projectId };
}

/**
 * Permissive variant of validateServiceAccount — accepts whatever
 * JSON.parse yields and only normalizes the project_id alias. Lets
 * `admin.credential.cert()` raise its own error when the credential is
 * unusable. Used by the loadFirebaseAdminCredentials() main entry point
 * to preserve the previous call-site behavior, which delegated field
 * validation to firebase-admin itself.
 */
function softValidateServiceAccount(record) {
	const projectId = readField(record, 'project_id');
	return { projectId };
}

function getAdminModule() {
	if (typeof global.__firebaseAdminCredentialsAdmin === 'object'
		&& global.__firebaseAdminCredentialsAdmin !== null) {
		return global.__firebaseAdminCredentialsAdmin;
	}
	try {
		return require('firebase-admin');
	} catch (error) {
		throw new FirebaseAdminCredentialsError(
			'Failed to load firebase-admin module: ' + error.message,
			{ code: 'FIREBASE_ADMIN_MODULE_MISSING', cause: error }
		);
	}
}

let hasWarnedNoCredentials = false;
let testEnvOverride = null;

function warnOnce(message) {
	if (hasWarnedNoCredentials) return;
	hasWarnedNoCredentials = true;
	console.warn(`[firebaseAdminCredentials] ${message}`);
}

function resetWarningStateForTests() {
	hasWarnedNoCredentials = false;
}

function setAdminForTests(adminMock) {
	global.__firebaseAdminCredentialsAdmin = adminMock;
}

function setTestEnv(env) {
	if (env && typeof env === 'object') {
		const merged = {};
		for (const key of Object.keys(env)) {
			merged[key] = env[key];
		}
		testEnvOverride = merged;
	} else {
		testEnvOverride = null;
	}
}

function getWellKnownCredentialsPath() {
	const env = testEnvOverride || process.env;
	const configRoot = process.platform === 'win32'
		? env.APPDATA
		: env.HOME;
	if (!hasStringValue(configRoot)) return null;
	const configDirectory = process.platform === 'win32'
		? configRoot
		: require('path').join(configRoot, '.config');
	return require('path').join(configDirectory, 'gcloud', 'application_default_credentials.json');
}

/**
 * Parse FIREBASE_SERVICE_ACCOUNT_JSON / GOOGLE_APPLICATION_CREDENTIALS and
 * return `{ credential, projectId, source }` ready for admin.initializeApp().
 *
 * @param {Object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Override env (defaults to process.env)
 * @returns {{ credential: *, projectId: string, source: ('inline_json'|'gac_path'|'adc') }}
 * @throws {FirebaseAdminCredentialsError} when credentials are configured but malformed
 */
function loadFirebaseAdminCredentials(options = {}) {
	const env = options.env || testEnvOverride || process.env;
	const admin = getAdminModule();

	if (hasStringValue(env.FIREBASE_SERVICE_ACCOUNT_JSON)) {
		let parsed;
		try {
			parsed = JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON);
		} catch (error) {
			throw new FirebaseAdminCredentialsError(
				'FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ' + error.message,
				{ code: 'FIREBASE_CREDENTIALS_INVALID_JSON', cause: error }
			);
		}
		const { projectId } = softValidateServiceAccount(parsed);
		const credential = admin.credential.cert(parsed);
		return {
			credential,
			projectId: hasStringValue(env.FIREBASE_PROJECT_ID)
				? env.FIREBASE_PROJECT_ID.trim()
				: projectId,
			source: 'inline_json',
		};
	}

	if (hasStringValue(env.GOOGLE_APPLICATION_CREDENTIALS)) {
		const filePath = env.GOOGLE_APPLICATION_CREDENTIALS;
		try {
			accessSync(filePath, constants.R_OK);
			if (!statSync(filePath).isFile()) {
				throw new Error('path is not a regular file');
			}
		} catch (error) {
			throw new FirebaseAdminCredentialsError(
				`GOOGLE_APPLICATION_CREDENTIALS path is not readable: ${filePath}`,
				{ code: 'FIREBASE_CREDENTIALS_UNREADABLE_FILE', cause: error }
			);
		}
		const { parsed, projectId } = readAndValidateFile(filePath);
		const credential = admin.credential.cert(parsed);
		return {
			credential,
			projectId: hasStringValue(env.FIREBASE_PROJECT_ID)
				? env.FIREBASE_PROJECT_ID.trim()
				: projectId,
			source: 'gac_path',
		};
	}

	const wellKnown = getWellKnownCredentialsPath();
	if (wellKnown && hasStringValue(wellKnown)) {
		try {
			accessSync(wellKnown, constants.R_OK);
			if (statSync(wellKnown).isFile()) {
				const { parsed, projectId } = readAndValidateFile(wellKnown);
				const credential = admin.credential.cert(parsed);
				return {
					credential,
					projectId: hasStringValue(env.FIREBASE_PROJECT_ID)
						? env.FIREBASE_PROJECT_ID.trim()
						: projectId,
					source: 'adc',
				};
			}
		} catch (error) {
			// fall through to the "no credentials configured" warning
		}
	}

	return null;
}

/**
 * Fail-open variant of loadFirebaseAdminCredentials().
 * Returns null instead of throwing; logs a single warning per process on
 * the first failure so storage call sites can preserve their existing
 * behavior (return null on credential errors).
 */
function loadFirebaseAdminCredentialsOrNull(options = {}) {
	try {
		const result = loadFirebaseAdminCredentials(options);
		if (result === null) {
			warnOnce('No Firebase admin credentials configured; continuing with in-memory fallback.');
		}
		return result;
	} catch (error) {
		if (error instanceof FirebaseAdminCredentialsError) {
			warnOnce(`${error.message} — Firebase admin credentials unavailable; continuing with in-memory fallback.`);
		} else {
			warnOnce(`Unexpected error loading Firebase admin credentials: ${error.message}`);
		}
		return null;
	}
}

function buildFirebaseAppOptions(options = {}) {
	const loaded = options.loaded || loadFirebaseAdminCredentialsOrNull();
	const appOptions = {};
	if (loaded && loaded.credential) {
		appOptions.credential = loaded.credential;
	}
	if (loaded && loaded.projectId) {
		appOptions.projectId = loaded.projectId;
	}
	return appOptions;
}

module.exports = {
	loadFirebaseAdminCredentials,
	loadFirebaseAdminCredentialsOrNull,
	buildFirebaseAppOptions,
	FirebaseAdminCredentialsError,
	_resetWarningStateForTests: resetWarningStateForTests,
	_setAdminForTests: setAdminForTests,
	_setTestEnv: setTestEnv,
};