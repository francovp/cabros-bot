/* global describe, it, expect, beforeEach, afterEach */

const {
	createCrossTimeframeCooldown,
	crossTimeframeCooldown,
	buildCrossTimeframeKey,
	oppositeCrossTimeframeKeyOf,
	normalizeCrossTimeframe,
	CROSS_TIMEFRAME_SUPPRESSION_REASON,
	DEFAULT_WINDOW_MS,
	MAX_WINDOW_MS,
	MAX_ENTRIES,
} = require('../../src/services/alerts/crossTimeframeCooldown');

const { parseTradingViewSignal } = require('../../src/services/tradingview/parseTradingViewSignal');

function throwingStore(overrides = {}) {
	const broken = {
		get() {
			throw new Error('store read exploded');
		},
		set() {
			throw new Error('store write exploded');
		},
		delete() {
			throw new Error('store delete exploded');
		},
		entries() {
			throw new Error('store iteration exploded');
		},
		...overrides,
	};
	broken.size = 0;
	return broken;
}

describe('crossTimeframeCooldown', () => {
	beforeEach(() => {
		delete process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION;
		delete process.env.ALERT_CROSS_TF_WINDOW_MS;
	});

	describe('feature gate', () => {
		it('is disabled by default', () => {
			expect(crossTimeframeCooldown.isEnabled()).toBe(false);
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'false';
			expect(crossTimeframeCooldown.isEnabled()).toBe(false);
		});

		it('is enabled only with the exact "true" value', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			expect(crossTimeframeCooldown.isEnabled()).toBe(true);
		});
	});

	describe('buildCrossTimeframeKey', () => {
		it('normalizes case and joins the three dimensions without timeframe', () => {
			expect(buildCrossTimeframeKey({ exchange: 'binance', symbol: 'EthUsdt', timeframe: '4h', side: 'compra' }))
				.toBe('BINANCE|ETHUSDT|COMPRA');
			expect(buildCrossTimeframeKey({ exchange: 'binance', symbol: 'EthUsdt', timeframe: '1D', side: 'BUY' }))
				.toBe('BINANCE|ETHUSDT|BUY');
		});

		it('treats a missing exchange as an empty segment', () => {
			expect(buildCrossTimeframeKey({ exchange: null, symbol: 'NVDA', timeframe: '1D', side: 'SELL' }))
				.toBe('|NVDA|SELL');
		});

		it('returns null without symbol or side', () => {
			expect(buildCrossTimeframeKey({ symbol: null, side: 'BUY' })).toBeNull();
			expect(buildCrossTimeframeKey({ symbol: 'BTCUSDT', side: null })).toBeNull();
		});
	});

	describe('normalizeCrossTimeframe', () => {
		it('lowercases and trims, mapping falsy values to an empty string', () => {
			expect(normalizeCrossTimeframe('1D')).toBe('1d');
			expect(normalizeCrossTimeframe(' 4H ')).toBe('4h');
			expect(normalizeCrossTimeframe(null)).toBe('');
			expect(normalizeCrossTimeframe(undefined)).toBe('');
		});
	});

	describe('oppositeCrossTimeframeKeyOf', () => {
		it('flips only the side segment', () => {
			expect(oppositeCrossTimeframeKeyOf('BINANCE|BTCUSDT|BUY')).toBe('BINANCE|BTCUSDT|SELL');
			expect(oppositeCrossTimeframeKeyOf('BINANCE|BTCUSDT|SELL')).toBe('BINANCE|BTCUSDT|BUY');
		});

		it('returns null for malformed keys', () => {
			expect(oppositeCrossTimeframeKeyOf(null)).toBeNull();
			expect(oppositeCrossTimeframeKeyOf('only|two')).toBeNull();
		});
	});

	describe('cross-timeframe collapse', () => {
		it('suppresses a different-timeframe signal on the same exchange/symbol/side', () => {
			const cooldown = createCrossTimeframeCooldown();
			const base = 1_000_000_000;

			const first = cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base);
			expect(first.suppressed).toBe(false);

			const second = cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 400);
			expect(second.suppressed).toBe(true);
			expect(second.reason).toBe(CROSS_TIMEFRAME_SUPPRESSION_REASON);
			expect(second.key).toBe('BINANCE|BTCUSDT|SELL');
			expect(second.conflictingTimeframe).toBe('1d');
			expect(second.suppressedTimeframe).toBe('4h');
			expect(second.windowMs).toBe(DEFAULT_WINDOW_MS);
			expect(second.elapsedMs).toBe(400);
			expect(second.retryInMs).toBe(DEFAULT_WINDOW_MS - 400);
		});

		it('collapses a burst of same-direction signals across several timeframes into one', () => {
			const cooldown = createCrossTimeframeCooldown();
			const base = 5_000_000_000;
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'BUY' }, base);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'BUY' }, base + 100).suppressed).toBe(true);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1h', side: 'BUY' }, base + 200).suppressed).toBe(true);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '15m', side: 'BUY' }, base + 300).suppressed).toBe(true);
			expect(cooldown.getStats(base + 300).suppressedCount).toBe(0); // counters only move via recordSuppression()
		});

		it('never suppresses the same timeframe (that stays CB-230 responsibility)', () => {
			const cooldown = createCrossTimeframeCooldown();
			const base = 42;
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base).suppressed).toBe(false);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 10).suppressed).toBe(false);
		});

		it('slides the window from the most recent delivered signal', () => {
			process.env.ALERT_CROSS_TF_WINDOW_MS = '60000';
			const cooldown = createCrossTimeframeCooldown();
			const base = 1_000;
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base);
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base + 50_000);

			// 70s after the *first* signal but only 20s after the sliding one.
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 70_000).suppressed).toBe(true);
			// Past the sliding entry's window.
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 110_001).suppressed).toBe(false);
		});

		it('never collapses an opposite-side flip', () => {
			const cooldown = createCrossTimeframeCooldown();
			const base = 7_000;
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'BUY' }, base).suppressed).toBe(false);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 400).suppressed).toBe(false);
			// The flip also clears the prior side, so a later same-direction
			// signal on another timeframe is delivered rather than swallowed.
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'BUY' }, base + 800).suppressed).toBe(false);
		});

		it('delivers again once the window expires', () => {
			process.env.ALERT_CROSS_TF_WINDOW_MS = '1000';
			const cooldown = createCrossTimeframeCooldown();
			const base = 9_000;
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 999).suppressed).toBe(true);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base + 1000).suppressed).toBe(false);
		});

		it('treats a zero window as "never collapse"', () => {
			process.env.ALERT_CROSS_TF_WINDOW_MS = '0';
			const cooldown = createCrossTimeframeCooldown();
			const base = 11_000;
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base);
			const verdict = cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base);
			expect(verdict.windowMs).toBe(0);
			expect(verdict.suppressed).toBe(false);
		});

		it('falls back to the default window for invalid configuration', () => {
			// ALERT_CROSS_TF_WINDOW_MS is bounded 0-600000 in PARAMETER_SCHEMA, so
			// out-of-range/non-integer/unparseable values are rejected upstream and
			// surface as the documented 60000ms default rather than a silent clamp.
			for (const invalid of [String(MAX_WINDOW_MS + 5000), '-5', '1.5', 'not-a-number']) {
				process.env.ALERT_CROSS_TF_WINDOW_MS = invalid;
				expect(createCrossTimeframeCooldown().reserve({ symbol: 'BTCUSDT', side: 'SELL', timeframe: '1D' }).windowMs)
					.toBe(DEFAULT_WINDOW_MS);
			}

			// Documented boundary: shared parseBoundedNumber() coerces a whitespace-only
			// value to 0 (the "never collapse" window), not to the default. Inert
			// because the feature flag gates it, and visible via /api/status windowMs.
			process.env.ALERT_CROSS_TF_WINDOW_MS = ' ';
			expect(createCrossTimeframeCooldown().reserve({ symbol: 'BTCUSDT', side: 'SELL', timeframe: '1D' }).windowMs).toBe(0);

			for (const valid of ['0', '1', String(MAX_WINDOW_MS)]) {
				process.env.ALERT_CROSS_TF_WINDOW_MS = valid;
				const windowMs = createCrossTimeframeCooldown().reserve({ symbol: 'BTCUSDT', side: 'SELL', timeframe: '1D' }).windowMs;
				expect(windowMs).toBe(Number(valid));
				expect(windowMs).toBeGreaterThanOrEqual(0);
				expect(windowMs).toBeLessThanOrEqual(MAX_WINDOW_MS);
			}
		});

		it('ignores clock rewind instead of suppressing on a negative elapsed time', () => {
			const cooldown = createCrossTimeframeCooldown();
			const base = 20_000;
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' }, base - 5_000).suppressed).toBe(false);
		});

		it('skips signals without a usable timeframe or side', () => {
			const cooldown = createCrossTimeframeCooldown();
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', side: 'SELL' }).suppressed).toBe(false);
			expect(cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D' }).suppressed).toBe(false);
			expect(cooldown.reserve(null).suppressed).toBe(false);
		});

		it('fails open when the store throws', () => {
			const cooldown = createCrossTimeframeCooldown({ store: throwingStore() });
			const verdict = cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '4h', side: 'SELL' });
			expect(verdict.suppressed).toBe(false);
			expect(verdict.storeError).toBe(true);
		});

		it('bounds the store and drops expired entries', () => {
			const store = new Map();
			const cooldown = createCrossTimeframeCooldown({ store });
			const base = 1_000;
			for (let index = 0; index <= MAX_ENTRIES + 20; index += 1) {
				cooldown.reserve({ exchange: 'BINANCE', symbol: `SYM${index}`, timeframe: '1D', side: 'BUY' }, base + index);
			}
			expect(store.size).toBeLessThanOrEqual(MAX_ENTRIES);
		});

		it('records suppression counters and resets them', () => {
			process.env.ALERT_CROSS_TF_WINDOW_MS = '5000';
			const cooldown = createCrossTimeframeCooldown();
			const base = 77_000;
			cooldown.reserve({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' }, base);
			cooldown.recordSuppression();
			const stats = cooldown.getStats(base + 10);
			expect(stats.suppressedCount).toBe(1);
			expect(typeof stats.lastSuppressedAt).toBe('string');
			expect(stats.activeTrackedSignals).toBe(1);
			expect(stats.windowMs).toBe(5000);
			cooldown.reset();
			expect(cooldown.getStats(base + 10)).toEqual({
				suppressedCount: 0,
				lastSuppressedAt: null,
				activeTrackedSignals: 0,
				windowMs: 5000,
			});
		});

		it('reports zero active signals when the store cannot be iterated', () => {
			const cooldown = createCrossTimeframeCooldown({ store: throwingStore() });
			expect(cooldown.getStats().activeTrackedSignals).toBe(0);
		});
	});

	describe('production evidence replay', () => {
		afterEach(() => {
			delete process.env.ALERT_CROSS_TF_WINDOW_MS;
		});

		it('collapses the 2026-08-31 BTCUSDT D + 240 SELL pair quoted in issue #1103', () => {
			process.env.ALERT_CROSS_TF_WINDOW_MS = '60000';
			// Exact texts and 426ms gap from GET /api/alerts/export
			// (window 2026-08-22 -> 2026-09-05), quoted in the issue body.
			const exportRows = [
				{
					receivedAt: '2026-08-31T00:00:25.419Z',
					text: 'BINANCE:BTCUSDT(D) cambió a señal de VENTA',
				},
				{
					receivedAt: '2026-08-31T00:00:25.845Z',
					text: 'BINANCE:BTCUSDT(240) pasó a señal de VENTA',
				},
			];

			const cooldown = createCrossTimeframeCooldown();
			let collapsed = 0;
			let delivered = 0;
			const base = Date.parse('2026-08-31T00:00:25.419Z');
			for (const row of exportRows) {
				const parsed = parseTradingViewSignal(row.text);
				expect(parsed).not.toBeNull();
				const verdict = cooldown.reserve(parsed, Date.parse(row.receivedAt));
				expect(verdict.key).toBe('BINANCE|BTCUSDT|SELL');
				if (verdict.suppressed) {
					collapsed += 1;
					cooldown.recordSuppression();
				} else {
					delivered += 1;
				}
			}

			expect(delivered).toBe(1);
			expect(collapsed).toBe(1);
			expect(cooldown.getStats(base + 426).suppressedCount).toBe(1);
		});
	});
});