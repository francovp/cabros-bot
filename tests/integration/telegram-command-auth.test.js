'use strict';

const request = require('supertest');
const express = require('express');
const { getRoutes } = require('../../src/routes');

describe('Telegram command authorization integration', () => {
	let originalEnv;
	let app;

	beforeEach(() => {
		originalEnv = { ...process.env };
		app = express();
		app.use(express.json());
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	test('GET /api/status reports telegramCommandAuth enabled when TELEGRAM_ALLOWED_CHAT_IDS is set', async () => {
		process.env.TELEGRAM_ALLOWED_CHAT_IDS = '111,222';
		process.env.TELEGRAM_CHAT_ID = '999';

		const res = await request(app).get('/api/status');
		if (res.status !== 200) {
			console.error('Status endpoint error:', res.body);
		}
		expect(res.status).toBe(200);
		expect(res.body.featureFlags).toHaveProperty('telegramCommandAuth');
		expect(res.body.featureFlags.telegramCommandAuth).toBe(true);
		expect(res.body.dependencies).toHaveProperty('telegramCommandAuth');
		expect(res.body.dependencies.telegramCommandAuth).toMatchObject({
			enabled: true,
			allowlistSource: 'TELEGRAM_ALLOWED_CHAT_IDS',
			allowlistSize: 2,
			deniedSinceStart: 0,
		});
	});

	test('GET /api/status reports telegramCommandAuth enabled by fallback when only TELEGRAM_CHAT_ID is set', async () => {
		delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
		process.env.TELEGRAM_CHAT_ID = '777';

		const res = await request(app).get('/api/status');
		expect(res.status).toBe(200);
		expect(res.body.featureFlags.telegramCommandAuth).toBe(true);
		expect(res.body.dependencies.telegramCommandAuth).toMatchObject({
			enabled: true,
			allowlistSource: 'TELEGRAM_CHAT_ID',
			allowlistSize: 1,
		});
	});

	test('GET /api/status reports telegramCommandAuth disabled when no allowlist is configured', async () => {
		delete process.env.TELEGRAM_ALLOWED_CHAT_IDS;
		delete process.env.TELEGRAM_CHAT_ID;

		const res = await request(app).get('/api/status');
		expect(res.status).toBe(200);
		expect(res.body.featureFlags.telegramCommandAuth).toBe(false);
		expect(res.body.dependencies.telegramCommandAuth).toMatchObject({
			enabled: false,
			allowlistSize: 0,
		});
	});
});
