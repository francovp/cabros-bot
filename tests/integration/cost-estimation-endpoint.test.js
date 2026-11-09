'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');

describe('Cost estimation endpoints (Issue #745)', () => {
	const originalEnv = process.env;
	let mockBot;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			ENABLE_NEWS_MONITOR: 'true',
			ENABLE_MARKET_SCANNER: 'true',
			WEBHOOK_API_KEY: 'test-key',
			BOT_TOKEN: 'test-token',
			TELEGRAM_CHAT_ID: '123456789',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT',
		};
		delete process.env.LLM_COST_RATES_JSON;
		mockBot = { telegram: { sendMessage: jest.fn().mockResolvedValue({ message_id: '1' }) } };
		jest.spyOn(app, 'use');
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	function mount() {
		const express = require('express');
		const testApp = express();
		testApp.use(express.json());
		testApp.use('/api', getRoutes(() => mockBot));
		return testApp;
	}

	it('POST /api/operations/estimate returns costEstimate with zero billable shape', async () => {
		const res = await request(mount())
			.post('/api/operations/estimate')
			.set('x-api-key', 'test-key')
			.send({ operation: 'news-monitor', crypto: ['BTCUSDT', 'ETHUSDT'] });
		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.costEstimate.operation).toBe('news-monitor');
		expect(res.body.costEstimate.noBillableCalls).toBe(true);
		expect(res.body.costEstimate.tokensIn).toBeGreaterThan(0);
		expect(res.body.costEstimate.estimatedCostUsd).toBeGreaterThan(0);
	});

	it('POST /api/operations/estimate rejects missing/invalid operation', async () => {
		const missing = await request(mount())
			.post('/api/operations/estimate')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] });
		expect(missing.status).toBe(400);

		const invalid = await request(mount())
			.post('/api/operations/estimate')
			.set('x-api-key', 'test-key')
			.send({ operation: 'nope' });
		expect(invalid.status).toBe(400);
	});

	it('dryRun=cost on /api/news-monitor returns costEstimate without analysis', async () => {
		const res = await request(mount())
			.post('/api/news-monitor?dryRun=cost')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] });
		expect(res.status).toBe(200);
		expect(res.body.dryRun).toBe('cost');
		expect(res.body.costEstimate.operation).toBe('news-monitor');
		expect(res.body.results).toEqual([]);
	});

	it('dryRun=cost on /api/webhook/expanded-analysis-alert returns unknown MCP cost', async () => {
		const res = await request(mount())
			.post('/api/webhook/expanded-analysis-alert')
			.set('x-api-key', 'test-key')
			.send({ symbols: ['BINANCE:BTCUSDT'], dryRun: 'cost' });
		expect(res.status).toBe(200);
		expect(res.body.costEstimate.operation).toBe('expanded-analysis-alert');
		expect(res.body.costEstimate.externalCosts[0].status).toBe('unknown');
	});

	it('dryRun=cost on /api/webhook/market-scanner-alert returns costEstimate', async () => {
		const res = await request(mount())
			.post('/api/webhook/market-scanner-alert')
			.set('x-api-key', 'test-key')
			.send({ scans: ['top_gainers'], dryRun: 'cost' });
		expect(res.status).toBe(200);
		expect(res.body.costEstimate.operation).toBe('market-scanner-alert');
	});

	it('dryRun=cost on /api/jobs/tradingview-analysis does not create a job', async () => {
		const res = await request(mount())
			.post('/api/jobs/tradingview-analysis?dryRun=cost')
			.set('x-api-key', 'test-key')
			.send({ type: 'expanded-analysis', symbols: ['BINANCE:BTCUSDT'] });
		expect(res.status).toBe(200);
		expect(res.body.dryRun).toBe('cost');
		expect(res.body.jobId).toBeUndefined();
		expect(res.body.costEstimate.operation).toBe('expanded-analysis-alert');
	});

	it('dryRun=cost on /api/jobs/tradingview-analysis resolves default symbols when omitted', async () => {
		process.env.EXPANDED_ANALYSIS_ALERT_SYMBOLS = 'BINANCE:BTCUSDT,BINANCE:ETHUSDT';
		const res = await request(mount())
			.post('/api/jobs/tradingview-analysis?dryRun=cost')
			.set('x-api-key', 'test-key')
			.send({ type: 'expanded-analysis' });
		expect(res.status).toBe(200);
		expect(res.body.dryRun).toBe('cost');
		expect(res.body.costEstimate.operation).toBe('expanded-analysis-alert');
		expect(res.body.costEstimate.perSymbol.length).toBe(2);
		expect(res.body.costEstimate.perSymbol.map((p) => p.symbol)).toEqual(
			expect.arrayContaining(['BINANCE:BTCUSDT', 'BINANCE:ETHUSDT']),
		);
	});

		it('dryRun=cost returns 404 FEATURE_DISABLED when cost estimation is disabled', async () => {
		process.env.ENABLE_DRY_RUN_COST = 'false';
		const res = await request(mount())
			.post('/api/news-monitor?dryRun=cost')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] });
		expect(res.status).toBe(404);
		expect(res.body.code).toBe('FEATURE_DISABLED');
	});

	it('unrecognised dryRun typo returns 400 instead of executing live', async () => {
		const res = await request(mount())
			.post('/api/news-monitor?dryRun=costt')
			.set('x-api-key', 'test-key')
			.send({ crypto: ['BTCUSDT'] });
		expect(res.status).toBe(400);
		expect(res.body.code).toBe('INVALID_REQUEST');
	});

	it('operations/estimate requires API key', async () => {
		const res = await request(mount())
			.post('/api/operations/estimate')
			.send({ operation: 'news-monitor' });
		expect([400, 401]).toContain(res.status);
	});
});
