const {
	parseTradingViewSignal,
	normalizeTradingViewTimeframe,
	normalizeSignalSide,
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
});
