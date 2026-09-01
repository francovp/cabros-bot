const {
	parseTradingViewSignal,
	normalizeTradingViewTimeframe,
	normalizeSignalSide,
	deriveAssetContext,
	deriveCleanSearchQuery,
	resolveExchangeAlias,
	EXCHANGE_ALIASES,
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

	it('keeps known forex exchange context neutral', () => {
		const text = 'FX_IDC:USDCLP(D) cambió a señal de VENTA';

		expect(deriveAssetContext(text)).toEqual(expect.objectContaining({
			symbol: 'USDCLP',
			exchange: 'FX_IDC',
			assetClass: null,
		}));
		expect(deriveCleanSearchQuery(text)).toBe('USDCLP market news analyst');
	});

	it('keeps unlisted equity exchanges classified as stocks', () => {
		for (const exchange of ['LSE', 'TSX']) {
			expect(deriveAssetContext(`${exchange}:VOD(D) cambió a señal de COMPRA`)).toEqual(expect.objectContaining({
				exchange,
				assetClass: 'stock',
			}));
		}
	});

	it('keeps known futures venues neutral', () => {
		for (const exchange of ['CME_MINI', 'CBOT_MINI']) {
			expect(deriveAssetContext(`${exchange}:ESU2026(D) cambió a señal de COMPRA`)).toEqual(expect.objectContaining({
				exchange,
				assetClass: null,
			}));
		}

		expect(deriveAssetContext('CME_MINI:ETH(D) cambió a señal de COMPRA')).toEqual(expect.objectContaining({
			exchange: 'CME_MINI',
			assetClass: null,
		}));
		expect(deriveCleanSearchQuery('CME_MINI:ETH(D) cambió a señal de COMPRA')).toBe('ETH market news analyst');
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

	it('preserves slash-delimited crypto pairs in grounding context and queries', () => {
		const text = 'BTC/USDT price rose after the announcement';
		const ambiguousQuoteText = 'eth/btc price rose after the announcement';

		expect(deriveAssetContext(text)).toEqual(expect.objectContaining({
			symbol: 'BTC/USDT',
			assetClass: 'crypto',
		}));
		expect(deriveCleanSearchQuery(text)).toBe('BTC/USDT crypto price news market analyst');
		expect(deriveAssetContext(ambiguousQuoteText)).toEqual(expect.objectContaining({
			symbol: 'ETH/BTC',
			assetClass: 'crypto',
		}));
		expect(deriveCleanSearchQuery(ambiguousQuoteText)).toBe('ETH/BTC crypto price news market analyst');
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

describe('resolveExchangeAlias', () => {
	it('maps BATS to its known supported venue on the MCP server', () => {
		expect(resolveExchangeAlias('BATS')).toBe('NASDAQ');
		expect(resolveExchangeAlias('bats')).toBe('NASDAQ');
	});

	it('maps ARCA and NYSE_ARCA to NYSE (canonical listing venue)', () => {
		expect(resolveExchangeAlias('ARCA')).toBe('NYSE');
		expect(resolveExchangeAlias('NYSE_ARCA')).toBe('NYSE');
		expect(resolveExchangeAlias('NYSE ARCA')).toBe('NYSE');
	});

	it('passes through known crypto and stock venues unchanged', () => {
		for (const venue of ['BINANCE', 'NASDAQ', 'NYSE', 'AMEX', 'FX_IDC', 'SPCFD']) {
			expect(resolveExchangeAlias(venue)).toBe(venue);
		}
	});

	it('returns null for null/undefined/empty input', () => {
		expect(resolveExchangeAlias(null)).toBeNull();
		expect(resolveExchangeAlias(undefined)).toBeNull();
		expect(resolveExchangeAlias('')).toBeNull();
	});

	it('returns the input unchanged when no alias mapping is configured', () => {
		expect(resolveExchangeAlias('LSE')).toBe('LSE');
		expect(resolveExchangeAlias('TSE')).toBe('TSE');
	});

	it('exposes EXCHANGE_ALIASES as a frozen object literal', () => {
		expect(typeof EXCHANGE_ALIASES).toBe('object');
		expect(Object.isFrozen(EXCHANGE_ALIASES)).toBe(true);
		expect(EXCHANGE_ALIASES.BATS).toBe('NASDAQ');
	});
});
