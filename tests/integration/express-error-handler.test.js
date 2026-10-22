'use strict';

const request = require('supertest');
const Sentry = require('@sentry/node');
const expressErrorHandler = require('../../src/lib/expressErrorHandler');

beforeEach(() => {
	Sentry.isEnabled.mockReturnValue(false);
	for (const level of ['info', 'warn', 'error']) {
		jest.spyOn(console, level).mockImplementation(() => {});
	}
});

afterEach(() => {
	jest.restoreAllMocks();
});

function buildApp({ sentryEventId, error = new Error('forced runtime error') } = {}) {
	let app;
	jest.isolateModules(() => {
		app = require('../../app');
	});

	app.post('/api/webhook/alert', (_req, _res, next) => {
		next(error);
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

	it('preserves unsupported JSON charset as a structured 415 response', async () => {
		const app = buildApp();
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json; charset=unsupported-charset')
			.send('{"text":"valid JSON"}');

		expect(response.status).toBe(415);
		expect(response.headers['content-type']).toMatch(/application\/json/);
		expect(response.body).toEqual(expect.objectContaining({
			success: false,
			code: 'INVALID_REQUEST',
			requestId: expect.any(String),
			retryable: false,
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

	it('preserves err.status ahead of err.statusCode', async () => {
		const error = Object.assign(new Error('status precedence'), {
			status: 409,
			statusCode: 502,
		});
		const response = await request(buildApp({ error }))
			.post('/api/webhook/alert')
			.send({ trigger: 'runtime-error' });

		expect(response.status).toBe(409);
		expect(response.body).toEqual(expect.objectContaining({
			code: 'INVALID_REQUEST',
			retryable: false,
		}));
	});

	it('returns a structured 413 for too many URL-encoded parameters', async () => {
		const body = Array.from({ length: 1001 }, (_value, index) => `key${index}=x`).join('&');
		const response = await request(buildApp())
			.post('/api/webhook/alert')
			.type('form')
			.send(body);

		expect(response.status).toBe(413);
		expect(response.body).toEqual(expect.objectContaining({
			success: false,
			code: 'PAYLOAD_TOO_LARGE',
			requestId: expect.any(String),
			error: 'Request contains too many URL-encoded parameters',
		}));
	});

	it('omits a synthetic Sentry event ID when Sentry is disabled', async () => {
		const app = buildApp({ sentryEventId: 'synthetic-event-id' });
		const response = await request(app)
			.post('/api/webhook/alert')
			.send({ trigger: 'runtime-error' });

		expect(response.status).toBe(500);
		expect(response.body).not.toHaveProperty('sentryEventId');
	});

	it('includes a Sentry event ID in the structured 500 response when Sentry is active', async () => {
		Sentry.isEnabled.mockReturnValue(true);
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
