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

	it('parses underscore-delimited exchange prefixes', () => {
		const result = parseTradingViewSignal('FX_IDC:USDCLP(D) cambió a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({
			symbol: 'USDCLP',
			exchange: 'FX_IDC',
			rawTimeframe: 'D',
			timeframe: '1D',
			side: 'SELL',
		}));
	});

	it('keeps unknown exchange asset context neutral', () => {
		const text = 'FX_IDC:USDCLP(D) cambió a señal de VENTA';

		expect(deriveAssetContext(text)).toEqual(expect.objectContaining({
			symbol: 'USDCLP',
			exchange: 'FX_IDC',
			assetClass: null,
		}));
		expect(deriveCleanSearchQuery(text)).toBe('USDCLP market news analyst');
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

	it('returns null asset context for generic prose alerts without explicit symbols', () => {
		expect(deriveAssetContext('The SEC approved a new filing for a listed company')).toBeNull();
		expect(deriveAssetContext('Bitcoin ETF inflows accelerated after the market opened')).toBeNull();
	});

	it('derives clean search query for BATS and BINANCE signals', () => {
		expect(deriveCleanSearchQuery('BATS:TSM(D) cambió a señal de VENTA')).toBe('TSM stock price news market analyst');
		expect(deriveCleanSearchQuery('BATS:AAPL(D) cambió a señal de COMPRA')).toBe('AAPL stock price news market analyst');
		expect(deriveCleanSearchQuery('BINANCE:BTCUSDT(1H) cambió a señal de COMPRA')).toBe('BTCUSDT crypto price news market analyst');
	});

	it('preserves generic alert text in search query without replacing with first word', () => {
		expect(deriveCleanSearchQuery('The SEC approved a new filing for a listed company'))
			.toBe('The SEC approved a new filing for a listed company');
		expect(deriveCleanSearchQuery('Bitcoin ETF inflows accelerated after the market opened'))
			.toBe('Bitcoin ETF inflows accelerated after the market opened');
	});

	it('preserves prose words that collide with ambiguous crypto suffixes', () => {
		for (const text of [
			'aerosol prices rose after the announcement',
			'teeth broke resistance',
		]) {
			expect(deriveAssetContext(text)).toBeNull();
			expect(deriveCleanSearchQuery(text)).toBe(text);
		}
	});

	it('retains unqualified crypto pairs and exact bare crypto symbols', () => {
		expect(deriveAssetContext('BTCUSDT price rose after the announcement')).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			assetClass: 'crypto',
		}));
		expect(deriveAssetContext('ETHBTC price rose after the announcement')).toEqual(expect.objectContaining({
			symbol: 'ETHBTC',
			assetClass: 'crypto',
		}));
		expect(deriveAssetContext('ETH price rose after the announcement')).toEqual(expect.objectContaining({
			symbol: 'ETH',
			assetClass: 'crypto',
		}));
	});

	it('does not classify lowercase bare symbols used as prose words', () => {
		const text = 'El sol salió después del anuncio';

		expect(deriveAssetContext(text)).toBeNull();
		expect(deriveCleanSearchQuery(text)).toBe(text);
		expect(deriveAssetContext('SOL price rose after the announcement')).toEqual(expect.objectContaining({
			symbol: 'SOL',
			assetClass: 'crypto',
		}));
		expect(deriveAssetContext('El sol salió; BTCUSDT price rose')).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			assetClass: 'crypto',
		}));
		const unicodeWord = 'SOLÍA subir después del anuncio';
		expect(deriveAssetContext(unicodeWord)).toBeNull();
		expect(deriveCleanSearchQuery(unicodeWord)).toBe(unicodeWord);
	});
});
