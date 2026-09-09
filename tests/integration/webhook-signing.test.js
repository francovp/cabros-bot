/* global jest, describe, it, beforeEach, afterEach, expect */

const crypto = require('crypto');
const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callVolumeConfirmation: jest.fn(),
	},
}));

function sign(secret, timestamp, path, body) {
	return `sha256=${crypto.createHmac('sha256', secret)
		.update(`${timestamp}\nPOST\n${path}\n${body}`)
		.digest('hex')}`;
}

describe('webhook request signing', () => {
	let savedEnv;
	const secret = 'integration-signing-secret';

	beforeEach(() => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			NODE_ENV: 'test',
			WEBHOOK_API_KEY: 'test-key',
			WEBHOOK_SIGNING_SECRET: secret,
			WEBHOOK_SIGNING_TOLERANCE_MS: '300000',
		});
		tradingViewMcpService.callVolumeConfirmation.mockResolvedValue({
			volume_analysis: { volume_ratio: 1.5 },
		});
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		jest.clearAllMocks();
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('accepts a valid signature and reaches the webhook handler', async () => {
		const path = '/api/webhook/volume-confirmation?source=test';
		const body = JSON.stringify({ symbol: 'BINANCE:BTCUSDT', timeframe: '1h' });
		const timestamp = String(Date.now());

		const res = await request(app)
			.post(path)
			.set('content-type', 'application/json')
			.set('x-api-key', 'test-key')
			.set('x-webhook-timestamp', timestamp)
			.set('x-webhook-signature', sign(secret, timestamp, path, body))
			.send(body)
			.expect(200);

		expect(res.body).toEqual(expect.objectContaining({ success: true, decision: 'confirm' }));
		expect(tradingViewMcpService.callVolumeConfirmation).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1h',
		});
	});

	it('rejects an unsigned webhook before invoking its handler', async () => {
		const res = await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(401);

		expect(res.body.code).toBe('WEBHOOK_SIGNATURE_MISSING');
		expect(tradingViewMcpService.callVolumeConfirmation).not.toHaveBeenCalled();
	});

	it('preserves API-key-only fallback when signing is disabled', async () => {
		delete process.env.WEBHOOK_SIGNING_SECRET;

		await request(app)
			.post('/api/webhook/volume-confirmation')
			.set('x-api-key', 'test-key')
			.send({ symbol: 'BINANCE:BTCUSDT' })
			.expect(200);

		expect(tradingViewMcpService.callVolumeConfirmation).toHaveBeenCalledTimes(1);
	});
});
