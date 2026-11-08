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
 *   2. GOOGLE_APPLICATION_CREDENTIALS env var (path to a credential JSON file)
 *   3. Application Default Credentials (GCP / Cloud Run managed identity)
 *
 * Not every credential file is a service-account certificate. `gcloud
 * application-default login` writes an `authorized_user` document (and
 * workload identity federation writes `external_account`), and both are
 * bearer-token credentials that only the SDK's Application Default
 * Credentials resolution understands — `admin.credential.cert()` rejects
 * them. `firestoreConfig.js` already reports those types as configured, so
 * this loader routes every non-service-account document to
 * `admin.credential.applicationDefault()` instead of handing it to
 * `cert()`. Service-account documents keep the existing `cert()` path.
 *
 * `authorized_user` and `external_account` documents carry no project id, so
 * `FIREBASE_PROJECT_ID` is the only project override available on that path
 * and is always forwarded to `initializeApp()`.
 *
 * Returns `null` (fail-open) when no credentials are configured so callers
 * keep their existing "skip Firebase, run in-memory" behavior. Throws a
 * typed `FirebaseAdminCredentialsError` when credentials are configured but
 * malformed — `loadFirebaseAdminCredentialsOrNull()` swallows the throw and
 * returns null for the common storage call sites that already fail-open.
 *
 * That single `null` is ambiguous, so storage callers use
 * `resolveFirebaseAdminCredentials()` (or the `initializeFirebaseAdminApp()`
 * wrapper) which separates UNCONFIGURED from INVALID instead of initializing
 * the app with `{}` after a failed credential check (issue #1128).
 *
 * @module services/storage/firebaseAdminCredentials
 */

const { createPrivateKey } = require('crypto');
const { accessSync, constants, readFileSync, statSync } = require('fs');

const REQUIRED_FIELDS = ['project_id', 'private_key', 'client_email'];

const SERVICE_ACCOUNT_TYPE = 'service_account';
const CREDENTIAL_TYPE_CERT = 'cert';
const CREDENTIAL_TYPE_APPLICATION_DEFAULT = 'application_default';

const CREDENTIAL_STATUS = Object.freeze({
	CONFIGURED: 'configured',
	UNCONFIGURED: 'unconfigured',
	INVALID: 'invalid',
	ALREADY_INITIALIZED: 'already_initialized',
});

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
 * Classify a parsed credential document as a service-account certificate or
 * as something only Application Default Credentials can resolve.
 *
 * `admin.credential.cert()` accepts a service account and nothing else. A
 * `gcloud application-default login` session (`authorized_user`) and workload
 * identity federation (`external_account`) both fail that call, which is why
 * they are routed to `admin.credential.applicationDefault()` instead.
 *
 * An explicit `type` wins. A document with no `type` is treated as a service
 * account when it carries the service-account fields, because that is what
 * `admin.credential.cert()` itself accepts for hand-written keys.
 */
function isServiceAccountDocument(record) {
	if (!record || typeof record !== 'object') return false;

	const type = readField(record, 'type');
	if (typeof type === 'string' && type.trim()) {
		return type.trim().toLowerCase() === SERVICE_ACCOUNT_TYPE;
	}

	return hasStringValue(readField(record, 'private_key'))
		&& hasStringValue(readField(record, 'client_email'));
}

function resolveProjectId(env, embeddedProjectId) {
	return hasStringValue(env.FIREBASE_PROJECT_ID)
		? env.FIREBASE_PROJECT_ID.trim()
		: embeddedProjectId;
}

function getApplicationDefaultCredential(admin) {
	if (!admin.credential || typeof admin.credential.applicationDefault !== 'function') {
		throw new FirebaseAdminCredentialsError(
			'firebase-admin does not expose credential.applicationDefault(); '
			+ 'cannot resolve Application Default Credentials',
			{ code: 'FIREBASE_CREDENTIALS_ADC_UNSUPPORTED' }
		);
	}
	return admin.credential.applicationDefault();
}

/**
 * Turn a parsed credential document into the `{ credential, projectId, source }`
 * shape every caller expects.
 *
 * `inlineVariable` is set only for FIREBASE_SERVICE_ACCOUNT_JSON: Application
 * Default Credentials can never read an inline value (it resolves a file, the
 * well-known gcloud path, or the managed-runtime metadata server), so handing
 * one back would silently use a *different* credential than the operator
 * configured. That case fails closed with an actionable error instead — and
 * still fails open to `null` through loadFirebaseAdminCredentialsOrNull().
 */
function buildCredentialResult(admin, parsed, {
	source,
	env,
	embeddedProjectId,
	inlineVariable,
}) {
	if (isServiceAccountDocument(parsed)) {
		return {
			credential: admin.credential.cert(parsed),
			projectId: resolveProjectId(env, embeddedProjectId),
			source,
			credentialType: CREDENTIAL_TYPE_CERT,
		};
	}

	const documentType = readField(parsed, 'type');
	if (inlineVariable) {
		throw new FirebaseAdminCredentialsError(
			`${inlineVariable} holds a "${typeof documentType === 'string' && documentType.trim()
				? documentType.trim()
				: 'untyped'}" credential document, which Application Default Credentials cannot resolve. `
			+ 'Application Default Credentials reads GOOGLE_APPLICATION_CREDENTIALS, the well-known gcloud '
			+ 'ADC file, or the managed-runtime metadata server — never an inline value. Store the credentials '
			+ 'in a file and point GOOGLE_APPLICATION_CREDENTIALS at it, or provide a service-account JSON inline.',
			{ code: 'FIREBASE_CREDENTIALS_UNSUPPORTED_TYPE' }
		);
	}

	return {
		credential: getApplicationDefaultCredential(admin),
		// These document types carry no project id, so `undefined` is a real
		// answer here and not a lost value.
		projectId: resolveProjectId(env, undefined),
		source,
		credentialType: CREDENTIAL_TYPE_APPLICATION_DEFAULT,
	};
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
 * return `{ credential, projectId, source, credentialType }` ready for
 * admin.initializeApp().
 *
 * `credentialType` is `'cert'` for a service-account certificate and
 * `'application_default'` for any other credential document, which the SDK
 * resolves through Application Default Credentials.
 *
 * @param {Object} [options]
 * @param {NodeJS.ProcessEnv} [options.env] - Override env (defaults to process.env)
 * @returns {{ credential: *, projectId: string, source: ('inline_json'|'gac_path'|'adc'), credentialType: ('cert'|'application_default') }|null}
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
		return buildCredentialResult(admin, parsed, {
			source: 'inline_json',
			env,
			embeddedProjectId: projectId,
			inlineVariable: 'FIREBASE_SERVICE_ACCOUNT_JSON',
		});
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
		return buildCredentialResult(admin, parsed, {
			source: 'gac_path',
			env,
			embeddedProjectId: projectId,
		});
	}

	const wellKnown = getWellKnownCredentialsPath();
	if (wellKnown && hasStringValue(wellKnown)) {
		try {
			accessSync(wellKnown, constants.R_OK);
			if (statSync(wellKnown).isFile()) {
				const { parsed, projectId } = readAndValidateFile(wellKnown);
				return buildCredentialResult(admin, parsed, {
					source: 'adc',
					env,
					embeddedProjectId: projectId,
				});
			}
		} catch (error) {
			// fall through to the "no credentials configured" warning
		}
	}

	if (hasStringValue(env.FIREBASE_PROJECT_ID)) {
		return {
			projectId: env.FIREBASE_PROJECT_ID.trim(),
			source: 'adc',
		};
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
	const resolved = resolveFirebaseAdminCredentials(options);
	if (resolved.status === CREDENTIAL_STATUS.INVALID) {
		warnOnce(`${resolved.error.message} — Firebase admin credentials unavailable; continuing with in-memory fallback.`);
	}
	return resolved.credentials;
}

/**
 * Resolve credentials while preserving the difference between "no credential
 * source configured" (ADC default-auth is still legitimate) and "a configured
 * source failed validation" (nothing to fall back to). `appOptions` is `null`
 * only for INVALID, so a caller cannot initialize the app with `{}` after a
 * configured credential failure.
 *
 * @param {Object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{status: string, credentials: Object|null, appOptions: Object|null, error: Error|null}}
 */
function resolveFirebaseAdminCredentials(options = {}) {
	try {
		const credentials = loadFirebaseAdminCredentials(options);
		if (!credentials) {
			return {
				status: CREDENTIAL_STATUS.UNCONFIGURED,
				credentials: null,
				appOptions: {},
				error: null,
			};
		}
		return {
			status: CREDENTIAL_STATUS.CONFIGURED,
			credentials,
			appOptions: toFirebaseAppOptions(credentials),
			error: null,
		};
	} catch (error) {
		const wrapped = error instanceof FirebaseAdminCredentialsError
			? error
			: new FirebaseAdminCredentialsError(
				'Unexpected error loading Firebase admin credentials: ' + error.message,
				{ code: 'FIREBASE_CREDENTIALS_LOAD_FAILED', cause: error }
			);
		return {
			status: CREDENTIAL_STATUS.INVALID,
			credentials: null,
			appOptions: null,
			error: wrapped,
		};
	}
}

/**
 * Shared Firebase Admin bootstrap for storage callers. Leaves the SDK untouched
 * and returns `ok: false` when credentials are configured but invalid, so the
 * caller falls back to memory instead of paying for SDK default-auth discovery.
 *
 * @param {Object} [options]
 * @param {Object} [options.admin] - firebase-admin module (defaults to the loaded one)
 * @param {NodeJS.ProcessEnv} [options.env]
 * @returns {{ok: boolean, status: string, error: Error|null}}
 */
function initializeFirebaseAdminApp(options = {}) {
	const admin = options.admin || getAdminModule();
	if (admin.apps.length) {
		return { ok: true, status: CREDENTIAL_STATUS.ALREADY_INITIALIZED, error: null };
	}

	const resolved = resolveFirebaseAdminCredentials({ env: options.env });
	if (!resolved.appOptions) {
		return { ok: false, status: resolved.status, error: resolved.error };
	}

	admin.initializeApp(resolved.appOptions);
	return { ok: true, status: resolved.status, error: null };
}

function toFirebaseAppOptions(loaded) {
	const appOptions = {};
	if (loaded && loaded.credential) {
		appOptions.credential = loaded.credential;
	}
	if (loaded && loaded.projectId) {
		appOptions.projectId = loaded.projectId;
	}
	return appOptions;
}

/**
 * @deprecated Returns `{}` for both UNCONFIGURED and INVALID — the ambiguity
 * issue #1128 removes. Use initializeFirebaseAdminApp() or
 * resolveFirebaseAdminCredentials() instead.
 */
function buildFirebaseAppOptions(options = {}) {
	if (options.loaded) {
		return toFirebaseAppOptions(options.loaded);
	}
	return resolveFirebaseAdminCredentials(options).appOptions || {};
}

module.exports = {
	loadFirebaseAdminCredentials,
	loadFirebaseAdminCredentialsOrNull,
	resolveFirebaseAdminCredentials,
	initializeFirebaseAdminApp,
	buildFirebaseAppOptions,
	CREDENTIAL_STATUS,
	FirebaseAdminCredentialsError,
	_resetWarningStateForTests: resetWarningStateForTests,
	_setAdminForTests: setAdminForTests,
	_setTestEnv: setTestEnv,
};
