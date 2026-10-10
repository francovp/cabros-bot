'use strict';

const request = require('supertest');
const expressErrorHandler = require('../../src/lib/expressErrorHandler');

beforeEach(() => {
	for (const level of ['info', 'warn', 'error']) {
		jest.spyOn(console, level).mockImplementation(() => {});
	}
});

afterEach(() => {
	jest.restoreAllMocks();
});

function buildApp({ sentryEventId } = {}) {
	let app;
	jest.isolateModules(() => {
		app = require('../../app');
	});

	app.post('/api/webhook/alert', (_req, _res, next) => {
		next(new Error('forced runtime error'));
	});
	app.use((error, _req, res, next) => {
		if (sentryEventId) res.sentry = sentryEventId;
		next(error);
	});

	app.use(expressErrorHandler);

	return app;
}

describe('Express fallthrough error handler', () => {
	it('preserves malformed webhook JSON as a structured 400 response', async () => {
		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send('{"text":');

		expect(response.status).toBe(400);
		expect(response.headers['content-type']).toMatch(/application\/json/);
		expect(response.body).toEqual(expect.objectContaining({
			success: false,
			code: 'INVALID_REQUEST',
			requestId: expect.any(String),
		}));
		expect(response.body.requestId).toBe(response.headers['x-request-id']);
	});

	it('returns a structured 500 when no Sentry event ID is available', async () => {
		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.send({ trigger: 'runtime-error' });

		expect(response.status).toBe(500);
		expect(response.headers['content-type']).toMatch(/application\/json/);
		expect(response.body).toEqual(expect.objectContaining({
			success: false,
			code: 'INTERNAL_ERROR',
			requestId: expect.any(String),
		}));
		expect(response.body.requestId).toBe(response.headers['x-request-id']);
		expect(response.text).not.toContain('undefined');
	});

	it('includes a Sentry event ID in the structured 500 response when present', async () => {
		const app = buildApp({ sentryEventId: 'event-123' });
		const response = await request(app)
			.post('/api/webhook/alert')
			.send({ trigger: 'runtime-error' });

		expect(response.status).toBe(500);
		expect(response.body).toEqual(expect.objectContaining({
			code: 'INTERNAL_ERROR',
			sentryEventId: 'event-123',
		}));
	});
});
