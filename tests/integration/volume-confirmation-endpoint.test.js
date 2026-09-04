const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callVolumeConfirmation: jest.fn(),
		callMultiTimeframeAnalysis: jest.fn(),
	},
}));

describe('Volume confirmation endpoint', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '4h',
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

	it('returns structured volume confirmation data for a valid TradingView symbol', async () => {
		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			symbol: 'BINANCE:BTCUSDT',
			volume_analysis: {
				volume_ratio: 1.7,
				volume_strength: 'HIGH',
			},
			confidence: 0.91,
		});

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			symbol: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			asset: 'BTCUSDT',
			timeframe: '4h',
			confirmed: true,
			decision: 'confirm',
			volumeRatio: 1.7,
			analysis: expect.objectContaining({
				symbol: 'BINANCE:BTCUSDT',
				confidence: 0.91,
			}),
		}));
		expect(tradingViewMcpService.callVolumeConfirmation).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		});
	});

	it('returns 400 for invalid symbol identifiers', async () => {
		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BTCUSDT' })
			.expect(400);

		expect(res.body).toEqual(expect.objectContaining({
			code: 'INVALID_REQUEST',
		}));
		expect(res.body.error).toContain('EXCHANGE:SYMBOL');
		expect(tradingViewMcpService.callVolumeConfirmation).not.toHaveBeenCalled();
	});

	it('returns 502 when TradingView MCP volume confirmation fails', async () => {
		tradingViewMcpService.callVolumeConfirmation.mockRejectedValueOnce(new Error('MCP unavailable'));

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT', timeframe: '1D' })
			.expect(502);

		expect(res.body).toEqual(expect.objectContaining({
			success: false,
			code: 'VOLUME_CONFIRMATION_FAILED',
			error: 'MCP unavailable',
		}));
	});

	it('normalizes lowercase symbols and denies low-volume confirmations', async () => {
		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			volume_analysis: { volume_ratio: 0.95 },
		});

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'binance:btcusdt', timeframe: '240' })
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			symbol: 'BINANCE:BTCUSDT',
			timeframe: '4h',
			confirmed: false,
			decision: 'deny',
			volumeRatio: 0.95,
		}));
	});

	it('returns an unknown decision when volume ratio is missing', async () => {
		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			volume_analysis: {},
		});

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'NYSE:F' })
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			symbol: 'NYSE:F',
			confirmed: null,
			decision: 'unknown',
			volumeRatio: null,
		}));
	});

	it('includes multiTimeframeAnalysis and htfAlignment when enabled and feature flag is on', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME = 'true';

		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			symbol: 'BINANCE:BTCUSDT',
			volume_analysis: {
				volume_ratio: 1.8,
				volume_strength: 'HIGH',
			},
			confidence: 0.95,
		});
		tradingViewMcpService.callMultiTimeframeAnalysis.mockResolvedValueOnce({
			alignment: { status: 'ALIGNED', confidence: 0.9 },
			recommendation: { action: 'BUY' },
		});

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BINANCE:BTCUSDT',
				includeMultiTimeframe: true,
			})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			symbol: 'BINANCE:BTCUSDT',
			confirmed: true,
			decision: 'confirm',
			volumeRatio: 1.8,
			htfAlignment: 'aligned',
			multiTimeframeAnalysis: expect.objectContaining({
				alignment: { status: 'ALIGNED', confidence: 0.9 },
			}),
			volumeConfirmation: expect.objectContaining({
				confirmed: true,
				decision: 'confirm',
				volumeRatio: 1.8,
			}),
		}));

		expect(tradingViewMcpService.callMultiTimeframeAnalysis).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
		});
	});

	it('evaluates htfAlignment as counter-trend when direction opposes HTF trend', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME = 'true';

		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			symbol: 'BINANCE:BTCUSDT',
			volume_analysis: { volume_ratio: 1.5 },
		});
		tradingViewMcpService.callMultiTimeframeAnalysis.mockResolvedValueOnce({
			direction: 'bullish',
			confidence: 0.85,
		});

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BINANCE:BTCUSDT',
				includeMultiTimeframe: true,
				side: 'SELL',
			})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			htfAlignment: 'counter-trend',
		}));
	});

	it('fails open when multi-timeframe analysis throws an error', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME = 'true';

		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			symbol: 'BINANCE:BTCUSDT',
			volume_analysis: { volume_ratio: 1.6 },
		});
		tradingViewMcpService.callMultiTimeframeAnalysis.mockRejectedValueOnce(
			new Error('MCP multi-timeframe timeout'),
		);

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BINANCE:BTCUSDT',
				includeMultiTimeframe: true,
			})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			symbol: 'BINANCE:BTCUSDT',
			confirmed: true,
			decision: 'confirm',
			volumeRatio: 1.6,
			multiTimeframeAnalysis: null,
			htfAlignment: 'unknown',
		}));
	});

	it('does not invoke multi-timeframe analysis when feature flag is disabled', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME = 'false';

		tradingViewMcpService.callVolumeConfirmation.mockResolvedValueOnce({
			symbol: 'BINANCE:BTCUSDT',
			volume_analysis: { volume_ratio: 1.5 },
		});

		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BINANCE:BTCUSDT',
				includeMultiTimeframe: true,
			})
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({
			success: true,
			symbol: 'BINANCE:BTCUSDT',
			confirmed: true,
			decision: 'confirm',
		}));
		expect(res.body.multiTimeframeAnalysis).toBeUndefined();
		expect(res.body.htfAlignment).toBeUndefined();
		expect(tradingViewMcpService.callMultiTimeframeAnalysis).not.toHaveBeenCalled();
	});

	it('returns 400 when includeMultiTimeframe is not a boolean', async () => {
		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({
				symbol: 'BINANCE:BTCUSDT',
				includeMultiTimeframe: 'not-a-bool',
			})
			.expect(400);

		expect(res.body).toEqual(expect.objectContaining({
			code: 'INVALID_REQUEST',
			error: 'includeMultiTimeframe must be a boolean',
		}));
		expect(tradingViewMcpService.callVolumeConfirmation).not.toHaveBeenCalled();
		expect(tradingViewMcpService.callMultiTimeframeAnalysis).not.toHaveBeenCalled();
	});
});
