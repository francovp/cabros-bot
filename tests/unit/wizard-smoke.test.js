'use strict';

const http = require('node:http');
const { checkEndpoint, isStatusOk } = require('../../scripts/wizard-smoke');

describe('wizard-smoke', () => {
	let server;
	let port;

	beforeAll((done) => {
		server = http.createServer((req, res) => {
			if (req.url === '/healthcheck') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"status":"ok"}');
			} else if (req.url === '/api/status') {
				if (req.headers['x-api-key'] === 'valid-secret') {
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end('{"ready":true}');
				} else {
					res.writeHead(401, { 'Content-Type': 'application/json' });
					res.end('{"error":"unauthorized"}');
				}
			} else if (req.url === '/server-error') {
				res.writeHead(500, { 'Content-Type': 'application/json' });
				res.end('{"error":"internal"}');
			} else {
				res.writeHead(404);
				res.end();
			}
		});
		server.listen(0, '127.0.0.1', () => {
			port = server.address().port;
			done();
		});
	});

	afterAll((done) => {
		server.close(done);
	});

	describe('isStatusOk', () => {
		it('accepts 200 for healthcheck', () => {
			expect(isStatusOk('/healthcheck', 200)).toBe(true);
		});

		it('rejects 401 for healthcheck', () => {
			expect(isStatusOk('/healthcheck', 401)).toBe(false);
		});

		it('accepts 200 or 401/403 for api routes', () => {
			expect(isStatusOk('/api/status', 200)).toBe(true);
			expect(isStatusOk('/api/status', 401)).toBe(true);
			expect(isStatusOk('/api/status', 403)).toBe(true);
		});

		it('rejects 404 and 500', () => {
			expect(isStatusOk('/api/status', 404)).toBe(false);
			expect(isStatusOk('/api/status', 500)).toBe(false);
			expect(isStatusOk('/unknown', 404)).toBe(false);
		});
	});

	it('reports OK for a healthy endpoint', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/healthcheck');
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
	});

	it('reports OK for the status endpoint with valid API key', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/api/status', 'valid-secret');
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
	});

	it('reports OK for auth-gated endpoint when unauthenticated (401)', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/api/status', null);
		expect(result.ok).toBe(true);
		expect(result.status).toBe(401);
	});

	it('reports failure for 404 responses', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/unknown');
		expect(result.ok).toBe(false);
		expect(result.status).toBe(404);
	});

	it('reports failure for 500 server error', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/server-error');
		expect(result.ok).toBe(false);
		expect(result.status).toBe(500);
	});

	it('reports failure for connection error', async () => {
		const result = await checkEndpoint('127.0.0.1', 1, '/healthcheck');
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.error).toBeTruthy();
	});
});
