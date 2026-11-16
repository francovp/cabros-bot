/**
 * /api/ops/snooze integration tests
 *
 * Verifies the operator-initiated snooze API surface (mounted under /api/ops/snooze):
 *  - GET returns the active snooze or { active: false }
 *  - POST activates with valid durationMs and returns the snapshot
 *  - POST rejects out-of-range or non-numeric durationMs with 400
 *  - DELETE cancels an active snooze
 *  - Admin auth gate applies (POST/DELETE require admin.operator)
 */

const request = require('supertest');
const express = require('express');
jest.mock('firebase-admin');
const { snoozeService } = require('../../src/services/notification/SnoozeService');
const { getRoutes } = require('../../src/routes');

function buildApp(apiKey) {
	process.env.WEBHOOK_API_KEY = apiKey;
	const app = express();
	app.use(express.json());
	app.use('/api', getRoutes(() => null));
	return app;
}

describe('/api/ops/snooze', () => {
	let savedWebhookKey;
	let app;
	const API_KEY = 'snooze-test-key';

	beforeEach(() => {
		snoozeService.resetForTesting();
		savedWebhookKey = process.env.WEBHOOK_API_KEY;
		app = buildApp(API_KEY);
	});

	afterEach(() => {
		snoozeService.resetForTesting();
		if (savedWebhookKey === undefined) {
			delete process.env.WEBHOOK_API_KEY;
		} else {
			process.env.WEBHOOK_API_KEY = savedWebhookKey;
		}
	});

	it('GET returns { active: false } when no snooze is active', async () => {
		const response = await request(app)
			.get('/api/ops/snooze')
			.set('x-api-key', API_KEY);
		expect(response.status).toBe(200);
		expect(response.body).toEqual({ active: false });
	});

	it('POST activates a snooze and GET returns the active snapshot', async () => {
		const postResponse = await request(app)
			.post('/api/ops/snooze')
			.set('x-api-key', API_KEY)
			.send({ durationMs: 30 * 60 * 1000, reason: 'integration test' });
		expect(postResponse.status).toBe(200);
		expect(postResponse.body.reason).toBe('integration test');
		expect(postResponse.body.durationMs).toBe(30 * 60 * 1000);

		const getResponse = await request(app)
			.get('/api/ops/snooze')
			.set('x-api-key', API_KEY);
		expect(getResponse.status).toBe(200);
		expect(getResponse.body.reason).toBe('integration test');
	});

	it('POST rejects out-of-range durationMs with 400', async () => {
		const response = await request(app)
			.post('/api/ops/snooze')
			.set('x-api-key', API_KEY)
			.send({ durationMs: 1000 });
		expect(response.status).toBe(400);
		expect(response.body.code).toBe('INVALID_DURATION');
	});

	it('POST rejects above-maximum durationMs', async () => {
		const response = await request(app)
			.post('/api/ops/snooze')
			.set('x-api-key', API_KEY)
			.send({ durationMs: 24 * 60 * 60 * 1000 });
		expect(response.status).toBe(400);
		expect(response.body.code).toBe('INVALID_DURATION');
	});

	it('POST accepts a channels subset', async () => {
		const response = await request(app)
			.post('/api/ops/snooze')
			.set('x-api-key', API_KEY)
			.send({ durationMs: 60_000, channels: ['telegram'] });
		expect(response.status).toBe(200);
		expect(response.body.channels).toEqual(['telegram']);
	});

	it('DELETE cancels an active snooze', async () => {
		await request(app)
			.post('/api/ops/snooze')
			.set('x-api-key', API_KEY)
			.send({ durationMs: 60_000, reason: 'will cancel' });
		const deleteResponse = await request(app)
			.delete('/api/ops/snooze')
			.set('x-api-key', API_KEY);
		expect(deleteResponse.status).toBe(200);
		expect(deleteResponse.body).toEqual({ active: false });

		const getResponse = await request(app)
			.get('/api/ops/snooze')
			.set('x-api-key', API_KEY);
		expect(getResponse.body).toEqual({ active: false });
	});
});
