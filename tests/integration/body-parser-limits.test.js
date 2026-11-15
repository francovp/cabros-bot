'use strict';

const express = require('express');
const request = require('supertest');
const expressErrorHandler = require('../../src/lib/expressErrorHandler');

function buildOversizedJsonPayload(sizeKb = 110) {
	const filler = 'x'.repeat(sizeKb * 1024);
	return JSON.stringify({ text: filler });
}

function buildOversizedTextPayload(sizeKb = 110) {
	return 'x'.repeat(sizeKb * 1024);
}

function buildOversizedUrlencodedPayload(sizeKb = 110) {
	return 'text=' + 'x'.repeat(sizeKb * 1024);
}

describe('Body parser size limits', () => {
	let app;
	let productionApp;
	let savedEnv;

	beforeAll(() => {
		savedEnv = { ...process.env };
		delete process.env.WEBHOOK_MAX_BODY_SIZE;
		app = require('../../app');
		productionApp = express();
		productionApp.use(app);
		productionApp.use(expressErrorHandler);
	});

	afterAll(() => {
		for (const key of Object.keys(process.env)) {
			if (!(key in savedEnv)) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	it('accepts a normal-sized webhook JSON payload', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BTCUSDT at 117000' });

		expect(res.status).not.toBe(413);
	});

	it('accepts a webhook JSON payload between 100kb and the default 256kb limit', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'application/json')
			.send(buildOversizedJsonPayload(110));

		expect(res.status).not.toBe(413);
	});

	it('accepts a news-monitor JSON payload between 100kb and the default 256kb limit', async () => {
		const res = await request(productionApp)
			.post('/api/news-monitor')
			.set('Content-Type', 'application/json')
			.send(buildOversizedJsonPayload(110));

		expect(res.status).not.toBe(413);
	});

	it('rejects webhook JSON larger than the default 256kb limit with 413', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'application/json')
			.send(buildOversizedJsonPayload(300));

		expect(res.status).toBe(413);
	});

	it('rejects news-monitor JSON larger than the default 256kb limit with 413', async () => {
		const res = await request(productionApp)
			.post('/api/news-monitor')
			.set('Content-Type', 'application/json')
			.send(buildOversizedJsonPayload(300));

		expect(res.status).toBe(413);
	});

	it('rejects oversized webhook text/plain payloads with 413', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'text/plain')
			.send(buildOversizedTextPayload(300));

		expect(res.status).toBe(413);
	});

	it('rejects oversized webhook urlencoded payloads with 413', async () => {
		const res = await request(productionApp)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.set('Content-Type', 'application/x-www-form-urlencoded')
			.send(buildOversizedUrlencodedPayload(300));

		expect(res.status).toBe(413);
	});

	it('rejects non-webhook JSON payloads over 100kb with 413', async () => {
		const res = await request(productionApp)
			.post('/api/jobs/tradingview-analysis')
			.set('Content-Type', 'application/json')
			.send(buildOversizedJsonPayload(110));

		expect(res.status).toBe(413);
		expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
	});

	it('rejects non-webhook text/plain payloads over 100kb with 413', async () => {
		const res = await request(productionApp)
			.post('/api/jobs/tradingview-analysis')
			.set('Content-Type', 'text/plain')
			.send(buildOversizedTextPayload(110));

		expect(res.status).toBe(413);
		expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
	});

	it('rejects non-webhook urlencoded payloads over 100kb with 413', async () => {
		const res = await request(productionApp)
			.post('/api/jobs/tradingview-analysis')
			.set('Content-Type', 'application/x-www-form-urlencoded')
			.send(buildOversizedUrlencodedPayload(110));

		expect(res.status).toBe(413);
		expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
	});
});
