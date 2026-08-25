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

	it('uses a Firebase bearer token without replacing legacy API-key headers', () => {
		expect(createRequest({
			path: '/api/status',
			method: 'GET',
			apiKey: 'legacy-key',
			authToken: 'firebase-token',
		})).toEqual({
			url: '/api/status',
			options: {
				method: 'GET',
				headers: {
					'x-api-key': 'legacy-key',
					Authorization: 'Bearer firebase-token',
				},
			},
		});
	});

	it('prepends an explicit baseUrl to the generated API request URL', () => {
		expect(createRequest({
			path: '/api/status',
			method: 'GET',
			baseUrl: 'https://cabros-bot-production.up.railway.app',
			query: { format: 'json' },
		})).toEqual({
			url: 'https://cabros-bot-production.up.railway.app/api/status?format=json',
			options: { method: 'GET', headers: {} },
		});

		expect(createRequest({
			path: '/api/status',
			method: 'GET',
			baseUrl: 'https://cabros-bot-production.up.railway.app/',
		})).toEqual({
			url: 'https://cabros-bot-production.up.railway.app/api/status',
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

	it('exposes the role metadata needed for viewer controls', () => {
		const definitions = operationDefinitions({
			paths: {
				'/api/status': { get: { summary: 'Status', 'x-admin-role': 'admin.viewer' } },
				'/api/jobs': { post: { summary: 'Create job', 'x-admin-role': 'admin.operator' } },
			},
		});

		expect(definitions.find(({ path }) => path === '/api/status').requiredRole).toBe('admin.viewer');
		expect(definitions.find(({ path }) => path === '/api/jobs').requiredRole).toBe('admin.operator');
	});
});

describe('admin deadline budget calculations', () => {
	const adminRequest = require('../../src/admin/admin-request');

	it('derives the volume confirmation deadline from 3 sequential MCP RPCs plus explicit overhead', () => {
		expect(adminRequest.VOLUME_CONFIRMATION_MCP_CALLS).toBe(3);
		expect(adminRequest.TRADINGVIEW_MCP_MAX_TIMEOUT_MS).toBe(120000);
		expect(adminRequest.VOLUME_CONFIRMATION_OVERHEAD_MS).toBe(30000);

		const expectedVolumeTimeout = (adminRequest.VOLUME_CONFIRMATION_MCP_CALLS * adminRequest.TRADINGVIEW_MCP_MAX_TIMEOUT_MS)
			+ adminRequest.VOLUME_CONFIRMATION_OVERHEAD_MS;
		expect(expectedVolumeTimeout).toBe(390000);
		expect(adminRequest.VOLUME_CONFIRMATION_API_REQUEST_TIMEOUT_MS).toBe(390000);
	});

	it('derives the long-running analysis and alert deadline from full enrichment, multi-chunk retries, and overhead', () => {
		expect(adminRequest.TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS).toBe(120000);
		expect(adminRequest.GROUNDING_MAX_TIMEOUT_MS).toBe(120000);
		expect(adminRequest.DISCORD_MAX_CHUNKS).toBe(3);
		expect(adminRequest.DISCORD_REQUEST_TIMEOUT_MS).toBe(10000);
		expect(adminRequest.DISCORD_MAX_RETRIES).toBe(10);
		expect(adminRequest.DISCORD_MAX_TOTAL_RETRY_WAIT_MS).toBe(120000);

		const expectedChunkBudget = adminRequest.DISCORD_REQUEST_TIMEOUT_MS
			+ (adminRequest.DISCORD_MAX_RETRIES * adminRequest.DISCORD_REQUEST_TIMEOUT_MS)
			+ adminRequest.DISCORD_MAX_TOTAL_RETRY_WAIT_MS;
		expect(expectedChunkBudget).toBe(230000);
		expect(adminRequest.DISCORD_MAX_CHUNK_BUDGET_MS).toBe(230000);

		const expectedDeliveryBudget = adminRequest.DISCORD_MAX_CHUNKS * expectedChunkBudget;
		expect(expectedDeliveryBudget).toBe(690000);
		expect(adminRequest.DISCORD_MAX_TOTAL_DELIVERY_BUDGET_MS).toBe(690000);

		const expectedBackendBudget = adminRequest.TRADINGVIEW_MCP_MAX_ENRICHMENT_BUDGET_MS
			+ adminRequest.GROUNDING_MAX_TIMEOUT_MS
			+ expectedDeliveryBudget;
		expect(expectedBackendBudget).toBe(930000);
		expect(adminRequest.LONG_RUNNING_BACKEND_BUDGET_MS).toBe(930000);

		expect(adminRequest.LONG_RUNNING_OVERHEAD_MS).toBe(60000);
		expect(adminRequest.LONG_RUNNING_API_REQUEST_TIMEOUT_MS).toBe(990000);
	});

	it('assigns the derived volume confirmation timeout to /api/webhook/volume-confirmation', () => {
		expect(adminRequest.getApiRequestTimeout({ path: '/api/webhook/volume-confirmation' })).toBe(390000);
	});

	it('assigns the derived long-running timeout to all long-running analysis and alert endpoints', () => {
		const longRunningRoutes = [
			'/api/webhook/expanded-analysis-alert',
			'/api/webhook/market-scanner-alert',
			'/api/news-monitor',
			'/api/scanner-presets/{id}/run',
			'/api/webhook/alert',
			'/api/webhook/message',
			'/api/alerts/{alertId}/replay',
		];

		longRunningRoutes.forEach((path) => {
			expect(adminRequest.getApiRequestTimeout({ path })).toBe(990000);
		});
	});

	it('assigns standard 30s timeout to short operations and handles missing definitions safely', () => {
		expect(adminRequest.getApiRequestTimeout({ path: '/api/status' })).toBe(30000);
		expect(adminRequest.getApiRequestTimeout({ path: '/api/jobs' })).toBe(30000);
		expect(adminRequest.getApiRequestTimeout({ path: '/api/alerts' })).toBe(30000);
		expect(adminRequest.getApiRequestTimeout({})).toBe(30000);
		expect(adminRequest.getApiRequestTimeout(null)).toBe(30000);
		expect(adminRequest.getApiRequestTimeout(undefined)).toBe(30000);
	});
});
