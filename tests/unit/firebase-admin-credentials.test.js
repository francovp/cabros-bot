'use strict';

const path = require('path');
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

const FAKE_ADMIN = {
	credential: { cert: jest.fn((sa) => ({ __cert__: true, sa })) },
	initializeApp: jest.fn(),
};

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
});
