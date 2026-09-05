'use strict';

const {
	AlertSchedulerService,
	parseSchedules,
	parseIntervalToMs,
} = require('../../src/services/scheduler/AlertSchedulerService');

describe('AlertSchedulerService', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_ALERT_SCHEDULER = 'false';
		process.env.ALERT_SCHEDULER_WORKER_ROLE = 'web';
		process.env.ALERT_SCHEDULER_INTERVAL_MS = '60000';
		process.env.ALERT_SCHEDULER_BATCH_LIMIT = '10';
		process.env.ALERT_SCHEDULER_SCHEDULES = '';
		process.env.ALERT_SCHEDULER_LEASE_MS = '120000';
		process.env.ALERT_SCHEDULER_TIMEOUT_MS = '90000';
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	describe('parseIntervalToMs', () => {
		it('parses millisecond strings', () => {
			expect(parseIntervalToMs('1000', 0)).toBe(1000);
			expect(parseIntervalToMs('500ms', 0)).toBe(500);
		});

		it('parses second, minute, hour, day units', () => {
			expect(parseIntervalToMs('30s', 0)).toBe(30000);
			expect(parseIntervalToMs('5m', 0)).toBe(300000);
			expect(parseIntervalToMs('1h', 0)).toBe(3600000);
			expect(parseIntervalToMs('2d', 0)).toBe(2 * 24 * 60 * 60 * 1000);
		});

		it('returns fallback for invalid input', () => {
			expect(parseIntervalToMs('', 5000)).toBe(5000);
			expect(parseIntervalToMs('garbage', 5000)).toBe(5000);
			expect(parseIntervalToMs(null, 5000)).toBe(5000);
		});

		it('returns fallback for non-positive values', () => {
			expect(parseIntervalToMs('0', 5000)).toBe(5000);
			expect(parseIntervalToMs('-5m', 5000)).toBe(5000);
		});

		it('accepts numeric input directly', () => {
			expect(parseIntervalToMs(7500, 0)).toBe(7500);
		});
	});

	describe('parseSchedules', () => {
		it('returns empty array for empty or invalid input', () => {
			expect(parseSchedules('')).toEqual([]);
			expect(parseSchedules(null)).toEqual([]);
			expect(parseSchedules('not json')).toEqual([]);
			expect(parseSchedules('{}')).toEqual([]);
		});

		it('parses news-monitor schedules with crypto and stock symbols', () => {
			const raw = JSON.stringify([
				{
					type: 'news-monitor',
					name: 'Daily crypto news',
					symbols: { crypto: ['BTCUSDT', 'ETHUSDT'], stocks: ['NVDA'] },
					interval: '6h',
					channels: ['telegram', 'whatsapp'],
				},
			]);
			const result = parseSchedules(raw);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('news-monitor');
			expect(result[0].cadenceMs).toBe(6 * 60 * 60 * 1000);
			expect(result[0].symbols.crypto).toEqual(['BTCUSDT', 'ETHUSDT']);
			expect(result[0].symbols.stocks).toEqual(['NVDA']);
			expect(result[0].channels).toEqual(['telegram', 'whatsapp']);
		});

		it('parses scanner schedules with default and custom parameters', () => {
			const raw = JSON.stringify([
				{
					type: 'scanner',
					name: 'Top gainers/losers',
					exchange: 'BINANCE',
					timeframe: '4h',
					scans: ['top_gainers', 'top_losers'],
					interval: '4h',
					ranked: true,
					limit: 10,
				},
			]);
			const result = parseSchedules(raw);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('scanner');
			expect(result[0].exchange).toBe('BINANCE');
			expect(result[0].timeframe).toBe('4h');
			expect(result[0].scans).toEqual(['top_gainers', 'top_losers']);
			expect(result[0].ranked).toBe(true);
			expect(result[0].limit).toBe(10);
		});

		it('skips entries with invalid types or missing required fields', () => {
			const raw = JSON.stringify([
				{ type: 'unknown-type', foo: 'bar' },
				{ type: 'news-monitor', symbols: { crypto: [], stocks: [] } },
				{ type: 'scanner', scans: [] },
				{ type: 'scanner', scans: ['invalid_scan_type'] },
				{ type: 'news-monitor', symbols: { crypto: ['BTCUSDT'] } },
			]);
			const result = parseSchedules(raw);
			expect(result).toHaveLength(1);
			expect(result[0].type).toBe('news-monitor');
		});

		it('filters invalid symbols and channels', () => {
			const raw = JSON.stringify([
				{
					type: 'news-monitor',
					symbols: { crypto: ['VALID', 'inv@lid'], stocks: [] },
					channels: ['telegram', 'invalid_channel'],
				},
			]);
			const result = parseSchedules(raw);
			expect(result).toHaveLength(1);
			expect(result[0].symbols.crypto).toEqual(['VALID']);
			expect(result[0].channels).toEqual(['telegram']);
		});

		it('clamps cadence to min/max bounds', () => {
			const raw = JSON.stringify([
				{
					type: 'news-monitor',
					symbols: { crypto: ['BTCUSDT'] },
					interval: '1s',
				},
				{
					type: 'news-monitor',
					symbols: { crypto: ['ETHUSDT'] },
					interval: '30d',
				},
			]);
			const result = parseSchedules(raw);
			expect(result).toHaveLength(2);
			// 1s gets clamped to MIN_CADENCE_MS (60s)
			expect(result[0].cadenceMs).toBe(60000);
			// 30d gets clamped to MAX_CADENCE_MS (7d)
			expect(result[1].cadenceMs).toBe(7 * 24 * 60 * 60 * 1000);
		});
	});

	describe('configuration and gating', () => {
		it('is disabled when ENABLE_ALERT_SCHEDULER is false or unset', () => {
			const scheduler = new AlertSchedulerService();
			expect(scheduler.isEnabled()).toBe(false);

			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			expect(scheduler.isEnabled()).toBe(true);
		});

		it('normalizes worker role to web, worker, or disabled', () => {
			const scheduler = new AlertSchedulerService();
			process.env.ALERT_SCHEDULER_WORKER_ROLE = 'WORKER';
			expect(scheduler.getWorkerRole()).toBe('worker');

			process.env.ALERT_SCHEDULER_WORKER_ROLE = 'disabled';
			expect(scheduler.getWorkerRole()).toBe('disabled');

			process.env.ALERT_SCHEDULER_WORKER_ROLE = 'invalid';
			expect(scheduler.getWorkerRole()).toBe('web');
		});

		it('reports misconfigured status when no schedules are defined', () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			const scheduler = new AlertSchedulerService();
			const status = scheduler.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.configured).toBe(false);
			expect(status.ready).toBe(false);
			expect(status.status).toBe('misconfigured');
			expect(status.scheduleCount).toBe(0);
		});

		it('reports ready status when enabled with valid schedules', () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
				{ type: 'news-monitor', symbols: { crypto: ['BTCUSDT'] }, interval: '1h' },
			]);
			const scheduler = new AlertSchedulerService();
			scheduler._loadSchedules();
			const status = scheduler.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.configured).toBe(true);
			expect(status.ready).toBe(true);
			expect(status.status).toBe('ready');
			expect(status.scheduleCount).toBe(1);
		});

		it('startWorker returns false when no valid schedules are defined', () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			const scheduler = new AlertSchedulerService();
			expect(scheduler.startWorker({ source: 'web' })).toBe(false);
		});
	});

	describe('sweep execution', () => {
		it('executes news-monitor schedule and updates state', async () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			process.env.ENABLE_NEWS_MONITOR = 'true';
			process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
				{
					type: 'news-monitor',
					name: 'Test news',
					symbols: { crypto: ['BTCUSDT'] },
					interval: '6h',
				},
			]);

			const mockAnalyzer = {
				analyzeSymbols: jest.fn(async () => [
					{ symbol: 'BTCUSDT', status: 'success' },
				]),
			};
			const mockNotificationManager = {};

			const scheduler = new AlertSchedulerService({
				getAnalyzer: () => mockAnalyzer,
				getNotificationManager: () => mockNotificationManager,
			});

			const result = await scheduler.sweep();
			expect(result.executedCount).toBe(1);
			expect(result.errorCount).toBe(0);
			expect(mockAnalyzer.analyzeSymbols).toHaveBeenCalledTimes(1);

			const state = scheduler.scheduleState.get(scheduler.schedules[0].id);
			expect(state.lastStatus).toBe('success');
			expect(state.consecutiveErrors).toBe(0);
		});

		it('skips news-monitor schedule when ENABLE_NEWS_MONITOR is false', async () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			delete process.env.ENABLE_NEWS_MONITOR;
			process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
				{ type: 'news-monitor', symbols: { crypto: ['BTCUSDT'] }, interval: '1h' },
			]);

			const mockAnalyzer = { analyzeSymbols: jest.fn() };
			const scheduler = new AlertSchedulerService({
				getAnalyzer: () => mockAnalyzer,
				getNotificationManager: () => null,
			});

			const result = await scheduler.sweep();
			expect(result.executedCount).toBe(1);
			expect(result.errorCount).toBe(1);
			expect(mockAnalyzer.analyzeSymbols).not.toHaveBeenCalled();
		});

		it('executes scanner schedule with notification dispatch', async () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			process.env.ENABLE_MARKET_SCANNER = 'true';
			process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
				{
					type: 'scanner',
					name: 'Top gainers',
					scans: ['top_gainers'],
					interval: '4h',
				},
			]);

			const mockScanResults = [
				{ scan: 'top_gainers', status: 'success', items: [{ symbol: 'BTCUSDT' }] },
			];

			const marketScannerModule = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
			const requestRoutingModule = require('../../src/services/notification/requestRouting');

			const runScansSpy = jest.spyOn(marketScannerModule, 'runScans').mockResolvedValue(mockScanResults);
			const buildReportSpy = jest.spyOn(
				require('../../src/services/tradingview/marketScannerReport'),
				'buildMarketScannerReport',
			).mockReturnValue('Mock report');
			const sendSpy = jest.spyOn(requestRoutingModule, 'sendWithNotificationRouting').mockResolvedValue([
				{ channel: 'telegram', success: true },
			]);

			const scheduler = new AlertSchedulerService({
				getNotificationManager: () => ({}),
			});

			const result = await scheduler.sweep();
			expect(result.executedCount).toBe(1);
			expect(result.errorCount).toBe(0);
			expect(runScansSpy).toHaveBeenCalled();
			expect(buildReportSpy).toHaveBeenCalled();
			expect(sendSpy).toHaveBeenCalled();

			runScansSpy.mockRestore();
			buildReportSpy.mockRestore();
			sendSpy.mockRestore();
		});

		it('records error when scanner returns no results', async () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			process.env.ENABLE_MARKET_SCANNER = 'true';
			process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
				{ type: 'scanner', scans: ['top_gainers'], interval: '4h' },
			]);

			const marketScannerModule = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
			jest.spyOn(marketScannerModule, 'runScans').mockResolvedValue([]);

			const scheduler = new AlertSchedulerService({
				getNotificationManager: () => null,
			});

			const result = await scheduler.sweep();
			expect(result.executedCount).toBe(1);
			expect(result.errorCount).toBe(1);

			const state = scheduler.scheduleState.get(scheduler.schedules[0].id);
			expect(state.lastStatus).toBe('error');
			expect(state.consecutiveErrors).toBe(1);
		});

		it('respects batch limit and skips not-due schedules', async () => {
			process.env.ENABLE_ALERT_SCHEDULER = 'true';
			process.env.ENABLE_NEWS_MONITOR = 'true';
			process.env.ALERT_SCHEDULER_BATCH_LIMIT = '1';
			process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
				{ type: 'news-monitor', symbols: { crypto: ['BTCUSDT'] }, interval: '1h' },
				{ type: 'news-monitor', symbols: { crypto: ['ETHUSDT'] }, interval: '1h' },
			]);

			const mockAnalyzer = { analyzeSymbols: jest.fn(async () => []) };
			const scheduler = new AlertSchedulerService({
				getAnalyzer: () => mockAnalyzer,
				getNotificationManager: () => null,
			});

			const result = await scheduler.sweep({ batchLimit: 1 });
			expect(result.executedCount).toBe(1);
		});
	});

	describe('lifecycle', () => {
		it('startWorker initializes state for each schedule', () => {
			jest.useFakeTimers();
			try {
				process.env.ENABLE_ALERT_SCHEDULER = 'true';
				process.env.ENABLE_NEWS_MONITOR = 'true';
				process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
					{ type: 'news-monitor', symbols: { crypto: ['BTCUSDT'] }, interval: '1h' },
				]);

				const scheduler = new AlertSchedulerService();
				const started = scheduler.startWorker({ source: 'web' });
				expect(started).toBe(true);
				expect(scheduler.running).toBe(true);
				expect(scheduler.scheduleState.size).toBe(1);
				scheduler.running = false;
			} finally {
				jest.useRealTimers();
			}
		});

		it('stopWorker stops running and clears timer', async () => {
			jest.useFakeTimers();
			try {
				process.env.ENABLE_ALERT_SCHEDULER = 'true';
				process.env.ENABLE_NEWS_MONITOR = 'true';
				process.env.ALERT_SCHEDULER_SCHEDULES = JSON.stringify([
					{ type: 'news-monitor', symbols: { crypto: ['BTCUSDT'] }, interval: '1h' },
				]);

				const scheduler = new AlertSchedulerService();
				scheduler.startWorker({ source: 'web' });
				await scheduler.stopWorker({ drain: false });
				expect(scheduler.running).toBe(false);
			} finally {
				jest.useRealTimers();
			}
		});
	});
});
