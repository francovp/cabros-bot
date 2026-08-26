/* global jest, describe, it, expect, beforeEach */

const {
	createSignalRepeatCooldown,
	signalRepeatCooldown,
	TIMEFRAME_BAR_MS,
	buildSignalKey,
	DEFAULT_COOLDOWN_BARS,
	MAX_COOLDOWN_BARS,
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

		it('honors ALERT_SIGNAL_COOLDOWN_BARS multiplier and clamps invalid values', () => {
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

			process.env.ALERT_SIGNAL_COOLDOWN_BARS = String(MAX_COOLDOWN_BARS + 50);
			expect(cooldown.isSuppressed(signal, t0 + TIMEFRAME_BAR_MS['1D']).windowMs)
				.toBe(MAX_COOLDOWN_BARS * TIMEFRAME_BAR_MS['1D']);
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
});
