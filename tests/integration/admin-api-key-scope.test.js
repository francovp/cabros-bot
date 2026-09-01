'use strict';

const request = require('supertest');
const express = require('express');
const { generateKeyPairSync } = require('crypto');
const { getRoutes } = require('../../src/routes');

jest.mock('firebase-admin');

const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
	type: 'pkcs1',
	format: 'pem',
});

function configureFirebaseMocks() {
	const admin = require('firebase-admin');
	admin.__resetApps();
	admin.auth = jest.fn(() => ({
		verifyIdToken: jest.fn().mockResolvedValue({
			uid: 'viewer-1',
			roles: ['admin.viewer'],
		}),
	}));
}

function makeApp() {
	const app = express();
	app.use(express.json());
	app.use('/api', getRoutes(() => null));
	return app;
}

describe('Admin/operator API key scope separation', () => {
	let savedEnv;
	let app;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		process.env.WEBHOOK_API_KEY = 'webhook-only';
		process.env.ADMIN_API_KEY = 'admin-only';
		process.env.FIREBASE_PROJECT_ID = 'test-project';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			type: 'service_account',
			project_id: 'test-project',
			client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
			private_key: privateKey,
		});
		configureFirebaseMocks();
		app = makeApp();
	});

	afterEach(() => restoreEnv(savedEnv));

	it('rejects the webhook API key on /api/alerts (admin surface)', async () => {
		const response = await request(app)
			.get('/api/alerts')
			.set('x-api-key', 'webhook-only');

		expect(response.status).toBe(403);
		expect(response.body).toEqual({ error: 'Forbidden: Invalid API key' });
	});

	it('rejects the webhook API key on /api/status (admin surface)', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'webhook-only');

		expect(response.status).toBe(403);
	});

	it('rejects the webhook API key on /api/jobs (admin surface)', async () => {
		const response = await request(app)
			.get('/api/jobs')
			.set('x-api-key', 'webhook-only');

		expect(response.status).toBe(403);
	});

	it('accepts the admin API key on /api/alerts (admin surface)', async () => {
		// /api/alerts without ENABLE_FIRESTORE_ALERT_STORAGE returns
		// 403 FEATURE_DISABLED; with it the list is empty (200). Both prove
		// the admin key passed the auth gate. A 401/403 "Invalid API key"
		// would mean auth failed; assert the body to confirm the gate passed.
		const response = await request(app)
			.get('/api/alerts')
			.set('x-api-key', 'admin-only');

		if (response.status === 401 || (response.status === 403 && response.body.code === undefined)) {
			throw new Error(`Auth failed: ${response.status} ${JSON.stringify(response.body)}`);
		}
		expect([200, 403]).toContain(response.status);
	});

	it('accepts the admin API key on /api/status (admin surface)', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('x-api-key', 'admin-only');

		expect(response.status).toBe(200);
	});

	it('still accepts the webhook API key on /api/webhook/alert', async () => {
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'webhook-only')
			.send({ text: 'hello' });

		expect(response.status).toBe(200);
	});

	it('rejects the admin API key on /api/webhook/alert (scope boundary)', async () => {
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'admin-only')
			.send({ text: 'hello' });

		// `validateApiKey` returns 403 when a key was supplied but did not
		// match WEBHOOK_API_KEY (the admin key is intentionally not a webhook
		// credential). The key-vs-no-key distinction is a `validateApiKey`
		// detail; the scope-boundary contract is that the admin key alone
		// does not authenticate the webhook ingest path.
		expect(response.status).toBe(403);
		expect(response.body).toEqual({ error: 'Forbidden: Invalid API key' });
	});

	it('keeps Firebase bearer tokens as the browser-admin path', async () => {
		const response = await request(app)
			.get('/api/status')
			.set('Authorization', 'Bearer firebase-token');

		expect(response.status).toBe(200);
	});

	it('returns ADMIN_AUTH_UNAVAILABLE on Binance trading routes when no key is set and Firebase is disabled', async () => {
		const previousAdmin = process.env.ADMIN_API_KEY;
		const previousWebhook = process.env.WEBHOOK_API_KEY;
		const previousFirebase = process.env.ENABLE_FIREBASE_ADMIN_AUTH;
		const previousTrading = process.env.BINANCE_TRADING_API_KEY;
		delete process.env.ADMIN_API_KEY;
		delete process.env.WEBHOOK_API_KEY;
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
		delete process.env.BINANCE_TRADING_API_KEY;
		app = makeApp();

		try {
			const response = await request(app).get('/api/trading/binance/orders');
			expect(response.status).toBe(503);
			expect(response.body.code).toBe('ADMIN_AUTH_UNAVAILABLE');
		} finally {
			process.env.ADMIN_API_KEY = previousAdmin;
			process.env.WEBHOOK_API_KEY = previousWebhook;
			process.env.ENABLE_FIREBASE_ADMIN_AUTH = previousFirebase;
			process.env.BINANCE_TRADING_API_KEY = previousTrading;
		}
	});
});

describe('Binance trading API key scope separation', () => {
	let savedEnv;
	let app;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'true';
		process.env.WEBHOOK_API_KEY = 'webhook-only';
		process.env.ADMIN_API_KEY = 'admin-only';
		process.env.BINANCE_TRADING_API_KEY = 'trading-only';
		process.env.FIREBASE_PROJECT_ID = 'test-project';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			type: 'service_account',
			project_id: 'test-project',
			client_email: 'firebase-adminsdk@test-project.iam.gserviceaccount.com',
			private_key: privateKey,
		});
		configureFirebaseMocks();
		app = makeApp();
	});

	afterEach(() => restoreEnv(savedEnv));

	it('rejects the webhook API key on POST /api/trading/binance/orders', async () => {
		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'webhook-only')
			.send({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 });

		expect(response.status).toBe(403);
	});

	it('rejects the admin API key on POST /api/trading/binance/orders when a trading key is configured', async () => {
		const response = await request(app)
			.post('/api/trading/binance/orders')
			.set('x-api-key', 'admin-only')
			.send({ symbol: 'BTCUSDT', side: 'BUY', quantity: 1 });

		expect(response.status).toBe(403);
	});

	it('accepts the trading API key on GET /api/trading/binance/orders', async () => {
		const response = await request(app)
			.get('/api/trading/binance/orders')
			.set('x-api-key', 'trading-only');

		// The trading endpoint can return 200 (success), 400 (bad query),
		// 403 (FEATURE_DISABLED when ENABLE_BINANCE_TRADING != true), or
		// 502/503 (Binance unavailable). The auth gate MUST have passed,
		// so a 401 or a 403 "Invalid API key" would be a regression.
		if (response.status === 401) {
			throw new Error(`Auth failed with 401: ${JSON.stringify(response.body)}`);
		}
		if (response.status === 403 && /Invalid API key/i.test(response.body.error || '')) {
			throw new Error(`Auth failed with 403: ${JSON.stringify(response.body)}`);
		}
		expect([200, 400, 403, 502, 503]).toContain(response.status);
	});

	it('falls back to admin auth on the trading path when BINANCE_TRADING_API_KEY is unset', async () => {
		delete process.env.BINANCE_TRADING_API_KEY;
		app = makeApp();

		const response = await request(app)
			.get('/api/trading/binance/orders')
			.set('x-api-key', 'admin-only');

		// Same auth-pass contract: 200/400/403 FEATURE_DISABLED/502/503 are
		// all acceptable; 401 or 403 "Invalid API key" is a regression.
		if (response.status === 401) {
			throw new Error(`Auth failed with 401: ${JSON.stringify(response.body)}`);
		}
		if (response.status === 403 && /Invalid API key/i.test(response.body.error || '')) {
			throw new Error(`Auth failed with 403: ${JSON.stringify(response.body)}`);
		}
		expect([200, 400, 403, 502, 503]).toContain(response.status);
	});
});
