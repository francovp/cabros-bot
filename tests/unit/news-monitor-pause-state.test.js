'use strict';

const {
	isNewsMonitorPaused,
	getNewsMonitorPauseState,
	pauseNewsMonitor,
	resumeNewsMonitor,
	resetNewsMonitorPauseStateForTest,
	postPauseNewsMonitor,
	postResumeNewsMonitor,
	getNewsMonitorStatus,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/pauseState');

describe('NewsMonitor pauseState', () => {
	beforeEach(() => {
		resetNewsMonitorPauseStateForTest();
	});

	afterEach(() => {
		resetNewsMonitorPauseStateForTest();
	});

	it('initializes in an unpaused state', () => {
		expect(isNewsMonitorPaused()).toBe(false);
		expect(getNewsMonitorPauseState()).toEqual({
			paused: false,
			pausedAt: null,
			reason: null,
		});
	});

	it('pauses with a provided reason and records timestamp', () => {
		const result = pauseNewsMonitor({ reason: 'Gemini quota exhaustion' });
		expect(result.paused).toBe(true);
		expect(result.reason).toBe('Gemini quota exhaustion');
		expect(result.pausedAt).toEqual(expect.any(String));
		expect(isNewsMonitorPaused()).toBe(true);
	});

	it('pauses without reason or with empty string falling back to null', () => {
		const result = pauseNewsMonitor({ reason: '   ' });
		expect(result.paused).toBe(true);
		expect(result.reason).toBeNull();
		expect(result.pausedAt).toEqual(expect.any(String));
	});

	it('resumes and returns previous paused state and resumed timestamp', () => {
		pauseNewsMonitor({ reason: 'Outage' });
		expect(isNewsMonitorPaused()).toBe(true);

		const result = resumeNewsMonitor();
		expect(result.paused).toBe(false);
		expect(result.wasPaused).toBe(true);
		expect(result.previouslyPausedAt).toEqual(expect.any(String));
		expect(result.resumedAt).toEqual(expect.any(String));
		expect(isNewsMonitorPaused()).toBe(false);

		expect(getNewsMonitorPauseState()).toEqual({
			paused: false,
			pausedAt: null,
			reason: null,
		});
	});

	describe('HTTP Controller Handlers', () => {
		it('postPauseNewsMonitor returns 200 with paused status', async () => {
			const req = {
				body: { reason: 'Binance maintenance' },
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			await postPauseNewsMonitor(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				message: 'News monitor analysis paused',
				paused: true,
				reason: 'Binance maintenance',
				pausedAt: expect.any(String),
			}));
		});

		it('postResumeNewsMonitor returns 200 with resume status', async () => {
			pauseNewsMonitor({ reason: 'Test' });
			const req = {};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			await postResumeNewsMonitor(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
				message: 'News monitor analysis resumed',
				paused: false,
				resumedAt: expect.any(String),
			}));
		});

		it('getNewsMonitorStatus returns 200 with current state', async () => {
			pauseNewsMonitor({ reason: 'Maintenance' });
			const req = {};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			await getNewsMonitorStatus(req, res);

			expect(res.status).toHaveBeenCalledWith(200);
			expect(res.json).toHaveBeenCalledWith({
				paused: true,
				pausedAt: expect.any(String),
				reason: 'Maintenance',
			});
		});
	});
});
