'use strict';

const httpMocks = require('node-mocks-http');
const { idempotencyService } = require('../../src/services/storage/IdempotencyService');
const { idempotencyMiddleware } = require('../../src/lib/idempotency');

describe('Idempotency Service & Middleware', () => {
	beforeEach(() => {
		idempotencyService.clear();
		jest.restoreAllMocks();
		delete process.env.WEBHOOK_IDEMPOTENCY_TTL_MS;
	});

	describe('IdempotencyService', () => {
		test('should store and retrieve cached response details', () => {
			const key = 'test-key-1';
			const payload = { body: { text: 'alert-1' }, query: {} };
			const response = {
				statusCode: 200,
				body: { success: true, results: [] },
				headers: { 'content-type': 'application/json' },
			};

			idempotencyService.set(key, payload, response);

			const cached = idempotencyService.get(key, payload);
			expect(cached).not.toBeNull();
			expect(cached.statusCode).toBe(200);
			expect(cached.responseBody).toEqual({ success: true, results: [] });
			expect(cached.headers['content-type']).toBe('application/json');
		});

		test('should throw IDEMPOTENCY_CONFLICT when payload does not match the cached hash', () => {
			const key = 'test-key-2';
			const response = {
				statusCode: 200,
				body: { success: true },
				headers: {},
			};

			idempotencyService.set(key, { body: { text: 'alert-2' }, query: {} }, response);

			expect(() => {
				idempotencyService.reserve(key, { body: { text: 'different-alert' }, query: {} });
			}).toThrow('Idempotency key was reused with a different payload');
		});

		test('should honor custom TTL from environment', () => {
			process.env.WEBHOOK_IDEMPOTENCY_TTL_MS = '1000';
			expect(idempotencyService.getTtlMs()).toBe(1000);

			const key = 'test-key-ttl';
			const payload = { body: { text: 'ttl-test' }, query: {} };
			const response = { statusCode: 200, body: 'ok', headers: {} };

			idempotencyService.set(key, payload, response);

			// Mock Date.now to simulate expiration
			const now = Date.now();
			const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(now + 1001);

			const cached = idempotencyService.get(key, payload);
			expect(cached).toBeNull();
			dateSpy.mockRestore();
		});

		test('should evict oldest key when cache size exceeds limit', () => {
			// Mock max keys to a smaller number for testing eviction
			const originalMaxKeys = idempotencyService.maxKeys;
			idempotencyService.maxKeys = 3;

			try {
				idempotencyService.set('key-1', { body: 'body-1', query: {} }, { statusCode: 200, body: '1' });
				idempotencyService.set('key-2', { body: 'body-2', query: {} }, { statusCode: 200, body: '2' });
				idempotencyService.set('key-3', { body: 'body-3', query: {} }, { statusCode: 200, body: '3' });

				expect(idempotencyService.get('key-1', { body: 'body-1', query: {} })).not.toBeNull();

				// Adding 4th key should evict 'key-1' (as it was the oldest inserted)
				idempotencyService.set('key-4', { body: 'body-4', query: {} }, { statusCode: 200, body: '4' });

				expect(idempotencyService.get('key-1', { body: 'body-1', query: {} })).toBeNull();
				expect(idempotencyService.get('key-2', { body: 'body-2', query: {} })).not.toBeNull();
				expect(idempotencyService.get('key-4', { body: 'body-4', query: {} })).not.toBeNull();
			} finally {
				idempotencyService.maxKeys = originalMaxKeys;
			}
		});

		test('should keep retries pending until the first matching request completes', async () => {
			const key = 'pending-key';
			const payload = { body: { text: 'alert-1' }, query: { useTradingViewData: 'true' } };

			expect(idempotencyService.reserve(key, payload)).toEqual({ state: 'fresh' });

			const pendingRetry = idempotencyService.reserve(key, payload);
			expect(pendingRetry.state).toBe('pending');

			idempotencyService.set(key, payload, { statusCode: 200, body: { success: true }, headers: {} });

			await expect(pendingRetry.promise).resolves.toMatchObject({
				state: 'completed',
				statusCode: 200,
				responseBody: { success: true },
			});
		});
	});

	describe('idempotencyMiddleware', () => {
		let req, res, next;

		beforeEach(() => {
			req = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				body: { text: 'test alert' },
			});
			res = httpMocks.createResponse();
			next = jest.fn();
		});

		test('should call next() directly if no idempotency key is present', () => {
			idempotencyMiddleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.getHeader('Idempotency-Replay')).toBeUndefined();
		});

		test('should set Idempotency-Replay to false for fresh request with header key', () => {
			req.headers['idempotency-key'] = 'unique-key-header';

			idempotencyMiddleware(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.getHeader('Idempotency-Replay')).toBe('false');
		});

		test('should set Idempotency-Replay to false for fresh request with body key', () => {
			delete req.body.text;
			req.body.idempotencyKey = 'unique-key-body';

			idempotencyMiddleware(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.getHeader('Idempotency-Replay')).toBe('false');
		});

		test('should cache and replay a response on second call with same key', () => {
			const key = 'test-replay-key';
			req.headers['idempotency-key'] = key;
			req.body = { text: 'replay-alert' };

			// First request processes
			idempotencyMiddleware(req, res, next);
			expect(next).toHaveBeenCalled();
			expect(res.getHeader('Idempotency-Replay')).toBe('false');

			// Controller sends JSON response
			res.status(202).json({ success: true, details: 'alert sent' });

			// Second request with same key/payload
			const req2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'idempotency-key': key },
				body: { text: 'replay-alert' },
			});
			const res2 = httpMocks.createResponse();
			const next2 = jest.fn();

			idempotencyMiddleware(req2, res2, next2);

			expect(next2).not.toHaveBeenCalled();
			expect(res2.statusCode).toBe(202);
			expect(res2.getHeader('Idempotency-Replay')).toBe('true');

			const responseBody = JSON.parse(res2._getData());
			expect(responseBody.success).toBe(true);
			expect(responseBody.idempotencyReplayed).toBe(true);
		});

		test('should return 409 Conflict if payload changes for the same key', () => {
			const key = 'conflict-key';
			req.headers['idempotency-key'] = key;
			req.body = { text: 'alert-a' };

			idempotencyMiddleware(req, res, next);
			res.status(200).json({ success: true });

			const req2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'idempotency-key': key },
				body: { text: 'alert-b' }, // different body!
			});
			const res2 = httpMocks.createResponse();
			const next2 = jest.fn();

			idempotencyMiddleware(req2, res2, next2);

			expect(next2).not.toHaveBeenCalled();
			expect(res2.statusCode).toBe(409);
			const responseBody = JSON.parse(res2._getData());
			expect(responseBody.error).toBe('Idempotency key was reused with a different payload');
			expect(responseBody.code).toBe('IDEMPOTENCY_CONFLICT');
		});

		test('should NOT cache error responses with status code >= 500', () => {
			const key = 'transient-error-key';
			req.headers['idempotency-key'] = key;

			idempotencyMiddleware(req, res, next);
			res.status(503).json({ error: 'Service Unavailable' });

			// Check that key is not in cache
			const record = idempotencyService.get(key, { body: req.body, query: req.query || {} });
			expect(record).toBeNull();
		});

		test('should cache successful error responses with status code < 500 (e.g. 400)', () => {
			const key = 'client-error-key';
			req.headers['idempotency-key'] = key;

			idempotencyMiddleware(req, res, next);
			res.status(400).json({ error: 'Bad Request' });

			// Check that key is in cache
			const record = idempotencyService.get(key, { body: req.body, query: req.query || {} });
			expect(record).not.toBeNull();
			expect(record.statusCode).toBe(400);
		});

		test('should wait for in-flight request and replay once the first response is available', async () => {
			const key = 'in-flight-key';
			req.headers['idempotency-key'] = key;

			idempotencyMiddleware(req, res, next);
			expect(next).toHaveBeenCalledTimes(1);

			const req2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'idempotency-key': key },
				body: { text: 'test alert' },
			});
			const res2 = httpMocks.createResponse();
			const next2 = jest.fn();

			idempotencyMiddleware(req2, res2, next2);
			expect(next2).not.toHaveBeenCalled();
			expect(res2._isEndCalled()).toBe(false);

			res.status(202).json({ success: true, details: 'alert sent' });

			await new Promise(setImmediate);

			expect(res2.statusCode).toBe(202);
			expect(res2.getHeader('Idempotency-Replay')).toBe('true');
			expect(JSON.parse(res2._getData())).toEqual({
				success: true,
				details: 'alert sent',
				idempotencyReplayed: true,
			});
		});

		test('should treat request query as part of the idempotency fingerprint', () => {
			const key = 'query-sensitive-key';
			req.headers['idempotency-key'] = key;
			req.query = { useTradingViewData: 'true' };

			idempotencyMiddleware(req, res, next);
			res.status(200).json({ enriched: true });

			const req2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				headers: { 'idempotency-key': key },
				body: { text: 'test alert' },
				query: {},
			});
			const res2 = httpMocks.createResponse();
			const next2 = jest.fn();

			idempotencyMiddleware(req2, res2, next2);

			expect(next2).not.toHaveBeenCalled();
			expect(res2.statusCode).toBe(409);
			expect(JSON.parse(res2._getData())).toEqual({
				error: 'Idempotency key was reused with a different payload',
				code: 'IDEMPOTENCY_CONFLICT',
			});
		});
	});
});