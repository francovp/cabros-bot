'use strict';

const {
	DEFAULT_ALLOWED_ORIGINS,
	parseAllowedOrigins,
	isOriginAllowed,
	createCorsOptions,
	createCorsMiddleware,
} = require('../../src/lib/cors');

describe('CORS configuration', () => {
	describe('DEFAULT_ALLOWED_ORIGINS', () => {
		it('contains expected production origins', () => {
			expect(DEFAULT_ALLOWED_ORIGINS).toContain('https://cabros-bot.web.app');
			expect(DEFAULT_ALLOWED_ORIGINS).toContain('https://cabros-bot.firebaseapp.com');
			expect(DEFAULT_ALLOWED_ORIGINS).toContain('https://cabros-bot-production.up.railway.app');
		});
	});

	describe('parseAllowedOrigins', () => {
		it('returns an empty array when env var is unset, null, or empty', () => {
			expect(parseAllowedOrigins(undefined)).toEqual([]);
			expect(parseAllowedOrigins(null)).toEqual([]);
			expect(parseAllowedOrigins('')).toEqual([]);
			expect(parseAllowedOrigins('   ')).toEqual([]);
		});

		it('parses a single origin', () => {
			expect(parseAllowedOrigins('https://custom.example.com')).toEqual(['https://custom.example.com']);
		});

		it('parses comma-separated origins and trims whitespace', () => {
			expect(parseAllowedOrigins(' https://a.example.com , https://b.example.com , ')).toEqual([
				'https://a.example.com',
				'https://b.example.com',
			]);
		});
	});

	describe('isOriginAllowed', () => {
		it('allows requests with no origin header (server-to-server, webhooks, curl)', () => {
			expect(isOriginAllowed(undefined)).toBe(true);
			expect(isOriginAllowed(null)).toBe(true);
			expect(isOriginAllowed('')).toBe(true);
		});

		it('allows standard production origins', () => {
			expect(isOriginAllowed('https://cabros-bot.web.app')).toBe(true);
			expect(isOriginAllowed('https://cabros-bot.firebaseapp.com')).toBe(true);
			expect(isOriginAllowed('https://cabros-bot-production.up.railway.app')).toBe(true);
		});

		it('allows Firebase Hosting preview channel subdomains', () => {
			expect(isOriginAllowed('https://cabros-bot--preview-123.web.app')).toBe(true);
			expect(isOriginAllowed('https://cabros-bot--pr-456.firebaseapp.com')).toBe(true);
			expect(isOriginAllowed('https://other-bot--preview.web.app')).toBe(false);
		});

		it('allows localhost and 127.0.0.1 on any port for local development', () => {
			expect(isOriginAllowed('http://localhost')).toBe(true);
			expect(isOriginAllowed('http://localhost:3000')).toBe(true);
			expect(isOriginAllowed('http://localhost:5173')).toBe(true);
			expect(isOriginAllowed('http://localhost:8080')).toBe(true);
			expect(isOriginAllowed('https://localhost:3000')).toBe(true);
			expect(isOriginAllowed('http://127.0.0.1')).toBe(true);
			expect(isOriginAllowed('http://127.0.0.1:3000')).toBe(true);
			expect(isOriginAllowed('http://127.0.0.1:8080')).toBe(true);
		});

		it('allows custom origins configured in CORS_ALLOWED_ORIGINS', () => {
			const env = { CORS_ALLOWED_ORIGINS: 'https://staging.example.com,https://dashboard.example.com' };
			expect(isOriginAllowed('https://staging.example.com', env)).toBe(true);
			expect(isOriginAllowed('https://dashboard.example.com', env)).toBe(true);
			expect(isOriginAllowed('https://unrelated.example.com', env)).toBe(false);
		});

		it('rejects untrusted third-party origins', () => {
			expect(isOriginAllowed('https://evil.com')).toBe(false);
			expect(isOriginAllowed('https://attacker.example.org')).toBe(false);
			expect(isOriginAllowed('https://cabros-bot.web.app.attacker.com')).toBe(false);
			expect(isOriginAllowed('https://fake-cabros-bot.web.app')).toBe(false);
			expect(isOriginAllowed('http://not-localhost:3000')).toBe(false);
		});
	});

	describe('createCorsOptions', () => {
		it('configures credentials, allowed methods, and allowed headers', () => {
			const options = createCorsOptions();
			expect(options.credentials).toBe(true);
			expect(options.methods).toEqual(expect.arrayContaining(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']));
			expect(options.allowedHeaders).toEqual(
				expect.arrayContaining([
					'Content-Type',
					'Authorization',
					'x-api-key',
					'idempotency-key',
					'x-idempotency-key',
					'If-Match',
					'x-request-id',
				])
			);
			expect(options.exposedHeaders).toEqual(
				expect.arrayContaining(['ETag', 'Idempotency-Replay', 'x-request-id', 'Location'])
			);
		});

		it('calls callback with true for allowed origins', (done) => {
			const options = createCorsOptions();
			options.origin('https://cabros-bot.web.app', (err, allowed) => {
				expect(err).toBeNull();
				expect(allowed).toBe(true);
				done();
			});
		});

		it('calls callback with false for disallowed origins', (done) => {
			const options = createCorsOptions();
			options.origin('https://evil.example.com', (err, allowed) => {
				expect(err).toBeNull();
				expect(allowed).toBe(false);
				done();
			});
		});
	});

	describe('createCorsMiddleware', () => {
		it('returns an Express middleware function', () => {
			const middleware = createCorsMiddleware();
			expect(typeof middleware).toBe('function');
		});
	});
});
