const {
	parseTradingViewAlertRequest,
	buildTradingViewAlertReport,
} = require('../../src/services/tradingview/tradingViewAlertReport');

describe('TradingView alert report', () => {
	const originalEnv = process.env;

	afterEach(() => {
		process.env = originalEnv;
	});

	it('uses request body symbols before TRADINGVIEW_ALERT_SYMBOLS', () => {
		process.env = {
			...originalEnv,
			TRADINGVIEW_ALERT_SYMBOLS: 'NASDAQ:MSFT',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '4h',
		};

		const parsed = parseTradingViewAlertRequest({
			body: {
				symbols: [' BINANCE:BTCUSDT ', 'NASDAQ:NVDA'],
				timeframe: '1D',
			},
		});

		expect(parsed).toEqual({
			symbols: [
				{ raw: 'BINANCE:BTCUSDT', exchange: 'BINANCE', symbol: 'BTCUSDT' },
				{ raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
			],
			timeframe: '1D',
		});
	});

	it('falls back to TRADINGVIEW_ALERT_SYMBOLS and returns a clear error when none exist', () => {
		process.env = {
			...originalEnv,
			TRADINGVIEW_ALERT_SYMBOLS: 'NASDAQ:AAPL, BINANCE:ETHUSDC',
		};

		expect(parseTradingViewAlertRequest({ body: {} }).symbols).toEqual([
			{ raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
			{ raw: 'BINANCE:ETHUSDC', exchange: 'BINANCE', symbol: 'ETHUSDC' },
		]);

		process.env = {
			...originalEnv,
			TRADINGVIEW_ALERT_SYMBOLS: '',
		};

		expect(() => parseTradingViewAlertRequest({ body: {} })).toThrow('No TradingView symbols provided');
	});

	it('rejects symbols that are not EXCHANGE:SYMBOL identifiers', () => {
		expect(() => parseTradingViewAlertRequest({
			body: { symbols: ['NVDA'], timeframe: '1D' },
		})).toThrow('Symbol must use EXCHANGE:SYMBOL format: NVDA');
	});

	it('rejects unsupported timeframes instead of silently falling back', () => {
		expect(() => parseTradingViewAlertRequest({
			body: { symbols: ['NASDAQ:NVDA'], timeframe: '2h' },
		})).toThrow('Unsupported timeframe: 2h');
	});

	it('builds a grouped Spanish markdown report from analyzed symbols', () => {
		const report = buildTradingViewAlertReport([
			{
				input: { raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
				analysis: {
					price_data: {
						current_price: 219.51,
						change_percent: -1.8,
						volume: 70213090,
					},
					technical_indicators: {
						rsi: 57.8,
						sma20: 214.1,
						macd: 6.1,
						macd_signal: 7.2,
						atr: 7.69,
					},
				},
			},
			{
				input: { raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
				analysis: {
					price_data: {
						current_price: 304.99,
						change_percent: 0.9,
						volume: 10230000,
					},
					technical_indicators: {
						rsi: 76.2,
						sma20: 296.5,
						macd: 2.3,
						macd_signal: 1.1,
						atr: 5.91,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('📊 *ANÁLISIS AMPLIADO — Friday 22/05/2026*');
		expect(report).toContain('*🟡 NEUTROS*');
		expect(report).toContain('NVDA $219.51 (-1.8%) | RSI 57.8');
		expect(report).toContain('- *Tendencia (SMA20):* Alcista | *MACD:* Bearish');
		expect(report).toContain('- *Volumen:* Normal | *ATR:* $7.69');
		expect(report).toContain('- *Stop Loss sugerido:* $207.98');
		expect(report).toContain('*🔴 SOBRECOMPRADOS*');
		expect(report).toContain('AAPL $304.99 (+0.9%) | RSI 76.2');
		expect(report).toContain('- *Sugerencia:* VENDER / TOMAR GANANCIAS');
	});
});
