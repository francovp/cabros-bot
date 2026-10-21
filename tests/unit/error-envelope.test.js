'use strict';

const {
	buildErrorEnvelope,
	sendError,
	isRetryableStatus,
	normalizeCode,
	STANDARD_ERROR_CODES,
} = require('../../src/lib/errorEnvelope');

describe('errorEnvelope', () => {
	describe('buildErrorEnvelope', () => {
		it('produces a structured envelope with success: false', () => {
			const envelope = buildErrorEnvelope({
				error: 'Something went wrong',
				code: STANDARD_ERROR_CODES.INVALID_REQUEST,
				requestId: 'req-123',
				statusCode: 400,
			});

			expect(envelope).toEqual({
				success: false,
				error: 'Something went wrong',
				code: 'INVALID_REQUEST',
				requestId: 'req-123',
				retryable: false,
			});
		});

		it('marks retryable: true for 5xx status codes', () => {
			const envelope = buildErrorEnvelope({
				error: 'Provider failed',
				code: STANDARD_ERROR_CODES.PROVIDER_UNAVAILABLE,
				requestId: 'req-124',
				statusCode: 502,
			});

			expect(envelope.retryable).toBe(true);
			expect(envelope.code).toBe('PROVIDER_UNAVAILABLE');
		});

		it('marks retryable: true for 429 rate limit responses', () => {
			const envelope = buildErrorEnvelope({
				error: 'Rate limited',
				code: 'RATE_LIMITED',
				statusCode: 429,
			});

			expect(envelope.retryable).toBe(true);
		});

		it('includes sanitized details when provided', () => {
			const envelope = buildErrorEnvelope({
				error: 'Invalid body',
				code: STANDARD_ERROR_CODES.INVALID_REQUEST,
				requestId: 'req-125',
				statusCode: 400,
				details: { field: 'symbol', reason: 'malformed' },
			});

			expect(envelope.details).toEqual({ field: 'symbol', reason: 'malformed' });
		});

		it('omits details when empty', () => {
			const envelope = buildErrorEnvelope({
				error: 'Bad input',
				code: STANDARD_ERROR_CODES.INVALID_REQUEST,
				requestId: 'req-126',
				statusCode: 400,
				details: {},
			});

			expect(envelope).not.toHaveProperty('details');
		});

		it('falls back to INTERNAL_ERROR when code is missing or invalid', () => {
			const envelope = buildErrorEnvelope({
				error: 'Boom',
				requestId: 'req-127',
				statusCode: 500,
			});

			expect(envelope.code).toBe('INTERNAL_ERROR');
		});

		it('uppercases arbitrary codes without dropping them', () => {
			const envelope = buildErrorEnvelope({
				error: 'Quota',
				code: 'gemini_quota_exhausted',
				requestId: 'req-128',
				statusCode: 429,
			});

			expect(envelope.code).toBe('GEMINI_QUOTA_EXHAUSTED');
			expect(envelope.retryable).toBe(true);
		});

		it('generates a UUID requestId when missing', () => {
			const envelope = buildErrorEnvelope({
				error: 'Server error',
				code: STANDARD_ERROR_CODES.INTERNAL_ERROR,
				statusCode: 500,
			});

			expect(envelope.requestId).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
			);
		});

		it('honors explicit retryable override', () => {
			const envelope = buildErrorEnvelope({
				error: 'Forbidden',
				code: STANDARD_ERROR_CODES.FEATURE_DISABLED,
				requestId: 'req-129',
				statusCode: 403,
				retryable: true,
			});

			expect(envelope.retryable).toBe(true);
		});
});

	describe('sendError', () => {
		it('emits the envelope on the Express response', () => {
			const json = jest.fn();
			const status = jest.fn(() => ({ json }));
			const res = { status };

			const envelope = sendError(res, 400, {
				error: 'Bad input',
				code: STANDARD_ERROR_CODES.INVALID_REQUEST,
				requestId: 'req-130',
			});

			expect(status).toHaveBeenCalledWith(400);
			expect(json).toHaveBeenCalledWith(envelope);
			expect(envelope.success).toBe(false);
			expect(envelope.retryable).toBe(false);
		});
	});

	describe('isRetryableStatus', () => {
		it.each([408, 425, 429, 500, 502, 503, 504])(
			'returns true for retryable status %s',
			(code) => {
				expect(isRetryableStatus(code)).toBe(true);
			}
		);

		it.each([200, 201, 204, 400, 401, 403, 404, 422])(
			'returns false for non-retryable status %s',
			(code) => {
				expect(isRetryableStatus(code)).toBe(false);
			}
		);

		it('returns false for non-integer status codes', () => {
			expect(isRetryableStatus(null)).toBe(false);
			expect(isRetryableStatus('500')).toBe(false);
			expect(isRetryableStatus(undefined)).toBe(false);
		});
	});

	describe('normalizeCode', () => {
		it('passes through standard codes unchanged', () => {
			expect(normalizeCode('INVALID_REQUEST')).toBe('INVALID_REQUEST');
			expect(normalizeCode('FEATURE_DISABLED')).toBe('FEATURE_DISABLED');
			expect(normalizeCode('PROVIDER_TIMEOUT')).toBe('PROVIDER_TIMEOUT');
			expect(normalizeCode('STORAGE_UNAVAILABLE')).toBe('STORAGE_UNAVAILABLE');
		});

		it('uppercases arbitrary codes', () => {
			expect(normalizeCode('custom_code')).toBe('CUSTOM_CODE');
		});

		it('returns INTERNAL_ERROR when input is missing or invalid', () => {
			expect(normalizeCode(null)).toBe('INTERNAL_ERROR');
			expect(normalizeCode('')).toBe('INTERNAL_ERROR');
			expect(normalizeCode(undefined)).toBe('INTERNAL_ERROR');
			expect(normalizeCode(42)).toBe('INTERNAL_ERROR');
		});
	});
});