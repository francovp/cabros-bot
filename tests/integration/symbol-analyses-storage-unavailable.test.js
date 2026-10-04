'use strict';

jest.mock('firebase-admin');
const admin = require('firebase-admin');
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const symbolAnalysisStorageService = require('../../src/services/storage/SymbolAnalysisStorageService');
const { getRoutes } = require('../../src/routes');

const providerError = () => {
	const error = new Error(
		'7 PERMISSION_DENIED: Missing or insufficient permissions. Resource: projects/demo-cabros/databases/(default)',
	);
	error.code = 7;
	return error;
};

describe('Symbol analyses read failures (enabled but unreachable Firestore)', () => {
	let savedEnv;
	let app;

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.keys(process.env).forEach((key) => {
			delete process.env[key];
		});
		process.env.NODE_ENV = 'test';
		process.env.WEBHOOK_API_KEY = 'test-key';
		process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
		process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
			type: 'service_account',
			project_id: 'demo-cabros',
			client_email: 'firebase-adminsdk@demo-cabros.iam.gserviceaccount.com',
			private_key: crypto.generateKeyPairSync('rsa', {
				modulusLength: 2048,
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			}).privateKey,
		});

		admin.__resetApps();
		admin.__resetCollectionState();
		symbolAnalysisStorageService.__resetForTesting();
		admin.__mockGet.mockReset();

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		admin.__mockGet.mockReset();
		symbolAnalysisStorageService.__resetForTesting();
	});

	it('answers 503 STORAGE_UNAVAILABLE instead of 500 when the list query is rejected', async () => {
		admin.__mockGet.mockReturnValue(Promise.reject(providerError()));

		const res = await request(app)
			.get('/api/symbol-analyses')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
		expect(res.body.error).toContain('Firestore is unavailable');
		expect(res.body.error).not.toContain('demo-cabros');
		expect(res.body.error).not.toContain('PERMISSION_DENIED');

		const status = symbolAnalysisStorageService.getStatus();
		expect(status.readsFailed).toBe(1);
		expect(status.status).toBe('degraded');
		expect(status.lastErrorReason).toBe('firestore_unavailable');
	});

	it('answers 503 STORAGE_UNAVAILABLE instead of 500 when the summary query is rejected', async () => {
		admin.__mockGet.mockReturnValue(Promise.reject(providerError()));

		const res = await request(app)
			.get('/api/symbol-analyses/summary')
			.set('x-api-key', 'test-key')
			.expect(503);

		expect(res.body.code).toBe('STORAGE_UNAVAILABLE');
		expect(res.body.error).not.toContain('demo-cabros');

		expect(symbolAnalysisStorageService.getStatus().readsFailed).toBe(1);
	});

	it('keeps answering 200 once Firestore reads succeed again', async () => {
		admin.__mockGet.mockReturnValue(Promise.reject(providerError()));
		await request(app).get('/api/symbol-analyses').set('x-api-key', 'test-key').expect(503);

		admin.__mockGet.mockReset();
		const res = await request(app)
			.get('/api/symbol-analyses')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(res.body.success).toBe(true);

		const status = symbolAnalysisStorageService.getStatus();
		expect(status.readsSucceeded).toBe(1);
		expect(status.consecutiveFailures).toBe(0);
		expect(status.lastErrorReason).toBeNull();
	});
});