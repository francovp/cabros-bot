'use strict';

const { createRequest } = require('../../src/admin/admin-request');

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
