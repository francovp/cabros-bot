'use strict';

const request = require('supertest');
const express = require('express');
const { createCompressionMiddleware } = require('../../src/lib/compression');
const app = require('../../app');

describe('HTTP Response Compression Integration', () => {
	it('leaves large JSON uncompressed when explicitly disabled at startup', async () => {
		const priorValue = process.env.ENABLE_RESPONSE_COMPRESSION;
		process.env.ENABLE_RESPONSE_COMPRESSION = 'false';
		let disabledApp;
		try {
			jest.isolateModules(() => {
				disabledApp = require('../../app');
			});
			const res = await request(disabledApp)
				.get('/openapi.json')
				.set('Accept-Encoding', 'gzip');
			expect(res.status).toBe(200);
			expect(res.headers['content-encoding']).toBeUndefined();
		} finally {
			if (priorValue === undefined) delete process.env.ENABLE_RESPONSE_COMPRESSION;
			else process.env.ENABLE_RESPONSE_COMPRESSION = priorValue;
		}
	});

	it('compresses large JSON responses (> 1KB) with gzip when client accepts it', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Accept-Encoding', 'gzip');

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBe('gzip');
		expect(res.headers['vary']).toMatch(/Accept-Encoding/i);
	});

	it('does not compress small responses (< 1KB threshold)', async () => {
		const res = await request(app)
			.get('/healthcheck')
			.set('Accept-Encoding', 'gzip');

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBeUndefined();
	});

	it('does not compress when client specifies identity encoding', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Accept-Encoding', 'identity');

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBeUndefined();
	});

	it('does not compress when x-no-compression header is present', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Accept-Encoding', 'gzip')
			.set('x-no-compression', '1');

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBeUndefined();
	});

	it('does not compress streaming responses (text/event-stream)', async () => {
		const testApp = express();
		testApp.use(createCompressionMiddleware());
		testApp.get('/stream', (req, res) => {
			res.setHeader('Content-Type', 'text/event-stream');
			res.setHeader('Cache-Control', 'no-cache');
			const data = 'data: ' + 'A'.repeat(2000) + '\n\n';
			res.write(data);
			res.end();
		});

		const res = await request(testApp)
			.get('/stream')
			.set('Accept-Encoding', 'gzip');

		expect(res.status).toBe(200);
		expect(res.headers['content-type']).toContain('text/event-stream');
		expect(res.headers['content-encoding']).toBeUndefined();
	});

	it('compresses large API payload exceeding 1KB', async () => {
		const testApp = express();
		testApp.use(createCompressionMiddleware({ threshold: 1024 }));
		testApp.get('/large', (req, res) => {
			res.json({ data: 'x'.repeat(2048) });
		});

		const res = await request(testApp)
			.get('/large')
			.set('Accept-Encoding', 'gzip');

		expect(res.status).toBe(200);
		expect(res.headers['content-encoding']).toBe('gzip');
	});
});
