'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		analyzeSymbolIdentifier: jest.fn(),
		callScanTool: jest.fn(),
	},
}));

describe('Jobs API Integration Tests', () => {
	const originalEnv = process.env;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_MARKET_SCANNER: 'true',
		};

		jest.clearAllMocks();

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'job-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns 401 when POST /api/jobs/tradingview-analysis lacks valid api key', async () => {
		await request(app)
			.post('/api/jobs/tradingview-analysis')
			.send({ type: 'expanded-analysis', symbols: ['BINANCE:BTCUSDT'] })
			.expect(401);
	});

	it('returns 401 when GET /api/jobs/:jobId lacks valid api key', async () => {
		await request(app)
			.get('/api/jobs/some-job-id')
			.expect(401);
	});

	it('runs end-to-end expanded-analysis job lifecycle with progress polling and completion', async () => {
		// Mock with a small delay to allow polling processing state
		tradingViewMcpService.analyzeSymbolIdentifier.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return {
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			};
		});

		// Create job
		const createRes = await request(app)
			.post('/api/jobs/tradingview-analysis')
			.set('x-api-key', 'test-key')
			.send({ type: 'expanded-analysis', symbols: ['BINANCE:BTCUSDT'] })
			.expect(201);

		expect(createRes.body.success).toBe(true);
		expect(createRes.body.jobId).toBeDefined();
		expect(createRes.body.status).toBe('processing');

		const jobId = createRes.body.jobId;

		// Poll status - check for processing/completed
		let statusRes = await request(app)
			.get(`/api/jobs/${jobId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(statusRes.body.jobId).toBe(jobId);
		expect(statusRes.body.type).toBe('expanded-analysis');
		expect(statusRes.body.status).toMatch(/processing|completed/);

		// Wait until completed
		let attempts = 0;
		while (statusRes.body.status !== 'completed' && attempts < 10) {
			await new Promise((resolve) => setTimeout(resolve, 30));
			statusRes = await request(app)
				.get(`/api/jobs/${jobId}`)
				.set('x-api-key', 'test-key')
				.expect(200);
			attempts++;
		}

		expect(statusRes.body.status).toBe('completed');
		expect(statusRes.body.alertText).toContain('BTCUSDT');
		expect(statusRes.body.results).toHaveLength(1);
		expect(statusRes.body.results[0]).toEqual({
			symbol: 'BINANCE:BTCUSDT',
			status: 'analyzed',
			price: 65000,
			rsi: 45,
		});
		expect(statusRes.body.summary).toBeDefined();
		expect(statusRes.body.deliveryResults).toEqual([
			expect.objectContaining({ success: true, channel: 'telegram', messageId: 'job-msg-id' }),
		]);
	});

	it('returns 404 for non-existent job ID', async () => {
		const res = await request(app)
			.get('/api/jobs/non-existent-uuid')
			.set('x-api-key', 'test-key')
			.expect(404);

		expect(res.body.success).toBe(false);
		expect(res.body.error).toBe('Job not found');
	});

	it('supports cancellation and retry flow end-to-end', async () => {
		// Mock with a longer delay so we can cancel it mid-flight
		tradingViewMcpService.analyzeSymbolIdentifier.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			return {
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			};
		});

		// Create job
		const createRes = await request(app)
			.post('/api/jobs/tradingview-analysis')
			.set('x-api-key', 'test-key')
			.send({ type: 'expanded-analysis', symbols: ['BINANCE:BTCUSDT'] })
			.expect(201);

		const jobId = createRes.body.jobId;

		// Cancel it immediately
		const cancelRes = await request(app)
			.post(`/api/jobs/${jobId}/cancel`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(cancelRes.body.success).toBe(true);
		expect(cancelRes.body.status).toBe('cancelled');

		// Poll status to verify it's cancelled and does not complete
		await new Promise((resolve) => setTimeout(resolve, 100));
		const statusRes = await request(app)
			.get(`/api/jobs/${jobId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(statusRes.body.status).toBe('cancelled');

		// Attempt to cancel again (should return 409)
		await request(app)
			.post(`/api/jobs/${jobId}/cancel`)
			.set('x-api-key', 'test-key')
			.expect(409);

		// Retry the cancelled job
		const retryRes = await request(app)
			.post(`/api/jobs/${jobId}/retry`)
			.set('x-api-key', 'test-key')
			.expect(201);

		expect(retryRes.body.success).toBe(true);
		expect(retryRes.body.oldJobId).toBe(jobId);
		expect(retryRes.body.newJobId).toBeDefined();
		expect(retryRes.body.status).toBe('processing');
	});
});
