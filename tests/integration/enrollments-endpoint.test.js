'use strict';

const request = require('supertest');
const express = require('express');

const chatEnrollmentsService = require('../../src/services/enrollments/ChatEnrollmentsService');
const { getRoutes } = require('../../src/routes');

function buildApp() {
	const app = express();
	app.use(express.json());
	app.use('/api', getRoutes(() => null));
	return app;
}

describe('GET /api/enrollments', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		chatEnrollmentsService._resetForTesting();
		delete process.env.ENABLE_CHAT_ENROLLMENTS;
		delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
		process.env.WEBHOOK_API_KEY = 'test-key';
		jest.clearAllMocks();
	});

	afterEach(() => {
		chatEnrollmentsService._resetForTesting();
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('returns 403 FEATURE_DISABLED when ENABLE_CHAT_ENROLLMENTS is unset', async () => {
		const response = await request(buildApp())
			.get('/api/enrollments')
			.set('x-api-key', 'test-key');

		expect(response.status).toBe(403);
		expect(response.body.code).toBe('FEATURE_DISABLED');
	});

	it('returns the sanitized summary for an admin viewer when feature is enabled', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
		chatEnrollmentsService._resetForTesting();
		await chatEnrollmentsService.enroll({ chatId: 11, language: 'es', watchlist: ['BTCUSDT'] });
		await chatEnrollmentsService.enroll({ chatId: 22, language: 'en', watchlist: ['NVDA'] });

		const response = await request(buildApp())
			.get('/api/enrollments')
			.set('x-api-key', 'test-key');

		expect(response.status).toBe(200);
		expect(response.body.mode).toBe('ephemeral');
		expect(response.body.backend).toBe('memory');
		expect(response.body.count).toBe(2);
		expect(response.body.languages).toContainEqual({ value: 'es', total: 1 });
		expect(response.body.watchlist).toContainEqual({ value: 'BTCUSDT', total: 1 });
		expect(response.body.records).toBeUndefined();
	});

	it('returns 400 INVALID_REQUEST when limit is malformed', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';

		const response = await request(buildApp())
			.get('/api/enrollments?limit=foo')
			.set('x-api-key', 'test-key');

		expect(response.status).toBe(400);
		expect(response.body.code).toBe('INVALID_REQUEST');
	});

	it('rejects requests without API key', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';

		const response = await request(buildApp()).get('/api/enrollments');

		expect(response.status).toBe(401);
	});
});
