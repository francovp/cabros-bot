'use strict';

const http = require('node:http');
const { checkEndpoint } = require('../../scripts/wizard-smoke');

describe('wizard-smoke', () => {
	let server;
	let port;

	beforeAll((done) => {
		server = http.createServer((req, res) => {
			if (req.url === '/healthcheck') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"status":"ok"}');
			} else if (req.url === '/api/status') {
				res.writeHead(200, { 'Content-Type': 'application/json' });
				res.end('{"ready":true}');
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

	it('reports OK for a healthy endpoint', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/healthcheck');
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
	});

	it('reports OK for the status endpoint', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/api/status');
		expect(result.ok).toBe(true);
		expect(result.status).toBe(200);
	});

	it('reports OK for 4xx responses (auth-gated endpoint)', async () => {
		const result = await checkEndpoint('127.0.0.1', port, '/unknown');
		expect(result.ok).toBe(true);
		expect(result.status).toBe(404);
	});

	it('reports failure for connection error', async () => {
		const result = await checkEndpoint('127.0.0.1', 1, '/healthcheck');
		expect(result.ok).toBe(false);
		expect(result.status).toBe(0);
		expect(result.error).toBeTruthy();
	});
});