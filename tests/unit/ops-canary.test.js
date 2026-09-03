/* global jest, describe, it, beforeEach, afterEach, expect */

const {
	postOpsCanary,
	isCanaryEndpointEnabled,
	CANARY_SOURCE,
} = require('../../src/controllers/webhooks/handlers/opsCanary/opsCanary');

function createMockRes() {
	const res = {
		statusCode: 200,
		body: undefined,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.body = payload;
			return this;
		},
	};
	return res;
}

describe('Ops canary endpoint (unit)', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = saveEnv();
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		jest.restoreAllMocks();
	});

	describe('isCanaryEndpointEnabled', () => {
		it('returns true when ENABLE_CANARY_ENDPOINT=true', () => {
			process.env.ENABLE_CANARY_ENDPOINT = 'true';
			expect(isCanaryEndpointEnabled()).toBe(true);
		});

		it('returns false when ENABLE_CANARY_ENDPOINT=false', () => {
			process.env.ENABLE_CANARY_ENDPOINT = 'false';
			expect(isCanaryEndpointEnabled()).toBe(false);
		});

		it('returns false when ENABLE_CANARY_ENDPOINT is unset', () => {
			delete process.env.ENABLE_CANARY_ENDPOINT;
			expect(isCanaryEndpointEnabled()).toBe(false);
		});
	});

	describe('CANARY_SOURCE constant', () => {
		it('exposes a stable canary source identifier', () => {
			expect(CANARY_SOURCE).toBe('canary');
		});
	});

	describe('postOpsCanary handler', () => {
		it('returns 404 FEATURE_DISABLED when ENABLE_CANARY_ENDPOINT is false', async () => {
			process.env.ENABLE_CANARY_ENDPOINT = 'false';
			const handler = postOpsCanary(() => null);
			const res = createMockRes();

			await handler({}, res);

			expect(res.statusCode).toBe(404);
			expect(res.body.code).toBe('FEATURE_DISABLED');
		});

		it('returns 400 INVALID_REQUEST for unknown channel even when enabled', async () => {
			process.env.ENABLE_CANARY_ENDPOINT = 'true';
			const handler = postOpsCanary(() => null);
			const res = createMockRes();

			await handler({ body: { channels: ['unknown'] } }, res);

			expect(res.statusCode).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});

		it('returns 400 INVALID_REQUEST for empty channels array', async () => {
			process.env.ENABLE_CANARY_ENDPOINT = 'true';
			const handler = postOpsCanary(() => null);
			const res = createMockRes();

			await handler({ body: { channels: [] } }, res);

			expect(res.statusCode).toBe(400);
			expect(res.body.code).toBe('INVALID_REQUEST');
		});
	});
});
