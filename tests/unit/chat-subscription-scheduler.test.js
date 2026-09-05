'use strict';

const {
	ChatSubscriptionSchedulerService,
} = require('../../src/services/chatSubscriptions/ChatSubscriptionSchedulerService');

describe('ChatSubscriptionSchedulerService', () => {
	let service;
	let savedEnv;
	let mockJobService;
	let mockSubscriptionService;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_CHAT_SUBSCRIPTION_SCHEDULER = 'true';
		process.env.CHAT_SUBSCRIPTION_SCHEDULER_ROLE = 'web';
		process.env.CHAT_SUBSCRIPTION_SCHEDULER_INTERVAL_MS = '60000';
		process.env.CHAT_SUBSCRIPTION_SCHEDULER_BATCH_LIMIT = '5';

		mockJobService = {
			createJob: jest.fn(async (type, payload) => ({ jobId: `job-${type}`, status: 'pending' })),
		};
		mockSubscriptionService = {
			listSubscriptions: jest.fn(async () => []),
			markRunResult: jest.fn(async () => true),
		};

		service = new ChatSubscriptionSchedulerService({
			subscriptionService: mockSubscriptionService,
			jobService: mockJobService,
			workerId: 'test-worker',
		});
	});

	afterEach(() => {
		process.env = savedEnv;
		jest.clearAllMocks();
	});

	it('reports enabled status with scheduler role', () => {
		expect(service.isEnabled()).toBe(true);
		expect(service.getWorkerRole()).toBe('web');
		const status = service.getStatus();
		expect(status.enabled).toBe(true);
		expect(status.role).toBe('web');
	});

	it('returns disabled status when role=disabled', () => {
		process.env.CHAT_SUBSCRIPTION_SCHEDULER_ROLE = 'disabled';
		const status = service.getStatus();
		expect(status.ready).toBe(false);
		expect(status.status).toBe('disabled');
	});

	it('returns misconfigured status when feature flag is off', () => {
		process.env.ENABLE_CHAT_SUBSCRIPTION_SCHEDULER = 'false';
		const status = service.getStatus();
		expect(status.ready).toBe(false);
		expect(status.status).toBe('misconfigured');
	});

	it('executes due scanner subscriptions through the job service', async () => {
		mockSubscriptionService.listSubscriptions.mockResolvedValueOnce([
			{
				subscriptionId: 'sub-1',
				chatId: 'chat-1',
				type: 'scanner',
				params: { exchange: 'BINANCE', timeframe: '4h', scans: ['top_gainers', 'top_losers'] },
				intervalMs: 4 * 3600 * 1000,
				nextRunAt: new Date(Date.now() - 1000).toISOString(),
			},
		]);
		await service._runSweep();
		expect(mockJobService.createJob).toHaveBeenCalledTimes(1);
		const [type, payload] = mockJobService.createJob.mock.calls[0];
		expect(type).toBe('market-scanner');
		expect(payload.telegramChatId).toBe('chat-1');
		expect(payload.scans).toEqual(['top_gainers', 'top_losers']);
		expect(mockSubscriptionService.markRunResult).toHaveBeenCalledWith(expect.objectContaining({
			chatId: 'chat-1',
			subscriptionId: 'sub-1',
			jobId: 'job-market-scanner',
		}));
	});

	it('executes due analysis subscriptions through the job service', async () => {
		mockSubscriptionService.listSubscriptions.mockResolvedValueOnce([
			{
				subscriptionId: 'sub-2',
				chatId: 'chat-2',
				type: 'analysis',
				params: { exchange: 'BINANCE', timeframe: '1D', symbols: ['BINANCE:BTCUSDT'] },
				intervalMs: 24 * 3600 * 1000,
				nextRunAt: new Date(Date.now() - 1000).toISOString(),
			},
		]);
		await service._runSweep();
		expect(mockJobService.createJob).toHaveBeenCalledTimes(1);
		const [type, payload] = mockJobService.createJob.mock.calls[0];
		expect(type).toBe('expanded-analysis');
		expect(payload.symbols).toEqual(['BINANCE:BTCUSDT']);
	});

	it('skips subscriptions whose nextRunAt is in the future', async () => {
		mockSubscriptionService.listSubscriptions.mockResolvedValueOnce([
			{
				subscriptionId: 'sub-3',
				chatId: 'chat-3',
				type: 'scanner',
				params: { exchange: 'BINANCE', timeframe: '4h', scans: ['top_gainers'] },
				intervalMs: 4 * 3600 * 1000,
				nextRunAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			},
		]);
		await service._runSweep();
		expect(mockJobService.createJob).not.toHaveBeenCalled();
	});

	it('counts failed executions without throwing', async () => {
		mockSubscriptionService.listSubscriptions.mockResolvedValueOnce([
			{
				subscriptionId: 'sub-fail',
				chatId: 'chat-x',
				type: 'unknown',
				params: {},
				intervalMs: 4 * 3600 * 1000,
				nextRunAt: new Date(Date.now() - 1000).toISOString(),
			},
		]);
		await service._runSweep();
		expect(service.lastRunErrorCount).toBe(1);
		expect(service.lastRunExecutedCount).toBe(0);
	});
});
