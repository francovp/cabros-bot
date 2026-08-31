'use strict';

const request = require('supertest');

describe('CORS Integration Tests', () => {
	let app;
	let savedEnv;

	beforeAll(() => {
		savedEnv = saveEnv();
		delete process.env.CORS_ALLOWED_ORIGINS;
		app = require('../../app');
	});

	afterAll(() => {
		restoreEnv(savedEnv);
	});

	it('returns Access-Control-Allow-Origin for production Firebase Hosting origin', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Origin', 'https://cabros-bot.web.app');

		expect(res.status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBe('https://cabros-bot.web.app');
		expect(res.headers['access-control-allow-credentials']).toBe('true');
	});

	it('returns Access-Control-Allow-Origin for production Railway origin', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Origin', 'https://cabros-bot-production.up.railway.app');

		expect(res.status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBe('https://cabros-bot-production.up.railway.app');
		expect(res.headers['access-control-allow-credentials']).toBe('true');
	});

	it('returns Access-Control-Allow-Origin for localhost development origins', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Origin', 'http://localhost:5173');

		expect(res.status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
	});

	it('does not return Access-Control-Allow-Origin for untrusted third-party origins', async () => {
		const res = await request(app)
			.get('/openapi.json')
			.set('Origin', 'https://malicious-site.example.com');

		expect(res.status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('handles preflight OPTIONS requests for allowed origins', async () => {
		const res = await request(app)
			.options('/openapi.json')
			.set('Origin', 'https://cabros-bot.web.app')
			.set('Access-Control-Request-Method', 'GET')
			.set('Access-Control-Request-Headers', 'x-api-key');

		expect([200, 204]).toContain(res.status);
		expect(res.headers['access-control-allow-origin']).toBe('https://cabros-bot.web.app');
		expect(res.headers['access-control-allow-methods']).toMatch(/GET/);
		expect(res.headers['access-control-allow-headers']).toMatch(/x-api-key/i);
	});

	it('rejects preflight OPTIONS requests for untrusted origins (no CORS headers)', async () => {
		const res = await request(app)
			.options('/openapi.json')
			.set('Origin', 'https://attacker.example.org')
			.set('Access-Control-Request-Method', 'POST');

		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});

	it('serves server-to-server requests without an Origin header normally', async () => {
		const res = await request(app).get('/healthcheck');
		expect(res.status).toBe(200);
		expect(res.headers['access-control-allow-origin']).toBeUndefined();
	});
});
