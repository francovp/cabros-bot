const { getEventListeners } = require('node:events');
const { postMarketScannerAlert, runScans } = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { getNotificationManager, initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
	},
}));

jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => {
	const mockSend = jest.fn().mockResolvedValue([]);
	const mockManager = {
		sendToAll: mockSend,
	};
	return {
		getNotificationManager: jest.fn(() => mockManager),
		initializeNotificationServices: jest.fn(() => mockManager),
	};
});

describe('Market Scanner Handler', () => {
	const originalEnv = process.env;
	let mockRes;
	let mockReq;
	let mockNext;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_MARKET_SCANNER: 'true',
			MARKET_SCANNER_TIMEOUT_MS: '5000',
		};
		jest.clearAllMocks();

		mockRes = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
		mockNext = jest.fn();
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('postMarketScannerAlert', () => {
		it('returns 404 if ENABLE_MARKET_SCANNER is not true', async () => {
			process.env.ENABLE_MARKET_SCANNER = 'false';
			mockReq = { body: {} };

			const handler = postMarketScannerAlert(null);
			await handler(mockReq, mockRes);

			expect(mockRes.status).toHaveBeenCalledWith(404);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'FEATURE_DISABLED',
				}),
			);
		});

		it('returns 400 if validation fails', async () => {
			mockReq = {
				body: {
					timeframe: 'invalid_tf',
				},
			};

			const handler = postMarketScannerAlert(null);
			await handler(mockReq, mockRes);

			expect(mockRes.status).toHaveBeenCalledWith(400);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					code: 'INVALID_REQUEST',
				}),
			);
		});

		it('runs scans and formats report on success', async () => {
			mockReq = {
				body: {
					exchange: 'BINANCE',
					timeframe: '4h',
					scans: ['top_gainers'],
				},
			};

			tradingViewMcpService.callScanTool.mockResolvedValueOnce([
				{
					symbol: 'BINANCE:GMTUSDT',
					changePercent: 25.0,
					indicators: { close: 0.12, RSI: 80 },
				},
			]);

			const handler = postMarketScannerAlert(null);
			await handler(mockReq, mockRes);

			expect(tradingViewMcpService.callScanTool).toHaveBeenCalledWith(
				'top_gainers',
				{ exchange: 'BINANCE', timeframe: '4h', limit: 5 },
				expect.any(Object),
			);
			expect(mockRes.status).toHaveBeenCalledWith(200);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					success: true,
					alertText: expect.stringContaining('GMTUSDT'),
				}),
			);
		});

		it('returns 502 if all scans fail', async () => {
			mockReq = {
				body: {
					scans: ['top_gainers', 'top_losers'],
				},
			};

			tradingViewMcpService.callScanTool.mockRejectedValue(new Error('MCP failure'));

			const handler = postMarketScannerAlert(null);
			await handler(mockReq, mockRes);

			expect(mockRes.status).toHaveBeenCalledWith(502);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					code: 'ALL_SCANS_FAILED',
				}),
			);
		});

		it('returns 504 if abort signal triggers timeout', async () => {
			mockReq = {
				body: {
					scans: ['top_gainers'],
				},
			};

			process.env.MARKET_SCANNER_TIMEOUT_MS = '1';

			tradingViewMcpService.callScanTool.mockImplementationOnce(
				(scanType, args, options) => new Promise((resolve, reject) => {
					const onAbort = () => {
						clearTimeout(timeoutId);
						const err = new Error('AbortError');
						err.name = 'AbortError';
						reject(err);
					};
					const timeoutId = setTimeout(() => {
						if (options?.signal) {
							options.signal.removeEventListener('abort', onAbort);
						}
						resolve([]);
					}, 100);
					if (options?.signal) {
						if (options.signal.aborted) {
							onAbort();
						} else {
							options.signal.addEventListener('abort', onAbort, { once: true });
						}
					}
				}),
			);

			const handler = postMarketScannerAlert(null);
			await handler(mockReq, mockRes);

			expect(mockRes.status).toHaveBeenCalledWith(504);
			expect(mockRes.json).toHaveBeenCalledWith(
				expect.objectContaining({
					success: false,
					code: 'MARKET_SCANNER_TIMEOUT',
				}),
			);
		});
	});

	describe('runScans', () => {
		it('processes scans sequentially', async () => {
			const parsed = {
				exchange: 'BINANCE',
				timeframe: '4h',
				scans: ['top_gainers', 'top_losers'],
				limit: 3,
			};

			const callOrder = [];
			tradingViewMcpService.callScanTool.mockImplementation(async (scanType) => {
				callOrder.push(`start:${scanType}`);
				await new Promise((resolve) => setTimeout(resolve, 10));
				callOrder.push(`end:${scanType}`);
				return [];
			});

			const results = await runScans(parsed);

			expect(callOrder).toEqual([
				'start:top_gainers',
				'end:top_gainers',
				'start:top_losers',
				'end:top_losers',
			]);
			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({
				scan: 'top_gainers',
				status: 'success',
				items: [],
			});
		});

		it('handles intermediate scan failures without stopping other scans', async () => {
			const parsed = {
				exchange: 'BINANCE',
				timeframe: '4h',
				scans: ['top_gainers', 'top_losers'],
				limit: 3,
			};

			tradingViewMcpService.callScanTool
				.mockRejectedValueOnce(new Error('First scan failed'))
				.mockResolvedValueOnce([]);

			const results = await runScans(parsed);

			expect(results).toHaveLength(2);
			expect(results[0]).toEqual({
				scan: 'top_gainers',
				status: 'error',
				items: [],
				error: 'First scan failed',
			});
			expect(results[1]).toEqual({
				scan: 'top_losers',
				status: 'success',
				items: [],
			});
		});

		it('enriches scanner items with higher-timeframe data when requested', async () => {
			const parsed = {
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers'],
				limit: 3,
				includeMultiTimeframe: true,
			};
			const item = {
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 3.5,
				indicators: { RSI: 62 },
			};
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([item]);
			tradingViewMcpService.callMultiTimeframeAnalysis.mockResolvedValueOnce({
				alignment: { status: 'bullish', confidence: 82 },
			});

			const results = await runScans(parsed);

			expect(tradingViewMcpService.callMultiTimeframeAnalysis).toHaveBeenCalledWith({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				signal: undefined,
			});
			expect(results[0].items[0]).toEqual(expect.objectContaining({
				trendConfluence: {
					alignment: { status: 'bullish', confidence: 82 },
				},
			}));
		});

		it('keeps scanner items when higher-timeframe enrichment fails', async () => {
			const parsed = {
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers'],
				limit: 3,
				includeMultiTimeframe: true,
			};
			const item = { symbol: 'BINANCE:ETHUSDT', changePercent: 2.2 };
			tradingViewMcpService.callScanTool.mockResolvedValueOnce([item]);
			tradingViewMcpService.callMultiTimeframeAnalysis.mockRejectedValueOnce(new Error('MCP unavailable'));

			const results = await runScans(parsed);

			expect(results[0]).toEqual({
				scan: 'top_gainers',
				status: 'success',
				items: [item],
			});
		});

		it('preserves completed scan items when higher-timeframe enrichment times out', async () => {
			const controller = new AbortController();
			const parsed = {
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers', 'top_losers'],
				limit: 3,
				includeMultiTimeframe: true,
			};
			const item = { symbol: 'BINANCE:BTCUSDT', changePercent: 3.5 };
			tradingViewMcpService.callScanTool
				.mockResolvedValueOnce([item])
				.mockResolvedValueOnce([]);
			tradingViewMcpService.callMultiTimeframeAnalysis.mockImplementationOnce(async () => {
				const error = new Error('AbortError');
				error.name = 'AbortError';
				controller.abort(new Error('Market scanner timeout after 1ms'));
				throw error;
			});

			const results = await runScans(parsed, { signal: controller.signal });

			expect(results[0]).toEqual({
				scan: 'top_gainers',
				status: 'success',
				items: [item],
			});
			expect(results[1]).toEqual(expect.objectContaining({
				scan: 'top_losers',
				status: 'timeout',
			}));
		});

		it('cleans up abort listeners across multi-scan execution with multi-timeframe confluence', async () => {
			const controller = new AbortController();
			const parsed = {
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers', 'top_losers', 'volume_breakout_scanner'],
				limit: 3,
				includeMultiTimeframe: true,
			};
			tradingViewMcpService.callScanTool
				.mockResolvedValueOnce([{ symbol: 'BINANCE:BTCUSDT', changePercent: 3.5 }])
				.mockResolvedValueOnce([{ symbol: 'BINANCE:ETHUSDT', changePercent: -2.1 }])
				.mockResolvedValueOnce([{ symbol: 'BINANCE:SOLUSDT', volume_ratio: 2.0 }]);
			tradingViewMcpService.callMultiTimeframeAnalysis.mockResolvedValue({
				alignment: { status: 'bullish', confidence: 80 },
			});

			const results = await runScans(parsed, { signal: controller.signal });

			expect(results).toHaveLength(3);
			expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
		});
	});
});

