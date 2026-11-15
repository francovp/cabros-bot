'use strict';

jest.mock('../../src/services/remoteConfig/resolveRemoteOverride', () => ({
	resolveRemoteOverride: jest.fn(),
}));
jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: { callScanTool: jest.fn().mockResolvedValue([]), getStatus: jest.fn() },
}));

const { resolveRemoteOverride } = require('../../src/services/remoteConfig/resolveRemoteOverride');
const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const { NewsMonitorSchedulerService } = require('../../src/services/newsMonitorScheduler/NewsMonitorSchedulerService');
const { parseMarketScannerRequest } = require('../../src/services/tradingview/marketScannerReport');
const { scannerPresetService } = require('../../src/services/scannerPresets/ScannerPresetService');
const { postMarketScannerAlert } = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
const { postRunPreset } = require('../../src/controllers/webhooks/handlers/scannerPresets/scannerPresets');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('news and scanner published runtime defaults', () => {
	let savedEnv;
	let overrides;
	beforeEach(() => {
		savedEnv = { ...process.env };
		Object.assign(process.env, {
			ENABLE_FIREBASE_REMOTE_CONFIG: 'false', ENABLE_MARKET_SCANNER: 'true',
			NEWS_SYMBOLS_CRYPTO: 'BTCUSDT', NEWS_SYMBOLS_STOCKS: 'AAPL',
			MARKET_SCANNER_DEFAULT_EXCHANGE: 'BINANCE', MARKET_SCANNER_TIMEOUT_MS: '5000',
		});
		overrides = {};
		resolveRemoteOverride.mockImplementation((key) => overrides[key]);
	});
	afterEach(() => {
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	it('refreshes webhook and scheduler symbols, including empty published lists', () => {
		const handler = new NewsMonitorHandler();
		const scheduler = new NewsMonitorSchedulerService();
		expect(handler.getDefaultSymbols()).toEqual(['BTCUSDT', 'AAPL']);
		overrides.NEWS_SYMBOLS_CRYPTO = ' ETHUSDT, SOLUSDT ';
		overrides.NEWS_SYMBOLS_STOCKS = '';
		expect(handler.getDefaultSymbols()).toEqual(['ETHUSDT', 'SOLUSDT']);
		expect(handler.getAssetClassBySymbol([], [], true)).toEqual({ ETHUSDT: 'crypto', SOLUSDT: 'crypto' });
		expect(scheduler._resolveSymbols(50)).toEqual(['ETHUSDT', 'SOLUSDT']);
		overrides.NEWS_SYMBOLS_CRYPTO = 'BNBUSDT';
		expect(handler.getDefaultSymbols()).toEqual(['BNBUSDT']);
		expect(scheduler._resolveSymbols(50)).toEqual(['BNBUSDT']);
	});

	it('uses published exchange for requests and new presets, preserving explicit exchanges', () => {
		overrides.MARKET_SCANNER_DEFAULT_EXCHANGE = 'nasdaq_dly';
		expect(parseMarketScannerRequest({ body: {} }).exchange).toBe('NASDAQ_DLY');
		expect(scannerPresetService._parseExchange(undefined)).toBe('NASDAQ_DLY');
		expect(parseMarketScannerRequest({ body: { exchange: 'NYSE ARCA' } }).exchange).toBe('NYSE ARCA');
		expect(scannerPresetService._parseExchange('BINANCE')).toBe('BINANCE');
		delete overrides.MARKET_SCANNER_DEFAULT_EXCHANGE;
		expect(parseMarketScannerRequest({ body: {} }).exchange).toBe('BINANCE');
	});

	it('applies the published scanner budget and retains legacy subsecond environment budgets', async () => {
		const invoke = async () => {
			const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
			await postMarketScannerAlert(null)({ body: { scans: ['top_gainers'], dryRun: true } }, res);
			expect(res.status).toHaveBeenCalledWith(200);
			return res.json.mock.calls[0][0].timeoutMs;
		};
		overrides.MARKET_SCANNER_TIMEOUT_MS = 12000;
		expect(await invoke()).toBe(12000);
		delete overrides.MARKET_SCANNER_TIMEOUT_MS;
		process.env.MARKET_SCANNER_TIMEOUT_MS = '1';
		expect(await invoke()).toBe(1);
	});

	it('applies the same published budget when running a saved preset', async () => {
		jest.spyOn(scannerPresetService, 'getPreset').mockResolvedValue({
			id: 'saved', exchange: 'BINANCE', timeframe: '4h', scans: ['top_gainers'], limit: 5,
		});
		tradingViewMcpService.callScanTool.mockRejectedValueOnce(new Error('Provider unavailable'));
		overrides.MARKET_SCANNER_TIMEOUT_MS = 14000;
		const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
		await postRunPreset(null)({ params: { id: 'saved' }, body: {} }, res);
		expect(res.status).toHaveBeenCalledWith(502);
		expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 14000 }));
	});
});
