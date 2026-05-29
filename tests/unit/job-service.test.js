'use strict';

const { JobService } = require('../../src/services/jobs/JobService');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		analyzeSymbolIdentifier: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
		callScanTool: jest.fn(),
	},
}));

jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => {
	const mockSend = jest.fn().mockResolvedValue([{ success: true, channel: 'telegram' }]);
	const mockManager = {
		sendToAll: mockSend,
		getEnabledChannels: () => ['telegram'],
	};
	return {
		getNotificationManager: jest.fn(() => mockManager),
		initializeNotificationServices: jest.fn(() => mockManager),
	};
});

describe('JobService Unit Tests', () => {
	let jobService;
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_MARKET_SCANNER: 'true',
		};
		jest.clearAllMocks();
		jobService = new JobService();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('createJob', () => {
		it('throws UNSUPPORTED_TYPE for invalid job type', () => {
			expect(() => {
				jobService.createJob('invalid-type', {});
			}).toThrow('Unsupported job type: invalid-type');
		});

		it('throws FEATURE_DISABLED if market-scanner is requested but disabled', () => {
			process.env.ENABLE_MARKET_SCANNER = 'false';
			expect(() => {
				jobService.createJob('market-scanner', {});
			}).toThrow('Market scanner is not enabled');
		});

		it('throws validation error if request payload is invalid', () => {
			expect(() => {
				jobService.createJob('expanded-analysis', { symbols: 'not-an-array' });
			}).toThrow();
		});

		it('throws validation error if timeoutMs is not a positive integer', () => {
			expect(() => {
				jobService.createJob('expanded-analysis', { symbols: ['BINANCE:BTCUSDT'], timeoutMs: 'invalid' });
			}).toThrow('timeoutMs must be a positive integer');

			expect(() => {
				jobService.createJob('expanded-analysis', { symbols: ['BINANCE:BTCUSDT'], timeoutMs: -100 });
			}).toThrow('timeoutMs must be a positive integer');
		});

		it('creates a job and returns metadata on success', () => {
			const result = jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			expect(result.success).toBe(true);
			expect(result.jobId).toBeDefined();
			expect(result.status).toBe('processing');
		});

		it('correctly validates and parses timeoutMs string format like 1e3', () => {
			const metadata = jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				timeoutMs: '1e3',
			});

			const rawJob = jobService.jobs.get(metadata.jobId);
			expect(rawJob.timeoutMs).toBe(1000);
		});
	});

	describe('Background execution and retrieval', () => {
		const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

		it('completes expanded-analysis job successfully', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			const metadata = jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			const jobId = metadata.jobId;

			// Poll until completed
			let job = jobService.getJob(jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = jobService.getJob(jobId);
				attempts++;
			}

			expect(job.status).toBe('completed');
			expect(job.alertText).toContain('BTCUSDT');
			expect(job.results).toHaveLength(1);
			expect(job.results[0]).toEqual({
				symbol: 'BINANCE:BTCUSDT',
				status: 'analyzed',
				price: 65000,
				rsi: 45,
			});
			expect(job.deliveryResults).toBeDefined();
			expect(job.summary).toEqual({
				total: 1,
				analyzed: 1,
				error: 0,
				delivered: 1,
			});
		});

		it('fails expanded-analysis job when all symbols fail', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockRejectedValueOnce(new Error('MCP Failed'));

			const metadata = jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			const jobId = metadata.jobId;

			// Poll until failed
			let job = jobService.getJob(jobId);
			let attempts = 0;
			while (job.status !== 'failed' && attempts < 10) {
				await delay(20);
				job = jobService.getJob(jobId);
				attempts++;
			}

			expect(job.status).toBe('failed');
			expect(job.error).toContain('TradingView MCP failed for all requested symbols.');
			expect(job.code).toBe('ALL_SYMBOLS_FAILED');
			expect(job.results[0]).toEqual({
				symbol: 'BINANCE:BTCUSDT',
				status: 'error',
				error: 'MCP Failed',
			});
		});

		it('completes market-scanner job successfully', async () => {
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([
				{ symbol: 'BINANCE:ETHUSDT', changePercent: 5.0, indicators: { close: 3200, RSI: 55 } },
			]);

			const metadata = jobService.createJob('market-scanner', {
				scans: ['top_gainers'],
			});

			const jobId = metadata.jobId;

			// Poll until completed
			let job = jobService.getJob(jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = jobService.getJob(jobId);
				attempts++;
			}

			expect(job.status).toBe('completed');
			expect(job.alertText).toContain('ETHUSDT');
			expect(job.scanResults).toHaveLength(1);
			expect(job.scanResults[0]).toEqual({
				scan: 'top_gainers',
				status: 'success',
				itemCount: 1,
			});
			expect(job.deliveryResults).toBeDefined();
		});
	});

	describe('Job eviction / cleanup', () => {
		it('evicts jobs older than 1 hour if status is completed or failed', () => {
			const metadata = jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			const jobId = metadata.jobId;

			// Access internal jobs Map to manipulate the createdAt timestamp
			const rawJob = jobService.jobs.get(jobId);
			expect(rawJob).toBeDefined();

			// Set createdAt to 2 hours ago
			rawJob.createdAt = new Date(Date.now() - 7200000).toISOString();
			rawJob.status = 'completed';

			// Querying job should clean it up and return null
			const job = jobService.getJob(jobId);
			expect(job).toBeNull();
			expect(jobService.jobs.has(jobId)).toBe(false);
		});

		it('does not evict jobs older than 1 hour if they are not completed or failed', () => {
			const metadata = jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			const jobId = metadata.jobId;
			const rawJob = jobService.jobs.get(jobId);
			expect(rawJob).toBeDefined();

			// Set createdAt to 2 hours ago
			rawJob.createdAt = new Date(Date.now() - 7200000).toISOString();
			rawJob.status = 'processing';

			// Querying job should NOT clean it up
			const job = jobService.getJob(jobId);
			expect(job).not.toBeNull();
			expect(jobService.jobs.has(jobId)).toBe(true);

			// Now set status to completed, querying it should clean it up
			rawJob.status = 'completed';
			const jobAfterComplete = jobService.getJob(jobId);
			expect(jobAfterComplete).toBeNull();
			expect(jobService.jobs.has(jobId)).toBe(false);
		});
	});
});
