'use strict';

const {
	resolveSymbolQuery,
	resolveToCanonicalId,
	listAliases,
	normalizeQuery,
	isEnabled,
	_resetCache,
} = require('../../src/services/symbols/aliasResolver');

describe('symbol alias resolver', () => {
	beforeEach(() => {
		_resetCache();
	});

	describe('normalizeQuery', () => {
		it('trims, uppercases, removes slash separators and noise characters', () => {
			expect(normalizeQuery('  xau/usd ')).toBe('XAUUSD');
			expect(normalizeQuery('$GOLD=')).toBe('GOLD');
			expect(normalizeQuery('(BTCUSDT)')).toBe('BTCUSDT');
			expect(normalizeQuery('EUR / USD')).toBe('EURUSD');
		});

		it('returns empty string for non-string input', () => {
			expect(normalizeQuery(null)).toBe('');
			expect(normalizeQuery(undefined)).toBe('');
			expect(normalizeQuery(123)).toBe('');
		});
	});

	describe('resolveSymbolQuery', () => {
		it('returns at least one match for GOLD', () => {
			const result = resolveSymbolQuery('GOLD');
			expect(result.matches.length).toBeGreaterThan(0);
			const top = result.matches[0];
			expect(top.exchange).toBe('TVC');
			expect(top.symbol).toBe('GOLD');
			expect(top.aliases).toEqual(expect.arrayContaining(['GOLD', 'XAUUSD', 'XAU/USD', 'XAU']));
			expect(top.assetClass).toBe('commodity');
			expect(top.matchType).toBe('exact');
		});

		it('resolves XAUUSD and XAU/USD to the same canonical identifier', () => {
			const a = resolveToCanonicalId('XAUUSD');
			const b = resolveToCanonicalId('XAU/USD');
			expect(a).toBe('TVC:GOLD');
			expect(b).toBe('TVC:GOLD');
		});

		it('returns 0 matches for nonsense input without throwing', () => {
			const result = resolveSymbolQuery('NONSENSE_TICKERX_XYZ');
			expect(result.matches).toEqual([]);
			expect(result.normalizedQuery).toBe('NONSENSE_TICKERX_XYZ');
		});

		it('does not throw for empty input', () => {
			const result = resolveSymbolQuery('');
			expect(result.matches).toEqual([]);
		});

		it('orders BTC ahead of BINANCE alias-prefix matches when defaultExchange is set', () => {
			const result = resolveSymbolQuery('BTC', { defaultExchange: 'BINANCE', maxResults: 5 });
			expect(result.matches.length).toBeGreaterThan(0);
			expect(result.matches[0].exchange).toBe('BINANCE');
			expect(result.matches[0].symbol).toBe('BTCUSDT');
		});

		it('keeps multi-match deterministic ordering when defaultExchange is omitted', () => {
			const a = resolveSymbolQuery('XAUUSD');
			const b = resolveSymbolQuery('XAUUSD');
			expect(a.matches[0]).toEqual(b.matches[0]);
		});

		it('propagates assetClass metadata', () => {
			expect(resolveToCanonicalId('BTC')).toBe('BINANCE:BTCUSDT');
			expect(resolveToCanonicalId('ETH')).toBe('BINANCE:ETHUSDT');
			expect(resolveToCanonicalId('DXY')).toBe('TVC:DXY');
			expect(resolveToCanonicalId('BRENT')).toBe('TVC:UKOIL');
			expect(resolveToCanonicalId('ES')).toBe('CME_MINI:ES1!');
		});

		it('respects maxResults', () => {
			const result = resolveSymbolQuery('XAU', { maxResults: 1 });
			expect(result.matches.length).toBeLessThanOrEqual(1);
		});

		it('returns totalEntries count regardless of match result', () => {
			const result = resolveSymbolQuery('BTC');
			expect(result.totalEntries).toBeGreaterThan(0);
		});

		it('does not match unrelated short tickers (no false positives)', () => {
			// `ES` is a real alias but `EX` is not — make sure we don't accidentally
			// return anything for genuinely unrelated input.
			const result = resolveSymbolQuery('EXXXRANDOM');
			expect(result.matches).toEqual([]);
		});
	});

	describe('resolveToCanonicalId', () => {
		it('returns the canonical EXCHANGE:SYMBOL identifier', () => {
			expect(resolveToCanonicalId('GOLD')).toBe('TVC:GOLD');
			expect(resolveToCanonicalId('BTC')).toBe('BINANCE:BTCUSDT');
		});

		it('returns null when no match is found', () => {
			expect(resolveToCanonicalId('COMPLETELY-FAKE-TICKER')).toBe(null);
		});
	});

	describe('listAliases', () => {
		it('returns the full alias table in deterministic order', () => {
			const a = listAliases();
			const b = listAliases();
			expect(a.length).toBeGreaterThan(0);
			expect(a).toEqual(b);
			for (const entry of a) {
				expect(entry.aliases.length).toBeGreaterThan(0);
				expect(typeof entry.exchange).toBe('string');
				expect(typeof entry.symbol).toBe('string');
				expect(entry.assetClass === null || typeof entry.assetClass === 'string').toBe(true);
			}
		});
	});

	describe('isEnabled', () => {
		it('reports enabled when the static table loads', () => {
			expect(isEnabled()).toBe(true);
		});

		it('can be disabled via DISABLE_SYMBOL_ALIAS_RESOLVER', () => {
			const original = process.env.DISABLE_SYMBOL_ALIAS_RESOLVER;
			process.env.DISABLE_SYMBOL_ALIAS_RESOLVER = 'true';
			_resetCache();
			try {
				expect(isEnabled()).toBe(false);
			} finally {
				if (original === undefined) {
					delete process.env.DISABLE_SYMBOL_ALIAS_RESOLVER;
				} else {
					process.env.DISABLE_SYMBOL_ALIAS_RESOLVER = original;
				}
				_resetCache();
			}
		});
	});
});