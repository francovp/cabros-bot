'use strict';

const request = require('supertest');
const express = require('express');
const { generateKeyPairSync } = require('crypto');

jest.mock('firebase-admin');
const admin = require('firebase-admin');
const { validateAdminAccess, requireAdminRole } = require('../../src/lib/adminAuth');
const requestDeadline = require('../../src/lib/requestDeadline');
const rateLimiter = require('../../src/lib/rateLimiter');

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

function createApp() {
	const app = express();
	app.get('/read', validateAdminAccess, requireAdminRole('admin.viewer'), (req, res) => {
		res.json({ role: req.adminRole });
	});
	app.post('/write', validateAdminAccess, requireAdminRole('admin.operator'), (req, res) => {
		res.json({ role: req.adminRole });
	});
	return app;
}

describe('Firebase admin authorization', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		process.env.FIREBASE_PROJECT_ID = 'test-project';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = serviceAccount;
		admin.__resetApps();
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		admin.auth?.mockReset?.();
	});

	it('accepts a verified viewer token for reads but rejects it for operator actions', async () => {
		const verifyIdToken = jest.fn().mockResolvedValue({
			uid: 'viewer-1',
			roles: ['admin.viewer'],
		});
		admin.auth = jest.fn(() => ({ verifyIdToken }));

		const app = createApp();
		const read = await request(app).get('/read').set('Authorization', 'Bearer firebase-token');
		const write = await request(app).post('/write').set('Authorization', 'Bearer firebase-token');

		expect(read.status).toBe(200);
		expect(read.body).toEqual({ role: 'admin.viewer' });
		expect(write.status).toBe(403);
		expect(write.body.code).toBe('ADMIN_ROLE_REQUIRED');
		expect(verifyIdToken).toHaveBeenCalledWith('firebase-token', true);
	});

	it('does not enter the route when async token verification outlives the request deadline', async () => {
		requestDeadline.setTestOverrides({ timeoutMs: 20 });
		let releaseVerification;
		admin.auth = jest.fn(() => ({
			verifyIdToken: jest.fn(() => new Promise((resolve) => {
				releaseVerification = resolve;
			})),
		}));
		let handlerCalled = false;
		const app = express();
		app.use(requestDeadline);
		app.use(rateLimiter);
		app.get('/read', validateAdminAccess, (req, res) => {
			handlerCalled = true;
			res.json({ role: req.adminRole });
		});

		try {
			const responsePromise = request(app)
				.get('/read')
				.set('Authorization', 'Bearer slow-token');
			await new Promise((resolve) => setTimeout(resolve, 35));
			const response = await responsePromise;
			releaseVerification({ uid: 'viewer-1', roles: ['admin.viewer'] });
			await new Promise((resolve) => setImmediate(resolve));

			expect(response.status).toBe(408);
			expect(handlerCalled).toBe(false);
		} finally {
			requestDeadline.resetForTests();
		}
	});

	it.each(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/argument-error'])
		('fails closed without exposing a %s verification error', async (code) => {
			const verifyIdToken = jest.fn().mockRejectedValue({ code, message: 'token must not leak' });
			admin.auth = jest.fn(() => ({ verifyIdToken }));

			const response = await request(createApp())
				.get('/read')
				.set('Authorization', 'Bearer secret-firebase-token');

			expect(response.status).toBe(401);
			expect(response.body).toEqual({ error: 'Unauthorized', code: 'ADMIN_AUTH_INVALID' });
			expect(JSON.stringify(response.body)).not.toContain('secret-firebase-token');
		});

	it('rejects a valid Firebase identity without an admin role', async () => {
		admin.auth = jest.fn(() => ({
			verifyIdToken: jest.fn().mockResolvedValue({ uid: 'unprivileged-user' }),
		}));

		const response = await request(createApp())
			.get('/read')
			.set('Authorization', 'Bearer valid-but-unprivileged-token');

		expect(response.status).toBe(403);
		expect(response.body.code).toBe('ADMIN_ROLE_REQUIRED');
	});

	it('keeps the legacy API-key path as an operator fallback while Firebase auth is enabled', async () => {
		process.env.WEBHOOK_API_KEY = 'legacy-key';
		admin.auth = jest.fn();

		const response = await request(createApp())
			.get('/read')
			.set('x-api-key', 'legacy-key');

		expect(response.status).toBe(200);
		expect(response.body).toEqual({ role: 'admin.operator' });
		expect(admin.auth).not.toHaveBeenCalled();
	});

	it('keeps invalid legacy API keys as a forbidden response in Firebase mode', async () => {
		process.env.WEBHOOK_API_KEY = 'legacy-key';

		const response = await request(createApp())
			.get('/read')
			.set('x-api-key', 'wrong-key');

		expect(response.status).toBe(403);
		expect(response.body).toEqual({ error: 'Forbidden: Invalid API key' });
	});

	it('accepts a valid API key when an invalid Firebase bearer token is also supplied', async () => {
		process.env.WEBHOOK_API_KEY = 'legacy-key';
		admin.auth = jest.fn(() => ({
			verifyIdToken: jest.fn().mockRejectedValue(new Error('expired token')),
		}));

		const response = await request(createApp())
			.get('/read')
			.set('Authorization', 'Bearer expired-token')
			.set('x-api-key', 'legacy-key');

		expect(response.status).toBe(200);
		expect(response.body).toEqual({ role: 'admin.operator' });
	});

	it('preserves the existing API-key middleware behavior when Firebase auth is disabled', async () => {
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
		delete process.env.WEBHOOK_API_KEY;

		const response = await request(createApp()).get('/read');

		expect(response.status).toBe(200);
		expect(response.body).toEqual({ role: 'admin.operator' });
	});
});
