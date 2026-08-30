// tests/unit/corsAllowlist.test.js
const express = require('express');
const request = require('supertest');

const {
	DEFAULT_CORS_ALLOWED_ORIGINS,
	normalizeHttpOrigin,
	isFirebasePreviewOrigin,
	isAllowedOrigin,
	parseCorsAllowedOrigins,
	buildCorsMiddleware,
} = require('../../src/lib/corsAllowlist');

describe('CORS allowlist', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
		delete process.env.CORS_ALLOWED_ORIGINS;
		delete process.env.FIREBASE_PROJECT_ID;
	});

	afterEach(() => {
		restoreEnv(savedEnv);
	});

	describe('normalizeHttpOrigin', () => {
		test('normalizes origins with trailing slashes, paths, or uppercase hostnames', () => {
			expect(normalizeHttpOrigin('https://staging.example.com/')).toBe('https://staging.example.com');
			expect(normalizeHttpOrigin('https://STAGING.EXAMPLE.COM/some/path')).toBe('https://staging.example.com');
			expect(normalizeHttpOrigin('http://localhost:3000/')).toBe('http://localhost:3000');
		});

		test('returns null for non-http(s) schemes or invalid inputs', () => {
			expect(normalizeHttpOrigin('ftp://example.com')).toBeNull();
			expect(normalizeHttpOrigin('javascript:alert(1)')).toBeNull();
			expect(normalizeHttpOrigin('not a url')).toBeNull();
			expect(normalizeHttpOrigin(null)).toBeNull();
			expect(normalizeHttpOrigin('')).toBeNull();
		});
	});

	describe('isFirebasePreviewOrigin', () => {
		test('matches project ephemeral preview channels on web.app and firebaseapp.com', () => {
			expect(isFirebasePreviewOrigin('https://cabros-bot--pr900-xyz.web.app')).toBe(true);
			expect(isFirebasePreviewOrigin('https://cabros-bot--pr-123.firebaseapp.com')).toBe(true);
		});

		test('rejects other projects or non-https preview origins', () => {
			expect(isFirebasePreviewOrigin('https://other-project--pr900.web.app')).toBe(false);
			expect(isFirebasePreviewOrigin('http://cabros-bot--pr900.web.app')).toBe(false);
			expect(isFirebasePreviewOrigin('https://cabros-bot.web.app')).toBe(false);
			expect(isFirebasePreviewOrigin('https://cabros-bot--pr900.web.app:8080')).toBe(false);
		});

		test('supports custom FIREBASE_PROJECT_ID', () => {
			expect(isFirebasePreviewOrigin('https://my-custom-app--pr5.web.app', 'my-custom-app')).toBe(true);
			expect(isFirebasePreviewOrigin('https://cabros-bot--pr5.web.app', 'my-custom-app')).toBe(false);
		});
	});

	describe('parseCorsAllowedOrigins', () => {
		test('returns the documented defaults when CORS_ALLOWED_ORIGINS is unset', () => {
			const origins = parseCorsAllowedOrigins(undefined);
			expect(origins.has('https://cabros-bot.web.app')).toBe(true);
			expect(origins.has('https://cabros-bot.firebaseapp.com')).toBe(true);
			expect(origins.has('https://cabros-bot-production.up.railway.app')).toBe(true);
			expect(origins.isDefault).toBe(true);
		});

		test('returns the documented defaults when CORS_ALLOWED_ORIGINS is empty', () => {
			const origins = parseCorsAllowedOrigins('');
			expect(origins.size).toBe(3);
			expect(origins.isDefault).toBe(true);
		});

		test('replaces the defaults with the explicit override list (no silent merge)', () => {
			const origins = parseCorsAllowedOrigins('https://staging.example.com, https://preview.example.com');
			expect(origins.has('https://staging.example.com')).toBe(true);
			expect(origins.has('https://preview.example.com')).toBe(true);
			expect(origins.has('https://cabros-bot.web.app')).toBe(false);
			expect(origins.size).toBe(2);
			expect(origins.isDefault).toBe(false);
		});

		test('trims whitespace, normalizes paths/slashes, and drops blank entries from an explicit override', () => {
			const origins = parseCorsAllowedOrigins('  https://a.example.com/ ,, https://B.example.com/path ');
			expect([...origins].sort()).toEqual([
				'https://a.example.com',
				'https://b.example.com',
			]);
		});

		test('rejects non-http(s) origins and falls back to defaults when nothing valid remains', () => {
			const origins = parseCorsAllowedOrigins('file:///tmp, javascript:alert(1)');
			expect(origins.has('file:///tmp')).toBe(false);
			expect(origins.has('javascript:alert(1)')).toBe(false);
			expect(origins.has('https://cabros-bot.web.app')).toBe(true);
			expect(origins.size).toBe(3);
			expect(origins.isDefault).toBe(true);
		});

		test('accepts the wildcard as an explicit override (documented opt-in for local testing)', () => {
			const origins = parseCorsAllowedOrigins('*');
			expect(origins.has('*')).toBe(true);
			expect(origins.size).toBe(1);
			expect(origins.isDefault).toBe(false);
		});

		test('refuses a mixed wildcard + explicit-origin list to avoid ambiguous intent', () => {
			const origins = parseCorsAllowedOrigins('*, https://staging.example.com');
			expect(origins.has('*')).toBe(false);
			expect(origins.has('https://staging.example.com')).toBe(false);
			expect(origins.has('https://cabros-bot.web.app')).toBe(true);
			expect(origins.isDefault).toBe(true);
		});

		test('returns a new Set on every call so callers cannot mutate the defaults', () => {
			const first = parseCorsAllowedOrigins(undefined);
			first.delete('https://cabros-bot.web.app');
			const second = parseCorsAllowedOrigins(undefined);
			expect(second.has('https://cabros-bot.web.app')).toBe(true);
		});
	});

	describe('buildCorsMiddleware', () => {
		function makeApp(options) {
			const app = express();
			app.use(buildCorsMiddleware(parseCorsAllowedOrigins(undefined), options));
			app.get('/api/test', (_req, res) => res.json({ ok: true }));
			return app;
		}

		test('lets requests without an Origin header pass through unchanged', async () => {
			const response = await request(makeApp()).get('/api/test');
			expect(response.status).toBe(200);
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
		});

		test('grants Access-Control-Allow-Origin for an allowed origin', async () => {
			const response = await request(makeApp())
				.get('/api/test')
				.set('Origin', 'https://cabros-bot.web.app');
			expect(response.status).toBe(200);
			expect(response.headers['access-control-allow-origin']).toBe('https://cabros-bot.web.app');
		});

		test('grants Access-Control-Allow-Origin for Firebase PR preview channels by default', async () => {
			const response = await request(makeApp())
				.get('/api/test')
				.set('Origin', 'https://cabros-bot--pr900-xyz.web.app');
			expect(response.status).toBe(200);
			expect(response.headers['access-control-allow-origin']).toBe('https://cabros-bot--pr900-xyz.web.app');
		});

		test('omits Access-Control-Allow-Origin for a disallowed origin', async () => {
			const response = await request(makeApp())
				.get('/api/test')
				.set('Origin', 'https://attacker.example.com');
			expect(response.status).toBe(200);
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
			expect(response.headers.vary).toContain('Origin');
		});

		test('responds to a preflight OPTIONS request from an allowed origin', async () => {
			const response = await request(makeApp())
				.options('/api/test')
				.set('Origin', 'https://cabros-bot.web.app')
				.set('Access-Control-Request-Method', 'POST')
				.set('Access-Control-Request-Headers', 'content-type, x-api-key');
			expect(response.status).toBe(204);
			expect(response.headers['access-control-allow-origin']).toBe('https://cabros-bot.web.app');
			expect(response.headers['access-control-allow-methods']).toMatch(/POST/);
			expect(response.headers['access-control-allow-headers']).toMatch(/x-api-key/);
			expect(response.headers['access-control-allow-credentials']).toBeUndefined();
		});

		test('blocks preflight from a disallowed origin (no CORS headers)', async () => {
			const response = await request(makeApp())
				.options('/api/test')
				.set('Origin', 'https://attacker.example.com')
				.set('Access-Control-Request-Method', 'POST');
			expect(response.headers['access-control-allow-origin']).toBeUndefined();
		});

		test('honors CORS_ALLOWED_ORIGINS overrides with trailing slashes when building the middleware', async () => {
			process.env.CORS_ALLOWED_ORIGINS = 'https://staging.example.com/';
			const app = express();
			app.use(buildCorsMiddleware(parseCorsAllowedOrigins(process.env.CORS_ALLOWED_ORIGINS)));
			app.get('/api/test', (_req, res) => res.json({ ok: true }));

			const allowed = await request(app)
				.get('/api/test')
				.set('Origin', 'https://staging.example.com');
			expect(allowed.headers['access-control-allow-origin']).toBe('https://staging.example.com');

			const denied = await request(app)
				.get('/api/test')
				.set('Origin', 'https://cabros-bot.web.app');
			expect(denied.headers['access-control-allow-origin']).toBeUndefined();
		});

		test('keeps credentials disabled even for allowed origins', async () => {
			const response = await request(makeApp())
				.get('/api/test')
				.set('Origin', 'https://cabros-bot.firebaseapp.com');
			expect(response.headers['access-control-allow-credentials']).toBeUndefined();
		});
	});
});