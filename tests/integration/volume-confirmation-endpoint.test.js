const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { idempotencyService } = require('../../src/services/storage/IdempotencyService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callVolumeConfirmation: jest.fn(),
	},
}));

describe('Volume confirmation endpoint', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		idempotencyService.clear();
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
		expect(res.body.processingTimeMs).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(res.body.processingTimeMs)).toBe(true);
		expect(res.body).not.toHaveProperty('totalDurationMs');
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
		expect(res.body.processingTimeMs).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(res.body.processingTimeMs)).toBe(true);
		expect(res.body).not.toHaveProperty('totalDurationMs');
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
		expect(res.body.processingTimeMs).toBeGreaterThanOrEqual(0);
		expect(Number.isInteger(res.body.processingTimeMs)).toBe(true);
		expect(res.body).not.toHaveProperty('totalDurationMs');
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

	describe('Idempotency handling', () => {
		it('replays cached volume confirmation response on identical request with Idempotency-Key without re-calling MCP service', async () => {
			tradingViewMcpService.callVolumeConfirmation.mockResolvedValue({
				symbol: 'BINANCE:BTCUSDT',
				volume_analysis: {
					volume_ratio: 1.7,
					volume_strength: 'HIGH',
				},
				confidence: 0.91,
			});

			const payload = { symbol: 'BINANCE:BTCUSDT', timeframe: '4h' };

			const first = await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.set('idempotency-key', 'vol-key-1')
				.send(payload)
				.expect(200);

			expect(first.headers['idempotency-replay']).toBe('false');
			expect(first.body.success).toBe(true);
			expect(tradingViewMcpService.callVolumeConfirmation).toHaveBeenCalledTimes(1);

			const second = await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.set('idempotency-key', 'vol-key-1')
				.send(payload)
				.expect(200);

			expect(second.headers['idempotency-replay']).toBe('true');
			expect(second.body).toEqual({
				...first.body,
				idempotencyReplayed: true,
			});
			expect(tradingViewMcpService.callVolumeConfirmation).toHaveBeenCalledTimes(1);
		});

		it('returns 409 IDEMPOTENCY_CONFLICT when Idempotency-Key is reused with a different payload', async () => {
			tradingViewMcpService.callVolumeConfirmation.mockResolvedValue({
				symbol: 'BINANCE:BTCUSDT',
				volume_analysis: {
					volume_ratio: 1.7,
					volume_strength: 'HIGH',
				},
				confidence: 0.91,
			});

			await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.set('idempotency-key', 'vol-key-conflict')
				.send({ symbol: 'BINANCE:BTCUSDT', timeframe: '4h' })
				.expect(200);

			const conflictRes = await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.set('idempotency-key', 'vol-key-conflict')
				.send({ symbol: 'BINANCE:ETHUSDT', timeframe: '4h' })
				.expect(409);

			expect(conflictRes.body).toEqual({
				error: 'Idempotency key was reused with a different payload',
				code: 'IDEMPOTENCY_CONFLICT',
			});
		});

		it('returns 400 INVALID_REQUEST when Idempotency-Key is invalid', async () => {
			const res = await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.set('idempotency-key', '   ')
				.send({ symbol: 'BINANCE:BTCUSDT' })
				.expect(400);

			expect(res.body).toEqual({
				error: 'Idempotency key must be a non-empty string',
				code: 'INVALID_REQUEST',
			});
			expect(tradingViewMcpService.callVolumeConfirmation).not.toHaveBeenCalled();
		});

		it('executes MCP service on every request when no Idempotency-Key is provided', async () => {
			tradingViewMcpService.callVolumeConfirmation.mockResolvedValue({
				symbol: 'BINANCE:BTCUSDT',
				volume_analysis: {
					volume_ratio: 1.5,
					volume_strength: 'NORMAL',
				},
				confidence: 0.8,
			});

			await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BINANCE:BTCUSDT' })
				.expect(200);

			await request(app)
				.post('/api/webhook/volume-confirmation')
				.set('x-api-key', 'test-key')
				.send({ symbol: 'BINANCE:BTCUSDT' })
				.expect(200);

			expect(tradingViewMcpService.callVolumeConfirmation).toHaveBeenCalledTimes(2);
		});
	});
});
