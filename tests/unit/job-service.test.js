'use strict';

const admin = require('firebase-admin');
const { JobService } = require('../../src/services/jobs/JobService');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const JobRepository = require('../../src/services/jobs/JobRepository');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
		delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		admin.__resetApps();
		admin.__resetCollectionState();
		JobRepository._resetForTesting();
		jest.clearAllMocks();
		jobService = new JobService();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('createJob', () => {
		it('throws UNSUPPORTED_TYPE for invalid job type', async () => {
			await expect(jobService.createJob('invalid-type', {}))
				.rejects.toThrow('Unsupported job type: invalid-type');
		});

		it('throws FEATURE_DISABLED if market-scanner is requested but disabled', async () => {
			process.env.ENABLE_MARKET_SCANNER = 'false';
			await expect(jobService.createJob('market-scanner', {}))
				.rejects.toThrow('Market scanner is not enabled');
		});

		it('throws validation error if request payload is invalid', async () => {
			await expect(jobService.createJob('expanded-analysis', { symbols: 'not-an-array' }))
				.rejects.toThrow();
		});

		it('throws validation error if timeoutMs is not a positive integer', async () => {
			await expect(jobService.createJob('expanded-analysis', { symbols: ['BINANCE:BTCUSDT'], timeoutMs: 'invalid' }))
				.rejects.toThrow('timeoutMs must be a positive integer');

			await expect(jobService.createJob('expanded-analysis', { symbols: ['BINANCE:BTCUSDT'], timeoutMs: -100 }))
				.rejects.toThrow('timeoutMs must be a positive integer');
		});

		it('creates a job and returns metadata on success', async () => {
			const result = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			expect(result.success).toBe(true);
			expect(result.jobId).toBeDefined();
			expect(result.status).toBe('processing');
		});

		it('correctly validates and parses timeoutMs string format like 1e3', async () => {
			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				timeoutMs: '1e3',
			});

			const rawJob = await jobService.repository.get(metadata.jobId);
			expect(rawJob.timeoutMs).toBe(1000);
		});
	});

	describe('Background execution and retrieval', () => {
		it('completes expanded-analysis job successfully', async () => {
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			const jobId = metadata.jobId;

			// Poll until completed
			let job = await jobService.getJob(jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = await jobService.getJob(jobId);
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

			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			const jobId = metadata.jobId;

			// Poll until failed
			let job = await jobService.getJob(jobId);
			let attempts = 0;
			while (job.status !== 'failed' && attempts < 10) {
				await delay(20);
				job = await jobService.getJob(jobId);
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

			const metadata = await jobService.createJob('market-scanner', {
				scans: ['top_gainers'],
			});

			const jobId = metadata.jobId;

			// Poll until completed
			let job = await jobService.getJob(jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = await jobService.getJob(jobId);
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
		it('evicts jobs older than 1 hour if status is completed or failed', async () => {
			const jobId = 'expired-completed-job';
			const rawJob = {
				jobId,
				type: 'expanded-analysis',
				status: 'completed',
				progress: { total: 1, current: 1, status: 'Completed analysis' },
				fullResults: [],
				fullScanResults: [],
				createdAt: new Date(Date.now() - 7200000).toISOString(),
				updatedAt: new Date(Date.now() - 7200000).toISOString(),
				totalDurationMs: 1000,
			};
			await jobService.repository.save(rawJob);

			// Querying job should clean it up and return null
			const job = await jobService.getJob(jobId);
			expect(job).toBeNull();
			expect(jobService.repository.has(jobId)).toBe(false);
		});

		it('does not evict jobs older than 1 hour if they are not completed or failed', async () => {
			const jobId = 'old-processing-job';
			const rawJob = {
				jobId,
				type: 'expanded-analysis',
				status: 'processing',
				progress: { total: 1, current: 0, status: 'processing' },
				fullResults: [],
				fullScanResults: [],
				createdAt: new Date(Date.now() - 7200000).toISOString(),
				updatedAt: new Date(Date.now() - 7200000).toISOString(),
				totalDurationMs: 0,
			};
			await jobService.repository.save(rawJob);

			// Querying job should NOT clean it up
			const job = await jobService.getJob(jobId);
			expect(job).not.toBeNull();
			expect(jobService.repository.has(jobId)).toBe(true);

			// Now set status to completed, querying it should clean it up
			rawJob.status = 'completed';
			await jobService.repository.save(rawJob);
			const jobAfterComplete = await jobService.getJob(jobId);
			expect(jobAfterComplete).toBeNull();
			expect(jobService.repository.has(jobId)).toBe(false);
		});
	});

	describe('Durable persistence', () => {
		it('reads a completed job from Firestore after a service restart', async () => {
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});

			let job = await jobService.getJob(metadata.jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = await jobService.getJob(metadata.jobId);
				attempts++;
			}

			JobRepository._resetForTesting();
			const restartedService = new JobService();
			const restored = await restartedService.getJob(metadata.jobId);

			expect(restored).toMatchObject({
				jobId: metadata.jobId,
				type: 'expanded-analysis',
				status: 'completed',
			});
			expect(restored.alertText).toContain('BTCUSDT');
			expect(restored.results).toHaveLength(1);
		});
	});
});
