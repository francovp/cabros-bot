'use strict';

const {
	classifySession,
	isEquityExchange,
	isCryptoExchange,
	lookupUsEquityHolidays,
	formatSessionLabelSpanish,
} = require('../../src/services/storage/EquitySessionService');

describe('EquitySessionService', () => {
	describe('isEquityExchange and isCryptoExchange', () => {
		it('recognizes equity exchanges including variants', () => {
			expect(isEquityExchange('NASDAQ')).toBe(true);
			expect(isEquityExchange('BATS')).toBe(true);
			expect(isEquityExchange('NYSE')).toBe(true);
			expect(isEquityExchange('AMEX')).toBe(true);
			expect(isEquityExchange('NYSE ARCA')).toBe(true);
			expect(isEquityExchange('NYSE_ARCA')).toBe(true);
			expect(isEquityExchange('ARCA')).toBe(true);
			expect(isEquityExchange('CBOE')).toBe(true);
			expect(isEquityExchange('BINANCE')).toBe(false);
			expect(isEquityExchange('FX_IDC')).toBe(false);
		});

		it('recognizes crypto exchanges', () => {
			expect(isCryptoExchange('BINANCE')).toBe(true);
			expect(isCryptoExchange('BYBIT')).toBe(true);
			expect(isCryptoExchange('COINBASE')).toBe(true);
			expect(isCryptoExchange('OKX')).toBe(true);
			expect(isCryptoExchange('NASDAQ')).toBe(false);
		});
	});

	describe('classifySession', () => {
		it('returns 24/7 for crypto exchanges and symbols', () => {
			expect(classifySession({ exchange: 'BINANCE', symbol: 'BTCUSDT' })).toBe('24/7');
			expect(classifySession({ exchange: 'BYBIT', symbol: 'ETHUSDT' })).toBe('24/7');
			expect(classifySession({ symbol: 'BTCUSDT' })).toBe('24/7');
		});

		it('returns 24/7 for non-equity venues', () => {
			expect(classifySession({ exchange: 'FX_IDC', symbol: 'EURUSD' })).toBe('24/7');
		});

		it('classifies regular trading hours (13:30 - 20:00 UTC)', () => {
			// 2026-06-10 is Wednesday (non-holiday)
			// 14:00 UTC
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AAPL',
				timestamp: '2026-06-10T14:00:00.000Z',
			})).toBe('regular');

			// Exactly 13:30 UTC
			expect(classifySession({
				exchange: 'NYSE',
				symbol: 'NVDA',
				timestamp: '2026-06-10T13:30:00.000Z',
			})).toBe('regular');

			// 19:59 UTC
			expect(classifySession({
				exchange: 'BATS',
				symbol: 'MSFT',
				timestamp: '2026-06-10T19:59:00.000Z',
			})).toBe('regular');
		});

		it('classifies pre-market hours (08:00 - 13:30 UTC)', () => {
			// 08:00 UTC
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AAPL',
				timestamp: '2026-06-10T08:00:00.000Z',
			})).toBe('pre');

			// 12:00 UTC
			expect(classifySession({
				exchange: 'NYSE',
				symbol: 'TSLA',
				timestamp: '2026-06-10T12:00:00.000Z',
			})).toBe('pre');

			// 13:29 UTC
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AMZN',
				timestamp: '2026-06-10T13:29:59.000Z',
			})).toBe('pre');
		});

		it('classifies post-market / after-hours (20:00 - 00:00 UTC)', () => {
			// 20:00 UTC
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AAPL',
				timestamp: '2026-06-10T20:00:00.000Z',
			})).toBe('post');

			// 22:30 UTC
			expect(classifySession({
				exchange: 'BATS',
				symbol: 'SPY',
				timestamp: '2026-06-10T22:30:00.000Z',
			})).toBe('post');

			// 23:59 UTC
			expect(classifySession({
				exchange: 'NYSE',
				symbol: 'JPM',
				timestamp: '2026-06-10T23:59:59.000Z',
			})).toBe('post');
		});

		it('classifies closed hours (00:00 - 08:00 UTC, weekends, and US holidays)', () => {
			// Overnight weekday 03:00 UTC
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AAPL',
				timestamp: '2026-06-10T03:00:00.000Z',
			})).toBe('closed');

			// Weekend (Saturday)
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AAPL',
				timestamp: '2026-06-13T15:00:00.000Z',
			})).toBe('closed');

			// Weekend (Sunday)
			expect(classifySession({
				exchange: 'NYSE',
				symbol: 'NVDA',
				timestamp: '2026-06-14T15:00:00.000Z',
			})).toBe('closed');

			// US Holiday (New Year's Day 2026-01-01)
			expect(classifySession({
				exchange: 'NASDAQ',
				symbol: 'AAPL',
				timestamp: '2026-01-01T15:00:00.000Z',
			})).toBe('closed');

			// US Holiday (Good Friday 2026-04-03)
			expect(classifySession({
				exchange: 'NYSE',
				symbol: 'NVDA',
				timestamp: '2026-04-03T15:00:00.000Z',
			})).toBe('closed');
		});

		it('formats Spanish labels correctly', () => {
			expect(formatSessionLabelSpanish('regular')).toBe('regular');
			expect(formatSessionLabelSpanish('pre')).toBe('pre');
			expect(formatSessionLabelSpanish('post')).toBe('post');
			expect(formatSessionLabelSpanish('closed')).toBe('cerrado');
			expect(formatSessionLabelSpanish('24/7')).toBe('24/7');
		});
	});

	describe('formatSessionLine', () => {
		const { formatSessionLine, isEquitySessionTagEnabled } = require('../../src/services/storage/EquitySessionService');

		it('formats session line for regular, pre, post, and closed', () => {
			expect(formatSessionLine('regular')).toBe('🌐 Sesión: regular');
			expect(formatSessionLine('pre')).toBe('🌐 Sesión: pre');
			expect(formatSessionLine('post')).toBe('🌐 Sesión: post');
			expect(formatSessionLine('closed')).toBe('🌐 Sesión: cerrado');
		});

		it('returns null for 24/7, unknown, or falsy session', () => {
			expect(formatSessionLine('24/7')).toBeNull();
			expect(formatSessionLine('unknown')).toBeNull();
			expect(formatSessionLine(null)).toBeNull();
			expect(formatSessionLine('')).toBeNull();
		});

		it('supports markdownV2 escaping', () => {
			const formatted = formatSessionLine('closed', { markdownV2: true });
			expect(formatted).toBe('🌐 Sesión: cerrado');
		});

		it('returns true for isEquitySessionTagEnabled by default', () => {
			expect(isEquitySessionTagEnabled()).toBe(true);
		});
	});
});

