const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callVolumeConfirmation: jest.fn(),
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
});
