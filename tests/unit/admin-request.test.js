'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const {
	confirmRequest,
	createRequest,
	operationDefinitions,
	redactSecret,
	validateQuery,
} = require('../../src/admin/admin-request');

describe('createRequest', () => {
	it('creates a same-origin request with an API-key header and JSON body', () => {
		expect(createRequest({
			path: '/api/webhook/volume-confirmation',
			method: 'POST',
			apiKey: 'secret',
			body: { symbol: 'BINANCE:BTCUSDT' },
			query: { dryRun: false },
		})).toEqual({
			url: '/api/webhook/volume-confirmation?dryRun=false',
			options: expect.objectContaining({
				method: 'POST',
				body: '{"symbol":"BINANCE:BTCUSDT"}',
				headers: { 'Content-Type': 'application/json', 'x-api-key': 'secret' },
			}),
		});
	});

	it('rejects a non-relative API path', () => {
		expect(() => createRequest({ path: 'https://example.com', method: 'GET' }))
			.toThrow('API path must start with /api/');
	});

	it('rejects API paths containing query strings or fragments', () => {
		expect(() => createRequest({ path: '/api/status?enabled=true', method: 'GET' }))
			.toThrow('API path must start with /api/');
		expect(() => createRequest({ path: '/api/status#details', method: 'GET' }))
			.toThrow('API path must start with /api/');
	});

	it('rejects invalid or credential-bearing query objects', () => {
		expect(() => createRequest({ path: '/api/status', method: 'GET', query: [] }))
			.toThrow('Query must be a JSON object.');
		expect(() => createRequest({ path: '/api/status', method: 'GET', query: { 'API-Key': 'secret' } }))
			.toThrow('Query credentials are not allowed; use the API key field.');
	});

	it('omits undefined query values and empty JSON bodies', () => {
		expect(createRequest({
			path: '/api/status',
			method: 'GET',
			query: { enabled: true, unused: undefined },
			body: {},
		})).toEqual({
			url: '/api/status?enabled=true',
			options: { method: 'GET', headers: {} },
		});
	});
});

it('exposes a working helper on a browser-like window global', () => {
	const browser = {};
	const source = fs.readFileSync(path.join(__dirname, '../../src/admin/admin-request.js'), 'utf8');

	vm.runInNewContext(source, { window: browser, URLSearchParams });

	expect(browser.CabrosAdminRequest.createRequest({
		path: '/api/status', method: 'GET', query: { detail: 'full' },
	})).toEqual({
		url: '/api/status?detail=full',
		options: { method: 'GET', headers: {} },
	});
});

describe('admin client safety', () => {
	it('requires query JSON to be an object without credential keys', () => {
		expect(validateQuery(undefined)).toBeUndefined();
		expect(validateQuery({ limit: 5 })).toEqual({ limit: 5 });
		expect(() => validateQuery(null)).toThrow('Query must be a JSON object.');
		expect(() => validateQuery([])).toThrow('Query must be a JSON object.');
		expect(() => validateQuery('limit=5')).toThrow('Query must be a JSON object.');
		expect(() => validateQuery({ 'API-Key': 'secret' }))
			.toThrow('Query credentials are not allowed; use the API key field.');
		expect(() => validateQuery({ 'X-API-KEY': 'secret' }))
			.toThrow('Query credentials are not allowed; use the API key field.');
	});

	it('redacts raw and JSON-escaped API keys with special characters', () => {
		const secret = 'quote" slash\\ tab\t newline\n';
		const escapedSecret = JSON.stringify(secret).slice(1, -1);

		const rawResult = redactSecret(`before ${secret} after`, secret);
		const jsonResult = redactSecret(JSON.stringify({ echoed: secret }), secret);

		expect(rawResult).toBe('before [REDACTED] after');
		expect(jsonResult).toContain('[REDACTED]');
		expect(jsonResult).not.toContain(secret);
		expect(jsonResult).not.toContain(escapedSecret);
	});

	it('keeps confirmations on every sensitive Playground operation', () => {
		const sensitiveRoutes = [
			['post', '/api/alerts/{alertId}/replay'],
			['post', '/api/scanner-presets/{id}/run'],
			['delete', '/api/scanner-presets/{id}'],
			['post', '/api/jobs/{jobId}/cancel'],
			['post', '/api/jobs/{jobId}/retry'],
			['post', '/api/jobs/{jobId}/retry-failed'],
		];
		const paths = Object.fromEntries(sensitiveRoutes.map(([method, route]) => [route, {
			[method]: { summary: route },
		}]));
		paths['/api/status'] = { get: { summary: 'Status' } };

		const definitions = operationDefinitions({ paths });
		const status = definitions.find(({ path }) => path === '/api/status');
		expect(status.confirm).toBeUndefined();
		sensitiveRoutes.forEach(([method, route]) => {
			const definition = definitions.find(({ path, method: actualMethod }) => (
				path === route && actualMethod === method.toUpperCase()
			));
			expect(definition.confirm).toEqual(expect.any(String));
		});

		const replay = definitions.find(({ path }) => path.endsWith('/replay'));
		let promptedWith;
		expect(confirmRequest(replay, (message) => {
			promptedWith = message;
			return false;
		})).toBe(false);
		expect(promptedWith).toBe(replay.confirm);
	});
});
