// tests/unit/trustProxy.test.js
const { parseTrustProxy, setupTrustProxy } = require('../../src/lib/trustProxy');
const express = require('express');

describe('Trust Proxy Configuration', () => {
	describe('parseTrustProxy', () => {
		test('should return true when TRUST_PROXY is "true"', () => {
			expect(parseTrustProxy('true', 'false')).toBe(true);
			expect(parseTrustProxy('TRUE', 'false')).toBe(true);
		});

		test('should return false when TRUST_PROXY is "false"', () => {
			expect(parseTrustProxy('false', 'true')).toBe(false);
			expect(parseTrustProxy('FALSE', 'false')).toBe(false);
		});

		test('should return integer when TRUST_PROXY is a number string', () => {
			expect(parseTrustProxy('1', 'false')).toBe(1);
			expect(parseTrustProxy('2', 'false')).toBe(2);
		});

		test('should return string when TRUST_PROXY is a keyword subnet string', () => {
			expect(parseTrustProxy('loopback', 'false')).toBe('loopback');
			expect(parseTrustProxy('linklocal', 'false')).toBe('linklocal');
		});

		test('should return array when TRUST_PROXY is a comma-separated list', () => {
			expect(parseTrustProxy('loopback, 10.0.0.0/8', 'false')).toEqual(['loopback', '10.0.0.0/8']);
		});

		test('should default to 1 hop when TRUST_PROXY is unset but RENDER is "true"', () => {
			expect(parseTrustProxy(undefined, 'true')).toBe(1);
			expect(parseTrustProxy('', 'true')).toBe(1);
		});

		test('should default to false when TRUST_PROXY and RENDER are unset', () => {
			expect(parseTrustProxy(undefined, undefined)).toBe(false);
			expect(parseTrustProxy('', 'false')).toBe(false);
		});

		test('should default to 1 hop for Vercel deployments', () => {
			expect(parseTrustProxy(undefined, undefined, '1')).toBe(1);
		});

		test('should default to 1 hop for Railway deployments', () => {
			expect(parseTrustProxy(undefined, undefined, undefined, 'production')).toBe(1);
		});
	});

	describe('setupTrustProxy', () => {
		test('should set trust proxy on an Express app instance', () => {
			const app = express();
			setupTrustProxy(app, { TRUST_PROXY: '1', RENDER: 'false', VERCEL: '1' });
			expect(app.get('trust proxy')).toBe(1);
		});
	});
});
