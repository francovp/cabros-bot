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
		it('evicts jobs older than 1 hour if status is terminal', async () => {
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

		it('evicts jobs older than 1 hour if status is cancelled or timed_out', async () => {
			const statuses = ['cancelled', 'timed_out'];

			for (const status of statuses) {
				const jobId = `expired-${status}-job`;
				const rawJob = {
					jobId,
					type: 'expanded-analysis',
					status,
					progress: { total: 1, current: 1, status },
					fullResults: [],
					fullScanResults: [],
					createdAt: new Date(Date.now() - 7200000).toISOString(),
					updatedAt: new Date(Date.now() - 7200000).toISOString(),
					totalDurationMs: 1000,
				};
				await jobService.repository.save(rawJob);

				const job = await jobService.getJob(jobId);
				expect(job).toBeNull();
				expect(jobService.repository.has(jobId)).toBe(false);
			}
		});

		it('does not evict jobs older than 1 hour if they are not terminal', async () => {
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

	describe('Cancellation and retry operations', () => {
		it('cancels a running job and returns 409 if already completed', async () => {
			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
			});
			const jobId = metadata.jobId;

			// Cancel it
			const cancelResult = await jobService.cancelJob(jobId);
			expect(cancelResult.success).toBe(true);
			expect(cancelResult.status).toBe('cancelled');

			// Re-cancelling should return terminal error
			const cancelAgain = await jobService.cancelJob(jobId);
			expect(cancelAgain.success).toBe(false);
			expect(cancelAgain.code).toBe('TERMINAL_JOB');

			// Check job state
			const job = await jobService.getJob(jobId);
			expect(job.status).toBe('cancelled');
		});

		it('retries a failed/cancelled job and creates a new one with requestMetadata', async () => {
			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				timeframe: '1H',
			});
			const jobId = metadata.jobId;

			// Cancel it so it is terminal and retryable
			await jobService.cancelJob(jobId);

			// Retry it
			const retryResult = await jobService.retryJob(jobId);
			expect(retryResult.success).toBe(true);
			expect(retryResult.oldJobId).toBe(jobId);
			expect(retryResult.newJobId).toBeDefined();
			expect(retryResult.status).toBe('processing');

			// Check that the new job has the same metadata
			const newJob = await jobService.repository.get(retryResult.newJobId);
			expect(newJob.requestMetadata).toEqual(
				expect.objectContaining({
					type: 'expanded-analysis',
					symbols: ['BINANCE:BTCUSDT'],
					timeframe: '1h',
				})
			);
		});

		it('returns null when retrying expired retryable terminal jobs', async () => {
			for (const status of ['cancelled', 'timed_out']) {
				const jobId = `expired-${status}-retry-job`;
				await jobService.repository.save({
					jobId,
					type: 'expanded-analysis',
					status,
					progress: { total: 1, current: 1, status },
					requestMetadata: {
						type: 'expanded-analysis',
						symbols: ['BINANCE:BTCUSDT'],
						timeframe: '1h',
					},
					fullResults: [],
					fullScanResults: [],
					createdAt: new Date(Date.now() - 7200000).toISOString(),
					updatedAt: new Date(Date.now() - 7200000).toISOString(),
					totalDurationMs: 1000,
				});

				const result = await jobService.retryJob(jobId);

				expect(result).toBeNull();
				expect(jobService.repository.has(jobId)).toBe(false);
			}
		});

		it('returns null when cancelling an expired terminal job', async () => {
			const jobId = 'expired-cancelled-cancel-job';
			await jobService.repository.save({
				jobId,
				type: 'expanded-analysis',
				status: 'cancelled',
				progress: { total: 1, current: 1, status: 'cancelled' },
				fullResults: [],
				fullScanResults: [],
				createdAt: new Date(Date.now() - 7200000).toISOString(),
				updatedAt: new Date(Date.now() - 7200000).toISOString(),
				totalDurationMs: 1000,
			});

			const result = await jobService.cancelJob(jobId);

			expect(result).toBeNull();
			expect(jobService.repository.has(jobId)).toBe(false);
		});

		it('retries only failed items via retryFailedJob', async () => {
			// Save a job that is completed with mixed status
			const jobId = 'mixed-job';
			const rawJob = {
				jobId,
				type: 'expanded-analysis',
				status: 'completed',
				progress: { total: 3, current: 3, status: 'Completed' },
				requestMetadata: {
					type: 'expanded-analysis',
					symbols: ['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:SOLUSDT'],
					timeframe: '60',
				},
				fullResults: [
					{ symbol: 'BINANCE:BTCUSDT', status: 'analyzed' },
					{ symbol: 'BINANCE:ETHUSDT', status: 'error', error: 'MCP error' },
					{ symbol: 'BINANCE:SOLUSDT', status: 'timeout', error: 'Timed out' },
				],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await jobService.repository.save(rawJob);

			const retryResult = await jobService.retryFailedJob(jobId);
			expect(retryResult.success).toBe(true);
			expect(retryResult.oldJobId).toBe(jobId);

			const newJob = await jobService.repository.get(retryResult.newJobId);
			expect(newJob.requestMetadata.symbols).toEqual(['BINANCE:ETHUSDT', 'BINANCE:SOLUSDT']);
		});
	});

	describe('Async job completion callbacks', () => {
		let fetchMock;

		beforeEach(() => {
			fetchMock = jest.fn();
			globalThis.fetch = fetchMock;
		});

		afterEach(() => {
			delete globalThis.fetch;
		});

		it('validates callbackUrl protocol and format', async () => {
			const prevEnv = process.env.NODE_ENV;
			const prevAllow = process.env.ALLOW_HTTP_CALLBACKS;
			process.env.NODE_ENV = 'production';
			process.env.ALLOW_HTTP_CALLBACKS = 'false';

			try {
				await expect(jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'http://example.com/callback',
				})).rejects.toThrow('callbackUrl must be a valid HTTPS URL');

				await expect(jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'not-a-url',
				})).rejects.toThrow('callbackUrl must be a valid HTTPS URL');
			} finally {
				process.env.NODE_ENV = prevEnv;
				process.env.ALLOW_HTTP_CALLBACKS = prevAllow;
			}
		});

		it('allows http for localhost in local environments', async () => {
			const prevEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = 'test';
			try {
				const res = await jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'http://localhost:8080/callback',
				});
				expect(res.success).toBe(true);
			} finally {
				process.env.NODE_ENV = prevEnv;
			}
		});

		describe('private-network blocking (SSRF protection)', () => {
			let dnsSpy;

			beforeAll(() => {
				const dns = require('dns');
				dnsSpy = jest.spyOn(dns.promises, 'lookup').mockImplementation(async (hostname, options) => {
					if (hostname === 'example.com') {
						return options?.all
							? [{ address: '93.184.216.34', family: 4 }]
							: { address: '93.184.216.34', family: 4 };
					}
					if (hostname === 'localhost') {
						return options?.all
							? [{ address: '127.0.0.1', family: 4 }]
							: { address: '127.0.0.1', family: 4 };
					}
					if (hostname === 'mixed.example.com') {
						return [
							{ address: '93.184.216.34', family: 4 },
							{ address: '169.254.169.254', family: 4 },
						];
					}
					throw new Error('ENOTFOUND');
				});
			});

			afterAll(() => {
				if (dnsSpy) {
					dnsSpy.mockRestore();
				}
			});

			it('rejects loopback, link-local, RFC1918, multicast, and metadata-service callback URLs in production', async () => {
				const prevEnv = process.env.NODE_ENV;
				const prevAllow = process.env.ALLOW_HTTP_CALLBACKS;
				const prevPrivate = process.env.ALLOW_PRIVATE_CALLBACKS;

				process.env.NODE_ENV = 'production';
				process.env.ALLOW_HTTP_CALLBACKS = 'false';
				delete process.env.ALLOW_PRIVATE_CALLBACKS;

				try {
					const blockedUrls = [
						'https://0.0.0.1/callback',
						'https://localhost/callback',
						'https://127.0.0.1/callback',
						'https://[::1]/callback',
						'https://10.0.0.1/callback',
						'https://172.16.5.5/callback',
						'https://192.0.0.8/callback',
						'https://192.0.2.1/callback',
						'https://192.168.1.100/callback',
						'https://100.64.0.1/callback',
						'https://169.254.169.254/callback',
						'https://198.18.0.1/callback',
						'https://240.0.0.1/callback',
						'https://[fe80::1]/callback',
						'https://[fc00::]/callback',
						'https://[ff02::1]/callback',
						'https://[::ffff:127.0.0.1]/callback',
						'https://[::ffff:7f00:0001]/callback',
					];

					for (const urlStr of blockedUrls) {
						await expect(jobService.createJob('expanded-analysis', {
							symbols: ['BINANCE:BTCUSDT'],
							callbackUrl: urlStr,
						})).rejects.toThrow('callbackUrl must be a valid HTTPS URL');
					}

					// Verify a public URL passes
					const successRes = await jobService.createJob('expanded-analysis', {
						symbols: ['BINANCE:BTCUSDT'],
						callbackUrl: 'https://example.com/callback',
					});
					expect(successRes.success).toBe(true);
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

			it('rejects private HTTP callback URLs even when HTTP callbacks are enabled', async () => {
				const prevEnv = process.env.NODE_ENV;
				const prevAllow = process.env.ALLOW_HTTP_CALLBACKS;
				const prevPrivate = process.env.ALLOW_PRIVATE_CALLBACKS;

				process.env.NODE_ENV = 'production';
				process.env.ALLOW_HTTP_CALLBACKS = 'true';
				delete process.env.ALLOW_PRIVATE_CALLBACKS;

				try {
					await expect(jobService.createJob('expanded-analysis', {
						symbols: ['BINANCE:BTCUSDT'],
						callbackUrl: 'http://169.254.169.254/callback',
					})).rejects.toThrow('callbackUrl must be a valid HTTPS URL');
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

			it('allows private-network callback URLs if ALLOW_PRIVATE_CALLBACKS override is set', async () => {
				const prevEnv = process.env.NODE_ENV;
				const prevAllow = process.env.ALLOW_HTTP_CALLBACKS;
				const prevPrivate = process.env.ALLOW_PRIVATE_CALLBACKS;

				process.env.NODE_ENV = 'production';
				process.env.ALLOW_HTTP_CALLBACKS = 'false';
				process.env.ALLOW_PRIVATE_CALLBACKS = 'true';

				try {
					const res = await jobService.createJob('expanded-analysis', {
						symbols: ['BINANCE:BTCUSDT'],
						callbackUrl: 'https://127.0.0.1/callback',
					});
					expect(res.success).toBe(true);
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

			it('rejects a hostname when any resolved address is private', async () => {
				process.env.NODE_ENV = 'production';
				delete process.env.ALLOW_PRIVATE_CALLBACKS;

				await expect(jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://mixed.example.com/callback',
				})).rejects.toThrow('callbackUrl must be a valid HTTPS URL');

				expect(dnsSpy).toHaveBeenCalledWith('mixed.example.com', { all: true, verbatim: true });
			});

			it('accepts public 192.0.0.0/16 addresses outside the IETF special-purpose /24', async () => {
				process.env.NODE_ENV = 'production';
				delete process.env.ALLOW_PRIVATE_CALLBACKS;

				const result = await jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://192.0.3.1/callback',
				});

				expect(result.success).toBe(true);
			});

			it('accepts a public bracketed IPv6 literal without DNS lookup', async () => {
				process.env.NODE_ENV = 'production';
				delete process.env.ALLOW_PRIVATE_CALLBACKS;
				dnsSpy.mockClear();

				const result = await jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://[2606:4700:4700::1111]/callback',
				});

				expect(result.success).toBe(true);
				expect(dnsSpy).not.toHaveBeenCalled();
			});
		});

		it('validates callbackSecret is a string', async () => {
			await expect(jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				callbackUrl: 'https://example.com/callback',
				callbackSecret: 12345,
			})).rejects.toThrow('callbackSecret must be a string');
		});

		it('validates callbackEvents is an array of strings with valid event types', async () => {
			await expect(jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				callbackUrl: 'https://example.com/callback',
				callbackEvents: 'completed',
			})).rejects.toThrow('callbackEvents must be an array of strings');

			await expect(jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				callbackUrl: 'https://example.com/callback',
				callbackEvents: ['completed', 'invalid-event'],
			})).rejects.toThrow('Invalid event in callbackEvents');
		});

		it('sends separate callbacks for processing and completed events', async () => {
			fetchMock
				.mockResolvedValueOnce({ ok: true, status: 200 })
				.mockResolvedValueOnce({ ok: true, status: 200 });

			const job = {
				jobId: 'job-callback-events',
				type: 'expanded-analysis',
				status: 'processing',
				requestMetadata: {
					type: 'expanded-analysis',
					symbols: ['BINANCE:BTCUSDT'],
					timeframe: '1D',
					includeMultiTimeframe: false,
					analysisMode: 'standard',
					timeoutMs: 300000,
					callbackUrl: 'https://example.com/callback',
					callbackEvents: ['processing', 'completed'],
				},
				progress: { total: 1, current: 0, status: 'pending' },
				fullResults: [],
				fullScanResults: [],
				alertText: null,
				deliveryResults: [],
				summary: null,
				error: null,
				code: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				totalDurationMs: 0,
				timeoutMs: 300000,
				callbackUrl: 'https://example.com/callback',
				callbackEvents: ['processing', 'completed'],
				callbackStatus: { status: 'pending', attempts: [] },
			};

			await jobService.repository.save(job);
			await jobService._triggerCallbackIfConfigured(job);

			let freshJob = await jobService.repository.get(job.jobId);
			let pollAttempts = 0;
			while (
				(!freshJob.callbackStatus || freshJob.callbackStatus.status !== 'success')
				&& pollAttempts < 20
			) {
				await delay(20);
				freshJob = await jobService.repository.get(job.jobId);
				pollAttempts++;
			}

			expect(fetchMock).toHaveBeenCalledTimes(1);

			freshJob.status = 'completed';
			freshJob.updatedAt = new Date().toISOString();
			await jobService.repository.save(freshJob);
			await jobService._triggerCallbackIfConfigured(freshJob);

			pollAttempts = 0;
			while (fetchMock.mock.calls.length < 2 && pollAttempts < 20) {
				await delay(20);
				pollAttempts++;
			}

			expect(fetchMock).toHaveBeenCalledTimes(2);
			const statuses = fetchMock.mock.calls.map(([, options]) => JSON.parse(options.body).status);
			expect(statuses).toEqual(['processing', 'completed']);
		});

		it('sends callback when job reaches terminal state and records success', async () => {
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				callbackUrl: 'https://example.com/callback',
			});

			let job = await jobService.getJob(metadata.jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = await jobService.getJob(metadata.jobId);
				attempts++;
			}

			expect(job.status).toBe('completed');

			await delay(100);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [url, options] = fetchMock.mock.calls[0];
			expect(url).toBe('https://example.com/callback');
			expect(options.method).toBe('POST');
			expect(options.headers['Content-Type']).toBe('application/json');
			expect(options.redirect).toBe('error');

			const body = JSON.parse(options.body);
			expect(body.jobId).toBe(metadata.jobId);
			expect(body.status).toBe('completed');
			expect(body.totalDurationMs).toBeGreaterThanOrEqual(0);

			const freshJob = await jobService.getJob(metadata.jobId);
			expect(freshJob.callbackStatus).toBeDefined();
			expect(freshJob.callbackStatus.status).toBe('success');
			expect(freshJob.callbackStatus.attempts).toHaveLength(1);
			expect(freshJob.callbackStatus.attempts[0].statusCode).toBe(200);
		});

		it('sanitizes blocked callback URLs before logging delivery failures', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			const prevEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = 'production';
			delete process.env.ALLOW_PRIVATE_CALLBACKS;
			const job = {
				jobId: 'job-callback-blocked-log',
				type: 'expanded-analysis',
				status: 'completed',
				requestMetadata: {
					type: 'expanded-analysis',
					symbols: ['BINANCE:BTCUSDT'],
					timeframe: '1D',
					includeMultiTimeframe: false,
					analysisMode: 'standard',
					timeoutMs: 300000,
					callbackUrl: 'https://198.18.0.1/secret/path?token=super-secret',
				},
				progress: { total: 1, current: 1, status: 'completed' },
				fullResults: [],
				fullScanResults: [],
				alertText: null,
				deliveryResults: [],
				summary: null,
				error: null,
				code: null,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				totalDurationMs: 0,
				timeoutMs: 300000,
				callbackUrl: 'https://198.18.0.1/secret/path?token=super-secret',
				callbackStatus: { status: 'pending', attempts: [] },
			};

			await jobService.repository.save(job);
			try {
				await jobService._triggerCallbackIfConfigured(job);

				let freshJob = await jobService.repository.get(job.jobId);
				let pollAttempts = 0;
				while ((!freshJob.callbackStatus || freshJob.callbackStatus.status === 'pending') && pollAttempts < 20) {
					await delay(20);
					freshJob = await jobService.repository.get(job.jobId);
					pollAttempts++;
				}

				expect(fetchMock).not.toHaveBeenCalled();
				expect(freshJob.callbackStatus.status).toBe('failed');
				expect(warnSpy).toHaveBeenCalledWith(
					expect.stringContaining('Aborting callback to unsafe URL'),
					'https://198.18.0.1/...',
				);
				const loggedText = warnSpy.mock.calls.flat().join(' ');
				expect(loggedText).not.toContain('super-secret');
				expect(loggedText).not.toContain('/secret/path');
			} finally {
				process.env.NODE_ENV = prevEnv;
				warnSpy.mockRestore();
			}
		});

		it('revalidates DNS before each retry and stops after rebinding to a private address', async () => {
			const dns = require('dns');
			const lookupSpy = jest.spyOn(dns.promises, 'lookup')
				.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }])
				.mockResolvedValueOnce([{ address: '169.254.169.254', family: 4 }]);
			process.env.NODE_ENV = 'production';
			process.env.JOB_CALLBACK_RETRY_DELAY_MS = '1';
			delete process.env.ALLOW_PRIVATE_CALLBACKS;
			fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: 'Server Error' });

			const job = {
				jobId: 'job-dns-rebinding',
				type: 'expanded-analysis',
				status: 'completed',
				callbackUrl: 'https://rebind.example.com/callback',
				callbackStatus: { status: 'pending', attempts: [] },
				fullResults: [],
				fullScanResults: [],
				deliveryResults: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await jobService.repository.save(job);

			try {
				await jobService._sendCallbackWithRetry(job);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				expect(lookupSpy).toHaveBeenCalledTimes(2);
				const freshJob = await jobService.repository.get(job.jobId);
				expect(freshJob.callbackStatus.status).toBe('failed');
				expect(freshJob.callbackStatus.attempts).toHaveLength(2);
				expect(freshJob.callbackStatus.attempts[1].error).toBe('Callback URL is blocked (private network)');
			} finally {
				lookupSpy.mockRestore();
			}
		});

		it('retries delivery when DNS validation has a transient failure', async () => {
			const dns = require('dns');
			const lookupSpy = jest.spyOn(dns.promises, 'lookup')
				.mockRejectedValueOnce(new Error('ENOTFOUND'))
				.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]);
			const prevEnv = process.env.NODE_ENV;
			const prevDelay = process.env.JOB_CALLBACK_RETRY_DELAY_MS;
			process.env.NODE_ENV = 'production';
			process.env.JOB_CALLBACK_RETRY_DELAY_MS = '1';
			delete process.env.ALLOW_PRIVATE_CALLBACKS;
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

			const job = {
				jobId: 'job-transient-dns-failure',
				type: 'expanded-analysis',
				status: 'completed',
				callbackUrl: 'https://flaky-dns.example.com/callback',
				callbackStatus: { status: 'pending', attempts: [] },
				fullResults: [],
				fullScanResults: [],
				deliveryResults: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			await jobService.repository.save(job);

			try {
				await jobService._sendCallbackWithRetry(job);

				expect(lookupSpy).toHaveBeenCalledTimes(2);
				expect(fetchMock).toHaveBeenCalledTimes(1);
				const freshJob = await jobService.repository.get(job.jobId);
				expect(freshJob.callbackStatus.status).toBe('success');
				expect(freshJob.callbackStatus.attempts).toHaveLength(2);
				expect(freshJob.callbackStatus.attempts[0].error).toBe('Callback URL validation failed');
				expect(freshJob.callbackStatus.attempts[1].statusCode).toBe(200);
			} finally {
				process.env.NODE_ENV = prevEnv;
				process.env.JOB_CALLBACK_RETRY_DELAY_MS = prevDelay;
				lookupSpy.mockRestore();
			}
		});

		it('signs payload with HMAC signature if callbackSecret is provided', async () => {
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			const metadata = await jobService.createJob('expanded-analysis', {
				symbols: ['BINANCE:BTCUSDT'],
				callbackUrl: 'https://example.com/callback',
				callbackSecret: 'super-secret',
			});

			let job = await jobService.getJob(metadata.jobId);
			let attempts = 0;
			while (job.status !== 'completed' && attempts < 10) {
				await delay(20);
				job = await jobService.getJob(metadata.jobId);
				attempts++;
			}

			await delay(100);

			expect(fetchMock).toHaveBeenCalledTimes(1);
			const [, options] = fetchMock.mock.calls[0];
			const signature = options.headers['x-callback-signature'];
			expect(signature).toBeDefined();

			const crypto = require('crypto');
			const expectedSignature = crypto
				.createHmac('sha256', 'super-secret')
				.update(options.body)
				.digest('hex');
			expect(signature).toBe(expectedSignature);
		});

		it('signs payload with server-side configured secret if no client secret is provided', async () => {
			const prevSecret = process.env.JOB_CALLBACK_SIGNING_SECRET;
			process.env.JOB_CALLBACK_SIGNING_SECRET = 'server-secret';
			fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			try {
				const metadata = await jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://example.com/callback',
				});

				let job = await jobService.getJob(metadata.jobId);
				let attempts = 0;
				while (job.status !== 'completed' && attempts < 10) {
					await delay(20);
					job = await jobService.getJob(metadata.jobId);
					attempts++;
				}

				await delay(100);

				expect(fetchMock).toHaveBeenCalledTimes(1);
				const [, options] = fetchMock.mock.calls[0];
				const signature = options.headers['x-callback-signature'];
				expect(signature).toBeDefined();

				const crypto = require('crypto');
				const expectedSignature = crypto
					.createHmac('sha256', 'server-secret')
					.update(options.body)
					.digest('hex');
				expect(signature).toBe(expectedSignature);
			} finally {
				process.env.JOB_CALLBACK_SIGNING_SECRET = prevSecret;
			}
		});

		it('retries up to 3 times on transient failure and fails open without affecting job status', async () => {
			const prevDelay = process.env.JOB_CALLBACK_RETRY_DELAY_MS;
			process.env.JOB_CALLBACK_RETRY_DELAY_MS = '1';

			fetchMock
				.mockRejectedValueOnce(new Error('Network error'))
				.mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway' })
				.mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
				.mockRejectedValueOnce(new Error('Timeout'));

			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			try {
				const metadata = await jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://example.com/callback',
				});

				let job = await jobService.getJob(metadata.jobId);
				let attempts = 0;
				while (job.status !== 'completed' && attempts < 10) {
					await delay(20);
					job = await jobService.getJob(metadata.jobId);
					attempts++;
				}

				expect(job.status).toBe('completed');

				let freshJob = await jobService.getJob(metadata.jobId);
				let pollAttempts = 0;
				while ((!freshJob.callbackStatus || freshJob.callbackStatus.status === 'pending') && pollAttempts < 20) {
					await delay(20);
					freshJob = await jobService.getJob(metadata.jobId);
					pollAttempts++;
				}

				expect(fetchMock).toHaveBeenCalledTimes(4);

				expect(freshJob.callbackStatus.status).toBe('failed');
				expect(freshJob.callbackStatus.attempts).toHaveLength(4);
				expect(freshJob.callbackStatus.attempts[0].error).toBe('Network error');
				expect(freshJob.callbackStatus.attempts[1].error).toBe('HTTP 502 Bad Gateway');
				expect(freshJob.callbackStatus.attempts[2].error).toBe('HTTP 503 Service Unavailable');
				expect(freshJob.callbackStatus.attempts[3].error).toBe('Timeout');
			} finally {
				process.env.JOB_CALLBACK_RETRY_DELAY_MS = prevDelay;
			}
		});

		it('stops retrying once a retry succeeds', async () => {
			const prevDelay = process.env.JOB_CALLBACK_RETRY_DELAY_MS;
			process.env.JOB_CALLBACK_RETRY_DELAY_MS = '1';

			fetchMock
				.mockRejectedValueOnce(new Error('Network error'))
				.mockResolvedValueOnce({ ok: true, status: 200 });

			tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
				symbol: 'BINANCE:BTCUSDT',
				price_data: { close: 65000, change_percent: 1.5 },
				rsi: { value: 45 },
			});

			try {
				const metadata = await jobService.createJob('expanded-analysis', {
					symbols: ['BINANCE:BTCUSDT'],
					callbackUrl: 'https://example.com/callback',
				});

				let job = await jobService.getJob(metadata.jobId);
				let attempts = 0;
				while (job.status !== 'completed' && attempts < 10) {
					await delay(20);
					job = await jobService.getJob(metadata.jobId);
					attempts++;
				}

				let freshJob = await jobService.getJob(metadata.jobId);
				let pollAttempts = 0;
				while ((!freshJob.callbackStatus || freshJob.callbackStatus.status === 'pending') && pollAttempts < 20) {
					await delay(20);
					freshJob = await jobService.getJob(metadata.jobId);
					pollAttempts++;
				}

				expect(fetchMock).toHaveBeenCalledTimes(2);

				expect(freshJob.callbackStatus.status).toBe('success');
				expect(freshJob.callbackStatus.attempts).toHaveLength(2);
			} finally {
				process.env.JOB_CALLBACK_RETRY_DELAY_MS = prevDelay;
			}
		});
	});
});
