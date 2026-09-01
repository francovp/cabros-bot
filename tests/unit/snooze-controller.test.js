/**
 * SnoozeController unit tests
 *
 * Verifies the request validation and response shapes for the
 * /api/ops/snooze endpoints.
 */

const {
	getSnooze,
	postSnooze,
	deleteSnooze,
} = require('../../src/controllers/ops/snooze');
const { snoozeService, MIN_DURATION_MS, MAX_DURATION_MS } = require('../../src/services/notification/SnoozeService');

function mockRes() {
	const res = {};
	res.status = jest.fn(() => res);
	res.json = jest.fn(() => res);
	return res;
}

describe('SnoozeController', () => {
	afterEach(() => {
		snoozeService.resetForTesting();
	});

	describe('GET /api/ops/snooze', () => {
		it('returns { active: false } when no snooze is active', () => {
			const req = {};
			const res = mockRes();
			getSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({ active: false });
		});

		it('returns the active snooze', () => {
			snoozeService.activate({ durationMs: 60_000, reason: 'test' });
			const req = {};
			const res = mockRes();
			getSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
			const body = res.json.mock.calls[0][0];
			expect(body.reason).toBe('test');
		});
	});

	describe('POST /api/ops/snooze', () => {
		it('rejects missing durationMs', () => {
			const req = { body: {} };
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_DURATION' }));
		});

		it('rejects below-minimum durationMs', () => {
			const req = { body: { durationMs: 1000 } };
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json.mock.calls[0][0].code).toBe('INVALID_DURATION');
		});

		it('rejects above-maximum durationMs', () => {
			const req = { body: { durationMs: 24 * 60 * 60 * 1000 } };
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json.mock.calls[0][0].code).toBe('INVALID_DURATION');
		});

		it('accepts a valid duration and returns the active snooze', () => {
			const req = {
				body: { durationMs: 30 * 60 * 1000, reason: 'FOMC decision' },
				ip: '127.0.0.1',
			};
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
			const body = res.json.mock.calls[0][0];
			expect(body.reason).toBe('FOMC decision');
			expect(body.durationMs).toBe(30 * 60 * 1000);
		});

		it('accepts string durationMs and parses it numerically', () => {
			const req = {
				body: { durationMs: '1800000', reason: 'string duration' },
				ip: '127.0.0.1',
			};
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
		});

		it('rejects non-numeric durationMs strings', () => {
			const req = {
				body: { durationMs: 'not-a-number' },
				ip: '127.0.0.1',
			};
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(400);
			expect(res.json.mock.calls[0][0].code).toBe('INVALID_DURATION');
		});

		it('honors explicit channels list', () => {
			const req = {
				body: { durationMs: 60_000, channels: ['telegram'] },
				ip: '127.0.0.1',
			};
			const res = mockRes();
			postSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json.mock.calls[0][0].channels).toEqual(['telegram']);
		});
	});

	describe('DELETE /api/ops/snooze', () => {
		it('cancels an active snooze and returns { active: false }', () => {
			snoozeService.activate({ durationMs: 60_000 });
			const req = {};
			const res = mockRes();
			deleteSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({ active: false });
		});

		it('returns { active: false } when no snooze is active', () => {
			const req = {};
			const res = mockRes();
			deleteSnooze(req, res);
			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({ active: false });
		});
	});

	describe('module constants', () => {
		it('exposes the min and max duration bounds', () => {
			expect(MIN_DURATION_MS).toBe(60_000);
			expect(MAX_DURATION_MS).toBe(6 * 60 * 60 * 1000);
		});
	});
});
