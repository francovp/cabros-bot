const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const sentryService = require('../../src/services/monitoring/SentryService');

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
		jest.spyOn(sentryService, 'captureRuntimeError').mockImplementation(() => {});
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
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
					target: 80,
					invalidation_level: 106,
					risk_reward_ratio: 3.3333333333333335,
					valid: true,
				}),
				decision: expect.objectContaining({ action: 'SELL', dataSufficient: true }),
				multi_timeframe: expect.objectContaining({ alignment: expect.any(Object) }),
			}),
		}));
		expect(res.body).not.toHaveProperty('deliveryResults');
		expect(res.body.alertText).toContain('*Target sugerido:*');
		expect(res.body.alertText).toContain('*Risk/Reward:*');
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
		expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
			http: expect.objectContaining({ endpoint: '/api/webhook/symbol-analysis', statusCode: 502 }),
		}));
	});

	it('preserves missing numeric values and supports ATR from volatility data', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: null, high: null, low: null },
				technical_indicators: { rsi: null },
				volatility: { atr: 4 },
			},
			confluence: { recommendation: 'BUY', confidence: 'LOW' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis.price_data).toEqual(expect.objectContaining({ close: null, high: null, low: null }));
		expect(res.body.analysis.technical_indicators).toEqual(expect.objectContaining({ RSI: null, ATR: 4 }));
		expect(res.body.analysis.risk).toEqual(expect.objectContaining({ valid: false, entry_price: null }));
		expect(res.body.analysis.decision).toEqual(expect.objectContaining({ action: 'NO_TRADE', dataSufficient: false }));

		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 100 },
				technical_indicators: { rsi: 50 },
				volatility: { atr: 4 },
			},
			confluence: { recommendation: 'BUY', confidence: 'HIGH' },
		});

		const atrRes = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(atrRes.body.analysis.risk).toEqual(expect.objectContaining({ stop_loss: 94, target: 112, valid: true }));
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
		expect(sentryService.captureRuntimeError).toHaveBeenCalledWith(expect.objectContaining({
			http: expect.objectContaining({ endpoint: '/api/webhook/symbol-analysis', statusCode: 504 }),
		}));
	});

	it('rejects nonpositive directional risk levels', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 1 },
				technical_indicators: { rsi: 50, atr: 2 },
			},
			confluence: { recommendation: 'BUY', confidence: 'HIGH' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis.risk).toEqual(expect.objectContaining({ valid: false }));
		expect(res.body.analysis.decision).toEqual(expect.objectContaining({ action: 'NO_TRADE', dataSufficient: false }));
	});

	it('does not return an actionable decision when RSI is missing', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 100 },
				technical_indicators: { atr: 4 },
			},
			confluence: { recommendation: 'BUY', confidence: 'HIGH' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis.decision).toEqual(expect.objectContaining({
			action: 'NO_TRADE',
			dataSufficient: false,
		}));
		expect(res.body.analysis.decision.warnings).toContain('Falta el RSI para una decisión accionable.');
	});

	it('keeps structured targets aligned with the displayed nearest resistance', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 100 },
				technical_indicators: { rsi: 50, atr: 4 },
				support_resistance: { nearest_resistance: 105 },
			},
			confluence: { recommendation: 'BUY', confidence: 'HIGH' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis.risk).toEqual(expect.objectContaining({ target: 105, valid: true }));
		expect(res.body.alertText).toContain('- *Target sugerido:* $105.00');
	});

	it('uses current_price as the structured risk entry when close differs', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 100, close: 90 },
				technical_indicators: { rsi: 50, atr: 4 },
			},
			confluence: { recommendation: 'BUY', confidence: 'HIGH' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis.price_data).toEqual(expect.objectContaining({ close: 90, current_price: 100 }));
		expect(res.body.analysis.risk).toEqual(expect.objectContaining({
			entry_price: 100,
			stop_loss: 94,
			target: 112,
		}));
		expect(res.body.alertText).toContain('BTCUSDT $100.00');
	});

	it('does not invent BUY report levels for inconclusive analysis', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 100 },
				technical_indicators: { rsi: 50, atr: 4 },
			},
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis).toEqual(expect.objectContaining({
			risk: expect.objectContaining({ side: null, stop_loss: null, target: null, valid: false }),
			decision: expect.objectContaining({ action: 'NO_TRADE' }),
		}));
		expect(res.body.alertText).not.toContain('Stop Loss sugerido');
		expect(res.body.alertText).not.toContain('Target sugerido');
		expect(res.body.alertText).not.toContain('Risk/Reward');
	});

	it('formats uppercase indicator aliases consistently with structured analysis', async () => {
		tradingViewMcpService.analyzeSymbolIdentifier.mockResolvedValueOnce({
			technical: {
				price_data: { current_price: 100 },
				technical_indicators: { RSI: 50, ATR: 4 },
			},
			confluence: { recommendation: 'BUY', confidence: 'HIGH' },
		});

		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body.analysis.decision).toEqual(expect.objectContaining({ action: 'BUY', dataSufficient: true }));
		expect(res.body.alertText).toContain('RSI 50.0');
		expect(res.body.alertText).toContain('*ATR:* $4.00');
		expect(res.body.alertText).toContain('- *Target sugerido:* $112.00');
	});

	it('short-circuits to a dryRun response without calling TradingView MCP when dryRun query is set', async () => {
		const res = await request(app)
			.post('/api/webhook/symbol-analysis?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BINANCE:BTCUSDT',
				timeframe: '1D',
				analysisMode: 'combined',
				includeMultiTimeframe: true,
			})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			dryRun: true,
			symbol: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			asset: 'BTCUSDT',
			timeframe: '1D',
			analysisMode: 'combined',
			includeMultiTimeframe: true,
			side: null,
			analysis: null,
			analysisStatus: 'dry-run',
		}));
		expect(res.body).not.toHaveProperty('alertText');
		expect(tradingViewMcpService.analyzeSymbolIdentifier).not.toHaveBeenCalled();
		expect(tradingViewMcpService.callMultiTimeframeAnalysis).not.toHaveBeenCalled();
	});

	it('short-circuits to a dryRun response when dryRun body field is true', async () => {
		const res = await request(app)
			.post('/api/webhook/symbol-analysis')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT', dryRun: true })
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			dryRun: true,
			analysisStatus: 'dry-run',
			analysis: null,
		}));
		expect(tradingViewMcpService.analyzeSymbolIdentifier).not.toHaveBeenCalled();
	});

	it('still rejects malformed symbols on the dryRun path before any MCP call', async () => {
		const res = await request(app)
			.post('/api/webhook/symbol-analysis?dryRun=true')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BTCUSDT' })
			.expect(400);

		expect(res.body).toEqual(expect.objectContaining({ code: 'INVALID_REQUEST' }));
		expect(tradingViewMcpService.analyzeSymbolIdentifier).not.toHaveBeenCalled();
	});
});
