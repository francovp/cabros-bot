const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		analyzeSymbolIdentifier: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
	},
}));

describe('Symbol analysis endpoint', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '1D',
		};
		jest.clearAllMocks();
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns one-symbol markdown and decision-ready structured analysis without delivery', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: {
					current_price: 100,
					change_percent: -1.2,
					high: 105,
					low: 95,
					volume: 1000,
				},
				technical_indicators: {
					rsi: 77.9,
					sma20: 90,
					macd: 2,
					macd_signal: 1,
					atr: 4,
				},
				bollinger_bands: {
					upper: 110,
					lower: 80,
					position: 'WITHIN',
				},
			},
			volume_analysis: {
				current_volume: 1000,
				average_volume: 900,
				volume_ratio: 1.11,
				volume_strength: 'NORMAL',
			},
			confluence: {
				recommendation: 'SELL',
				confidence: 'HIGH',
				signals_agree: true,
			},
			sentiment: {
				sentiment_label: 'Neutral',
				sentiment_score: 0,
				posts_analyzed: 0,
			},
			signals: [{ name: 'RSI', direction: 'bearish', reason: 'overbought' }],
			overall_assessment: { bullish_signals: 0, bearish_signals: 1, warning_signals: 1 },
		});
		tradingViewMcpService.callMultiTimeframeAnalysis.mockResolvedValueOnce({
			timeframes: { '1D': { bias: 'bearish', rsi: 77.9 } },
			alignment: { status: 'ALIGNED', confidence: 'HIGH' },
			recommendation: { action: 'SELL' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'binance:btcusdt',
				timeframe: '1D',
				analysisMode: 'combined',
				includeMultiTimeframe: true,
			})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			symbol: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			asset: 'BTCUSDT',
			timeframe: '1D',
			alertText: expect.stringContaining('BTCUSDT'),
			analysis: expect.objectContaining({
				price_data: expect.objectContaining({ close: 100, change_percent: -1.2 }),
				volume_analysis: expect.objectContaining({ volume_ratio: 1.11 }),
				technical_indicators: expect.objectContaining({ RSI: 77.9, ATR: 4 }),
				signals: [{ name: 'RSI', direction: 'bearish', reason: 'overbought' }],
				overall_assessment: { bullish_signals: 0, bearish_signals: 1, warning_signals: 1 },
				risk: expect.objectContaining({
					side: 'SELL',
					stop_loss: 106,
					target: 88,
					invalidation_level: 106,
					risk_reward_ratio: 2,
					valid: true,
				}),
				decision: expect.objectContaining({ action: 'SELL', dataSufficient: true }),
				multi_timeframe: expect.objectContaining({ alignment: expect.any(Object) }),
			}),
		}));
		expect(res.body).not.toHaveProperty('deliveryResults');
		expect(tradingViewMcpService.analyzeSymbolIdentifier).toHaveBeenCalledWith(expect.objectContaining({
			raw: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			timeframe: '1D',
			analysisMode: 'combined',
		}));
		expect(tradingViewMcpService.callMultiTimeframeAnalysis).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
		}));
	});

	it('rejects malformed symbols before calling TradingView MCP', async () => {
		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BTCUSDT' })
			.expect(400);

		expect(res.body).toEqual(expect.objectContaining({ code: 'INVALID_REQUEST' }));
		expect(tradingViewMcpService.analyzeSymbolIdentifier).not.toHaveBeenCalled();
	});

	it('returns a bounded upstream failure without delivery', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockRejectedValueOnce(new Error('TradingView MCP unavailable'));

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(502);

		expect(res.body).toEqual(expect.objectContaining({
			success: false,
			code: 'SYMBOL_ANALYSIS_FAILED',
		}));
	});

	it('returns 504 when the TradingView call exceeds the endpoint deadline', async () => {
		process.env.EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS = '10';
		tradingViewMcpService.analyzeSymbolIdentifier.mockImplementationOnce(({ signal }) => new Promise((resolve, reject) => {
			signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
		}));

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(504);

		expect(res.body).toEqual(expect.objectContaining({
			success: false,
			code: 'SYMBOL_ANALYSIS_TIMEOUT',
		}));
	});
});
