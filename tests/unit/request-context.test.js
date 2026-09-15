/* global jest, describe, it, expect, beforeEach */

const {
	requestContextMiddleware,
	buildRequestContext,
	resolveRequestIdFromHeaders,
} = require('../../src/lib/requestContext');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function buildReqRes(headers = {}) {
	const req = { headers: { ...headers } };
	const res = {
		setHeader: jest.fn(),
	};
	const next = jest.fn();
	return { req, res, next };
}

describe('requestContextMiddleware', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('attaches a fresh uuid requestId when none is provided', () => {
		const { req, res, next } = buildReqRes();
		requestContextMiddleware()(req, res, next);

		expect(typeof req.requestId).toBe('string');
		expect(req.requestId).toMatch(UUID_REGEX);
		expect(typeof req.startTime).toBe('number');
		expect(req.requestContext).toEqual({
			requestId: req.requestId,
			startTime: req.startTime,
		});
		expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('honors an inbound x-request-id header', () => {
		const inbound = 'abc-123-XYZ';
		const { req, res, next } = buildReqRes({ 'x-request-id': inbound });
		requestContextMiddleware()(req, res, next);

		expect(req.requestId).toBe(inbound);
		expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', inbound);
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('honors mixed-case X-Request-Id headers', () => {
		const inbound = 'mixed-case-id-42';
		const { req, res, next } = buildReqRes({ 'X-Request-Id': inbound });
		requestContextMiddleware()(req, res, next);

		expect(req.requestId).toBe(inbound);
		expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', inbound);
	});

	it('rejects empty / whitespace / overlong / unsafe headers and generates a uuid', () => {
		const cases = [
			'',
			'   ',
			null,
			'a'.repeat(129),
			'has space',
			'invalid\0char',
		];
		for (const headerValue of cases) {
			const { req, res, next } = buildReqRes({ 'x-request-id': headerValue });
			requestContextMiddleware()(req, res, next);
			expect(req.requestId).toMatch(UUID_REGEX);
			expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', req.requestId);
			expect(next).toHaveBeenCalledTimes(1);
		}
	});

	it('falls back to a uuid if the middleware throws and still calls next', () => {
		const req = {
			headers: {
				get x() {
					throw new Error('boom');
				},
			},
		};
		const res = { setHeader: jest.fn() };
		const next = jest.fn();

		// Force the throw by stubbing buildRequestContext indirectly via headers access
		requestContextMiddleware()(req, res, next);

		expect(req.requestId).toMatch(UUID_REGEX);
		expect(typeof req.startTime).toBe('number');
		expect(next).toHaveBeenCalledTimes(1);
	});

	it('stamps startTime close to the request wall-clock', () => {
		const before = Date.now();
		const { req } = buildReqRes();
		requestContextMiddleware()(req, { setHeader: jest.fn() }, jest.fn());
		const after = Date.now();

		expect(req.startTime).toBeGreaterThanOrEqual(before);
		expect(req.startTime).toBeLessThanOrEqual(after);
	});
});

describe('buildRequestContext', () => {
	it('honors an explicit requestId override', () => {
		const ctx = buildRequestContext({ requestId: 'explicit-id' });
		expect(ctx.requestId).toBe('explicit-id');
	});

	it('falls back to a uuid when neither header nor override is given', () => {
		const ctx = buildRequestContext();
		expect(ctx.requestId).toMatch(UUID_REGEX);
	});

	it('rejects unsafe explicit requestIds and falls back to uuid', () => {
		const ctx = buildRequestContext({ requestId: 'has space' });
		expect(ctx.requestId).toMatch(UUID_REGEX);
	});

	it('ignores non-string headers', () => {
		const ctx = buildRequestContext({ headers: { 'x-request-id': 12345 } });
		expect(ctx.requestId).toMatch(UUID_REGEX);
	});

	it('accepts missing header bag', () => {
		const ctx = buildRequestContext({ headers: null });
		expect(ctx.requestId).toMatch(UUID_REGEX);
	});
});

describe('resolveRequestIdFromHeaders', () => {
	it('returns null when no header is present', () => {
		expect(resolveRequestIdFromHeaders({})).toBeNull();
	});

	it('returns the inbound value when valid', () => {
		expect(resolveRequestIdFromHeaders({ 'x-request-id': 'abc-123' })).toBe('abc-123');
	});

	it('trims whitespace from inbound values', () => {
		expect(resolveRequestIdFromHeaders({ 'x-request-id': '  trimmed-id  ' })).toBe('trimmed-id');
	});

	it('returns null for invalid characters', () => {
		expect(resolveRequestIdFromHeaders({ 'x-request-id': 'has space' })).toBeNull();
	});

	it('returns null for too-long values', () => {
		expect(resolveRequestIdFromHeaders({ 'x-request-id': 'a'.repeat(200) })).toBeNull();
	});

	it('returns null for empty / whitespace strings', () => {
		expect(resolveRequestIdFromHeaders({ 'x-request-id': '   ' })).toBeNull();
	});

	it('accepts non-string header values by returning null', () => {
		expect(resolveRequestIdFromHeaders({ 'x-request-id': 42 })).toBeNull();
	});

	it('tolerates a missing header bag', () => {
		expect(resolveRequestIdFromHeaders(null)).toBeNull();
	});
});
