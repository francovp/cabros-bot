'use strict';

const {
	buildPortfolioSnapshot,
	parseWindowHours,
	parseMaxAlerts,
	parsePaperNotional,
	parseConcentrationThreshold,
	parseMaxSymbols,
	formatMarkdownSnapshot,
	isEnabled,
	STORAGE_UNAVAILABLE_CODE,
} = require('../../src/services/portfolio/PortfolioAnalyticsService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	isEnabled: jest.fn(),
	listAlerts: jest.fn(),
	STORAGE_UNAVAILABLE_CODE: 'STORAGE_UNAVAILABLE',
}));

describe('PortfolioAnalyticsService', () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = { ...originalEnv };
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.ENABLE_PORTFOLIO_ANALYTICS = 'true';
		process.env.PORTFOLIO_ANALYTICS_WINDOW_HOURS = '168';
		process.env.PORTFOLIO_ANALYTICS_MAX_ALERTS = '200';
		process.env.PORTFOLIO_ANALYTICS_PAPER_NOTIONAL = '1000';
		process.env.PORTFOLIO_ANALYTICS_CONCENTRATION_THRESHOLD = '0.25';
		process.env.PORTFOLIO_ANALYTICS_MAX_SYMBOLS = '25';
	});

	afterAll(() => {
		process.env = originalEnv;
	});

	describe('config parsers', () => {
		describe('parseWindowHours', () => {
			it('returns the parsed integer when within bounds', () => {
				expect(parseWindowHours('24')).toBe(24);
				expect(parseWindowHours('168')).toBe(168);
				expect(parseWindowHours('720')).toBe(720);
			});

			it('falls back to default for missing or invalid values', () => {
				expect(parseWindowHours(undefined)).toBe(168);
				expect(parseWindowHours('not-a-number')).toBe(168);
				expect(parseWindowHours('-1')).toBe(168);
				expect(parseWindowHours('0')).toBe(168);
			});

			it('clamps out-of-range values to the nearest bound', () => {
				expect(parseWindowHours('0.5')).toBe(1);
				expect(parseWindowHours('99999')).toBe(8760);
			});
		});

		describe('parseMaxAlerts', () => {
			it('parses values within [1, 1000]', () => {
				expect(parseMaxAlerts('1')).toBe(1);
				expect(parseMaxAlerts('500')).toBe(500);
				expect(parseMaxAlerts('1000')).toBe(1000);
			});

			it('falls back to default for invalid input', () => {
				expect(parseMaxAlerts(undefined)).toBe(200);
				expect(parseMaxAlerts('abc')).toBe(200);
			});

			it('clamps out-of-range values', () => {
				expect(parseMaxAlerts('0')).toBe(200);
				expect(parseMaxAlerts('5000')).toBe(200);
			});
		});

		describe('parsePaperNotional', () => {
			it('parses positive finite values', () => {
				expect(parsePaperNotional('500')).toBe(500);
				expect(parsePaperNotional('1000.5')).toBe(1000.5);
			});

			it('falls back to default for invalid values', () => {
				expect(parsePaperNotional(undefined)).toBe(1000);
				expect(parsePaperNotional('-1')).toBe(1000);
				expect(parsePaperNotional('notanumber')).toBe(1000);
			});
		});

		describe('parseConcentrationThreshold', () => {
			it('parses positive values within (0, 1]', () => {
				expect(parseConcentrationThreshold('0.25')).toBeCloseTo(0.25);
				expect(parseConcentrationThreshold('0.5')).toBeCloseTo(0.5);
				expect(parseConcentrationThreshold('1')).toBeCloseTo(1);
			});

			it('falls back to default for invalid input', () => {
				expect(parseConcentrationThreshold(undefined)).toBeCloseTo(0.25);
				expect(parseConcentrationThreshold('0')).toBeCloseTo(0.25);
				expect(parseConcentrationThreshold('-0.1')).toBeCloseTo(0.25);
				expect(parseConcentrationThreshold('1.5')).toBeCloseTo(0.25);
			});
		});

		describe('parseMaxSymbols', () => {
			it('parses values within [1, 100]', () => {
				expect(parseMaxSymbols('1')).toBe(1);
				expect(parseMaxSymbols('25')).toBe(25);
				expect(parseMaxSymbols('100')).toBe(100);
			});

			it('falls back to default for invalid input', () => {
				expect(parseMaxSymbols(undefined)).toBe(25);
				expect(parseMaxSymbols('0')).toBe(25);
				expect(parseMaxSymbols('200')).toBe(25);
			});
		});
	});

	describe('isEnabled', () => {
		it('returns true only when the gate is the literal string "true"', () => {
			process.env.ENABLE_PORTFOLIO_ANALYTICS = 'true';
			expect(isEnabled()).toBe(true);
		});

		it('returns false when the gate is missing or any other value', () => {
			delete process.env.ENABLE_PORTFOLIO_ANALYTICS;
			expect(isEnabled()).toBe(false);
			process.env.ENABLE_PORTFOLIO_ANALYTICS = 'false';
			expect(isEnabled()).toBe(false);
			process.env.ENABLE_PORTFOLIO_ANALYTICS = '1';
			expect(isEnabled()).toBe(false);
		});
	});

	describe('buildPortfolioSnapshot', () => {
		beforeEach(() => {
			alertStorageService.isEnabled.mockReturnValue(true);
		});

		it('throws STORAGE_UNAVAILABLE when alert storage is disabled', async () => {
			alertStorageService.isEnabled.mockReturnValue(false);
			await expect(buildPortfolioSnapshot({})).rejects.toMatchObject({
				code: STORAGE_UNAVAILABLE_CODE,
			});
		});

		it('returns an empty snapshot when no alerts are available', async () => {
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [],
				hasMore: false,
				nextBefore: null,
			});

			const result = await buildPortfolioSnapshot({});
			expect(result.mode).toBe('implied_paper');
			expect(result.symbols).toEqual([]);
			expect(result.totals.openCount).toBe(0);
			expect(result.riskFlags).toEqual([]);
			expect(result.totals.concentrationIndex).toBe(0);
			expect(result.totals.netSide).toBe('neutral');
			expect(result.totals.unrealizedPnl).toBe(0);
		});

		it('aggregates per-symbol BUY/SELL counts and computes implied notional', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - 1000 }),
					buildAlert({ id: 'a2', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'SELL', price: 51000, setupType: 'breakout', timestamp: now - 500 }),
					buildAlert({ id: 'a3', symbol: 'ETHUSDT', exchange: 'BINANCE', side: 'BUY', price: 3000, setupType: 'trend_continuation', timestamp: now - 200 }),
				],
				hasMore: false,
				nextBefore: null,
			});

			const result = await buildPortfolioSnapshot({ paperNotional: 1000 });
			expect(result.symbols).toHaveLength(2);
			const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT');
			expect(btc.openCount).toBe(0);
			expect(btc.netSide).toBe('neutral');
			expect(btc.buyCount).toBe(1);
			expect(btc.sellCount).toBe(1);
			expect(btc.setupTypeBreakdown.breakout).toBe(2);
			expect(btc.averageEntry).toBe(50500);
			const eth = result.symbols.find((s) => s.symbol === 'ETHUSDT');
			expect(eth.openCount).toBe(1);
			expect(eth.netSide).toBe('long');
			expect(eth.buyCount).toBe(1);
			expect(eth.sellCount).toBe(0);
		});

		it('emits concentration_high risk flag when HHI exceeds threshold', async () => {
			const now = Date.now();
			const alerts = [];
			for (let i = 0; i < 3; i += 1) {
				alerts.push(buildAlert({ id: `a${i}`, symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - i }));
			}
			alerts.push(buildAlert({ id: 'a3', symbol: 'ETHUSDT', exchange: 'BINANCE', side: 'BUY', price: 3000, setupType: 'trend_continuation', timestamp: now - 10 }));

			alertStorageService.listAlerts.mockResolvedValue({ alerts, hasMore: false, nextBefore: null });

			const result = await buildPortfolioSnapshot({ paperNotional: 1000, concentrationThreshold: 0.25 });
			expect(result.riskFlags).toContain('concentration_high');
		});

		it('does not flag concentration when HHI is below the threshold', async () => {
			const now = Date.now();
			const alerts = [];
			for (const symbol of ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT']) {
				alerts.push(buildAlert({ id: symbol, symbol, exchange: 'BINANCE', side: 'BUY', price: 100, setupType: 'breakout', timestamp: now }));
			}
			alertStorageService.listAlerts.mockResolvedValue({ alerts, hasMore: false, nextBefore: null });
			const result = await buildPortfolioSnapshot({ paperNotional: 1000, concentrationThreshold: 0.25 });
			expect(result.riskFlags).not.toContain('concentration_high');
		});

		it('emits open_sells_overweight when net side is short', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'SELL', price: 50000, setupType: 'reversal', timestamp: now - 100 }),
					buildAlert({ id: 'a2', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'SELL', price: 51000, setupType: 'reversal', timestamp: now - 50 }),
				],
				hasMore: false,
				nextBefore: null,
			});
			const result = await buildPortfolioSnapshot({ paperNotional: 1000 });
			expect(result.totals.netSide).toBe('short');
			expect(result.riskFlags).toContain('open_sells_overweight');
		});

		it('emits no_market_data when no current price is available', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - 100 }),
				],
				hasMore: false,
				nextBefore: null,
			});
			const result = await buildPortfolioSnapshot({
				paperNotional: 1000,
				fetchCurrentPrice: async () => null,
			});
			expect(result.riskFlags).toContain('no_market_data');
			expect(result.totals.unrealizedPnl).toBe(0);
		});

		it('computes unrealized P&L from a provided current price resolver', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - 100 }),
				],
				hasMore: false,
				nextBefore: null,
			});
			const result = await buildPortfolioSnapshot({
				paperNotional: 1000,
				fetchCurrentPrice: async (symbol) => {
					if (symbol === 'BTCUSDT') {
						return { price: 55000, source: 'binance' };
					}
					return null;
				},
			});
			const btc = result.symbols[0];
			expect(btc.currentPrice).toBe(55000);
			expect(btc.unrealizedReturnPct).toBeCloseTo(10);
			expect(btc.unrealizedPnl).toBeCloseTo(100);
		});

		it('produces a sorted topSymbols list ordered by absolute notional', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - 100 }),
					buildAlert({ id: 'a2', symbol: 'ETHUSDT', exchange: 'BINANCE', side: 'BUY', price: 3000, setupType: 'breakout', timestamp: now - 50 }),
					buildAlert({ id: 'a3', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - 25 }),
				],
				hasMore: false,
				nextBefore: null,
			});
			const result = await buildPortfolioSnapshot({ paperNotional: 1000 });
			expect(result.topSymbols[0]).toBe('BTCUSDT');
			expect(result.totals.notional).toBe(3000);
		});

		it('caps the number of symbols to maxSymbols', async () => {
			const now = Date.now();
			const alerts = [];
			for (let i = 0; i < 30; i += 1) {
				alerts.push(buildAlert({ id: `a${i}`, symbol: `SYM${i}`, exchange: 'BINANCE', side: 'BUY', price: 100, setupType: 'breakout', timestamp: now - i }));
			}
			alertStorageService.listAlerts.mockResolvedValue({ alerts, hasMore: false, nextBefore: null });
			const result = await buildPortfolioSnapshot({ paperNotional: 1000, maxSymbols: 5 });
			expect(result.symbols.length).toBe(5);
			expect(result.topSymbols.length).toBe(5);
		});

		it('skips alerts without a resolvable symbol', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: 50000, setupType: 'breakout', timestamp: now - 100 }),
					buildAlert({ id: 'a2', symbol: null, exchange: null, side: 'BUY', price: 100, setupType: 'breakout', timestamp: now - 50 }),
				],
				hasMore: false,
				nextBefore: null,
			});
			const result = await buildPortfolioSnapshot({ paperNotional: 1000 });
			const btc = result.symbols.find((s) => s.symbol === 'BTCUSDT');
			expect(btc).toBeDefined();
			expect(result.totals.totalAlerts).toBe(1);
		});

		it('does not produce NaN/Infinity for numeric fields', async () => {
			const now = Date.now();
			alertStorageService.listAlerts.mockResolvedValue({
				alerts: [
					buildAlert({ id: 'a1', symbol: 'BTCUSDT', exchange: 'BINANCE', side: 'BUY', price: null, setupType: null, timestamp: now - 100 }),
				],
				hasMore: false,
				nextBefore: null,
			});
			const result = await buildPortfolioSnapshot({ paperNotional: 1000 });
			for (const sym of result.symbols) {
				expect(Number.isFinite(sym.averageEntry) || sym.averageEntry === null).toBe(true);
				expect(Number.isFinite(sym.unrealizedReturnPct) || sym.unrealizedReturnPct === null).toBe(true);
				expect(Number.isFinite(sym.unrealizedPnl) || sym.unrealizedPnl === null).toBe(true);
			}
			expect(Number.isFinite(result.totals.concentrationIndex)).toBe(true);
			expect(Number.isFinite(result.totals.unrealizedPnl)).toBe(true);
		});
	});

	describe('formatMarkdownSnapshot', () => {
		it('returns a stable Spanish snapshot for top symbols and risk flags', () => {
			const snapshot = {
				mode: 'implied_paper',
				window: { from: '2026-08-26T00:00:00Z', to: '2026-09-02T00:00:00Z', hours: 168 },
				totals: {
					totalAlerts: 50,
					openCount: 5,
					netSide: 'long',
					notional: 5000,
					unrealizedPnl: 250,
					concentrationIndex: 0.4,
				},
				symbols: [
					{ symbol: 'BTCUSDT', exchange: 'BINANCE', openCount: 3, netSide: 'long', notional: 3000, unrealizedPnl: 150, unrealizedReturnPct: 5 },
					{ symbol: 'ETHUSDT', exchange: 'BINANCE', openCount: 2, netSide: 'long', notional: 2000, unrealizedPnl: 100, unrealizedReturnPct: 5 },
				],
				topSymbols: ['BTCUSDT', 'ETHUSDT'],
				riskFlags: ['concentration_high'],
				generatedAt: '2026-09-02T00:00:00Z',
			};
			const text = formatMarkdownSnapshot(snapshot);
			expect(text).toContain('BTCUSDT');
			expect(text).toContain('ETHUSDT');
			expect(text).toContain('Portafolio implícito');
			expect(text).toContain('concentration\\_high');
		});

		it('renders the empty-state message when no symbols are present', () => {
			const text = formatMarkdownSnapshot({
				mode: 'implied_paper',
				window: { from: '2026-08-26T00:00:00Z', to: '2026-09-02T00:00:00Z', hours: 168 },
				totals: { totalAlerts: 0, openCount: 0, netSide: 'neutral', notional: 0, unrealizedPnl: 0, concentrationIndex: 0 },
				symbols: [],
				topSymbols: [],
				riskFlags: [],
				generatedAt: '2026-09-02T00:00:00Z',
			});
			expect(text).toContain('Sin señales');
		});
	});
});

function buildAlert({ id, symbol, exchange, side, price, setupType, timestamp }) {
	const enrichmentData = {
		sentiment: side === 'SELL' ? 'BEARISH' : 'BULLISH',
		setup_type: setupType,
		technical_levels: price ? { entry: price } : null,
	};
	return {
		id,
		receivedAt: new Date(timestamp).toISOString(),
		text: `Test alert ${id}`,
		enriched: true,
		enrichmentData,
		channels: ['telegram'],
		deliveryResults: [{ channel: 'telegram', success: true }],
		source: 'webhook',
		useTradingViewData: false,
		tradingViewEnrichmentApplied: false,
		symbol: symbol || undefined,
		exchange: exchange || undefined,
	};
}
