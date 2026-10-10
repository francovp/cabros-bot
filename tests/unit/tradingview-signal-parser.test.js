const {
	parseTradingViewSignal,
	normalizeTradingViewTimeframe,
	normalizeSignalSide,
	deriveAssetContext,
	deriveCleanSearchQuery,
	resolveMcpExchange,
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
		// The bare `EXCHANGE:SYMBOL(TF)` form takes a different code path inside
		// deriveAssetContext than the side-word form. Both must apply the same
		// neutrality rule: a crypto suffix on CME_MINI:ETH must NOT relabel the
		// futures venue as crypto.
		expect(deriveAssetContext('CME_MINI:ETH(D)')).toEqual(expect.objectContaining({
			exchange: 'CME_MINI',
			assetClass: null,
		}));
		expect(deriveCleanSearchQuery('CME_MINI:ETH(D)')).toBe('ETH market news analyst');
		expect(deriveAssetContext('FX_IDC:USDCLP(D)')).toEqual(expect.objectContaining({
			exchange: 'FX_IDC',
			assetClass: null,
		}));

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

	it('keeps explicit stock exchanges as stock even when the symbol ends in a crypto suffix', () => {
		// Explicit exchange classification must win over suffix-based inference (#835).
		// Each input carries a real signal phrase so parseTradingViewSignal() succeeds and
		// the PRIMARY parsed-signal branch is exercised — the path real TradingView alerts
		// take. Without the side/timeframe phrase these fall through to the generic
		// explicit-exchange matcher and would pass even if precedence regressed.
		expect(deriveAssetContext('BATS:TSMUSDT(D) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'BATS',
			symbol: 'TSMUSDT',
			assetClass: 'stock',
		}));
		expect(deriveAssetContext('BATS:INTCUSDC(1H) cambió a señal de COMPRA')).toEqual(expect.objectContaining({
			exchange: 'BATS',
			symbol: 'INTCUSDC',
			assetClass: 'stock',
		}));
		expect(deriveAssetContext('BATS:ETHBUSD(D) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'BATS',
			symbol: 'ETHBUSD',
			assetClass: 'stock',
		}));
		expect(deriveAssetContext('NASDAQ:NVDAUSDT(1D) cambió a señal de COMPRA')).toEqual(expect.objectContaining({
			exchange: 'NASDAQ',
			symbol: 'NVDAUSDT',
			assetClass: 'stock',
		}));
	});

	it('still classifies explicit crypto exchanges as crypto', () => {
		expect(deriveAssetContext('BINANCE:BTCUSDT(D) cambió a señal de COMPRA')).toEqual(expect.objectContaining({
			exchange: 'BINANCE',
			assetClass: 'crypto',
		}));
		expect(deriveAssetContext('BYBIT:ETHUSDT(1H) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'BYBIT',
			assetClass: 'crypto',
		}));
	});

	it('infers crypto only for unknown exchanges carrying a crypto suffix', () => {
		const context = deriveAssetContext('SOMENEWEXCHANGE:PAIRUSDT(D) cambió a señal de COMPRA');
		expect(context).toEqual(expect.objectContaining({
			exchange: 'SOMENEWEXCHANGE',
			assetClass: 'crypto',
		}));
	});

	it('normalizes lowercase exchange prefixes to their canonical stock form', () => {
		// Exchange matching is case-insensitive upstream; confirm the normalized
		// prefix still wins over the crypto suffix.
		const context = deriveAssetContext('bats:TSMUSDT(D) cambió a señal de VENTA');
		expect(context).toEqual(expect.objectContaining({
			exchange: 'BATS',
			assetClass: 'stock',
		}));
	});

	it('applies exchange precedence to English and shorthand signal phrasings', () => {
		expect(deriveAssetContext('NASDAQ:NVDAUSDT changed to BUY signal')).toEqual(expect.objectContaining({
			exchange: 'NASDAQ',
			assetClass: 'stock',
		}));
		expect(deriveAssetContext('BATS:TSMUSDT(D) changed to SELL signal')).toEqual(expect.objectContaining({
			exchange: 'BATS',
			assetClass: 'stock',
		}));
	});

	it('keeps forex and futures venues neutral even with crypto-suffixed symbols', () => {
		// NON_EQUITY_EXCHANGES must stay neutral; suffix inference must not leak in.
		for (const venue of ['FX_IDC', 'CME_MINI', 'CBOT_MINI']) {
			const context = deriveAssetContext(`${venue}:USDT(D) cambió a señal de COMPRA`);
			expect(context === null || context.assetClass === null).toBe(true);
		}
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

	// #591: the TradingView MCP server advertises only a subset of venues
	// (EGX, BIST, NASDAQ, NYSE, Bursa Malaysia, HKEX, SSE, SZSE, TWSE, TPEX +
	// crypto). Prefixes outside that set are resolved by the server to KUCOIN
	// and every call returns "No data found for <SYM> on KUCOIN".
	it('maps BATS to a venue the MCP server actually resolves', () => {
		const resolved = resolveMcpExchange('BATS');

		expect(resolved.mapped).toBe(true);
		expect(resolved.mappedExchange).toBe('NASDAQ');
		expect(resolved.reason).toMatch(/BATS/);
	});

	it('maps NASDAQ_DLY to a venue the MCP server actually resolves', () => {
		const resolved = resolveMcpExchange('NASDAQ_DLY');

		expect(resolved.mapped).toBe(true);
		expect(resolved.mappedExchange).toBe('NASDAQ');
		expect(resolved.reason).toMatch(/NASDAQ_DLY/);
	});

	it('leaves FX_IDC and SPCFD unmapped because the server has no venue for them', () => {
		// Verified live: USDCLP/FX_IDC and SPX/SPCFD both fall through to KUCOIN for
		// every candidate venue tried (OANDA/FOREXCOM/CBOE/CAPITALCOM/SP/INDEX/FRED).
		// Inventing an alias here would fabricate a venue, so they degrade instead.
		for (const exchange of ['FX_IDC', 'SPCFD']) {
			const resolved = resolveMcpExchange(exchange);

			expect(resolved.mapped).toBe(false);
			expect(resolved.mappedExchange).toBe(exchange);
			expect(resolved.unsupported).toBe(true);
			expect(resolved.reason).toMatch(new RegExp(exchange));
		}
	});

	it('keeps MCP-supported exchanges untouched', () => {
		for (const exchange of ['BINANCE', 'NASDAQ', 'NYSE', 'BIST', 'EGX', 'SSE', 'SZSE', 'TWSE', 'TPEX', 'HKEX', 'KUCOIN', 'BYBIT', 'MEXC']) {
			const resolved = resolveMcpExchange(exchange);

			expect(resolved.mapped).toBe(false);
			expect(resolved.mappedExchange).toBe(exchange);
			expect(resolved.unsupported).toBe(false);
		}
	});

	it('accepts lowercase and padded exchange prefixes in alias resolution', () => {
		expect(resolveMcpExchange(' bats ').mappedExchange).toBe('NASDAQ');
		expect(resolveMcpExchange('nasdaq_dly').mappedExchange).toBe('NASDAQ');
	});

	it('degrades safely for missing or non-string exchange values', () => {
		for (const value of [null, undefined, '', 42, {}]) {
			const resolved = resolveMcpExchange(value);

			expect(resolved.mappedExchange).toBeNull();
			expect(resolved.mapped).toBe(false);
			expect(resolved.unsupported).toBe(false);
		}
	});

	it('does not rewrite the stored exchange when resolving aliases for outbound MCP calls', () => {
		// The parser still reports the venue the screener actually sent, so stored
		// alert metadata, asset classification and FX/futures neutrality are unchanged.
		expect(parseTradingViewSignal('BATS:TSLA(D) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'BATS',
		}));
		expect(parseTradingViewSignal('FX_IDC:USDCLP(D) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'FX_IDC',
		}));
		expect(parseTradingViewSignal('SPCFD:SPX(D) cambió a señal de COMPRA')).toEqual(expect.objectContaining({
			exchange: 'SPCFD',
		}));

		expect(deriveAssetContext('BATS:TSLA(D) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'BATS',
			assetClass: 'stock',
		}));
		expect(deriveAssetContext('FX_IDC:USDCLP(D) cambió a señal de VENTA')).toEqual(expect.objectContaining({
			exchange: 'FX_IDC',
			assetClass: null,
		}));
		expect(deriveAssetContext('SPCFD:SPX(D) cambió a señal de COMPRA')).toEqual(expect.objectContaining({
			exchange: 'SPCFD',
			assetClass: 'stock',
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

describe('TradingView signal parser - BATS exchange prefix bug (GH-835)', () => {
	it('classifies BATS:TSM as stock even when symbol ends with USDT suffix', () => {
		const context = deriveAssetContext('BATS:TSMUSDT(1D) pasó a señal de VENTA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'TSMUSDT',
			exchange: 'BATS',
			assetClass: 'stock',
		}));
	});

	it('classifies BATS:BTCUSDT as stock because exchange wins over suffix', () => {
		const context = deriveAssetContext('BATS:BTCUSDT(1D) pasó a señal de COMPRA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BATS',
			assetClass: 'stock',
		}));
	});

	it('classifies BATS:INTC as stock', () => {
		const context = deriveAssetContext('BATS:INTC(1D) pasó a señal de COMPRA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'INTC',
			exchange: 'BATS',
			assetClass: 'stock',
		}));
	});

	it('classifies NASDAQ:TSLAUSDT as stock because exchange wins over suffix', () => {
		const context = deriveAssetContext('NASDAQ:TSLAUSDT(1D) pasó a señal de VENTA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'TSLAUSDT',
			exchange: 'NASDAQ',
			assetClass: 'stock',
		}));
	});

	it('classifies NYSE:ETHUSDT as stock because exchange wins over suffix', () => {
		const context = deriveAssetContext('NYSE:ETHUSDT(1D) pasó a señal de COMPRA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'ETHUSDT',
			exchange: 'NYSE',
			assetClass: 'stock',
		}));
	});

	it('classifies BINANCE:BTCUSDT as crypto', () => {
		const context = deriveAssetContext('BINANCE:BTCUSDT(1D) pasó a señal de COMPRA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			assetClass: 'crypto',
		}));
	});

	it('classifies bare BTCUSDT (no exchange) as crypto via suffix fallback', () => {
		const context = deriveAssetContext('BTCUSDT(1D) pasó a señal de VENTA');
		expect(context).toEqual(expect.objectContaining({
			symbol: 'BTCUSDT',
			assetClass: 'crypto',
		}));
	});
});
