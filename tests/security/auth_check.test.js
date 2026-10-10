const crypto = require('crypto');
const request = require('supertest');
const express = require('express');
const { isValidApiKey, validateApiKey, matchesAnyApiKey } = require('../../src/lib/auth');
const { requireConfiguredAdminAccess } = require('../../src/lib/adminAuth');

// A length-based skip made the comparison count depend on the presented key's
// length, which leaked the configured key-length set. Counting comparisons is a
// non-flaky proxy for that: the old code called timingSafeEqual only for
// same-length candidates.
describe('Security: matchesAnyApiKey has no length-dependent comparison count', () => {
	const crypto = require('crypto');

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('compares every candidate even when none share the presented key length', () => {
		const candidates = ['a', 'bb', 'ccc', 'dddd'];
		const equalSpy = jest.spyOn(crypto, 'timingSafeEqual');

		const result = matchesAnyApiKey('zzzzzzz', candidates);

		expect(result).toBe(false);
		expect(equalSpy).toHaveBeenCalledTimes(candidates.length);
	});

	it('still matches a key of a different length than its neighbours', () => {
		const equalSpy = jest.spyOn(crypto, 'timingSafeEqual');

		const result = matchesAnyApiKey('longer-key-value', ['short', 'medium', 'longer-key-value']);

		expect(result).toBe(true);
		expect(equalSpy).toHaveBeenCalledTimes(3);
	});

	it('keeps the comparison count stable across presented key lengths', () => {
		const candidates = ['k1', 'k22', 'k333'];

		const shortCount = (() => {
			const spy = jest.spyOn(crypto, 'timingSafeEqual');
			matchesAnyApiKey('x', candidates);
			const n = spy.mock.calls.length;
			spy.mockRestore();
			return n;
		})();
		const longCount = (() => {
			const spy = jest.spyOn(crypto, 'timingSafeEqual');
			matchesAnyApiKey('x'.repeat(64), candidates);
			const n = spy.mock.calls.length;
			spy.mockRestore();
			return n;
		})();

		expect(shortCount).toBe(longCount);
		expect(shortCount).toBe(candidates.length);
	});
});

describe('Security: API Key Validation', () => {
	let app;
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		app = express();
		process.env.WEBHOOK_API_KEY = 'valid-api-key';
		app.use(express.json());
		app.post('/protected', validateApiKey, (req, res) => {
			res.status(200).json({ success: true });
		});
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	it('should reject requests without x-api-key header', async () => {
		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(401);
		expect(res.body.error).toBe('Unauthorized: Missing API key');
	});

	it('should reject requests with invalid API key', async () => {
		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'invalid-key')
			.send({});

		expect(res.status).toBe(403);
		expect(res.body.error).toBe('Forbidden: Invalid API key');
	});

	it('should accept requests with valid API key', async () => {
		const res = await request(app)
			.post('/protected')
			.set('x-api-key', 'valid-api-key')
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
	});

	it('should use a fixed-length timing-safe comparison for keys of different lengths', () => {
		const timingSafeEqual = jest.spyOn(crypto, 'timingSafeEqual');

		expect(isValidApiKey({ headers: { 'x-api-key': 'short' } })).toBe(false);
		expect(timingSafeEqual).toHaveBeenCalledTimes(1);
		expect(timingSafeEqual.mock.calls[0][0].byteLength)
			.toBe(timingSafeEqual.mock.calls[0][1].byteLength);

		timingSafeEqual.mockRestore();
	});

	it('should allow requests (insecure mode) when WEBHOOK_API_KEY is not set in development or test mode', async () => {
		delete process.env.WEBHOOK_API_KEY;
		process.env.NODE_ENV = 'development';

		// Suppress console.warn during this test
		const originalConsoleWarn = console.warn;
		console.warn = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('insecure'));

		console.warn = originalConsoleWarn;
	});

	it.each([
		['NODE_ENV=production', { NODE_ENV: 'production' }],
		['RENDER=true', { NODE_ENV: '', RENDER: 'true', IS_PULL_REQUEST: 'false' }],
		['VERCEL_ENV=production', { NODE_ENV: '', VERCEL_ENV: 'production' }],
		['RAILWAY_ENVIRONMENT_NAME=production', { NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'production' }],
	])('should reject requests with 503 when WEBHOOK_API_KEY is unset in production-like environment (%s)', async (_, envVars) => {
		delete process.env.WEBHOOK_API_KEY;
		Object.assign(process.env, envVars);

		const originalConsoleError = console.error;
		console.error = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(503);
		expect(res.body.code).toBe('WEBHOOK_API_KEY_UNSET');
		expect(res.body.error).toContain('WEBHOOK_API_KEY is not set in production');
		expect(console.error).toHaveBeenCalledWith(expect.stringContaining('ERROR: WEBHOOK_API_KEY is not set in production environment'));

		console.error = originalConsoleError;
	});

	it.each([
		['VERCEL_ENV=preview', { NODE_ENV: '', VERCEL_ENV: 'preview' }],
		['RENDER preview PR', { NODE_ENV: '', RENDER: 'true', IS_PULL_REQUEST: 'true' }],
		['Railway PR number', { NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'production', RAILWAY_GIT_PULL_REQUEST_NUMBER: '42' }],
		['Railway PR env name', { NODE_ENV: '', RAILWAY_ENVIRONMENT_NAME: 'pr-42' }],
	])('should allow bypass when WEBHOOK_API_KEY is unset in preview environment (%s)', async (_, envVars) => {
		delete process.env.WEBHOOK_API_KEY;
		Object.assign(process.env, envVars);

		const originalConsoleWarn = console.warn;
		console.warn = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);

		console.warn = originalConsoleWarn;
	});

	it('should capture a Sentry error event when WEBHOOK_API_KEY is unset in production', async () => {
		delete process.env.WEBHOOK_API_KEY;
		process.env.NODE_ENV = 'production';

		const sentryService = require('../../src/services/monitoring/SentryService');
		const spy = jest.spyOn(sentryService, 'captureRuntimeError').mockImplementation(() => ({ captured: true }));

		const originalConsoleError = console.error;
		console.error = jest.fn();

		const res = await request(app)
			.post('/protected')
			.send({});

		expect(res.status).toBe(503);
		expect(spy).toHaveBeenCalledWith(expect.objectContaining({
			channel: 'api',
			feature: 'auth',
			http: expect.objectContaining({ statusCode: 503 }),
			extra: expect.objectContaining({ type: 'auth-fail-open' }),
		}));

		spy.mockRestore();
		console.error = originalConsoleError;
	});

	describe('WEBHOOK_API_KEYS multi-key support (GH-692 follow-up)', () => {
		beforeEach(() => {
			process.env.WEBHOOK_API_KEY = 'primary-key';
			process.env.WEBHOOK_API_KEYS = 'secondary-key,tertiary-key';
		});

		it('should accept requests that match any key in WEBHOOK_API_KEYS', async () => {
			const res = await request(app)
				.post('/protected')
				.set('x-api-key', 'secondary-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});

		it('should still accept the primary WEBHOOK_API_KEY when WEBHOOK_API_KEYS is set', async () => {
			const res = await request(app)
				.post('/protected')
				.set('x-api-key', 'primary-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});

		it('should accept the third key from WEBHOOK_API_KEYS', async () => {
			const res = await request(app)
				.post('/protected')
				.set('x-api-key', 'tertiary-key')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});

		it('should reject requests with an unknown key', async () => {
			const res = await request(app)
				.post('/protected')
				.set('x-api-key', 'not-a-real-key')
				.send({});

			expect(res.status).toBe(403);
			expect(res.body.error).toBe('Forbidden: Invalid API key');
		});

		it('should accept WEBHOOK_API_KEYS alone when WEBHOOK_API_KEY is unset', async () => {
			delete process.env.WEBHOOK_API_KEY;
			process.env.WEBHOOK_API_KEYS = 'only-secondary';

			const res = await request(app)
				.post('/protected')
				.set('x-api-key', 'only-secondary')
				.send({});

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
		});
	});
});

describe('Security: list-only WEBHOOK_API_KEYS configuration (issue #692 review)', () => {
	let app;
	let savedEnv;

	const setProdLike = () => {
		process.env.NODE_ENV = 'production';
		delete process.env.RENDER;
		delete process.env.IS_PULL_REQUEST;
		delete process.env.VERCEL_ENV;
		delete process.env.RAILWAY_ENVIRONMENT_NAME;
	};

	beforeEach(() => {
		savedEnv = saveEnv();
		app = express();
		app.use(express.json());
		app.post('/protected', validateApiKey, (req, res) => {
			res.status(200).json({ success: true });
		});
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	// A production deployment may configure only WEBHOOK_API_KEYS. Deciding
	// "is auth configured" from process.env.WEBHOOK_API_KEY alone would answer no
	// and 503 every protected route before isValidApiKey could consult the list.
	// This runs the real production branch: NODE_ENV=production is neither
	// preview nor dev/test, so the insecure-mode bypass does not apply.
	it('accepts a listed key when only WEBHOOK_API_KEYS is set in production', async () => {
		setProdLike();
		delete process.env.WEBHOOK_API_KEY;
		process.env.WEBHOOK_API_KEYS = 'key-one,key-two';

		const accepted = await request(app).post('/protected').set('x-api-key', 'key-two').send({});
		expect(accepted.status).toBe(200);
		expect(accepted.body.success).toBe(true);
	});

	it('still rejects an unlisted key when only WEBHOOK_API_KEYS is set', async () => {
		setProdLike();
		delete process.env.WEBHOOK_API_KEY;
		process.env.WEBHOOK_API_KEYS = 'key-one,key-two';

		const rejected = await request(app).post('/protected').set('x-api-key', 'not-a-key').send({});
		expect(rejected.status).toBe(403);
	});

	it('still reports 503 when neither WEBHOOK_API_KEY nor WEBHOOK_API_KEYS is set', async () => {
		setProdLike();
		delete process.env.WEBHOOK_API_KEY;
		delete process.env.WEBHOOK_API_KEYS;

		const res = await request(app).post('/protected').set('x-api-key', 'anything').send({});
		expect(res.status).toBe(503);
		expect(res.body.code).toBe('WEBHOOK_API_KEY_UNSET');
	});

	// The tests above post to a validateApiKey route, so they cannot exercise the
	// admin config gate: requireConfiguredAdminAccess is a separate middleware and
	// emits its own ADMIN_AUTH_UNAVAILABLE code. These mount it directly.
	describe('requireConfiguredAdminAccess config gate', () => {
		let adminApp;
		let adminSavedEnv;

		beforeEach(() => {
			adminSavedEnv = saveEnv();
			adminApp = express();
			adminApp.use(express.json());
			adminApp.post('/admin', requireConfiguredAdminAccess, (req, res) => {
				res.status(200).json({ success: true });
			});
		});

		afterEach(() => {
			restoreEnv(adminSavedEnv);
		});

		it('admits a listed key when only WEBHOOK_API_KEYS is set', async () => {
			setProdLike();
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
			process.env.WEBHOOK_API_KEYS = 'key-one,key-two';

			const res = await request(adminApp).post('/admin').set('x-api-key', 'key-one').send({});
			expect(res.status).toBe(200);
			expect(res.body.code).toBeUndefined();
		});

		it('reports ADMIN_AUTH_UNAVAILABLE when no API key source is configured', async () => {
			setProdLike();
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.WEBHOOK_API_KEYS;
			delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;

			const res = await request(adminApp).post('/admin').set('x-api-key', 'anything').send({});
			expect(res.status).toBe(503);
			expect(res.body.code).toBe('ADMIN_AUTH_UNAVAILABLE');
		});

		it('still rejects an unlisted key when only WEBHOOK_API_KEYS is set', async () => {
			setProdLike();
			delete process.env.WEBHOOK_API_KEY;
			delete process.env.ENABLE_FIREBASE_ADMIN_AUTH;
			process.env.WEBHOOK_API_KEYS = 'key-one,key-two';

			const res = await request(adminApp).post('/admin').set('x-api-key', 'not-a-key').send({});
			expect(res.status).toBe(403);
		});
	});
});
