'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { generateKeyPairSync } = require('crypto');

const VALID_PEM = generateKeyPairSync('rsa', {
	modulusLength: 2048,
	privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const VALID_INLINE = JSON.stringify({
	type: 'service_account',
	project_id: 'demo-project',
	private_key: VALID_PEM,
	client_email: 'svc@demo-project.iam.gserviceaccount.com',
});

const VALID_INLINE_CAMEL = JSON.stringify({
	type: 'service_account',
	projectId: 'demo-project',
	privateKey: VALID_PEM,
	clientEmail: 'svc@demo-project.iam.gserviceaccount.com',
});

const MISSING_PROJECT_ID = JSON.stringify({
	type: 'service_account',
	private_key: VALID_PEM,
	client_email: 'svc@demo-project.iam.gserviceaccount.com',
});

const MISSING_PRIVATE_KEY = JSON.stringify({
	type: 'service_account',
	project_id: 'demo-project',
	client_email: 'svc@demo-project.iam.gserviceaccount.com',
});

const MALFORMED_JSON = '{ "project_id": "demo-project", "type": "service_account" ';

// A `gcloud application-default login` session document. It has no
// private_key/client_email, so admin.credential.cert() rejects it and only
// Application Default Credentials can resolve it.
const AUTHORIZED_USER = JSON.stringify({
	type: 'authorized_user',
	client_id: '1234567890.apps.googleusercontent.com',
	client_secret: 'not-a-real-secret',
	refresh_token: 'not-a-real-refresh-token',
	quota_project_id: 'demo-project',
});

const EXTERNAL_ACCOUNT = JSON.stringify({
	type: 'external_account',
	audience: '//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/pool/providers/provider',
	subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
	credential_source: { file: '/var/run/token' },
});

const FAKE_ADMIN = {
	apps: [],
	credential: {
		cert: jest.fn((sa) => ({ __cert__: true, sa })),
		applicationDefault: jest.fn(() => ({ __applicationDefault__: true })),
	},
	initializeApp: jest.fn(),
};

function wellKnownAdcPathFor(configRoot) {
	return path.join(
		process.platform === 'win32' ? configRoot : path.join(configRoot, '.config'),
		'gcloud',
		'application_default_credentials.json',
	);
}

function loadHelper(env) {
	jest.resetModules();
	global.__firebaseAdminCredentialsAdmin = FAKE_ADMIN;
	const mod = require('../../src/services/storage/firebaseAdminCredentials');
	mod._resetWarningStateForTests();
	mod._setTestEnv(env);
	return mod;
}

describe('firebaseAdminCredentials helper', () => {
	let warnSpy;

	beforeEach(() => {
		FAKE_ADMIN.credential.cert.mockClear();
		FAKE_ADMIN.credential.applicationDefault.mockClear();
		FAKE_ADMIN.initializeApp.mockClear();
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		global.__firebaseAdminCredentialsAdmin = undefined;
		jest.resetModules();
	});

	describe('inline JSON credentials', () => {
		it('returns credential + projectId + source=inline_json when FIREBASE_SERVICE_ACCOUNT_JSON is valid', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE });
			const result = helper.loadFirebaseAdminCredentials();

			expect(result).not.toBeNull();
			expect(result.source).toBe('inline_json');
			expect(result.projectId).toBe('demo-project');
			expect(result.credential).toEqual({ __cert__: true, sa: expect.objectContaining({ project_id: 'demo-project' }) });
			expect(FAKE_ADMIN.credential.cert).toHaveBeenCalledTimes(1);
		});

		it('accepts camelCase aliases for project_id / private_key / client_email', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE_CAMEL });
			const result = helper.loadFirebaseAdminCredentials();
			expect(result).not.toBeNull();
			expect(result.projectId).toBe('demo-project');
		});

		it('prefers FIREBASE_PROJECT_ID override over the embedded project_id', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE,
				FIREBASE_PROJECT_ID: 'override-project',
			});
			const result = helper.loadFirebaseAdminCredentials();
			expect(result.projectId).toBe('override-project');
		});

		it('throws FirebaseAdminCredentialsError when JSON is malformed', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON });
			expect(() => helper.loadFirebaseAdminCredentials()).toThrow(helper.FirebaseAdminCredentialsError);
		});

		it('returns null via the fail-open wrapper when JSON is malformed', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON });
			expect(helper.loadFirebaseAdminCredentialsOrNull()).toBeNull();
		});

		it('returns a credential even when project_id is missing (delegated to admin.credential.cert)', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MISSING_PROJECT_ID });
			const result = helper.loadFirebaseAdminCredentials();
			expect(result).not.toBeNull();
			expect(result.source).toBe('inline_json');
			expect(FAKE_ADMIN.credential.cert).toHaveBeenCalled();
		});

		it('returns a credential even when private_key is missing (delegated to admin.credential.cert)', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MISSING_PRIVATE_KEY });
			const result = helper.loadFirebaseAdminCredentials();
			expect(result).not.toBeNull();
			expect(result.source).toBe('inline_json');
			expect(FAKE_ADMIN.credential.cert).toHaveBeenCalled();
		});

		it('returns null without warning when no credential sources are configured', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: '',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentialsOrNull();
			expect(result).toBeNull();
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it('preserves explicit project ID when Firebase credentials use application defaults', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: '',
				FIREBASE_PROJECT_ID: 'override-project',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});

			const result = helper.loadFirebaseAdminCredentials();

			expect(result).toEqual(expect.objectContaining({
				projectId: 'override-project',
				source: 'adc',
			}));
		});

		it('warns once per process for repeated calls with bad credentials', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON });
			helper.loadFirebaseAdminCredentialsOrNull();
			helper.loadFirebaseAdminCredentialsOrNull();
			helper.loadFirebaseAdminCredentialsOrNull();
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('GOOGLE_APPLICATION_CREDENTIALS file path', () => {
		it('returns credential + source=gac_path when file is readable and contains a service account', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-sa.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, VALID_INLINE);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(result).not.toBeNull();
			expect(result.source).toBe('gac_path');
			expect(result.projectId).toBe('demo-project');
		});

		it('returns null when GAC path points at a missing or unreadable file', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: '/tmp/__definitely-not-a-real-credentials-file__.json',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentialsOrNull();
			expect(result).toBeNull();
		});

		it('never routes a service-account file through Application Default Credentials', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-sa.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, VALID_INLINE);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(result.credentialType).toBe('cert');
			expect(result.credential).toEqual(expect.objectContaining({ __cert__: true }));
			expect(FAKE_ADMIN.credential.cert).toHaveBeenCalledTimes(1);
			expect(FAKE_ADMIN.credential.applicationDefault).not.toHaveBeenCalled();
		});
	});

	describe('authorized-user Application Default Credentials (issue #1127)', () => {
		it('delegates an authorized_user GAC file to applicationDefault() instead of cert()', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-adc-authorized-user.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, AUTHORIZED_USER);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				FIREBASE_PROJECT_ID: 'adc-project',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(result.source).toBe('gac_path');
			expect(result.credentialType).toBe('application_default');
			expect(FAKE_ADMIN.credential.cert).not.toHaveBeenCalled();
			expect(FAKE_ADMIN.credential.applicationDefault).toHaveBeenCalledTimes(1);
			expect(result.credential).toEqual({ __applicationDefault__: true });
		});

		it('forwards FIREBASE_PROJECT_ID to initializeApp() for an authorized_user GAC file', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-adc-authorized-user.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, AUTHORIZED_USER);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				FIREBASE_PROJECT_ID: 'adc-project',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const appOptions = helper.buildFirebaseAppOptions();
			fs.unlinkSync(tmpFile);

			expect(appOptions).toEqual({
				credential: { __applicationDefault__: true },
				projectId: 'adc-project',
			});
		});

		it('leaves projectId unset for an authorized_user file with no FIREBASE_PROJECT_ID', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-adc-authorized-user.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, AUTHORIZED_USER);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(result.credentialType).toBe('application_default');
			expect(result.projectId).toBeUndefined();
			expect(FAKE_ADMIN.credential.cert).not.toHaveBeenCalled();
		});

		it('delegates an authorized_user well-known ADC file to applicationDefault()', () => {
			const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cabros-adc-'));
			const adcFile = wellKnownAdcPathFor(configRoot);
			fs.mkdirSync(path.dirname(adcFile), { recursive: true });
			fs.writeFileSync(adcFile, AUTHORIZED_USER);

			try {
				const helper = loadHelper({
					FIREBASE_SERVICE_ACCOUNT_JSON: '',
					GOOGLE_APPLICATION_CREDENTIALS: '',
					FIREBASE_PROJECT_ID: 'well-known-project',
					HOME: configRoot,
					APPDATA: configRoot,
				});
				const result = helper.loadFirebaseAdminCredentials();

				expect(result.source).toBe('adc');
				expect(result.credentialType).toBe('application_default');
				expect(result.projectId).toBe('well-known-project');
				expect(FAKE_ADMIN.credential.cert).not.toHaveBeenCalled();
				expect(FAKE_ADMIN.credential.applicationDefault).toHaveBeenCalledTimes(1);
			} finally {
				fs.rmSync(configRoot, { recursive: true, force: true });
			}
		});

		it('still uses cert() for a service-account well-known ADC file', () => {
			const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cabros-adc-'));
			const adcFile = wellKnownAdcPathFor(configRoot);
			fs.mkdirSync(path.dirname(adcFile), { recursive: true });
			fs.writeFileSync(adcFile, VALID_INLINE);

			try {
				const helper = loadHelper({
					FIREBASE_SERVICE_ACCOUNT_JSON: '',
					GOOGLE_APPLICATION_CREDENTIALS: '',
					FIREBASE_PROJECT_ID: 'well-known-project',
					HOME: configRoot,
					APPDATA: configRoot,
				});
				const result = helper.loadFirebaseAdminCredentials();

				expect(result.credentialType).toBe('cert');
				expect(result.projectId).toBe('well-known-project');
				expect(FAKE_ADMIN.credential.applicationDefault).not.toHaveBeenCalled();
			} finally {
				fs.rmSync(configRoot, { recursive: true, force: true });
			}
		});

		it('delegates a workload identity federation (external_account) file to applicationDefault()', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-adc-external-account.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, EXTERNAL_ACCOUNT);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				FIREBASE_PROJECT_ID: 'wif-project',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(result.credentialType).toBe('application_default');
			expect(FAKE_ADMIN.credential.cert).not.toHaveBeenCalled();
		});

		it('fails open with an actionable error when an authorized_user document is inline', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: AUTHORIZED_USER });

			expect(() => helper.loadFirebaseAdminCredentials()).toThrow(helper.FirebaseAdminCredentialsError);
			expect(() => helper.loadFirebaseAdminCredentials()).toThrow(/GOOGLE_APPLICATION_CREDENTIALS/);
			expect(FAKE_ADMIN.credential.applicationDefault).not.toHaveBeenCalled();
		});

		it('does not silently substitute another credential for an inline authorized_user document', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: AUTHORIZED_USER });

			expect(helper.loadFirebaseAdminCredentialsOrNull()).toBeNull();
			expect(FAKE_ADMIN.credential.cert).not.toHaveBeenCalled();
			expect(FAKE_ADMIN.credential.applicationDefault).not.toHaveBeenCalled();
		});

		it('fails open with a typed error when the SDK cannot resolve ADC', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-adc-authorized-user.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, AUTHORIZED_USER);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				FIREBASE_PROJECT_ID: 'adc-project',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const original = FAKE_ADMIN.credential.applicationDefault;
			delete FAKE_ADMIN.credential.applicationDefault;

			let thrown;
			let appOptions;
			try {
				helper.loadFirebaseAdminCredentials();
			} catch (error) {
				thrown = error;
			}
			appOptions = helper.buildFirebaseAppOptions();
			FAKE_ADMIN.credential.applicationDefault = original;
			fs.unlinkSync(tmpFile);

			expect(thrown).toBeInstanceOf(helper.FirebaseAdminCredentialsError);
			expect(thrown.code).toBe('FIREBASE_CREDENTIALS_ADC_UNSUPPORTED');
			expect(appOptions).toEqual({});
		});

		it('fails open when ADC resolution itself throws', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-adc-authorized-user.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, AUTHORIZED_USER);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				FIREBASE_PROJECT_ID: 'adc-project',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			FAKE_ADMIN.credential.applicationDefault.mockImplementationOnce(() => {
				throw new Error('no ADC available');
			});

			const result = helper.loadFirebaseAdminCredentialsOrNull();
			fs.unlinkSync(tmpFile);

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe('priority order', () => {
		it('prefers inline JSON over GOOGLE_APPLICATION_CREDENTIALS when both are configured', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-sa-other.json');
			const OTHER_PROJECT = JSON.stringify({
				type: 'service_account',
				project_id: 'other-project',
				private_key: VALID_PEM,
				client_email: 'svc@other-project.iam.gserviceaccount.com',
			});
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, OTHER_PROJECT);

			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE,
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const result = helper.loadFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(result.source).toBe('inline_json');
			expect(result.projectId).toBe('demo-project');
		});
	});

	describe('buildFirebaseAppOptions integration', () => {
		it('returns app options ready to pass to admin.initializeApp()', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE,
				FIREBASE_PROJECT_ID: 'override-project',
			});
			const options = helper.buildFirebaseAppOptions();
			expect(options.credential).toEqual({ __cert__: true, sa: expect.objectContaining({ project_id: 'demo-project' }) });
			expect(options.projectId).toBe('override-project');
		});

		it('returns an empty options object when no credentials are available', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: '',
				HOME: '/nonexistent-home',
				APPDATA: '',
			});
			const options = helper.buildFirebaseAppOptions();
			expect(options).toEqual({});
		});
	});

	// Issue #1128 regression: a single `null` for both "nothing configured" and
	// "configured but invalid" let storage callers initialize the app with `{}`,
	// entering the SDK default-auth path instead of failing fast to in-memory.
	describe('resolveFirebaseAdminCredentials status distinction (issue #1128)', () => {
		function unconfiguredEnv() {
			return {
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: '',
				HOME: '/nonexistent-home',
				APPDATA: '',
			};
		}

		it('reports UNCONFIGURED (not INVALID) when no credential source is set', () => {
			const helper = loadHelper(unconfiguredEnv());
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.UNCONFIGURED);
			expect(resolved.credentials).toBeNull();
			expect(resolved.appOptions).toEqual({});
			expect(resolved.error).toBeNull();
		});

		it('reports UNCONFIGURED for a FIREBASE_PROJECT_ID-only deployment (ADC path)', () => {
			const helper = loadHelper({ ...unconfiguredEnv(), FIREBASE_PROJECT_ID: 'adc-project' });
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.CONFIGURED);
			expect(resolved.credentials.source).toBe('adc');
			expect(resolved.appOptions).toEqual({ projectId: 'adc-project' });
		});

		it('reports CONFIGURED with app options when inline JSON is valid', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE });
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.CONFIGURED);
			expect(resolved.credentials.source).toBe('inline_json');
			expect(resolved.appOptions.credential).toEqual(expect.anything());
			expect(resolved.appOptions.projectId).toBe('demo-project');
			expect(resolved.error).toBeNull();
		});

		it('reports INVALID with a null appOptions for malformed inline JSON', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON });
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(resolved.credentials).toBeNull();
			expect(resolved.appOptions).toBeNull();
			expect(resolved.error).toBeInstanceOf(helper.FirebaseAdminCredentialsError);
			expect(resolved.error.code).toBe('FIREBASE_CREDENTIALS_INVALID_JSON');
		});

		it('reports INVALID for an unreadable GOOGLE_APPLICATION_CREDENTIALS path', () => {
			const helper = loadHelper({
				...unconfiguredEnv(),
				GOOGLE_APPLICATION_CREDENTIALS: '/tmp/__definitely-not-a-real-credentials-file__.json',
			});
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(resolved.appOptions).toBeNull();
			expect(resolved.error.code).toBe('FIREBASE_CREDENTIALS_UNREADABLE_FILE');
		});

		it('reports INVALID for a credential file containing malformed JSON', () => {
			const tmpFile = path.join(__dirname, '__fixtures__', 'mock-sa-broken.json');
			fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
			fs.writeFileSync(tmpFile, MALFORMED_JSON);

			const helper = loadHelper({
				...unconfiguredEnv(),
				GOOGLE_APPLICATION_CREDENTIALS: tmpFile,
			});
			const resolved = helper.resolveFirebaseAdminCredentials();
			fs.unlinkSync(tmpFile);

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(resolved.appOptions).toBeNull();
			expect(resolved.error).toBeInstanceOf(helper.FirebaseAdminCredentialsError);
		});

		it('reports INVALID when the SDK rejects a malformed credential document', () => {
			// The real `credential.cert()` throws for a service-account document missing
			// required fields; the shared manual mock never throws, so simulate it here.
			const rejectingAdmin = {
				credential: {
					cert: jest.fn(() => {
						throw new Error('Service account object must contain a string "private_key" property.');
					}),
				},
				initializeApp: jest.fn(),
			};
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MISSING_PRIVATE_KEY });
			helper._setAdminForTests(rejectingAdmin);

			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(resolved.appOptions).toBeNull();
			expect(resolved.error.code).toBe('FIREBASE_CREDENTIALS_LOAD_FAILED');
			expect(resolved.error.cause).toBeInstanceOf(Error);
		});

		it('does not fall back to the ADC path when FIREBASE_PROJECT_ID accompanies invalid JSON', () => {
			const helper = loadHelper({
				FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON,
				FIREBASE_PROJECT_ID: 'override-project',
			});
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(resolved.appOptions).toBeNull();
		});

		it('reports INVALID for an inline non-service-account document', () => {
			// Issue #1127 refuses ADC auth for an inline authorized_user document; #1128
		// requires that refusal to also skip initialization instead of reaching initializeApp({}).
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: AUTHORIZED_USER });
			const resolved = helper.resolveFirebaseAdminCredentials();

			expect(resolved.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(resolved.appOptions).toBeNull();
			expect(resolved.error.code).toBe('FIREBASE_CREDENTIALS_UNSUPPORTED_TYPE');
			expect(FAKE_ADMIN.credential.applicationDefault).not.toHaveBeenCalled();
		});
	});

	describe('initializeFirebaseAdminApp (issue #1128)', () => {
		function unconfiguredEnv() {
			return {
				FIREBASE_SERVICE_ACCOUNT_JSON: '',
				GOOGLE_APPLICATION_CREDENTIALS: '',
				HOME: '/nonexistent-home',
				APPDATA: '',
			};
		}

		it('does NOT call initializeApp when configured credentials fail validation', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON });

			const result = helper.initializeFirebaseAdminApp({ admin: FAKE_ADMIN });

			expect(result.ok).toBe(false);
			expect(result.status).toBe(helper.CREDENTIAL_STATUS.INVALID);
			expect(FAKE_ADMIN.initializeApp).not.toHaveBeenCalled();
		});

		it('still calls initializeApp({}) for an unconfigured ADC deployment', () => {
			const helper = loadHelper(unconfiguredEnv());

			const result = helper.initializeFirebaseAdminApp({ admin: FAKE_ADMIN });

			expect(result.ok).toBe(true);
			expect(result.status).toBe(helper.CREDENTIAL_STATUS.UNCONFIGURED);
			expect(FAKE_ADMIN.initializeApp).toHaveBeenCalledWith({});
		});

		it('passes the resolved credential to initializeApp when configuration is valid', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: VALID_INLINE });

			const result = helper.initializeFirebaseAdminApp({ admin: FAKE_ADMIN });

			expect(result.ok).toBe(true);
			expect(FAKE_ADMIN.initializeApp).toHaveBeenCalledWith(
				expect.objectContaining({ credential: expect.anything(), projectId: 'demo-project' })
			);
		});

		it('reuses an already-initialized app and does not re-resolve credentials', () => {
			const helper = loadHelper({ FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON });
			const admin = { apps: [{ name: '[DEFAULT]' }], initializeApp: jest.fn() };

			const result = helper.initializeFirebaseAdminApp({ admin });

			expect(result.ok).toBe(true);
			expect(result.status).toBe(helper.CREDENTIAL_STATUS.ALREADY_INITIALIZED);
			expect(admin.initializeApp).not.toHaveBeenCalled();
		});
	});
});
