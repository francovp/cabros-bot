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

	// RATE_LIMIT_API_KEY_MAX deliberately does not apply to webhook ingest paths:
	// those always use the isolated fixed 1,000-request allowance so TradingView
	// and scanner bursts keep their headroom. Asserted here so the precedence
	// cannot be flipped silently; the exclusion is documented in .env.example
	// and docs/environment-configuration.md.
	test('ignores RATE_LIMIT_API_KEY_MAX on webhook ingest paths', () => {
		const saved = {
			RATE_LIMIT_API_KEY_MAX: process.env.RATE_LIMIT_API_KEY_MAX,
			WEBHOOK_API_KEY: process.env.WEBHOOK_API_KEY,
		};
		process.env.RATE_LIMIT_API_KEY_MAX = '1';
		process.env.RATE_LIMIT_MAX = '1';
		process.env.WEBHOOK_API_KEY = 'ingest-key';
		rateLimiter.reset();

		try {
			const ingestReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/webhook/alert',
				ip: '127.0.0.1',
				headers: { 'x-api-key': 'ingest-key' },
			});
			const firstNext = jest.fn();
			rateLimiter(ingestReq, httpMocks.createResponse(), firstNext);
			const secondNext = jest.fn();
			rateLimiter(ingestReq, httpMocks.createResponse(), secondNext);

			// Both pass: the ingest allowance is 1,000, not the configured 1.
			expect(firstNext).toHaveBeenCalled();
			expect(secondNext).toHaveBeenCalled();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
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

	describe('API-key aware rate limiting (issue #692)', () => {
		beforeEach(() => {
			process.env.RATE_LIMIT_MAX = '2';
			delete process.env.RATE_LIMIT_API_KEY_MAX;
		});

		test('separates ordinary buckets by API-key hash when WEBHOOK_API_KEY is configured', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';

			const apiReq1 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});
			const apiReq2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.99',
				headers: { 'x-api-key': 'super-secret' },
			});
			const unauthReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
			});

			// Two authenticated requests from the SAME api-key (different IPs) share a bucket.
			rateLimiter(apiReq1, httpMocks.createResponse(), next);
			rateLimiter(apiReq2, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(apiReq1, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// Unauthenticated request from the same IP as the original blocked api-key caller
			// must still be allowed (separate bucket).
			const resOk = httpMocks.createResponse();
			const nextOk = jest.fn();
			rateLimiter(unauthReq, resOk, nextOk);
			expect(nextOk).toHaveBeenCalled();
		});

		test('separates buckets by API-key identity when multiple keys are configured', () => {
			process.env.WEBHOOK_API_KEYS = 'key-one,key-two';

			const apiReq1 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'key-one' },
			});
			const apiReq2 = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'key-two' },
			});

			rateLimiter(apiReq1, httpMocks.createResponse(), next);
			rateLimiter(apiReq1, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(apiReq1, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// key-two from the SAME IP must still be allowed (different bucket).
			const resOk = httpMocks.createResponse();
			const nextOk = jest.fn();
			rateLimiter(apiReq2, resOk, nextOk);
			expect(nextOk).toHaveBeenCalled();
		});
		test('keys anonymous traffic only on req.ip (no User-Agent fingerprint) when TRUST_PROXY is enabled', () => {
			process.env.TRUST_PROXY = '1';

			const browserReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'Mozilla/5.0 test-browser' },
			});
			const botReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'curl/8.4.0' },
			});

			// User-Agent is intentionally NOT part of the bucket key: an
			// attacker-controlled header must not let one client mint fresh
			// buckets to bypass the limit. With TRUST_PROXY on, both clients
			// share the trusted `req.ip` (203.0.113.10) bucket.
			rateLimiter(browserReq, httpMocks.createResponse(), next);
			rateLimiter(browserReq, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(browserReq, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// The "bot" request from the same IP but different UA is rejected
			// because the bucket is already exhausted — proving that UA
			// rotation no longer bypasses the limit.
			const resBot = httpMocks.createResponse();
			const nextBot = jest.fn();
			rateLimiter(botReq, resBot, nextBot);
			expect(resBot.statusCode).toBe(429);
			expect(nextBot).not.toHaveBeenCalled();
		});

		test('falls back to IP-only key when TRUST_PROXY is disabled (no API key awareness change)', () => {
			process.env.TRUST_PROXY = 'false';
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.WEBHOOK_API_KEYS;

			const reqA = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'Mozilla/5.0 test-browser' },
			});
			const reqB = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'user-agent': 'curl/8.4.0' },
			});

			// With TRUST_PROXY=false and no API keys configured, both requests share the
			// IP-only bucket to preserve legacy single-replica behavior.
			rateLimiter(reqA, httpMocks.createResponse(), next);
			rateLimiter(reqB, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(reqA, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);
		});

		test('honors RATE_LIMIT_API_KEY_MAX override for authenticated callers', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';
			process.env.RATE_LIMIT_API_KEY_MAX = '1';

			const authReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});
			const unauthReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
			});

			// Authenticated bucket limited to RATE_LIMIT_API_KEY_MAX=1.
			rateLimiter(authReq, httpMocks.createResponse(), next);
			const resBlocked = httpMocks.createResponse();
			rateLimiter(authReq, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);

			// Unauthenticated bucket has its own RATE_LIMIT_MAX=2 budget — fill it then block.
			rateLimiter(unauthReq, httpMocks.createResponse(), next);
			rateLimiter(unauthReq, httpMocks.createResponse(), next);
			const resUnauthBlocked = httpMocks.createResponse();
			rateLimiter(unauthReq, resUnauthBlocked, jest.fn());
			expect(resUnauthBlocked.statusCode).toBe(429);
		});

		test('treats WEBHOOK_API_KEY and WEBHOOK_API_KEYS as a union (both keys accepted)', () => {
			process.env.WEBHOOK_API_KEY = 'primary';
			process.env.WEBHOOK_API_KEYS = 'secondary,tertiary';

			const primaryReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'primary' },
			});
			const secondaryReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'secondary' },
			});
			const tertiaryReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'tertiary' },
			});

			// Each key must be recognized as an authenticated caller (per-key bucket).
			rateLimiter(primaryReq, httpMocks.createResponse(), next);
			rateLimiter(secondaryReq, httpMocks.createResponse(), next);
			rateLimiter(tertiaryReq, httpMocks.createResponse(), next);
			// All three calls should have been allowed (each bucket is fresh).
			expect(next).toHaveBeenCalledTimes(3);
		});

		test('uses HMAC-SHA256 fingerprint so the bucket key is not derivable from a plain SHA-256', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';

			const apiReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});

			const bucketKey = rateLimiter.deriveBucketKey({
				req: apiReq,
				ip: '203.0.113.10',
				isWebhookIngest: false,
			});

			// The bucket key must include the per-process HMAC fingerprint, not
			// a publicly reversible SHA-256 of the cleartext key. The fingerprint
			// must be a 16-hex-char suffix.
			expect(bucketKey).toMatch(/^apikey:[a-f0-9]{16}$/);
			expect(rateLimiter.hashApiKey('super-secret')).toMatch(/^[a-f0-9]{16}$/);
		});
		test('rejects invalid RATE_LIMIT_API_KEY_MAX with safe default', () => {
			process.env.WEBHOOK_API_KEY = 'super-secret';
			process.env.RATE_LIMIT_API_KEY_MAX = 'not-a-number';

			const authReq = httpMocks.createRequest({
				method: 'POST',
				url: '/api/test',
				ip: '203.0.113.10',
				headers: { 'x-api-key': 'super-secret' },
			});

			// Invalid RATE_LIMIT_API_KEY_MAX falls back to RATE_LIMIT_MAX=2 for authenticated callers.
			for (let i = 0; i < 2; i++) {
				rateLimiter(authReq, httpMocks.createResponse(), next);
			}
			const resBlocked = httpMocks.createResponse();
			rateLimiter(authReq, resBlocked, jest.fn());
			expect(resBlocked.statusCode).toBe(429);
		});

	});
});

describe('API-key bucket classification regressions (issue #692 review)', () => {
	const originalEnv = process.env;
	let next;

	beforeEach(() => {
		process.env = { ...originalEnv };
		next = jest.fn();
		rateLimiter.enableTestMode();
		rateLimiter.reset();
	});

	afterEach(() => {
		rateLimiter.disableTestMode();
		rateLimiter.reset();
		process.env = originalEnv;
	});

	test('gives the legacy ?api-key= variant its own per-key bucket instead of the anonymous one', () => {
		process.env.WEBHOOK_API_KEY = 'super-secret';
		const viaQuery = httpMocks.createRequest({
			method: 'POST',
			url: '/api/test?api-key=super-secret',
			ip: '203.0.113.10',
			headers: {},
		});
		const anonymous = httpMocks.createRequest({
			method: 'POST',
			url: '/api/test',
			ip: '203.0.113.10',
			headers: {},
		});

		const keyBucket = rateLimiter.deriveBucketKey({ req: viaQuery, ip: '203.0.113.10', isWebhookIngest: false });
		const anonBucket = rateLimiter.deriveBucketKey({ req: anonymous, ip: '203.0.113.10', isWebhookIngest: false });

		expect(keyBucket).toMatch(/^apikey:[a-f0-9]{16}$/);
		expect(anonBucket).toBe('203.0.113.10');
	});

	test('classifies keys with the shared timing-safe matcher rather than string equality', () => {
		process.env.WEBHOOK_API_KEY = 'super-secret';
		const req = httpMocks.createRequest({
			method: 'POST',
			url: '/api/test',
			ip: '203.0.113.10',
			headers: { 'x-api-key': 'super-secret' },
		});
		// Same bucket for the same key, and no bucket for a near-miss.
		const first = rateLimiter.deriveBucketKey({ req, ip: '203.0.113.10', isWebhookIngest: false });
		const again = rateLimiter.deriveBucketKey({ req, ip: '203.0.113.10', isWebhookIngest: false });
		const wrong = httpMocks.createRequest({
			method: 'POST',
			url: '/api/test',
			ip: '203.0.113.10',
			headers: { 'x-api-key': 'super-secre' },
		});
		expect(first).toBe(again);
		expect(rateLimiter.deriveBucketKey({ req: wrong, ip: '203.0.113.10', isWebhookIngest: false }))
			.toBe('203.0.113.10');
	});

	test('ignores a Remote Config value for RATE_LIMIT_API_KEY_MAX because the budget is environment-only', () => {
		jest.isolateModules(() => {
			const isolated = require('../../src/lib/rateLimiter');
			const isolatedMocks = require('node-mocks-http');
			const remoteConfigModule = require('../../src/services/remoteConfig/RemoteConfigService');
			const runtimeSpy = jest
				.spyOn(remoteConfigModule, 'getRuntimeConfig')
				.mockReturnValue({ RATE_LIMIT_API_KEY_MAX: 1 });

			try {
				process.env.WEBHOOK_API_KEY = 'super-secret';
				delete process.env.RATE_LIMIT_API_KEY_MAX;
				process.env.RATE_LIMIT_MAX = '5';
				isolated.enableTestMode();
				isolated.reset();

				const req = isolatedMocks.createRequest({
					method: 'POST',
					url: '/api/test',
					ip: '203.0.113.10',
					headers: { 'x-api-key': 'super-secret' },
				});
				const pass = jest.fn();
				// RATE_LIMIT_MAX=5 applies, so the 6th call is blocked -- not the
				// 2nd, which is what a Remote Config value of 1 would have produced.
				for (let i = 0; i < 5; i += 1) isolated(req, isolatedMocks.createResponse(), pass);
				const blocked = isolatedMocks.createResponse();
				isolated(req, blocked, pass);
				expect(blocked.statusCode).toBe(429);
				expect(pass).toHaveBeenCalledTimes(5);
			} finally {
				runtimeSpy.mockRestore();
				isolated.disableTestMode();
			}
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
