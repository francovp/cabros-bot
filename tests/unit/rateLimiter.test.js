// tests/unit/rateLimiter.test.js
const rateLimiter = require('../../src/lib/rateLimiter');
const httpMocks = require('node-mocks-http');

describe('Rate Limiter Middleware', () => {
	let req, res, next;
	let savedRateLimitEnv;

	afterAll(() => {
		rateLimiter.disableTestMode();
	});

	beforeEach(() => {
		savedRateLimitEnv = {
			RATE_LIMIT_MAX: process.env.RATE_LIMIT_MAX,
			RATE_LIMIT_WINDOW_MS: process.env.RATE_LIMIT_WINDOW_MS,
		};
		rateLimiter.enableTestMode();
		rateLimiter.reset();

		req = httpMocks.createRequest({
			method: 'GET',
			url: '/api/test',
			ip: '127.0.0.1',
			headers: { 'user-agent': 'test-agent/1.0' },
		});
		res = httpMocks.createResponse();
		next = jest.fn();
	});

	afterEach(() => {
		rateLimiter.disableTestMode();
		for (const [key, value] of Object.entries(savedRateLimitEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	test('should fallback to req.socket.remoteAddress if req.ip is undefined', () => {
		delete req.ip;
		req.socket = { remoteAddress: '192.168.1.50' };
		rateLimiter(req, res, next);
		expect(next).toHaveBeenCalled();
	});

	test('should reset count after window expiration', () => {
		req.ip = '10.0.0.4';
		const realNow = Date.now;
		let mockTime = 1000000;
		Date.now = jest.fn(() => mockTime);

		try {
			for (let i = 0; i < 100; i++) {
				rateLimiter(req, res, next);
			}

			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);
			expect(resBlocked.statusCode).toBe(429);

			// Advance time past the 15-minute (900,000ms) window
			mockTime += 900001;

			const resAfterWindow = httpMocks.createResponse();
			const nextAfterWindow = jest.fn();
			rateLimiter(req, resAfterWindow, nextAfterWindow);
			expect(nextAfterWindow).toHaveBeenCalled();
			expect(resAfterWindow.statusCode).toBe(200);
		} finally {
			Date.now = realNow;
		}
	});

	test('falls back to safe defaults and warns once per invalid setting', () => {
		process.env.RATE_LIMIT_MAX = 'not-a-number';
		process.env.RATE_LIMIT_WINDOW_MS = 'also-invalid';
		const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

		try {
			for (let i = 0; i < 100; i++) {
				rateLimiter(req, res, next);
			}

			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);

			expect(nextBlocked).not.toHaveBeenCalled();
			expect(resBlocked.statusCode).toBe(429);
			expect(JSON.parse(resBlocked._getData()).retryAfterSeconds).toBeGreaterThan(0);
			expect(warnSpy).toHaveBeenCalledTimes(2);
			expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('not-a-number');
			expect(warnSpy.mock.calls.flat().join(' ')).not.toContain('also-invalid');
		} finally {
			warnSpy.mockRestore();
		}
	});

	test.each(['', '0', '-1', 'NaN', 'Infinity', '1.5', '100abc'])
		('uses the safe max default for invalid RATE_LIMIT_MAX=%s', (value) => {
			process.env.RATE_LIMIT_MAX = value;

			for (let i = 0; i < 100; i++) {
				rateLimiter(req, res, next);
			}

			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);

			expect(nextBlocked).not.toHaveBeenCalled();
			expect(resBlocked.statusCode).toBe(429);
		});

	test.each(['', '0', '-1', 'NaN', 'Infinity', '1.5', '100abc'])
		('uses the safe window default for invalid RATE_LIMIT_WINDOW_MS=%s', (value) => {
			const realNow = Date.now;
			let mockTime = 1000000;
			Date.now = jest.fn(() => mockTime);
			process.env.RATE_LIMIT_MAX = '1';
			process.env.RATE_LIMIT_WINDOW_MS = value;

			try {
				rateLimiter(req, res, next);
				const resBlocked = httpMocks.createResponse();
				const nextBlocked = jest.fn();
				rateLimiter(req, resBlocked, nextBlocked);

				expect(nextBlocked).not.toHaveBeenCalled();
				expect(resBlocked.statusCode).toBe(429);
				expect(JSON.parse(resBlocked._getData()).retryAfterSeconds).toBe(900);
			} finally {
				Date.now = realNow;
			}
		});

	test('preserves valid custom max and window settings', () => {
		const realNow = Date.now;
		let mockTime = 1000000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '2';
		process.env.RATE_LIMIT_WINDOW_MS = '5000';

		try {
			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);

			expect(nextBlocked).not.toHaveBeenCalled();
			expect(resBlocked.statusCode).toBe(429);
			expect(JSON.parse(resBlocked._getData()).retryAfterSeconds).toBe(5);
		} finally {
			Date.now = realNow;
		}
	});

	test.each([
		'/api/webhook/alert',
		'/api/webhook/alert/',
		'/API/WEBHOOK/MESSAGE/',
		'/api/webhook/expanded-analysis-alert',
		'/API/WEBHOOK/EXPANDED-ANALYSIS-ALERT/',
		'/api/webhook/market-scanner-alert',
		'/api/webhook/volume-confirmation',
		'/api/webhook/symbol-analysis',
		'/api/news-monitor',
		'/API/NEWS-MONITOR/',
	])('uses a separate high-capacity bucket for %s', (url) => {
		process.env.RATE_LIMIT_MAX = '2';
		req.method = 'POST';
		req.url = url;
		req.originalUrl = url;

		for (let i = 0; i < 101; i++) {
			rateLimiter(req, res, next);
		}

		expect(next).toHaveBeenCalledTimes(101);
	});

	test('exports WEBHOOK_INGEST_PATHS containing all six webhook/MCP endpoints and news-monitor', () => {
		const expectedPaths = [
			'/api/webhook/alert',
			'/api/webhook/message',
			'/api/webhook/expanded-analysis-alert',
			'/api/webhook/market-scanner-alert',
			'/api/webhook/volume-confirmation',
			'/api/webhook/symbol-analysis',
			'/api/news-monitor',
		];
		expect(rateLimiter.WEBHOOK_INGEST_PATHS).toBeInstanceOf(Set);
		for (const path of expectedPaths) {
			expect(rateLimiter.WEBHOOK_INGEST_PATHS.has(path)).toBe(true);
		}
		expect(rateLimiter.WEBHOOK_INGEST_PATHS.size).toBe(expectedPaths.length);
	});

	test('keeps the ordinary bucket isolated and rate limited', () => {
		process.env.RATE_LIMIT_MAX = '2';

		rateLimiter(req, res, next);
		rateLimiter(req, res, next);
		const resBlocked = httpMocks.createResponse();
		rateLimiter(req, resBlocked, jest.fn());

		expect(resBlocked.statusCode).toBe(429);

		req.method = 'POST';
		req.url = '/api/webhook/alert';
		req.originalUrl = req.url;
		rateLimiter(req, res, next);

		expect(next).toHaveBeenCalledTimes(3);
	});

	describe('API key-based rate limiting', () => {
		test('uses API key hash as bucket key when x-api-key header is present', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.headers['x-api-key'] = 'test-api-key-123';

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);

			// Different API key should get a different bucket
			const req2 = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '127.0.0.1',
				headers: { 'user-agent': 'test-agent/1.0', 'x-api-key': 'different-key-456' },
			});
			const res2 = httpMocks.createResponse();
			rateLimiter(req2, res2, next);
			rateLimiter(req2, res2, next);
			const res2Blocked = httpMocks.createResponse();
			rateLimiter(req2, res2Blocked, jest.fn());
			expect(res2Blocked.statusCode).toBe(429);
		});

		test('uses API key hash as bucket key when api-key query param is present', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.query = { 'api-key': 'query-api-key-789' };

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);
		});

		test('falls back to client IP and prevents User-Agent rotation bypass when no API key is present', () => {
			process.env.RATE_LIMIT_MAX = '2';
			delete req.headers['x-api-key'];
			delete req.query;

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);

			// Same IP with rotating User-Agent MUST share the same bucket and remain blocked
			const reqRotatingUa = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '127.0.0.1',
				headers: { 'user-agent': 'different-agent/2.0' },
			});
			const resRotatingUa = httpMocks.createResponse();
			const nextRotatingUa = jest.fn();
			rateLimiter(reqRotatingUa, resRotatingUa, nextRotatingUa);
			expect(nextRotatingUa).not.toHaveBeenCalled();
			expect(resRotatingUa.statusCode).toBe(429);

			// Different client IP gets a separate bucket
			const reqOtherIp = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '10.0.0.99',
				headers: { 'user-agent': 'different-agent/2.0' },
			});
			const resOtherIp = httpMocks.createResponse();
			const nextOtherIp = jest.fn();
			rateLimiter(reqOtherIp, resOtherIp, nextOtherIp);
			expect(nextOtherIp).toHaveBeenCalled();
			expect(resOtherIp.statusCode).toBe(200);
		});

		test('duplicate api-key query values select the same bucket as scalar api-key', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.query = { 'api-key': 'test-query-key-789' };

			rateLimiter(req, res, next);
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// Duplicate query param with extra rotated value must resolve to the first authenticated key
			const reqDup = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '127.0.0.1',
				query: { 'api-key': ['test-query-key-789', 'rotated-nonce-value'] },
			});
			const resDup = httpMocks.createResponse();
			const nextDup = jest.fn();
			rateLimiter(reqDup, resDup, nextDup);

			expect(nextDup).not.toHaveBeenCalled();
			expect(resDup.statusCode).toBe(429);
		});

		test('isolates authenticated callers sharing the same API key by trusted client IP', () => {
			process.env.RATE_LIMIT_MAX = '2';
			const reqClientA = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '192.168.1.10',
				headers: { 'x-api-key': 'shared-api-key-abc' },
			});
			rateLimiter(reqClientA, res, next);
			rateLimiter(reqClientA, res, next);

			const resClientABlocked = httpMocks.createResponse();
			rateLimiter(reqClientA, resClientABlocked, jest.fn());
			expect(resClientABlocked.statusCode).toBe(429);

			// Client B with same API key but different IP must have its own fresh bucket
			const reqClientB = httpMocks.createRequest({
				method: 'GET',
				url: '/api/test',
				ip: '192.168.1.20',
				headers: { 'x-api-key': 'shared-api-key-abc' },
			});
			const resClientB = httpMocks.createResponse();
			const nextClientB = jest.fn();
			rateLimiter(reqClientB, resClientB, nextClientB);

			expect(nextClientB).toHaveBeenCalled();
			expect(resClientB.statusCode).toBe(200);
		});

		test('isolates authenticated callers sharing the same API key by trusted client IP on webhook ingest paths', () => {
			req.method = 'POST';
			req.url = '/api/webhook/alert';
			req.originalUrl = '/api/webhook/alert';
			req.ip = '192.168.1.10';
			req.headers['x-api-key'] = 'shared-webhook-key';

			for (let i = 0; i < 1000; i++) {
				rateLimiter(req, res, next);
			}
			const resBlocked = httpMocks.createResponse();
			const nextBlocked = jest.fn();
			rateLimiter(req, resBlocked, nextBlocked);
			expect(resBlocked.statusCode).toBe(429);

			// Client B with same API key on webhook ingest must not be blocked
			const reqClientB = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				originalUrl: '/api/webhook/alert',
				ip: '192.168.1.20',
				headers: { 'x-api-key': 'shared-webhook-key' },
			});
			const resClientB = httpMocks.createResponse();
			const nextClientB = jest.fn();
			rateLimiter(reqClientB, resClientB, nextClientB);
			expect(nextClientB).toHaveBeenCalled();
			expect(resClientB.statusCode).toBe(200);
		});

		test('webhook ingest paths use API key aware bucket key', () => {
			process.env.RATE_LIMIT_MAX = '2';
			req.method = 'POST';
			req.url = '/api/webhook/alert';
			req.originalUrl = '/api/webhook/alert';
			req.headers['x-api-key'] = 'webhook-key';

			// Should not hit limit at 101 requests (webhook max is 1000)
			for (let i = 0; i < 101; i++) {
				rateLimiter(req, res, next);
			}
			expect(next).toHaveBeenCalledTimes(101);

			// Different API key on webhook should be separate
			const req2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				originalUrl: '/api/webhook/alert',
				ip: '127.0.0.1',
				headers: { 'user-agent': 'test-agent/1.0', 'x-api-key': 'webhook-key-2' },
			});
			const res2 = httpMocks.createResponse();
			for (let i = 0; i < 101; i++) {
				rateLimiter(req2, res2, next);
			}
			expect(next).toHaveBeenCalledTimes(202);
		});

		describe('key derivation helper (_getRateLimitKey)', () => {
			test('produces identical bucket key for scalar and duplicate query api-key', () => {
				const reqScalar = { ip: '1.2.3.4', query: { 'api-key': 'secret-test-key' } };
				const reqArray = { ip: '1.2.3.4', query: { 'api-key': ['secret-test-key', 'extra-nonce'] } };
				expect(rateLimiter._getRateLimitKey(reqScalar)).toBe(rateLimiter._getRateLimitKey(reqArray));
			});

			test('binds client IP into authenticated bucket key to isolate tenants sharing a key', () => {
				const reqTenant1 = { ip: '10.0.0.1', headers: { 'x-api-key': 'shared-key' } };
				const reqTenant2 = { ip: '10.0.0.2', headers: { 'x-api-key': 'shared-key' } };
				expect(rateLimiter._getRateLimitKey(reqTenant1)).not.toBe(rateLimiter._getRateLimitKey(reqTenant2));
				expect(rateLimiter._getRateLimitKey(reqTenant1)).toMatch(/^key:[a-f0-9]{12}:ip:10\.0\.0\.1$/);
				expect(rateLimiter._getRateLimitKey(reqTenant2)).toMatch(/^key:[a-f0-9]{12}:ip:10\.0\.0\.2$/);
			});

			test('uses client IP as sole unauthenticated identity and ignores User-Agent changes', () => {
				const reqUa1 = { ip: '1.2.3.4', headers: { 'user-agent': 'curl/7.68.0' } };
				const reqUa2 = { ip: '1.2.3.4', headers: { 'user-agent': 'Mozilla/5.0' } };
				expect(rateLimiter._getRateLimitKey(reqUa1)).toBe('ip:1.2.3.4');
				expect(rateLimiter._getRateLimitKey(reqUa2)).toBe('ip:1.2.3.4');
			});

			test('treats empty or non-string API key as unauthenticated', () => {
				const reqEmpty = { ip: '1.2.3.4', headers: { 'x-api-key': '' } };
				const reqObj = { ip: '1.2.3.4', query: { 'api-key': {} } };
				expect(rateLimiter._getRateLimitKey(reqEmpty)).toBe('ip:1.2.3.4');
				expect(rateLimiter._getRateLimitKey(reqObj)).toBe('ip:1.2.3.4');
			});
		});
	});
	test('emits X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset on successful requests', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '5';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);

			expect(next).toHaveBeenCalled();
			expect(res.getHeader('X-RateLimit-Limit')).toBe('5');
			expect(res.getHeader('X-RateLimit-Remaining')).toBe('4');
			expect(res.getHeader('X-RateLimit-Reset')).toBe(
				String(Math.ceil((mockTime + 60000) / 1000))
			);
		} finally {
			Date.now = realNow;
		}
	});

	test('emits X-RateLimit-* headers on throttled 429 responses alongside Retry-After', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '1';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(req, resBlocked, jest.fn());

			expect(resBlocked.statusCode).toBe(429);
			expect(resBlocked.getHeader('X-RateLimit-Limit')).toBe('1');
			expect(resBlocked.getHeader('X-RateLimit-Remaining')).toBe('0');
			expect(resBlocked.getHeader('X-RateLimit-Reset')).toBe(
				String(Math.ceil((mockTime + 60000) / 1000))
			);
			expect(resBlocked.getHeader('Retry-After')).toBeDefined();
		} finally {
			Date.now = realNow;
		}
	});

	test('decrements X-RateLimit-Remaining across sequential requests within the window', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '10';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);
			expect(res.getHeader('X-RateLimit-Remaining')).toBe('9');

			const res2 = httpMocks.createResponse();
			rateLimiter(req, res2, jest.fn());
			expect(res2.getHeader('X-RateLimit-Remaining')).toBe('8');

			const res3 = httpMocks.createResponse();
			rateLimiter(req, res3, jest.fn());
			expect(res3.getHeader('X-RateLimit-Remaining')).toBe('7');
		} finally {
			Date.now = realNow;
		}
	});

	test('isolates X-RateLimit-* headers between ordinary and webhook buckets', () => {
		const realNow = Date.now;
		let mockTime = 1_000_000;
		Date.now = jest.fn(() => mockTime);
		process.env.RATE_LIMIT_MAX = '5';
		process.env.RATE_LIMIT_WINDOW_MS = '60000';

		try {
			rateLimiter(req, res, next);
			expect(res.getHeader('X-RateLimit-Limit')).toBe('5');
			expect(res.getHeader('X-RateLimit-Remaining')).toBe('4');

			const webhookReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				ip: '127.0.0.1',
			});
			const webhookRes = httpMocks.createResponse();
			rateLimiter(webhookReq, webhookRes, jest.fn());

			expect(webhookRes.getHeader('X-RateLimit-Limit')).toBe('1000');
			expect(webhookRes.getHeader('X-RateLimit-Remaining')).toBe('999');
		} finally {
			Date.now = realNow;
		}
	});

});
