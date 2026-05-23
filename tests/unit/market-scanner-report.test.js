const {
	parseMarketScannerRequest,
	buildMarketScannerReport,
	MarketScannerRequestError,
} = require('../../src/services/tradingview/marketScannerReport');

describe('Market Scanner Report', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('parseMarketScannerRequest', () => {
		it('returns default values for an empty body', () => {
			process.env.MARKET_SCANNER_DEFAULT_EXCHANGE = 'BINANCE';
			process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME = '4h';

			const parsed = parseMarketScannerRequest({ body: {} });
			expect(parsed).toEqual({
				exchange: 'BINANCE',
				timeframe: '4h',
				scans: ['top_gainers', 'top_losers', 'volume_breakout_scanner'],
				limit: 5,
				bbwThreshold: 0.05,
			});
		});

		it('uses env overrides for default exchange and timeframe', () => {
			process.env.MARKET_SCANNER_DEFAULT_EXCHANGE = 'NASDAQ';
			process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME = '1D';

			const parsed = parseMarketScannerRequest({ body: {} });
			expect(parsed.exchange).toBe('NASDAQ');
			expect(parsed.timeframe).toBe('1D');
		});

		it('validates and normalizes parameters correctly', () => {
			const parsed = parseMarketScannerRequest({
				body: {
					exchange: ' binance ',
					timeframe: ' 1h ',
					scans: ['top_gainers', 'bollinger_scan'],
					limit: '15',
					bbw_threshold: 0.02,
				},
			});

			expect(parsed).toEqual({
				exchange: 'BINANCE',
				timeframe: '1h',
				scans: ['top_gainers', 'bollinger_scan'],
				limit: 15,
				bbwThreshold: 0.02,
			});
		});

		it('clamps limit to [1, 20]', () => {
			const parsedLow = parseMarketScannerRequest({ body: { limit: 0 } });
			expect(parsedLow.limit).toBe(1);

			const parsedHigh = parseMarketScannerRequest({ body: { limit: 100 } });
			expect(parsedHigh.limit).toBe(20);
		});

		it('throws MarketScannerRequestError for non-object body', () => {
			expect(() => parseMarketScannerRequest({ body: 'invalid' }))
				.toThrow(MarketScannerRequestError);
			expect(() => parseMarketScannerRequest({ body: [] }))
				.toThrow('request body must be a JSON object');
		});

		it('throws MarketScannerRequestError for empty exchange', () => {
			expect(() => parseMarketScannerRequest({ body: { exchange: '' } }))
				.toThrow('exchange must be a non-empty string');
		});

		it('throws MarketScannerRequestError for invalid timeframe', () => {
			expect(() => parseMarketScannerRequest({ body: { timeframe: '2h' } }))
				.toThrow('Unsupported timeframe: 2h');
		});

		it('throws MarketScannerRequestError for non-array scans', () => {
			expect(() => parseMarketScannerRequest({ body: { scans: 'top_gainers' } }))
				.toThrow('scans must be an array of scan type strings');
		});

		it('throws MarketScannerRequestError for unsupported scan types', () => {
			expect(() => parseMarketScannerRequest({ body: { scans: ['top_gainers', 'invalid_scan'] } }))
				.toThrow('Unsupported scan types: invalid_scan');
		});

		it('throws MarketScannerRequestError for invalid limit', () => {
			expect(() => parseMarketScannerRequest({ body: { limit: 'abc' } }))
				.toThrow('limit must be an integer');
		});

		it('throws MarketScannerRequestError for invalid bbw_threshold', () => {
			expect(() => parseMarketScannerRequest({ body: { bbw_threshold: 'abc' } }))
				.toThrow('bbw_threshold must be a number');
		});
	});

	describe('buildMarketScannerReport', () => {
		const mockDate = new Date('2026-05-23T12:00:00Z');

		it('formats top_gainers and top_losers items correctly', () => {
			const results = [
				{
					scan: 'top_gainers',
					status: 'success',
					items: [
						{
							symbol: 'BINANCE:GMTUSDT',
							changePercent: 26.415,
							indicators: { close: 0.0134, RSI: 79.72 },
						},
						{
							symbol: 'BINANCE:DEXEUSDT',
							changePercent: 1.73,
							indicators: { close: 13.989, RSI: 55.6 },
						},
					],
				},
				{
					scan: 'top_losers',
					status: 'success',
					items: [],
				},
			];

			const report = buildMarketScannerReport(results, {
				exchange: 'BINANCE',
				timeframe: '4h',
				now: mockDate,
			});

			expect(report).toContain('📡 *SCANNER DE MERCADO — Saturday 23/05/2026*');
			expect(report).toContain('_BINANCE · 4h_');
			expect(report).toContain('*🟢 TOP GANADORES*');
			expect(report).toContain('1. GMTUSDT $0.013400 (+26.4%) | RSI 79.7');
			expect(report).toContain('2. DEXEUSDT $13.99 (+1.7%) | RSI 55.6');
			expect(report).toContain('*🔴 TOP PERDEDORES*');
			expect(report).toContain('No hay.');
		});

		it('formats volume_breakout_scanner and smart_volume_scanner correctly', () => {
			const results = [
				{
					scan: 'volume_breakout_scanner',
					status: 'success',
					items: [
						{
							symbol: 'BINANCE:GMTUSDT',
							changePercent: 26.415,
							volume_ratio: 2.1,
							breakout_type: 'bullish',
							indicators: { close: 0.0134 },
						},
					],
				},
				{
					scan: 'smart_volume_scanner',
					status: 'success',
					items: [
						{
							symbol: 'BINANCE:LSKUSDT',
							changePercent: -6.5,
							volume_ratio: 2.0,
							breakout_type: 'bearish',
							trading_recommendation: '📈 STRONG SELL',
							indicators: { close: 0.116 },
						},
					],
				},
			];

			const report = buildMarketScannerReport(results, {
				exchange: 'BINANCE',
				timeframe: '4h',
				now: mockDate,
			});

			expect(report).toContain('*💥 BREAKOUT DE VOLUMEN*');
			expect(report).toContain('1. GMTUSDT $0.013400 (+26.4%) | Vol 2.1x 📈');
			expect(report).toContain('*🔎 VOLUMEN INTELIGENTE*');
			expect(report).toContain('1. LSKUSDT $0.116000 (-6.5%) | Vol 2.0x 📉 STRONG SELL');
		});

		it('formats bollinger_scan with BBW correctly', () => {
			const results = [
				{
					scan: 'bollinger_scan',
					status: 'success',
					items: [
						{
							symbol: 'BINANCE:DOTUSDT',
							changePercent: 0.0,
							bbw: 0.034,
							indicators: { close: 7.45 },
						},
					],
				},
			];

			const report = buildMarketScannerReport(results, {
				exchange: 'BINANCE',
				timeframe: '4h',
				now: mockDate,
			});

			expect(report).toContain('*🔥 SQUEEZE BOLLINGER*');
			expect(report).toContain('1. DOTUSDT $7.45 (0.0%) | BBW 0.03');
		});

		it('filters out positive changes from top_losers and negative changes from top_gainers', () => {
			const results = [
				{
					scan: 'top_gainers',
					status: 'success',
					items: [
						{
							symbol: 'BINANCE:GMTUSDT',
							changePercent: 26.4,
							indicators: { close: 0.0134 },
						},
						{
							symbol: 'BINANCE:LOSERUSDT',
							changePercent: -1.5,
							indicators: { close: 10.0 },
						},
					],
				},
				{
					scan: 'top_losers',
					status: 'success',
					items: [
						{
							symbol: 'BINANCE:WINNERUSDT',
							changePercent: 2.5,
							indicators: { close: 1.0 },
						},
						{
							symbol: 'BINANCE:MTLUSDT',
							changePercent: -5.3,
							indicators: { close: 0.339 },
						},
					],
				},
			];

			const report = buildMarketScannerReport(results, {
				exchange: 'BINANCE',
				timeframe: '4h',
				now: mockDate,
			});

			expect(report).toContain('GMTUSDT');
			expect(report).not.toContain('LOSERUSDT');
			expect(report).toContain('MTLUSDT');
			expect(report).toContain('WINNERUSDT');
			expect(report).toContain('WINNERUSDT $1.00 (-2.5%)');
		});

		it('displays scan error message when failed', () => {
			const results = [
				{
					scan: 'top_gainers',
					status: 'error',
					error: 'MCP server connection refused',
				},
			];

			const report = buildMarketScannerReport(results, {
				exchange: 'BINANCE',
				timeframe: '4h',
				now: mockDate,
			});

			expect(report).toContain('*🟢 TOP GANADORES*');
			expect(report).toContain('⚠️ Error: MCP server connection refused');
		});
	});
});
