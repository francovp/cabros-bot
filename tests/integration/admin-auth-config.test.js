'use strict';

const express = require('express');
const request = require('supertest');
const { getOpenApiDocsRouter } = require('../../src/openapi/docs');

describe('Firebase admin browser configuration', () => {
	let savedEnv;
	let app;

	beforeEach(() => {
		savedEnv = saveEnv();
		app = express();
		app.use(getOpenApiDocsRouter());
	});

	afterEach(() => restoreEnv(savedEnv));

	it('returns only the public Firebase web configuration when enabled', async () => {
		Object.assign(process.env, {
			ENABLE_FIREBASE_ADMIN_AUTH: 'true',
			FIREBASE_WEB_API_KEY: 'public-api-key',
			FIREBASE_AUTH_DOMAIN: 'cabros.firebaseapp.com',
			FIREBASE_DATABASE_URL: 'https://cabros.firebaseio.com',
			FIREBASE_PROJECT_ID: 'cabros-project',
			FIREBASE_APP_ID: '1:123:web:abc',
			FIREBASE_SERVICE_ACCOUNT_JSON: '{"private_key":"must-not-leak"}',
		});

		const response = await request(app).get('/admin/auth-config');

		expect(response.status).toBe(200);
		expect(response.body).toEqual({
			enabled: true,
			configured: true,
			provider: 'firebase',
			signIn: 'email-password',
			config: {
				apiKey: 'public-api-key',
				authDomain: 'cabros.firebaseapp.com',
				databaseURL: 'https://cabros.firebaseio.com',
				projectId: 'cabros-project',
				appId: '1:123:web:abc',
			},
		});
		expect(response.text).not.toContain('must-not-leak');
	});

	it('keeps the legacy console mode explicit when Firebase auth is disabled', async () => {
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;

		const response = await request(app).get('/admin/auth-config');

		expect(response.status).toBe(200);
		expect(response.body).toEqual({ enabled: false, configured: false });
	});
});
