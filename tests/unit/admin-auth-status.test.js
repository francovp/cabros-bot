/* global saveEnv, restoreEnv */
'use strict';

const { generateKeyPairSync } = require('crypto');

jest.mock('firebase-admin');
jest.mock('../../src/services/storage/firestoreConfig', () => ({
	isFirestoreConfigured: jest.fn(() => false),
}));
const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../../src/services/storage/firestoreConfig');
const adminAuth = require('../../src/lib/adminAuth');
const httpMocks = require('node-mocks-http');

const { getAdminAuthStatus, isAdminAuthVerifierConfigured, validateAdminAccess, resetAdminAuthReadinessForTesting } = adminAuth;

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});

const serviceAccount = JSON.stringify({
	type: 'service_account',
	project_id: 'test-project',
	client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
	private_key: privateKey,
});

describe('admin auth status projection (issue #1134)', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		resetAdminAuthReadinessForTesting();
		admin.__resetApps();
		admin.initializeApp.mockReset();
		// Hermetic by default: a developer machine may hold a well-known gcloud
		// ADC file, which would make credential *shape* true no matter which
		// variables a test deletes.
		isFirestoreConfigured.mockReturnValue(false);
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete process.env.WEBHOOK_API_KEY;
		delete process.env.FIREBASE_WEB_API_KEY;
		delete process.env.FIREBASE_AUTH_DOMAIN;
		delete process.env.FIREBASE_PROJECT_ID;
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		resetAdminAuthReadinessForTesting();
		admin.__resetApps();
		admin.auth?.mockReset?.();
	});

	function enableWithCredentials() {
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount;
		isFirestoreConfigured.mockReturnValue(true);
	}

	describe('gate projection', () => {
		it('reports disabled with no provider or readiness when the gate is unset', () => {
			expect(getAdminAuthStatus()).toMatchObject({
				enabled: false,
				provider: null,
				signIn: null,
				verifierConfigured: false,
				browserConfigConfigured: false,
				ready: false,
				status: 'disabled',
			});
		});

		it('reports disabled for any non-"true" gate value', () => {
			for (const value of ['TRUE', '1', 'yes', '', 'false']) {
				process.env.ENABLE_FIREBASE_ADMIN_AUTH = value;
				expect(getAdminAuthStatus().status).toBe('disabled');
				expect(getAdminAuthStatus().enabled).toBe(false);
			}
		});

		it('reports misconfigured when enabled without server-side verifier credentials', () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			expect(isAdminAuthVerifierConfigured()).toBe(false);
			expect(getAdminAuthStatus()).toMatchObject({
				enabled: true,
				verifierConfigured: false,
				ready: false,
				status: 'misconfigured',
			});
		});

		it('reports misconfigured rather than ready even when browser config is complete', () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			process.env.FIREBASE_WEB_API_KEY = 'web-key';
			process.env.FIREBASE_AUTH_DOMAIN = 'test.firebaseapp.com';
			process.env.FIREBASE_PROJECT_ID = 'test-project';
			expect(getAdminAuthStatus()).toMatchObject({
				browserConfigConfigured: true,
				verifierConfigured: false,
				ready: false,
				status: 'misconfigured',
			});
		});

		it('reports unverified — not ready — when only credential shape is present', () => {
			enableWithCredentials();
			expect(getAdminAuthStatus()).toMatchObject({
				enabled: true,
				provider: 'firebase',
				signIn: 'email-password',
				verifierConfigured: true,
				ready: false,
				status: 'unverified',
			});
		});

		it('treats an already-initialized Firebase app as a usable verifier', () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			admin.__setApps([{ name: 'existing' }]);
			expect(isAdminAuthVerifierConfigured()).toBe(true);
			expect(getAdminAuthStatus().status).toBe('unverified');
		});
	});

	describe('never leaks credentials', () => {
		it('exposes no Firebase Web config values, only shape booleans', () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount;
			process.env.FIREBASE_WEB_API_KEY = 'super-secret-web-key';
			process.env.FIREBASE_AUTH_DOMAIN = 'test.firebaseapp.com';
			process.env.FIREBASE_PROJECT_ID = 'test-project';

			const status = getAdminAuthStatus();
			const serialized = JSON.stringify(status);
			expect(status.browserConfigConfigured).toBe(true);
			expect(serialized).not.toContain('super-secret-web-key');
			expect(serialized).not.toContain('test.firebaseapp.com');
			expect(serialized).not.toContain('test-project');
			expect(serialized).not.toContain(privateKey);
		});
	});

	describe('api key fallback reporting', () => {
		it('reports the legacy API-key fallback as unconfigured when WEBHOOK_API_KEY is absent', () => {
			enableWithCredentials();
			expect(getAdminAuthStatus().apiKeyFallbackConfigured).toBe(false);
		});

		it('reports the legacy API-key fallback as configured when WEBHOOK_API_KEY is set', () => {
			enableWithCredentials();
			process.env.WEBHOOK_API_KEY = 'shared-key';
			expect(getAdminAuthStatus().apiKeyFallbackConfigured).toBe(true);
		});

		it('treats a whitespace-only WEBHOOK_API_KEY as unconfigured', () => {
			process.env.WEBHOOK_API_KEY = '   ';
			expect(getAdminAuthStatus().apiKeyFallbackConfigured).toBe(false);
		});
	});

	describe('observed readiness', () => {
		function mockVerify(verifyIdToken) {
			admin.auth = jest.fn(() => ({ verifyIdToken }));
			return verifyIdToken;
		}

		async function callWithBearer(token) {
			const req = httpMocks.createRequest({ headers: { authorization: `Bearer ${token}` } });
			const res = httpMocks.createResponse();
			const next = jest.fn();
			await validateAdminAccess(req, res, next);
			return { res, next };
		}

		beforeEach(() => {
			enableWithCredentials();
		});

		it('stays unverified and not ready until a token actually verifies', () => {
			expect(getAdminAuthStatus().status).toBe('unverified');
			expect(getAdminAuthStatus().ready).toBe(false);
		});

		it('reports ready after a viewer token verifies', async () => {
			mockVerify(jest.fn().mockResolvedValue({ uid: 'viewer-1', roles: ['admin.viewer'] }));
			await callWithBearer('valid-token');

			const status = getAdminAuthStatus();
			expect(status.status).toBe('ready');
			expect(status.ready).toBe(true);
			expect(status.verificationSuccessCount).toBe(1);
			expect(status.consecutiveFailures).toBe(0);
			expect(typeof status.lastSuccessAt).toBe('string');
		});

		it('records verification success even when the token carries no admin role', async () => {
			mockVerify(jest.fn().mockResolvedValue({ uid: 'plain-user' }));
			const { res } = await callWithBearer('valid-token');

			expect(res.statusCode).toBe(403);
			// The token verified, which is the readiness evidence; the missing
			// role is an authorization outcome, not a provider failure.
			expect(getAdminAuthStatus()).toMatchObject({ status: 'ready', ready: true });
		});

		it('reports degraded when the Firebase Admin SDK cannot initialize despite valid credential shape', async () => {
			enableWithCredentials();
			admin.initializeApp.mockImplementation(() => {
				throw new Error('Invalid service account credential');
			});
			mockVerify(jest.fn());

			const { res } = await callWithBearer('any-token');
			expect(res.statusCode).toBe(503);

			const status = getAdminAuthStatus();
			expect(status.verifierConfigured).toBe(true);
			expect(status.status).toBe('degraded');
			expect(status.ready).toBe(false);
			expect(status.verifierUnavailableCount).toBe(1);
			expect(status.consecutiveFailures).toBe(1);
			expect(typeof status.lastUnavailableAt).toBe('string');
		});

		it('reports degraded when the SDK exposes no auth() entry point', async () => {
			enableWithCredentials();
			admin.auth = undefined;

			const { res } = await callWithBearer('any-token');
			expect(res.statusCode).toBe(503);
			expect(getAdminAuthStatus().status).toBe('degraded');
		});

		it('prefers misconfigured over degraded when credential shape is already knowably absent', async () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			isFirestoreConfigured.mockReturnValue(false);
			mockVerify(jest.fn());

			const { res } = await callWithBearer('any-token');
			expect(res.statusCode).toBe(503);

			const status = getAdminAuthStatus();
			expect(status.status).toBe('misconfigured');
			expect(status.consecutiveFailures).toBe(1);
		});

		it('self-heals back to ready on the next successful verification without a restart', async () => {
			enableWithCredentials();
			admin.initializeApp.mockImplementation(() => {
				throw new Error('Invalid service account credential');
			});
			mockVerify(jest.fn());
			await callWithBearer('any-token');
			expect(getAdminAuthStatus().status).toBe('degraded');

			admin.initializeApp.mockImplementation(() => ({}));
			admin.__resetApps();
			mockVerify(jest.fn().mockResolvedValue({ uid: 'admin', roles: ['admin.operator'] }));
			await callWithBearer('valid-token');

			expect(getAdminAuthStatus()).toMatchObject({
				status: 'ready',
				ready: true,
				consecutiveFailures: 0,
				verificationSuccessCount: 1,
				verifierUnavailableCount: 1,
			});
		});

		it('never latches degraded when the gate is switched off', async () => {
			enableWithCredentials();
			admin.initializeApp.mockImplementation(() => {
				throw new Error('Invalid service account credential');
			});
			mockVerify(jest.fn());
			await callWithBearer('any-token');
			expect(getAdminAuthStatus().status).toBe('degraded');

			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'false';
			expect(getAdminAuthStatus()).toMatchObject({ status: 'disabled', ready: false, enabled: false });
		});

		it('does NOT degrade on a rejected token, so an unauthenticated caller cannot forge an outage', async () => {
			mockVerify(jest.fn().mockRejectedValue(new Error('Firebase ID token has expired')));

			const { res } = await callWithBearer('garbage-token');
			expect(res.statusCode).toBe(401);

			const status = getAdminAuthStatus();
			expect(status.status).toBe('unverified');
			expect(status.ready).toBe(false);
			expect(status.consecutiveFailures).toBe(0);
			expect(status.verificationSuccessCount).toBe(0);
			expect(status.verifierUnavailableCount).toBe(0);
		});

		it('does NOT degrade on repeated random bearer tokens', async () => {
			mockVerify(jest.fn().mockRejectedValue(new Error('Decoding Firebase ID token failed')));
			for (let i = 0; i < 5; i += 1) {
				await callWithBearer(`not-a-real-token-${i}`);
			}
			expect(getAdminAuthStatus()).toMatchObject({
				status: 'unverified',
				consecutiveFailures: 0,
				verifierUnavailableCount: 0,
			});
		});

		it('does not record anything for the API-key path', async () => {
			mockVerify(jest.fn().mockRejectedValue(new Error('unused')));
			const req = httpMocks.createRequest({ headers: { 'x-api-key': 'shared-key' } });
			const res = httpMocks.createResponse();
			const next = jest.fn();
			process.env.WEBHOOK_API_KEY = 'shared-key';

			await validateAdminAccess(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(getAdminAuthStatus()).toMatchObject({
				status: 'unverified',
				verificationSuccessCount: 0,
				consecutiveFailures: 0,
			});
		});
	});

	describe('fail-open telemetry', () => {
		it('never throws when the clock is unusable', () => {
			expect(() => adminAuth.recordAdminAuthReadiness('success')).not.toThrow();
			expect(() => adminAuth.recordAdminAuthReadiness('unavailable')).not.toThrow();
			expect(() => adminAuth.recordAdminAuthReadiness(undefined)).not.toThrow();
		});

		it('ignores an unknown outcome instead of counting it as a failure', () => {
			adminAuth.recordAdminAuthReadiness('something-else');
			expect(getAdminAuthStatus()).toMatchObject({
				consecutiveFailures: 0,
				verifierUnavailableCount: 0,
				verificationSuccessCount: 0,
			});
		});

		it('never throws when the firebase-admin module shape is hostile', () => {
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
			admin.__setApps('not-an-array');
			expect(() => isAdminAuthVerifierConfigured()).not.toThrow();
			expect(() => getAdminAuthStatus()).not.toThrow();
		});
	});
});