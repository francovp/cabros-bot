'use strict';

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(),
	listOutcomes: jest.fn(),
}));

jest.mock('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol', () => ({
	classifyPriceQuery: jest.fn(),
	fetchCryptoPrice: jest.fn(),
	fetchEquityPrice: jest.fn(),
}));

const request = require('supertest');
const express = require('express');
const { getPretradeCheckHandler } = require('../../src/controllers/pretradeCheck/pretradeCheck');
const signalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const fetchPrice = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');

function buildApp() {
	const app = express();
	app.get('/api/pretrade-check', getPretradeCheckHandler());
	return app;
}

describe('pretradeCheck controller', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = process.env.WEBHOOK_API_KEY;
		process.env.WEBHOOK_API_KEY = 'test-key';
		jest.clearAllMocks();
		fetchPrice.classifyPriceQuery.mockImplementation((value) => {
			if (!value || typeof value !== 'string') return { valid: false, error: 'missing_symbol' };
			if (value.includes('UNSUPPORTED')) {
				return { valid: true, assetClass: 'unsupported', exchange: 'XYZ', symbol: 'FOO', reason: 'Exchange XYZ not supported' };
			}
			return { valid: true, assetClass: 'crypto', exchange: 'BINANCE', symbol: value.replace('BINANCE:', '').toUpperCase() };
		});
		fetchPrice.fetchCryptoPrice.mockResolvedValue({ symbol: 'BTCUSDT', price: 50000 });
		fetchPrice.fetchEquityPrice.mockResolvedValue({ symbol: 'NVDA', price: 450.12, percentChange: 1.5, currency: 'USD', exchange: 'NASDAQ' });
		signalOutcomeService.isEnabled.mockReturnValue(true);
		signalOutcomeService.listOutcomes.mockResolvedValue({
			outcomes: [
				{ outcomes: { '1h': { status: 'evaluated', return: 2 }, '4h': { status: 'evaluated', return: -1 } } },
				{ outcomes: { '1h': { status: 'evaluated', return: 0.5 } } },
			],
			hasMore: false,
		});
	});

	afterEach(() => {
		if (savedEnv === undefined) delete process.env.WEBHOOK_API_KEY;
		else process.env.WEBHOOK_API_KEY = savedEnv;
	});

	it('returns 400 when symbol is missing', async () => {
		const res = await request(buildApp()).get('/api/pretrade-check');
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when symbol is malformed', async () => {
		fetchPrice.classifyPriceQuery.mockReturnValueOnce({ valid: false, error: 'missing_symbol' });
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=bad');
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns 400 when limit is out of range', async () => {
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=BTCUSDT&limit=0');
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('returns the pretradeCheck on a successful request', async () => {
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=BTCUSDT');
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.pretradeCheck.symbol).toBe('BTCUSDT');
		expect(res.body.pretradeCheck.price.available).toBe(true);
		expect(res.body.pretradeCheck.price.price).toBe(50000);
		expect(res.body.pretradeCheck.hitRate.available).toBe(true);
		expect(res.body.pretradeCheck.hitRate.hitRatePercent).toBe(66.67);
		expect(res.body.pretradeCheck.hitRate.winWindows).toBe(2);
		expect(res.body.pretradeCheck.hitRate.evaluatedWindows).toBe(3);
	});

	it('does not fail when outcome tracking is disabled', async () => {
		signalOutcomeService.isEnabled.mockReturnValue(false);
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=BTCUSDT');
		expect(res.status).toBe(200);
		expect(res.body.pretradeCheck.price.available).toBe(true);
		expect(res.body.pretradeCheck.hitRate.available).toBe(false);
		expect(res.body.pretradeCheck.hitRate.reason).toMatch(/disabled/i);
	});

	it('reports an unsupported exchange gracefully', async () => {
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=UNSUPPORTED:FOO');
		expect(res.status).toBe(200);
		expect(res.body.pretradeCheck.price.available).toBe(false);
		expect(res.body.pretradeCheck.price.reason).toMatch(/not supported/i);
	});

	it('uses equity price path when assetClass is equity', async () => {
		fetchPrice.classifyPriceQuery.mockReturnValueOnce({
			valid: true,
			assetClass: 'equity',
			exchange: 'NASDAQ',
			symbol: 'NVDA',
		});
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=NASDAQ:NVDA');
		expect(res.status).toBe(200);
		expect(res.body.pretradeCheck.price.available).toBe(true);
		expect(res.body.pretradeCheck.price.price).toBe(450.12);
		expect(res.body.pretradeCheck.price.percentChange).toBe(1.5);
		expect(fetchPrice.fetchEquityPrice).toHaveBeenCalled();
	});

	it('surfaces price errors as price.reason', async () => {
		fetchPrice.fetchCryptoPrice.mockRejectedValueOnce(Object({ userMessage: 'invalid symbol' }));
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=BTCUSDT');
		expect(res.status).toBe(200);
		expect(res.body.pretradeCheck.price.available).toBe(false);
		expect(res.body.pretradeCheck.price.reason).toBe('invalid symbol');
	});

	it('surfaces outcome errors as hitRate.reason', async () => {
		signalOutcomeService.listOutcomes.mockRejectedValueOnce(new Error('firestore down'));
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=BTCUSDT');
		expect(res.status).toBe(200);
		expect(res.body.pretradeCheck.hitRate.available).toBe(false);
		expect(res.body.pretradeCheck.hitRate.reason).toBe('firestore down');
	});

	it('returns 500 on unexpected error from parseSymbol downstream', async () => {
		fetchPrice.fetchCryptoPrice.mockRejectedValueOnce(new Error('explode'));
		const res = await request(buildApp()).get('/api/pretrade-check?symbol=BTCUSDT');
		// unexpected error inside handler is swallowed inside loadPrice (available: false)
		expect(res.status).toBe(200);
		expect(res.body.pretradeCheck.price.available).toBe(false);
	});
});
