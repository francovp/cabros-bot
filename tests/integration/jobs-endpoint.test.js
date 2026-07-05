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
	let mockFetch;

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

		mockFetch = jest.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ idMessage: 'wa-msg-456' }),
		});
		global.fetch = mockFetch;

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
		delete global.fetch;
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

	it('routes async job delivery to requested channels only', async () => {
		process.env.ENABLE_WHATSAPP_ALERTS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.greenapi.com/waInstance123/';
		process.env.WHATSAPP_API_KEY = 'test-whatsapp-key';
		process.env.WHATSAPP_CHAT_ID = '120363000000000000@g.us';

		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			symbol: 'BINANCE:BTCUSDT',
			price_data: { close: 65000, change_percent: 1.5 },
			rsi: { value: 45 },
		});

		const createRes = await request(app)
			.post('/api/jobs/tradingview-analysis')
			.set('x-api-key', 'test-key')
			.send({
				type: 'expanded-analysis',
				symbols: ['BINANCE:BTCUSDT'],
				channels: ['telegram'],
				telegramChatId: '-100999888777',
			})
			.expect(201);

		const jobId = createRes.body.jobId;
		let statusRes = await request(app)
			.get(`/api/jobs/${jobId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

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
		expect(statusRes.body.requestedChannels).toEqual(['telegram']);
		expect(statusRes.body.deliveredChannels).toEqual(['telegram']);
		expect(statusRes.body.deliveryResults).toHaveLength(1);
		expect(mockTelegramSendMessage).toHaveBeenCalledWith(
			'-100999888777',
			expect.any(String),
			expect.any(Object),
		);
		expect(mockFetch).not.toHaveBeenCalled();
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

	describe('Async job callback integration', () => {
		let fetchMock;

		beforeEach(() => {
			fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
			globalThis.fetch = fetchMock;
		});

		afterEach(() => {
			delete globalThis.fetch;
		});

		it('allows creating a job with callbackUrl and triggers it on completion', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			const createRes = await request(app)
				.post('/api/jobs/tradingview-analysis')
				.set('x-api-key', 'test-key')
				.send({
					type: 'expanded-analysis',
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://example.com/api/callback',
					callbackSecret: 'my-signature-secret',
				})
				.expect(201);

			const jobId = createRes.body.jobId;

			let statusRes = await request(app)
				.get(`/api/jobs/${jobId}`)
				.set('x-api-key', 'test-key')
				.expect(200);

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

			let freshJob = statusRes.body;
			let pollAttempts = 0;
			while ((!freshJob.callbackStatus || freshJob.callbackStatus.status === 'pending') && pollAttempts < 20) {
				await new Promise((resolve) => setTimeout(resolve, 20));
				const checkRes = await request(app)
					.get(`/api/jobs/${jobId}`)
					.set('x-api-key', 'test-key')
					.expect(200);
				freshJob = checkRes.body;
				pollAttempts++;
			}

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, options] = fetchMock.mock.calls[0];
			expect(url).toBe('https://example.com/api/callback');

			expect(freshJob.callbackStatus).toBeDefined();
			expect(freshJob.callbackStatus.status).toBe('success');
			expect(freshJob.callbackStatus.attempts[0].statusCode).toBe(200);
		});

		it('returns 400 Bad Request if callbackUrl format is invalid', async () => {
			const prevEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = 'production';

			try {
				const createRes = await request(app)
					.post('/api/jobs/tradingview-analysis')
					.set('x-api-key', 'test-key')
					.send({
						type: 'expanded-analysis',
						symbols: ['BINANCE:BTCUSDT'],
						callbackUrl: 'http://example.com/callback',
					})
					.expect(400);

				expect(createRes.body.error).toContain('callbackUrl must be a valid HTTPS URL');
			} finally {
				process.env.NODE_ENV = prevEnv;
			}
		});

		it('returns 400 Bad Request if callbackUrl is a private network IP in production', async () => {
			const prevEnv = process.env.NODE_ENV;
			const prevAllow = process.env.ALLOW_HTTP_CALLBACKS;
			const prevPrivate = process.env.ALLOW_PRIVATE_CALLBACKS;

			process.env.NODE_ENV = 'production';
			process.env.ALLOW_HTTP_CALLBACKS = 'false';
			delete process.env.ALLOW_PRIVATE_CALLBACKS;

			try {
				const createRes = await request(app)
					.post('/api/jobs/tradingview-analysis')
					.set('x-api-key', 'test-key')
					.send({
						type: 'expanded-analysis',
						symbols: ['BINANCE:BTCUSDT'],
						callbackUrl: 'https://127.0.0.1/callback',
					})
					.expect(400);

				expect(createRes.body.error).toContain('callbackUrl must be a valid HTTPS URL');
			} finally {
				process.env.NODE_ENV = prevEnv;
				process.env.ALLOW_HTTP_CALLBACKS = prevAllow;
				if (prevPrivate !== undefined) {
					process.env.ALLOW_PRIVATE_CALLBACKS = prevPrivate;
				} else {
					delete process.env.ALLOW_PRIVATE_CALLBACKS;
				}
			}
		});

		it('allows private network callbackUrl if ALLOW_PRIVATE_CALLBACKS override is set', async () => {
			const prevEnv = process.env.NODE_ENV;
			const prevAllow = process.env.ALLOW_HTTP_CALLBACKS;
			const prevPrivate = process.env.ALLOW_PRIVATE_CALLBACKS;

			process.env.NODE_ENV = 'production';
			process.env.ALLOW_HTTP_CALLBACKS = 'false';
			process.env.ALLOW_PRIVATE_CALLBACKS = 'true';

			try {
				await request(app)
					.post('/api/jobs/tradingview-analysis')
					.set('x-api-key', 'test-key')
					.send({
						type: 'expanded-analysis',
						symbols: ['BINANCE:BTCUSDT'],
						callbackUrl: 'https://127.0.0.1/callback',
					})
					.expect(201);
			} finally {
				process.env.NODE_ENV = prevEnv;
				process.env.ALLOW_HTTP_CALLBACKS = prevAllow;
				if (prevPrivate !== undefined) {
					process.env.ALLOW_PRIVATE_CALLBACKS = prevPrivate;
				} else {
					delete process.env.ALLOW_PRIVATE_CALLBACKS;
				}
			}
		});
	});
});
