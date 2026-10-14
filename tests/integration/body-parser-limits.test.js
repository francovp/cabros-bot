'use strict';

const express = require('express');
const request = require('supertest');
const { onError } = require('../../src/lib/expressErrorHandler');

// Helper: build a JSON body larger than 100kb so express.json() rejects it
// with 413 Payload Too Large. Each character is one byte when encoded as ASCII.
function buildOversizedJsonPayload() {
	const filler = 'x'.repeat(110 * 1024); // 110kb of filler text
	return JSON.stringify({ text: filler });
}

// Helper: build a plain-text body larger than 100kb so express.text() rejects
// it with 413.
function buildOversizedTextPayload() {
	return 'x'.repeat(110 * 1024);
}

// Helper: build a urlencoded body larger than 100kb so express.urlencoded()
// rejects it with 413.
function buildOversizedUrlencodedPayload() {
	return 'text=' + 'x'.repeat(110 * 1024);
}

describe('Body parser size limits', () => {
	let app;
	let productionApp;
	let savedEnv;

	beforeAll(() => {
		savedEnv = (() => {
			const saved = {};
			for (const k of Object.keys(process.env)) {
				saved[k] = process.env[k];
			}
			return saved;
		})();
		app = require('../../app');
		productionApp = express();
		productionApp.use(app);
		productionApp.use(onError);
	});

	afterAll(() => {
		for (const k of Object.keys(process.env)) {
			if (!(k in savedEnv)) {
				delete process.env[k];
			} else {
				process.env[k] = savedEnv[k];
			}
		}
	});

	it('accepts a normal-sized JSON payload under 100kb', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BTCUSDT at 117000' });

		// Status may be 200/202 (success) or 401/403 (auth-gated), but it must
		// NOT be 413 - a 413 here would mean the body parser rejected a
		// small, valid payload, which would be a regression.
		expect(res.status).not.toBe(413);
	});

	it('rejects an oversized JSON payload with 413', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'application/json')
			.send(buildOversizedJsonPayload());

		expect(res.status).toBe(413);
	});

	it('rejects an oversized text/plain payload with 413', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'text/plain')
			.send(buildOversizedTextPayload());

		expect(res.status).toBe(413);
	});

	it('rejects an oversized urlencoded payload with 413', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'application/x-www-form-urlencoded')
			.send(buildOversizedUrlencodedPayload());

		expect(res.status).toBe(413);
	});
});
