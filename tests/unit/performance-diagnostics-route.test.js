'use strict';

const request = require('supertest');
const http = require('node:http');
const directAgent = new http.Agent();

describe('performance diagnostics route', () => {
	let app;
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		process.env.NODE_ENV = 'test';
		process.env.ENABLE_API_ONLY_MODE = 'true';
		process.env.WEBHOOK_API_KEY = 'performance-test-key';
		process.env.NO_PROXY = '*';
		process.env.no_proxy = '*';
		process.env.npm_config_no_proxy = '*';
		jest.resetModules();
		app = require('../../app');
	});

	afterEach(() => {
		require('../../src/lib/performanceDiagnostics').closePerformanceDiagnostics();
		process.env = originalEnv;
	});

	it('requires the configured API key and returns bounded diagnostics', async () => {
		await request(app)
			.get('/diag')
			.agent(directAgent)
			.expect(401);

		const response = await request(app)
			.get('/diag')
			.agent(directAgent)
			.set('x-api-key', 'performance-test-key');
		expect({ status: response.status, body: response.body, text: response.text }).toEqual(expect.objectContaining({ status: 200 }));

		expect(response.body).toEqual(expect.objectContaining({
			success: true,
			eventLoopLagMs: expect.any(Number),
			heapUsedBytes: expect.any(Number),
			rssBytes: expect.any(Number),
		}));
	});

	it('does not mount diagnostics in non-test environments', async () => {
		process.env.NODE_ENV = 'production';
		jest.resetModules();
		const productionApp = require('../../app');
		const response = await request(productionApp)
			.get('/diag')
			.agent(directAgent)
			.set('x-api-key', 'performance-test-key');
		expect({ status: response.status, body: response.body }).toEqual({ status: 404, body: {} });
	});
});
