'use strict';

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		callScanTool: jest.fn(),
	},
}));

const admin = require('firebase-admin');
const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { _resetForTesting: resetScannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');

describe('Scanner presets API integration tests', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
			ENABLE_MARKET_SCANNER: 'true',
			ENABLE_NEWS_MONITOR: 'false',
			MARKET_SCANNER_TIMEOUT_MS: '1000',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '4h',
		};

		jest.clearAllMocks();
		admin.__resetCollectionState();
		resetScannerPresetService();
		app.use('/api', getRoutes(null));
	});

	afterEach(() => {
		process.env = originalEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('creates, updates, lists, retrieves, and deletes saved presets', async () => {
		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Momentum preset',
				exchange: 'binance',
				timeframe: '1h',
				scans: ['top_gainers'],
				limit: 3,
				bbwThreshold: 0.08,
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		expect(createResponse.body).toEqual(expect.objectContaining({
			success: true,
			preset: expect.objectContaining({
				id: presetId,
				name: 'Momentum preset',
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers'],
				limit: 3,
				bbwThreshold: 0.08,
			}),
		}));

		const listResponse = await request(app)
			.get('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(listResponse.body.presets).toHaveLength(1);
		expect(listResponse.body.presets[0]).toEqual(expect.objectContaining({
			id: presetId,
			name: 'Momentum preset',
		}));

		const updateResponse = await request(app)
			.put(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.send({ limit: 7 })
			.expect(200);

		expect(updateResponse.body.preset).toEqual(expect.objectContaining({
			id: presetId,
			limit: 7,
		}));

		const getResponse = await request(app)
			.get(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(getResponse.body.preset).toEqual(expect.objectContaining({
			id: presetId,
			limit: 7,
		}));

		await request(app)
			.delete(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(200);

		await request(app)
			.get(`/api/scanner-presets/${presetId}`)
			.set('x-api-key', 'test-key')
			.expect(404);
	});

	it('runs a saved preset in dry-run mode with the market scanner report', async () => {
		tradingViewMcpService.callScanTool.mockResolvedValueOnce([
			{
				symbol: 'BINANCE:GMTUSDT',
				changePercent: 26.415,
				indicators: { close: 0.0134, RSI: 79.72 },
			},
		]);

		const createResponse = await request(app)
			.post('/api/scanner-presets')
			.set('x-api-key', 'test-key')
			.send({
				name: 'Dry run preset',
				exchange: 'binance',
				timeframe: '4h',
				scans: ['top_gainers'],
			})
			.expect(201);

		const presetId = createResponse.body.preset.id;

		const runResponse = await request(app)
			.post(`/api/scanner-presets/${presetId}/run?dryRun=true`)
			.set('x-api-key', 'test-key')
			.expect(200);

		expect(runResponse.body).toEqual(expect.objectContaining({
			success: true,
			dryRun: true,
			presetId,
			summary: expect.objectContaining({
				totalScans: 1,
				success: 1,
				error: 0,
				timeout: 0,
				totalItems: 1,
				delivered: 0,
			}),
		}));
		expect(runResponse.body.payload.alertText).toContain('SCANNER DE MERCADO');
		expect(runResponse.body.payload.alertText).toContain('GMTUSDT');
		expect(tradingViewMcpService.callScanTool).toHaveBeenCalledWith(
			'top_gainers',
			{ exchange: 'BINANCE', timeframe: '4h', limit: 5 },
			expect.any(Object),
		);
	});
});
