/* global describe, it, expect, beforeEach, afterEach */

const {
	DEFAULT_MAX_BODY_SIZE,
	MAX_BYTES,
	MIN_BYTES,
	parseByteSize,
	resolveWebhookMaxBodySize,
	buildWebhookBodySize,
} = require('../../src/lib/webhookBodySize');

describe('webhookBodySize.parseByteSize', () => {
	it('parses plain bytes without a unit suffix', () => {
		expect(parseByteSize('1024')).toBe(1024);
		expect(parseByteSize('1024b')).toBe(1024);
	});

	it('parses kilobytes and megabytes case-insensitively', () => {
		expect(parseByteSize('256kb')).toBe(256 * 1024);
		expect(parseByteSize('256KB')).toBe(256 * 1024);
		expect(parseByteSize('1MB')).toBe(1024 * 1024);
		expect(parseByteSize('2mb')).toBe(2 * 1024 * 1024);
	});

	it('parses fractional sizes', () => {
		expect(parseByteSize('1.5kb')).toBe(1.5 * 1024);
	});

	it('trims whitespace', () => {
		expect(parseByteSize('  2kb  ')).toBe(2 * 1024);
	});

	it('returns null for non-strings', () => {
		expect(parseByteSize(undefined)).toBeNull();
		expect(parseByteSize(null)).toBeNull();
		expect(parseByteSize(123)).toBeNull();
	});

	it('returns null for empty or whitespace-only strings', () => {
		expect(parseByteSize('')).toBeNull();
		expect(parseByteSize('   ')).toBeNull();
	});

	it('returns null for malformed values', () => {
		expect(parseByteSize('abc')).toBeNull();
		expect(parseByteSize('-100b')).toBeNull();
		expect(parseByteSize('0kb')).toBeNull();
		expect(parseByteSize('100tb')).toBeNull();
		expect(parseByteSize('10xyz')).toBeNull();
	});

	it('returns null for values below the minimum threshold', () => {
		expect(parseByteSize('100b')).toBeNull();
		expect(parseByteSize(MIN_BYTES - 1)).toBeNull();
	});

	it('returns null for values above the maximum threshold', () => {
		expect(parseByteSize(`${MAX_BYTES + 1}b`)).toBeNull();
	});
});

describe('webhookBodySize.resolveWebhookMaxBodySize', () => {
	let savedEnv;
	let warnSpy;

	beforeEach(() => {
		savedEnv = { ...process.env };
		delete process.env.WEBHOOK_MAX_BODY_SIZE;
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		for (const key of Object.keys(process.env)) {
			if (!Object.prototype.hasOwnProperty.call(savedEnv, key)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, savedEnv);
	});

	it('uses the documented default when the env var is unset', () => {
		const result = resolveWebhookMaxBodySize();
		expect(result.source).toBe('default');
		expect(result.limitString).toBe(DEFAULT_MAX_BODY_SIZE);
		expect(result.limitBytes).toBe(256 * 1024);
		expect(result.rawValue).toBeNull();
	});

	it('uses the env value when valid', () => {
		process.env.WEBHOOK_MAX_BODY_SIZE = '512kb';
		const result = resolveWebhookMaxBodySize();
		expect(result.source).toBe('env');
		expect(result.limitString).toBe('512kb');
		expect(result.limitBytes).toBe(512 * 1024);
		expect(result.rawValue).toBe('512kb');
	});

	it('falls back to the default and warns on malformed values', () => {
		process.env.WEBHOOK_MAX_BODY_SIZE = 'not-a-size';
		const result = resolveWebhookMaxBodySize();
		expect(result.source).toBe('default');
		expect(result.limitString).toBe(DEFAULT_MAX_BODY_SIZE);
		expect(warnSpy).toHaveBeenCalled();
	});

	it('falls back to the default and warns on out-of-range values', () => {
		process.env.WEBHOOK_MAX_BODY_SIZE = '100tb';
		const result = resolveWebhookMaxBodySize();
		expect(result.source).toBe('default');
		expect(warnSpy).toHaveBeenCalled();
	});
});

describe('webhookBodySize.buildWebhookBodySize', () => {
	let savedEnv;
	let warnSpy;

	beforeEach(() => {
		savedEnv = { ...process.env };
		delete process.env.WEBHOOK_MAX_BODY_SIZE;
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
		for (const key of Object.keys(process.env)) {
			if (!Object.prototype.hasOwnProperty.call(savedEnv, key)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, savedEnv);
	});

	it('returns matching JSON and text limits derived from the env var', () => {
		process.env.WEBHOOK_MAX_BODY_SIZE = '128kb';
		const result = buildWebhookBodySize();
		expect(result.jsonLimit).toBe('128kb');
		expect(result.textLimit).toBe('128kb');
	});

	it('exposes a middleware that responds to entity.too.large errors with a structured 413', () => {
		const { middleware, payloadTooLargeResponse } = buildWebhookBodySize();
		expect(typeof middleware).toBe('function');
		expect(middleware.length).toBe(4); // error-handling middleware signature

		const req = { method: 'POST', url: '/api/webhook/alert' };
		const res = {
			statusCode: 0,
			body: null,
			status(code) {
				this.statusCode = code;
				return this;
			},
			json(payload) {
				this.body = payload;
				return this;
			},
		};
		const next = jest.fn();

		middleware({ type: 'entity.too.large' }, req, res, next);
		expect(res.statusCode).toBe(413);
		expect(res.body).toEqual(
			expect.objectContaining({
				success: false,
				error: 'PAYLOAD_TOO_LARGE',
			})
		);
		expect(res.body.limit).toBe(DEFAULT_MAX_BODY_SIZE);
		expect(next).not.toHaveBeenCalled();
	});

	it('forwards non-entity.too.large errors via next()', () => {
		const { middleware } = buildWebhookBodySize();
		const next = jest.fn();
		const err = new Error('boom');
		middleware(err, {}, {}, next);
		expect(next).toHaveBeenCalledWith(err);
	});

	it('forwards falsy errors via next() so the chain continues', () => {
		const { middleware } = buildWebhookBodySize();
		const next = jest.fn();
		middleware(null, {}, {}, next);
		expect(next).toHaveBeenCalledWith(null);
	});

	it('exposes payloadTooLargeResponse for direct use in tests and routes', () => {
		const { payloadTooLargeResponse } = buildWebhookBodySize({ env: { WEBHOOK_MAX_BODY_SIZE: '1mb' } });
		const req = {};
		const res = {
			statusCode: 0,
			body: null,
			status(code) {
				this.statusCode = code;
				return this;
			},
			json(payload) {
				this.body = payload;
				return this;
			},
		};
		payloadTooLargeResponse(req, res);
		expect(res.statusCode).toBe(413);
		expect(res.body.limit).toBe('1mb');
	});
});
