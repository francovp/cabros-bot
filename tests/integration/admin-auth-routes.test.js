'use strict';

const request = require('supertest');
const express = require('express');
const { generateKeyPairSync } = require('crypto');
const admin = require('firebase-admin');
const { getRoutes } = require('../../src/routes');

jest.mock('firebase-admin');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});

describe('Firebase admin route authorization', () => {
	let savedEnv;
	let app;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		process.env.WEBHOOK_API_KEY = 'legacy-key';
		process.env.FIREBASE_PROJECT_ID = 'test-project';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			type: 'service_account',
			project_id: 'test-project',
			client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
			private_key: privateKey,
		});
		admin.__resetApps();
		admin.auth = jest.fn(() => ({
			verifyIdToken: jest.fn().mockResolvedValue({
				uid: 'viewer-1',
				roles: ['admin.viewer'],
			}),
		}));
		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));
	});

	afterEach(() => restoreEnv(savedEnv));

	it('accepts a Firebase viewer token on read-only admin routes', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('Authorization', 'Bearer firebase-token');

		expect(response.status).toBe(200);
	});

	it('rejects a Firebase viewer token on mutating admin routes', async () => {
		const response = await request(app)
			.post('/api/scanner-presets')
			.set('Authorization', 'Bearer firebase-token')
			.send({ name: 'blocked' });

		expect(response.status).toBe(403);
		expect(response.body.code).toBe('ADMIN_ROLE_REQUIRED');
	});

	it('keeps Firebase bearer tokens out of protected webhook authentication', async () => {
		const response = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('Authorization', 'Bearer firebase-token')
			.send({ symbol: 'BINANCE:BTCUSDT' });

		expect(response.status).toBe(401);
	});
});
