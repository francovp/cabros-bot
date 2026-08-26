/* global jest, describe, it, expect, beforeEach */

const {
	createSignalRepeatCooldown,
	signalRepeatCooldown,
	TIMEFRAME_BAR_MS,
	buildSignalKey,
	DEFAULT_COOLDOWN_BARS,
	MAX_COOLDOWN_BARS,
	MAX_ENTRIES,
} = require('../../src/services/alerts/signalRepeatCooldown');

describe('signalRepeatCooldown', () => {
	beforeEach(() => {
		delete process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION;
		delete process.env.ALERT_SIGNAL_COOLDOWN_BARS;
	});

	describe('feature gate', () => {
		it('is disabled by default', () => {
			expect(signalRepeatCooldown.isEnabled()).toBe(false);
			process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'false';
			expect(signalRepeatCooldown.isEnabled()).toBe(false);
		});

		it('is enabled only with the exact "true" value', () => {
			process.env.ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION = 'true';
			expect(signalRepeatCooldown.isEnabled()).toBe(true);
		});
	});

	describe('buildSignalKey', () => {
		it('normalizes case and joins the four dimensions', () => {
			expect(buildSignalKey({ exchange: 'binance', symbol: 'EthUsdt', timeframe: '4H', side: 'compra' }))
				.toBe('BINANCE|ETHUSDT|4h|COMPRA');
		});

		it('treats a missing exchange as an empty segment', () => {
			expect(buildSignalKey({ exchange: null, symbol: 'NVDA', timeframe: '1D', side: 'SELL' }))
				.toBe('|NVDA|1d|SELL');
		});

		it('returns null without symbol or side', () => {
			expect(buildSignalKey({ symbol: null, side: 'BUY' })).toBeNull();
			expect(buildSignalKey({ symbol: 'BTCUSDT', side: null })).toBeNull();
		});
	});

	describe('cooldown window', () => {
		it('defaults to 1 bar when ALERT_SIGNAL_COOLDOWN_BARS is unset', () => {
			const cooldown = createSignalRepeatCooldown();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const first = cooldown.isSuppressed(signal, 10_000_000);
			expect(first.suppressed).toBe(false);
			cooldown.recordFire(first.key, 10_000_000);
			const withinWindow = cooldown.isSuppressed(signal, 10_000_000 + TIMEFRAME_BAR_MS['4h'] - 1);
			expect(withinWindow.suppressed).toBe(true);
			const afterWindow = cooldown.isSuppressed(signal, 10_000_000 + TIMEFRAME_BAR_MS['4h']);
			expect(afterWindow.suppressed).toBe(false);
		});

		it('suppresses same-side repeats inside one bar and allows after it elapses (ETHUSDT COMPRA scenario)', () => {
			const cooldown = createSignalRepeatCooldown();
			const compra = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const t0 = 1_700_000_000_000;
			let verdict = cooldown.isSuppressed(compra, t0);
			expect(verdict.suppressed).toBe(false);
			cooldown.recordFire(verdict.key, t0);

			for (const offsetMs of [1000, TIMEFRAME_BAR_MS['4h'] / 2, TIMEFRAME_BAR_MS['4h'] - 60_000]) {
				verdict = cooldown.isSuppressed(compra, t0 + offsetMs);
				expect(verdict.suppressed).toBe(true);
			}

			verdict = cooldown.isSuppressed(compra, t0 + TIMEFRAME_BAR_MS['4h']);
			expect(verdict.suppressed).toBe(false);
		});

		it('always allows opposite-side flips through', () => {
			const cooldown = createSignalRepeatCooldown();
			const buy = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1h', side: 'BUY' };
			const sell = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1h', side: 'SELL' };
			const now = Date.now();
			const verdictBuy = cooldown.isSuppressed(buy, now);
			cooldown.recordFire(verdictBuy.key, now);
			expect(cooldown.isSuppressed(sell, now + 1000).suppressed).toBe(false);
		});

		it('keys different timeframes independently', () => {
			const cooldown = createSignalRepeatCooldown();
			const h1 = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '1h', side: 'BUY' };
			const h4 = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const now = Date.now();
			const verdictH1 = cooldown.isSuppressed(h1, now);
			cooldown.recordFire(verdictH1.key, now);
			expect(cooldown.isSuppressed(h4, now + 1000).suppressed).toBe(false);
		});

		it('honors ALERT_SIGNAL_COOLDOWN_BARS multiplier via runtime config and clamps out-of-range remote values', () => {
			const cooldown = createSignalRepeatCooldown();
			process.env.ALERT_SIGNAL_COOLDOWN_BARS = '2';
			const signal = { exchange: 'BATS', symbol: 'NVDA', timeframe: '1D', side: 'SELL' };
			const t0 = Date.now();
			const verdict = cooldown.isSuppressed(signal, t0);
			cooldown.recordFire(verdict.key, t0);
			expect(cooldown.isSuppressed(signal, t0 + TIMEFRAME_BAR_MS['1D'] - 1).suppressed).toBe(true);
			expect(cooldown.isSuppressed(signal, t0 + 2 * TIMEFRAME_BAR_MS['1D']).suppressed).toBe(false);

			process.env.ALERT_SIGNAL_COOLDOWN_BARS = '-5';
			expect(cooldown.isSuppressed(signal, t0 + TIMEFRAME_BAR_MS['1D']).windowMs)
				.toBe(DEFAULT_COOLDOWN_BARS * TIMEFRAME_BAR_MS['1D']);

			// Remote Config schema rejects out-of-range overrides and falls back
			// to the default, so the window stays at one bar.
			process.env.ALERT_SIGNAL_COOLDOWN_BARS = String(MAX_COOLDOWN_BARS + 50);
			expect(cooldown.isSuppressed(signal, t0 + TIMEFRAME_BAR_MS['1D']).windowMs)
				.toBe(DEFAULT_COOLDOWN_BARS * TIMEFRAME_BAR_MS['1D']);
			delete process.env.ALERT_SIGNAL_COOLDOWN_BARS;
		});
	});

	describe('fail-open behavior', () => {
		it('delivers (does not suppress) when the store read throws', () => {
			const throwingStore = new Map();
			throwingStore.get = () => {
				throw new Error('store unavailable');
			};
			const cooldown = createSignalRepeatCooldown({ store: throwingStore });
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			expect(cooldown.isSuppressed(signal).suppressed).toBe(false);
		});

		it('does not throw when the store write fails', () => {
			const throwingStore = new Map();
			throwingStore.set = () => {
				throw new Error('store read-only');
			};
			const cooldown = createSignalRepeatCooldown({ store: throwingStore });
			expect(() => cooldown.recordFire('BINANCE|ETHUSDT|4h|BUY')).not.toThrow();
		});
	});

	describe('reservations', () => {
		it('reserves before delivery so overlapping requests cannot both send', () => {
			const cooldown = createSignalRepeatCooldown();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const first = cooldown.reserve(signal, ['telegram'], 10_000);
			const overlapping = cooldown.reserve(signal, ['telegram'], 10_001);

			expect(first.suppressed).toBe(false);
			expect(first.channels).toEqual(['telegram']);
			expect(overlapping.suppressed).toBe(true);
		});

		it('releases only failed channels after partial delivery', () => {
			const cooldown = createSignalRepeatCooldown();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const first = cooldown.reserve(signal, ['telegram', 'discord'], 10_000);
			cooldown.finalize(first.key, first.channels, ['telegram'], 10_000);

			const retry = cooldown.reserve(signal, ['telegram', 'discord'], 10_001);
			expect(retry.suppressed).toBe(false);
			expect(retry.channels).toEqual(['discord']);
		});

		it('releases a reservation when a queued redrive becomes terminal', () => {
			const cooldown = createSignalRepeatCooldown();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const first = cooldown.reserve(signal, ['telegram:destination-a'], 10_000);

			cooldown.release(first.key, first.channels);

			expect(cooldown.reserve(signal, ['telegram:destination-a'], 10_001).suppressed).toBe(false);
		});

		it('refreshes a redriven channel timestamp after successful delivery', () => {
			const cooldown = createSignalRepeatCooldown();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '5m', side: 'BUY' };
			const first = cooldown.reserve(signal, ['telegram:destination-a'], 10_000);
			cooldown.finalize(first.key, first.channels, first.channels);

			cooldown.refresh(first.key, first.channels, 20_000);

			expect(cooldown.isSuppressed(signal, 20_000 + TIMEFRAME_BAR_MS['5m'] - 1).suppressed).toBe(true);
		});

		it('keeps the prior side active when an opposite-side delivery fails', () => {
			const cooldown = createSignalRepeatCooldown();
			const buy = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const sell = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'SELL' };
			const buyReservation = cooldown.reserve(buy, ['telegram'], 10_000);
			cooldown.finalize(buyReservation.key, buyReservation.channels, ['telegram']);
			const sellReservation = cooldown.reserve(sell, ['telegram'], 10_001);
			cooldown.finalize(sellReservation.key, sellReservation.channels, []);

			expect(cooldown.reserve(buy, ['telegram'], 10_002).suppressed).toBe(true);
		});

		it('clears opposite-side state only for delivered channels when failures are retained', () => {
			const cooldown = createSignalRepeatCooldown();
			const buy = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const sell = { ...buy, side: 'SELL' };
			const buyReservation = cooldown.reserve(buy, ['telegram', 'discord'], 10_000);
			cooldown.finalize(buyReservation.key, buyReservation.channels, buyReservation.channels);
			const sellReservation = cooldown.reserve(sell, ['telegram', 'discord'], 10_001);

			cooldown.finalize(sellReservation.key, sellReservation.channels, sellReservation.channels, ['telegram']);

			const retry = cooldown.reserve(buy, ['telegram', 'discord'], 10_002);
			expect(retry.suppressed).toBe(false);
			expect(retry.channels).toEqual(['telegram']);
		});

		it('keeps the last completed overlapping flip as the active cooldown', () => {
			const cooldown = createSignalRepeatCooldown();
			const buy = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const sell = { ...buy, side: 'SELL' };
			const now = Date.now();
			const buyReservation = cooldown.reserve(buy, ['telegram'], now);
			const sellReservation = cooldown.reserve(sell, ['telegram'], now + 1);

			cooldown.finalize(sellReservation.key, sellReservation.channels, sellReservation.channels);
			cooldown.finalize(buyReservation.key, buyReservation.channels, buyReservation.channels);

			expect(cooldown.reserve(buy, ['telegram'], Date.now()).suppressed).toBe(true);
		});
	});

	describe('bounded storage', () => {
		it('evicts oldest entries when the map exceeds its hard cap', () => {
			const store = new Map();
			const cooldown = createSignalRepeatCooldown({ store });
			const now = 10_000;

			for (let index = 0; index <= MAX_ENTRIES; index += 1) {
				cooldown.recordFire(`BINANCE|SYM${index}|1h|BUY`, now + index);
			}

			expect(store.size).toBe(MAX_ENTRIES);
			expect(store.has('BINANCE|SYM0|1h|BUY')).toBe(false);
		});
	});

	describe('stats and counters', () => {
		it('tracks suppression counters for /api/status', () => {
			const cooldown = createSignalRepeatCooldown();
			cooldown.recordSuppression();
			cooldown.recordSuppression();
			const stats = cooldown.getStats();
			expect(stats.suppressedCount).toBe(2);
			expect(typeof stats.lastSuppressedAt).toBe('string');
			expect(stats.activeTrackedSignals).toBe(0);
		});

		it('counts active tracked signals after fires', () => {
			const cooldown = createSignalRepeatCooldown();
			const now = Date.now();
			const verdict = cooldown.isSuppressed(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' },
				now,
			);
			cooldown.recordFire(verdict.key, now);
			expect(cooldown.getStats(now).activeTrackedSignals).toBe(1);
		});

		it('reset clears counters and tracked signals', () => {
			const cooldown = createSignalRepeatCooldown();
			cooldown.recordSuppression();
			cooldown.recordFire('K', Date.now());
			cooldown.reset();
			const stats = cooldown.getStats();
			expect(stats.suppressedCount).toBe(0);
			expect(stats.activeTrackedSignals).toBe(0);
		});
	});

	describe('unknown timeframes', () => {
		it('never suppresses signals whose timeframe has no bar mapping', () => {
			const cooldown = createSignalRepeatCooldown();
			const verdict = cooldown.isSuppressed(
				{ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '3m', side: 'BUY' },
				Date.now(),
			);
			expect(verdict.suppressed).toBe(false);
		});
	});

	describe('flip invalidation (BUY → SELL → BUY)', () => {
		it('clears the prior side so a re-flip delivers instead of being suppressed', () => {
			const cooldown = createSignalRepeatCooldown();
			const buy = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const sell = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'SELL' };
			const t0 = Date.now();

			let verdict = cooldown.isSuppressed(buy, t0);
			cooldown.recordFire(verdict.key, t0);

			// Flip to SELL inside the window and deliver it.
			verdict = cooldown.isSuppressed(sell, t0 + 1000);
			expect(verdict.suppressed).toBe(false);
			cooldown.recordFire(verdict.key, t0 + 1000);

			// Flip back to BUY: the stale first-BUY timestamp must not suppress it.
			verdict = cooldown.isSuppressed(buy, t0 + 2000);
			expect(verdict.suppressed).toBe(false);
		});

		it('exposes oppositeKeyOf helper for key inversion', () => {
			const { buildSignalKey } = require('../../src/services/alerts/signalRepeatCooldown');
			const key = buildSignalKey({ exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' });
			const cooldown2 = createSignalRepeatCooldown();
			// recordFire on the SELL twin removes the BUY entry.
			cooldown2.recordFire(key, Date.now());
			expect(cooldown2.getStats().activeTrackedSignals).toBe(1);
		});
	});
});
