'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { idempotencyService } = require('../../src/services/storage/IdempotencyService');
const requestDeadline = require('../../src/lib/requestDeadline');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('Runtime OpenAPI request validation integration', () => {
	const originalEnv = process.env;
	const AUTH = { 'x-api-key': 'test-key' };

	beforeEach(() => {
		idempotencyService.clear();
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_REQUEST_VALIDATION: 'true',
		};
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		jest.restoreAllMocks();
		requestDeadline.resetForTests();
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	function assertErrorEnvelope(body) {
		expect(body).toEqual(expect.objectContaining({
			success: false,
			code: 'VALIDATION_ERROR',
			retryable: false,
			requestId: expect.any(String),
		}));
		expect(typeof body.error).toBe('string');
		expect(body.error).toContain('Request validation failed');
		expect(body.details).toBeDefined();
		expect(Array.isArray(body.details.errors)).toBe(true);
		expect(body.details.errors.length).toBeGreaterThanOrEqual(1);
		for (const err of body.details.errors) {
			expect(['body', 'query', 'path']).toContain(err.location);
			expect(typeof err.path).toBe('string');
			expect(typeof err.keyword).toBe('string');
			expect(Object.keys(err).sort()).toEqual(['keyword', 'location', 'path']);
		}
	}

	it('rejects POST /api/webhook/alert with missing text as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/alert')
			.set(AUTH)
			.send({ channels: ['telegram'] })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path === '/text')).toBe(true);
	});

	it('rejects POST /api/webhook/alert with empty string text as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/alert')
			.set(AUTH)
			.send({ text: '' })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path === '/text')).toBe(true);
	});

	it('rejects whitespace-only text/plain alerts before the handler runs', async () => {
		const res = await request(app)
			.post('/api/webhook/alert')
			.set(AUTH)
			.set('content-type', 'text/plain')
			.send(' \t\n ')
			.expect(400);

		expect(res.body.code).toBe('VALIDATION_ERROR');
		expect(res.body.details.errors).toEqual([
			{ location: 'body', path: '/', keyword: 'pattern' },
		]);
	});

	it('rejects malformed query parameters before idempotency reservation', async () => {
		const reserveSpy = jest.spyOn(idempotencyService, 'reserve');
		const res = await request(app)
			.post('/api/webhook/alert?autoTrade=private-query-value')
			.set(AUTH)
			.set('x-idempotency-key', 'validation-query-1')
			.send({ text: 'Valid alert' })
			.expect(400);

		expect(res.body.code).toBe('VALIDATION_ERROR');
		expect(res.body.details.errors).toEqual([
			{ location: 'query', path: '/autoTrade', keyword: 'type' },
		]);
		expect(JSON.stringify(res.body)).not.toContain('private-query-value');
		expect(reserveSpy).not.toHaveBeenCalled();
	});

	it('rejects POST /api/webhook/alert with invalid autoTrade type as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/alert')
			.set(AUTH)
			.send({ text: 'Valid alert', autoTrade: 'not-a-bool' })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path === '/autoTrade')).toBe(true);
	});

	it('rejects POST /api/webhook/message with missing message as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/message')
			.set(AUTH)
			.send({ channels: ['telegram'] })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path === '/message')).toBe(true);
	});

	it('rejects POST /api/webhook/volume-confirmation with invalid symbol pattern as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set(AUTH)
			.send({ symbol: 'BTCUSDT' })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path === '/symbol')).toBe(true);
	});

	it('rejects POST /api/webhook/symbol-analysis with unknown property as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set(AUTH)
			.send({ symbol: 'BINANCE:BTCUSDT', invalidAdditionalProp: 'not-allowed' })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.keyword === 'additionalProperties')).toBe(true);
	});

	it('rejects POST /api/webhook/symbol-analysis with invalid timeframe enum as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set(AUTH)
			.send({ symbol: 'BINANCE:BTCUSDT', timeframe: '999d' })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path === '/timeframe')).toBe(true);
	});

	it('rejects POST /api/webhook/expanded-analysis-alert with invalid symbol pattern in array as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/expanded-analysis-alert')
			.set(AUTH)
			.send({ symbols: ['NVDA'] })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path.startsWith('/symbols'))).toBe(true);
	});

	it('rejects POST /api/webhook/market-scanner-alert with invalid scan name enum as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/market-scanner-alert')
			.set(AUTH)
			.send({ scans: ['unsupported_scan'] })
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.path.startsWith('/scans'))).toBe(true);
	});

	it('rejects array JSON body on optional object routes as 400 VALIDATION_ERROR', async () => {
		const res = await request(app)
			.post('/api/webhook/expanded-analysis-alert')
			.set(AUTH)
			.send([123])
			.expect(400);

		assertErrorEnvelope(res.body);
		expect(res.body.details.errors.some((e) => e.keyword === 'type')).toBe(true);
	});

	it('rejects non-empty unparsed bodies on optional-body routes before provider work', async () => {
		const analyzeSpy = jest.spyOn(tradingViewMcpService, 'analyzeSymbolIdentifier').mockResolvedValue({
			status: 'failed',
		});
		const res = await request(app)
			.post('/api/webhook/expanded-analysis-alert')
			.set(AUTH)
			.set('content-type', 'application/octet-stream')
			.send(Buffer.from('unparsed payload'))
			.expect(400);

		expect(res.body.code).toBe('VALIDATION_ERROR');
		expect(res.body.details.errors).toEqual([
			{ location: 'body', path: '/', keyword: 'contentType' },
		]);
		expect(analyzeSpy).not.toHaveBeenCalled();
	});

	it('bypasses validation when ENABLE_REQUEST_VALIDATION=false and reaches handler ad-hoc check', async () => {
		process.env.ENABLE_REQUEST_VALIDATION = 'false';
		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set(AUTH)
			.send({ symbol: 'BTCUSDT' })
			.expect(400);

		// Handler returns INVALID_REQUEST instead of VALIDATION_ERROR
		expect(res.body.code).toBe('INVALID_REQUEST');
		expect(res.body.error).toContain('EXCHANGE:SYMBOL');
	});

	it('enforces API key authentication before request validation', async () => {
		// Without x-api-key, request should be rejected with 401 UNAUTHORIZED, not reaching validator
		const res = await request(app)
			.post('/api/webhook/alert')
			.send({ text: '' })
			.expect(401);

		expect(res.body.code).toBe('UNAUTHORIZED');
	});
});
