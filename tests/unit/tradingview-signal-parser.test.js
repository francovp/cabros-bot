const {
	parseTradingViewSignal,
	normalizeTradingViewTimeframe,
	normalizeSignalSide,
	deriveAssetContext,
	deriveCleanSearchQuery,
} = require('../../src/services/tradingview/parseTradingViewSignal');

describe('TradingView signal parser', () => {
	it('parses Spanish SELL signal with numeric timeframe', () => {
		const result = parseTradingViewSignal('BTCUSDT(240) pasó a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			rawTimeframe: '240',
			timeframe: '4h',
			side: 'SELL',
		}));
	});

	it('parses BUY signal with exchange prefix', () => {
		const result = parseTradingViewSignal('BINANCE:ETHUSDT(60) paso a señal de COMPRA');

		expect(result).toEqual(expect.objectContaining({
			symbol: 'ETHUSDT',
			exchange: 'BINANCE',
			rawTimeframe: '60',
			timeframe: '1h',
			side: 'BUY',
		}));
	});

	it('returns null when side is missing', () => {
		const result = parseTradingViewSignal('BTCUSDT(240) sin señal definida');
		expect(result).toBeNull();
	});

	it('falls back timeframe when mapping is unknown', () => {
		const result = parseTradingViewSignal('BTCUSDT(123) pasó a señal de VENTA', { defaultTimeframe: '15m' });
		expect(result.timeframe).toBe('15m');
	});

	it('normalizes supported timeframe tokens', () => {
		expect(normalizeTradingViewTimeframe('240')).toBe('4h');
		expect(normalizeTradingViewTimeframe('D')).toBe('1D');
		expect(normalizeTradingViewTimeframe('1W')).toBe('1W');
	});

	it('normalizes side aliases', () => {
		expect(normalizeSignalSide('venta')).toBe('SELL');
		expect(normalizeSignalSide('buy')).toBe('BUY');
		expect(normalizeSignalSide('hold')).toBeNull();
	});

	it('derives asset context for BATS stock signals', () => {
		const context = deriveAssetContext('BATS:TSM(D) cambió a señal de VENTA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'TSM',
			exchange: 'BATS',
			assetClass: 'stock',
			side: 'SELL',
			timeframe: '1D',
		}));
	});

	it('derives clean search query for BATS and BINANCE signals', () => {
		expect(deriveCleanSearchQuery('BATS:TSM(D) cambió a señal de VENTA')).toBe('TSM stock price news market analyst');
		expect(deriveCleanSearchQuery('BATS:AAPL(D) cambió a señal de COMPRA')).toBe('AAPL stock price news market analyst');
		expect(deriveCleanSearchQuery('BINANCE:BTCUSDT(1H) cambió a señal de COMPRA')).toBe('BTCUSDT crypto price news market analyst');
	});
});

