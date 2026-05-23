const { postMarketScannerAlert, runScans } = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { getNotificationManager, initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
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

			tradingViewMcpService.callScanTool.mockImplementation(
				(scanType, args, options) => new Promise((resolve, reject) => {
					const timeoutId = setTimeout(() => {
						resolve([]);
					}, 100);
					if (options && options.signal) {
						options.signal.addEventListener('abort', () => {
							clearTimeout(timeoutId);
							reject(new Error('AbortError'));
						});
					}
				})
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
	});
});
