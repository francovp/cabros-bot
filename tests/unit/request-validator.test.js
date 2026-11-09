'use strict';

const {
	validateRequest,
	isRequestValidationEnabled,
	formatValidationErrors,
	routeValidators,
	compileOperationValidator,
} = require('../../src/lib/requestValidator');
const httpMocks = require('node-mocks-http');

describe('requestValidator', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('isRequestValidationEnabled', () => {
		it('defaults to true when env var is undefined in non-test environment', () => {
			delete process.env.ENABLE_REQUEST_VALIDATION;
			process.env.NODE_ENV = 'production';
			expect(isRequestValidationEnabled()).toBe(true);
		});

		it('defaults to true when env var is undefined in test environment', () => {
			delete process.env.ENABLE_REQUEST_VALIDATION;
			process.env.NODE_ENV = 'test';
			expect(isRequestValidationEnabled()).toBe(true);
		});

		it('returns true when ENABLE_REQUEST_VALIDATION=true in any environment', () => {
			process.env.ENABLE_REQUEST_VALIDATION = 'true';
			process.env.NODE_ENV = 'test';
			expect(isRequestValidationEnabled()).toBe(true);
		});

		it('returns false when ENABLE_REQUEST_VALIDATION=false in production', () => {
			process.env.ENABLE_REQUEST_VALIDATION = 'false';
			process.env.NODE_ENV = 'production';
			expect(isRequestValidationEnabled()).toBe(false);
		});

		it('disables only for the literal false value', () => {
			for (const value of ['FALSE', 'Off', 'no', '0', ' false ']) {
				process.env.ENABLE_REQUEST_VALIDATION = value;
				expect(isRequestValidationEnabled()).toBe(true);
			}
		});
	});

	describe('formatValidationErrors', () => {
		it('returns empty array when errors are null or empty', () => {
			expect(formatValidationErrors(null)).toEqual([]);
			expect(formatValidationErrors([])).toEqual([]);
		});

		it('formats missing property from params.missingProperty', () => {
			const ajvErrors = [
				{
					instancePath: '',
					keyword: 'required',
					params: { missingProperty: 'text' },
					message: "must have required property 'text'",
				},
			];
			const formatted = formatValidationErrors(ajvErrors);
			expect(formatted).toEqual([
				{
					location: 'body',
					path: '/text',
					keyword: 'required',
				},
			]);
		});

		it('formats instancePath when available', () => {
			const ajvErrors = [
				{
					instancePath: '/channels/0',
					keyword: 'enum',
					params: { allowedValues: ['telegram', 'whatsapp', 'discord'] },
					message: 'must be equal to one of the allowed values',
				},
			];
			const formatted = formatValidationErrors(ajvErrors);
			expect(formatted).toEqual([
				{
					location: 'body',
					path: '/channels/0',
					keyword: 'enum',
				},
			]);
		});

		it('sanitizes errors and never includes raw submitted data', () => {
			const ajvErrors = [
				{
					instancePath: '/secretField',
					keyword: 'pattern',
					data: 'super-secret-user-input',
					message: 'must match pattern',
				},
			];
			const formatted = formatValidationErrors(ajvErrors);
			expect(formatted[0]).not.toHaveProperty('data');
			expect(formatted[0]).not.toHaveProperty('message');
			expect(formatted[0]).toHaveProperty('location', 'body');
			expect(JSON.stringify(formatted)).not.toContain('super-secret-user-input');
		});
	});

	describe('Route schemas compilation', () => {
		it('compiles validators for all six webhook routes', () => {
			const expectedPaths = [
				'/api/webhook/alert',
				'/api/webhook/message',
				'/api/webhook/expanded-analysis-alert',
				'/api/webhook/market-scanner-alert',
				'/api/webhook/volume-confirmation',
				'/api/webhook/symbol-analysis',
			];
			for (const p of expectedPaths) {
				expect(routeValidators.has(p)).toBe(true);
			}
		});

		it('validates AlertRequest schema', () => {
			const validator = routeValidators.get('/api/webhook/alert');
			expect(validator.validate({ text: 'BTC breakout', channels: ['telegram'] })).toBe(true);
			expect(validator.validate({ text: '' })).toBe(false); // minLength 1
			expect(validator.validate({})).toBe(false); // required text
			expect(validator.validate({ text: 'BTC', channels: ['slack'] })).toBe(false); // invalid enum
			expect(validator.validate({ text: 'BTC', autoTrade: 'yes' })).toBe(false); // non-boolean
		});

		it('validates MessageRequest schema', () => {
			const validator = routeValidators.get('/api/webhook/message');
			expect(validator.validate({ message: 'Deployment done', channels: ['telegram'] })).toBe(true);
			expect(validator.validate({})).toBe(false); // required message
			expect(validator.validate({ message: '' })).toBe(false); // minLength 1
			expect(validator.validate({ message: 'Hello', channels: ['unknown'] })).toBe(false);
		});

		it('validates VolumeConfirmationRequest schema', () => {
			const validator = routeValidators.get('/api/webhook/volume-confirmation');
			expect(validator.validate({ symbol: 'BINANCE:BTCUSDT', timeframe: '1h' })).toBe(true);
			expect(validator.validate({})).toBe(false); // required symbol
			expect(validator.validate({ symbol: 'BTCUSDT' })).toBe(false); // missing EXCHANGE prefix pattern
			expect(validator.validate({ symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: 'yes' })).toBe(false); // non-boolean
		});

		it('validates SymbolAnalysisRequest schema', () => {
			const validator = routeValidators.get('/api/webhook/symbol-analysis');
			expect(validator.validate({ symbol: 'BINANCE:BTCUSDT', timeframe: '1D' })).toBe(true);
			expect(validator.validate({})).toBe(false); // required symbol
			expect(validator.validate({ symbol: 'BTCUSDT' })).toBe(false); // missing exchange
			expect(validator.validate({ symbol: 'BINANCE:BTCUSDT', timeframe: 'invalid' })).toBe(false); // invalid enum
			expect(validator.validate({ symbol: 'BINANCE:BTCUSDT', unknownField: 123 })).toBe(false); // additionalProperties false
		});

		it('validates ExpandedAnalysisRequest schema', () => {
			const validator = routeValidators.get('/api/webhook/expanded-analysis-alert');
			expect(validator.validate({ symbols: ['BINANCE:BTCUSDT'], timeframe: '1D' })).toBe(true);
			expect(validator.validate({})).toBe(true); // symbols optional at schema level
			expect(validator.validate({ symbols: ['BTCUSDT'] })).toBe(false); // invalid symbol pattern
			expect(validator.validate({ symbols: ['BINANCE:BTCUSDT'], timeframe: '2D' })).toBe(false); // invalid timeframe enum
		});

		it('validates MarketScannerRequest schema', () => {
			const validator = routeValidators.get('/api/webhook/market-scanner-alert');
			expect(validator.validate({ exchange: 'BINANCE', timeframe: '4h', scans: ['top_gainers'] })).toBe(true);
			expect(validator.validate({})).toBe(true);
			expect(validator.validate({ scans: ['invalid_scan'] })).toBe(false);
			expect(validator.validate({ limit: 'not-a-number' })).toBe(false);
		});
	});

	describe('validateRequest middleware', () => {
		beforeEach(() => {
			process.env.ENABLE_REQUEST_VALIDATION = 'true';
		});
		it('bypasses validation when ENABLE_REQUEST_VALIDATION=false', () => {
			process.env.ENABLE_REQUEST_VALIDATION = 'false';
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				body: { text: '' }, // invalid payload
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.statusCode).toBe(200); // untouched
		});

		it('rejects invalid OpenAPI query parameters with a safe query location', () => {
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert?autoTrade=private-query-value',
				query: { autoTrade: 'private-query-value' },
				body: { text: 'Valid alert' },
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(400);
			const data = JSON.parse(res._getData());
			expect(data.code).toBe('VALIDATION_ERROR');
			expect(data.details.errors).toEqual([
				{ location: 'query', path: '/autoTrade', keyword: 'type' },
			]);
			expect(JSON.stringify(data)).not.toContain('private-query-value');
		});

		it('validates boolean query strings without mutating req.query', () => {
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert?autoTrade=true',
				query: { autoTrade: 'true' },
				body: { text: 'Valid alert' },
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(req.query.autoTrade).toBe('true');
		});

		it('validates required path parameters from the compiled OpenAPI operation', () => {
			const path = '/api/webhook/synthetic/{eventId}';
			const routeValidator = compileOperationValidator({
				parameters: [{
					name: 'eventId',
					in: 'path',
					required: true,
					schema: { type: 'integer', minimum: 1 },
				}],
			}, {});
			routeValidators.set(path, routeValidator);
			try {
				const middleware = validateRequest(path);
				const req = httpMocks.createRequest({
					method: 'POST',
					url: '/api/webhook/synthetic/not-an-integer',
					params: { eventId: 'not-an-integer' },
				});
				const res = httpMocks.createResponse();
				const next = jest.fn();

				middleware(req, res, next);
				expect(next).not.toHaveBeenCalled();
				expect(JSON.parse(res._getData()).details.errors).toEqual([
					{ location: 'path', path: '/eventId', keyword: 'type' },
				]);
			} finally {
				routeValidators.delete(path);
			}
		});

		it('passes valid request to next()', () => {
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				body: { text: 'Valid alert text', channels: ['telegram'] },
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.statusCode).toBe(200);
		});

		it('accepts valid text/plain alert payload', () => {
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'content-type': 'text/plain' },
				body: 'BTCUSDT broke resistance',
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).toHaveBeenCalled();
		});

		it('rejects whitespace-only text/plain alert payload', () => {
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'content-type': 'text/plain' },
				body: ' \t\n ',
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(400);
			expect(JSON.parse(res._getData()).details.errors).toEqual([
				{ location: 'body', path: '/', keyword: 'pattern' },
			]);
		});

		it('returns 400 VALIDATION_ERROR on malformed JSON payload', () => {
			const middleware = validateRequest('/api/webhook/message');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/message',
				body: {
					message: '', // minLength 1 violation
					channels: ['invalid-channel'], // enum violation
				},
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(400);

			const data = JSON.parse(res._getData());
			expect(data).toEqual(expect.objectContaining({
				success: false,
				code: 'VALIDATION_ERROR',
				retryable: false,
			}));
			expect(typeof data.error).toBe('string');
			expect(data.error).toContain('Request validation failed');
			expect(Array.isArray(data.details.errors)).toBe(true);
			expect(data.details.errors.length).toBeGreaterThanOrEqual(1);
			expect(data.details.errors[0]).toHaveProperty('path');
			expect(data.details.errors[0]).toHaveProperty('keyword');
			expect(data.details.errors[0]).toMatchObject({
				location: 'body',
				path: '/message',
				keyword: 'minLength',
			});
			expect(Object.keys(data.details.errors[0]).sort()).toEqual(['keyword', 'location', 'path']);
			expect(data.details.errors).toHaveLength(1);
		});

		it('returns 400 VALIDATION_ERROR when required body is missing', () => {
			const middleware = validateRequest('/api/webhook/volume-confirmation');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/volume-confirmation',
			});
			delete req.body;
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(400);

			const data = JSON.parse(res._getData());
			expect(data).toMatchObject({
				success: false,
				code: 'VALIDATION_ERROR',
				retryable: false,
				error: 'Request validation failed',
			});
			expect(data.details.errors).toEqual([
				{ location: 'body', path: '/', keyword: 'required' },
			]);
		});

		it('bypasses validation when route is not registered in OpenAPI validators', () => {
			const middleware = validateRequest('/api/non-existent-route');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/non-existent-route',
				body: { anything: 'goes' },
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).toHaveBeenCalled();
		});

		it('rejects primitive non-object bodies on optional-body routes', () => {
			process.env.ENABLE_REQUEST_VALIDATION = 'true';
			const middleware = validateRequest('/api/webhook/expanded-analysis-alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/expanded-analysis-alert',
				body: 123,
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(400);

			const data = JSON.parse(res._getData());
			expect(data).toMatchObject({
				success: false,
				code: 'VALIDATION_ERROR',
				retryable: false,
			});
			expect(data.details.errors[0]).toMatchObject({
				location: 'body',
				path: '/',
				keyword: 'type',
			});
		});

		it('rejects an undocumented request content type without echoing input', () => {
			const middleware = validateRequest('/api/webhook/alert');
			const req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'content-type': 'application/xml' },
				body: '<text>private-body-value</text>',
			});
			const res = httpMocks.createResponse();
			const next = jest.fn();

			middleware(req, res, next);
			expect(next).not.toHaveBeenCalled();
			expect(res.statusCode).toBe(400);
			const data = JSON.parse(res._getData());
			expect(data.details.errors).toEqual([
				{ location: 'body', path: '/', keyword: 'contentType' },
			]);
			expect(JSON.stringify(data)).not.toContain('private-body-value');
		});

	});
});
