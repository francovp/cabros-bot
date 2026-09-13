/* global jest, describe, it, beforeEach, afterEach, expect */

const express = require('express');
const request = require('supertest');
const { buildWebhookBodySize } = require('../../src/lib/webhookBodySize');

function buildTestApp(options = {}) {
	const { jsonLimit = '2kb', textLimit = '1kb', route = '/api/webhook/alert' } = options;
	const app = express();
	app.use(express.urlencoded({ extended: false }));
	app.use(express.text({ type: 'text/plain', limit: textLimit }));
	app.use(express.json({ limit: jsonLimit }));
	app.use((req, res, next) => {
		req.rawBodyLength = req.rawBody ? req.rawBody.length : 0;
		next();
	});
	app.post(route, (req, res) => {
		res.status(200).json({ success: true, received: true, body: req.body });
	});
	const bodySize = buildWebhookBodySize({ env: { WEBHOOK_MAX_BODY_SIZE: jsonLimit } });
	app.use(bodySize.middleware);
	return app;
}

describe('POST /api/webhook/* - Webhook body size limits', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	it('accepts a JSON body within the configured size limit', async () => {
		const app = buildTestApp({ jsonLimit: '2kb' });
		const payload = { text: 'A'.repeat(1024) }; // ~1KB body, under 2KB
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send(payload);
		expect(response.status).toBe(200);
		expect(response.body.success).toBe(true);
	});

	it('rejects an oversized JSON body with a structured 413 PAYLOAD_TOO_LARGE response', async () => {
		const app = buildTestApp({ jsonLimit: '2kb' });
		const payload = { text: 'A'.repeat(4096) }; // ~4KB body, over 2KB
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send(payload);

		expect(response.status).toBe(413);
		expect(response.body).toEqual(
			expect.objectContaining({
				success: false,
				error: 'PAYLOAD_TOO_LARGE',
				message: expect.stringContaining('exceeds maximum size'),
				limit: '2kb',
			})
		);
	});

	it('rejects an oversized text/plain body with a structured 413 response', async () => {
		const app = buildTestApp({ jsonLimit: '4kb', textLimit: '1kb' });
		const longText = 'B'.repeat(2048); // 2KB, over 1KB text limit
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'text/plain')
			.send(longText);

		expect(response.status).toBe(413);
		expect(response.body.error).toBe('PAYLOAD_TOO_LARGE');
		expect(response.body.limit).toBe('4kb'); // jsonLimit is the source of truth
	});

	it('does not modify valid requests within the size limit', async () => {
		const app = buildTestApp({ jsonLimit: '4kb' });
		const payload = { message: 'hello world', count: 5 };
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send(payload);
		expect(response.status).toBe(200);
		expect(response.body.received).toBe(true);
		expect(response.body.body).toEqual(payload);
	});

	it('returns 413 for a 10MB JSON payload instead of buffering it through the parser', async () => {
		const app = buildTestApp({ jsonLimit: '256kb' });
		const hugePayload = { text: 'X'.repeat(10 * 1024 * 1024) };
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send(hugePayload);

		expect(response.status).toBe(413);
		expect(response.body.error).toBe('PAYLOAD_TOO_LARGE');
		expect(response.body.limit).toBe('256kb');
	});

	it('passes through non-413 errors to the next handler', async () => {
		const app = express();
		app.use(express.json({ limit: '1kb' }));
		app.post('/api/webhook/alert', (req, res) => {
			// Trigger a non-body-size error
			throw new Error('boom');
		});
		const bodySize = buildWebhookBodySize({ env: { WEBHOOK_MAX_BODY_SIZE: '256kb' } });
		app.use(bodySize.middleware);
		app.use((err, req, res, next) => {
			res.status(500).json({ error: 'unhandled' });
		});

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('Content-Type', 'application/json')
			.send({ ok: true });
		expect(response.status).toBe(500);
		expect(response.body.error).toBe('unhandled');
	});
});
