'use strict';

/**
 * Issue #1128: storage callers must skip Firebase initialization immediately when
 * a credential source is configured but fails validation, instead of calling
 * `admin.initializeApp({})` and entering the SDK default-auth path.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MALFORMED_JSON = '{ "project_id": "demo-project", "type": "service_account" ';
const MISSING_GAC_FILE = '/tmp/__issue-1128-not-a-real-credentials-file__.json';

const SERVICE_CASES = [
	{
		label: 'IdempotencyStorageService',
		featureEnv: 'ENABLE_FIRESTORE_IDEMPOTENCY',
		featureValue: 'true',
		load(env) {
			process.env.ENABLE_FIRESTORE_IDEMPOTENCY = 'true';
			delete process.env.ENABLE_FIRESTORE_IDEMPOTENCY_STORAGE;
			const admin = require('firebase-admin');
			const service = require('../../src/services/storage/IdempotencyStorageService');
			service._resetForTesting();
			return { admin, getFirestore: service.getFirestore };
		},
		extraCleanup() {
			const service = require('../../src/services/storage/IdempotencyStorageService');
			service._resetForTesting();
		},
	},
	{
		label: 'NewsDedupStorageService',
		featureEnv: 'ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP',
		featureValue: 'true',
		load() {
			process.env.ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP = 'true';
			const admin = require('firebase-admin');
			const service = require('../../src/services/storage/NewsDedupStorageService');
			service._resetForTesting();
			return { admin, getFirestore: service.getFirestore };
		},
		extraCleanup() {
			const service = require('../../src/services/storage/NewsDedupStorageService');
			service._resetForTesting();
		},
	},
	{
		label: 'AlertStorageService',
		featureEnv: 'ENABLE_FIRESTORE_ALERT_STORAGE',
		featureValue: 'true',
		load() {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const admin = require('firebase-admin');
			const service = require('../../src/services/storage/AlertStorageService');
			service._resetForTesting();
			return { admin, getFirestore: service.getFirestore };
		},
		extraCleanup() {
			const service = require('../../src/services/storage/AlertStorageService');
			service._resetForTesting();
		},
	},
	{
		label: 'ChatPreferenceService',
		featureEnv: 'ENABLE_FIRESTORE_CHAT_PREFERENCES',
		featureValue: 'true',
		load() {
			process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES = 'true';
			const admin = require('firebase-admin');
			const service = require('../../src/services/preferences/ChatPreferenceService');
			const instance = new service.ChatPreferenceService();
			return { admin, getFirestore: () => instance.getFirestore() };
		},
		extraCleanup() {},
	},
];

const CREDENTIAL_FAILURES = [
	{
		label: 'malformed inline JSON',
		env: { FIREBASE_SERVICE_ACCOUNT_JSON: MALFORMED_JSON },
	},
	{
		label: 'explicit credential path that does not exist',
		env: { FIREBASE_SERVICE_ACCOUNT_JSON: '', GOOGLE_APPLICATION_CREDENTIALS: MISSING_GAC_FILE },
	},
	{
		label: 'credential file containing a malformed document',
		credentialFileContents: MALFORMED_JSON,
	},
];

function unconfiguredEnv() {
	return {
		FIREBASE_SERVICE_ACCOUNT_JSON: '',
		GOOGLE_APPLICATION_CREDENTIALS: '',
		HOME: '/nonexistent-home-issue-1128',
		APPDATA: '',
	};
}

describe('configured Firebase credential failures skip initialization (issue #1128)', () => {
	const originalEnv = { ...process.env };
	let tempDir;

	beforeAll(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'issue-1128-'));
	});

	afterAll(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	beforeEach(() => {
		jest.resetModules();
		const admin = require('firebase-admin');
		admin.__resetApps();
		admin.__mockInitializeApp.mockClear();
		admin.__mockCert.mockClear();
		Object.keys(process.env).forEach((key) => {
			if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
				delete process.env[key];
			}
		});
		Object.assign(process.env, originalEnv);
		process.env.HOME = '/nonexistent-home-issue-1128';
		process.env.APPDATA = '';
	});

	afterEach(() => {
		for (const serviceCase of SERVICE_CASES) {
			serviceCase.extraCleanup();
		}
	});

	describe.each(SERVICE_CASES)('$label', (serviceCase) => {
		describe.each(CREDENTIAL_FAILURES)('with $label', (failure) => {
			it('returns null and never calls admin.initializeApp', () => {
				Object.assign(process.env, unconfiguredEnv(), failure.env);

				if (failure.credentialFileContents !== undefined) {
					const filePath = path.join(tempDir, 'service-account.json');
					fs.writeFileSync(filePath, failure.credentialFileContents);
					process.env.GOOGLE_APPLICATION_CREDENTIALS = filePath;
				}

				const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
				jest.spyOn(console, 'debug').mockImplementation(() => {});

				const { admin, getFirestore } = serviceCase.load();
				const result = getFirestore();

				expect(result).toBeNull();
				expect(admin.__mockInitializeApp).not.toHaveBeenCalled();
				expect(warnSpy.mock.calls.flat().join(' ')).toContain(serviceCase.label);

				warnSpy.mockRestore();
				jest.restoreAllMocks();
			});
		});

		it('retains the ADC default-auth path when no credential source is configured', () => {
			Object.assign(process.env, unconfiguredEnv());

			jest.spyOn(console, 'debug').mockImplementation(() => {});
			const { admin, getFirestore } = serviceCase.load();
			const result = getFirestore();

			expect(result).not.toBeNull();
			expect(admin.__mockInitializeApp).toHaveBeenCalledWith({});

			jest.restoreAllMocks();
		});
	});
});