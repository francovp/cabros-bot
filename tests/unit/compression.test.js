'use strict';

const {
	DEFAULT_COMPRESSION_OPTIONS,
	isEventStream,
	shouldCompress,
	createCompressionMiddleware,
} = require('../../src/lib/compression');

describe('Response Compression Middleware', () => {
	describe('DEFAULT_COMPRESSION_OPTIONS', () => {
		it('defines threshold of 1024 bytes and level 6', () => {
			expect(DEFAULT_COMPRESSION_OPTIONS.threshold).toBe(1024);
			expect(DEFAULT_COMPRESSION_OPTIONS.level).toBe(6);
		});
	});

	describe('isEventStream', () => {
		it('returns false for null or undefined res or res without getHeader', () => {
			expect(isEventStream(null)).toBe(false);
			expect(isEventStream(undefined)).toBe(false);
			expect(isEventStream({})).toBe(false);
		});

		it('returns false when Content-Type is missing', () => {
			const res = { getHeader: jest.fn().mockReturnValue(undefined) };
			expect(isEventStream(res)).toBe(false);
		});

		it('returns false for non-SSE content types', () => {
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return 'application/json';
					return undefined;
				}),
			};
			expect(isEventStream(res)).toBe(false);
		});

		it('returns true when Content-Type is text/event-stream', () => {
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return 'text/event-stream';
					return undefined;
				}),
			};
			expect(isEventStream(res)).toBe(true);
		});

		it('returns true when Content-Type includes text/event-stream with parameters', () => {
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return 'text/event-stream; charset=utf-8';
					return undefined;
				}),
			};
			expect(isEventStream(res)).toBe(true);
		});

		it('returns true when Content-Type is provided as an array', () => {
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return ['text/event-stream', 'boundary=something'];
					return undefined;
				}),
			};
			expect(isEventStream(res)).toBe(true);
		});
	});

	describe('shouldCompress', () => {
		it('returns false when response is an event stream', () => {
			const req = { headers: { 'accept-encoding': 'gzip' } };
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return 'text/event-stream';
					return undefined;
				}),
			};
			expect(shouldCompress(req, res)).toBe(false);
		});

		it('returns false when x-no-compression header is present', () => {
			const req = { headers: { 'x-no-compression': '1' } };
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return 'application/json';
					return undefined;
				}),
			};
			expect(shouldCompress(req, res)).toBe(false);
		});

		it('returns true for compressible JSON responses when client accepts gzip', () => {
			const req = { headers: { 'accept-encoding': 'gzip' } };
			const res = {
				getHeader: jest.fn().mockImplementation((h) => {
					if (h.toLowerCase() === 'content-type') return 'application/json; charset=utf-8';
					return undefined;
				}),
			};
			expect(shouldCompress(req, res)).toBe(true);
		});
	});

	describe('createCompressionMiddleware', () => {
		it('returns an Express middleware function', () => {
			const middleware = createCompressionMiddleware();
			expect(typeof middleware).toBe('function');
		});

		it('allows custom threshold and level overrides', () => {
			const middleware = createCompressionMiddleware({ threshold: 2048, level: 9 });
			expect(typeof middleware).toBe('function');
		});
	});
});
