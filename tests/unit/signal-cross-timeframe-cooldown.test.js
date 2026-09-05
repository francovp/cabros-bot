/* global jest, describe, it, expect, beforeEach */

const {
	createSignalCrossTimeframeCooldown,
	signalCrossTimeframeCooldown,
	SUPPRESSION_REASON,
	DEFAULT_WINDOW_MS,
	MIN_WINDOW_MS,
	MAX_WINDOW_MS,
	buildCrossTimeframeKey,
} = require('../../src/services/alerts/signalCrossTimeframeCooldown');

describe('signalCrossTimeframeCooldown', () => {
	beforeEach(() => {
		delete process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION;
		delete process.env.ALERT_CROSS_TF_WINDOW_MS;
	});

	describe('feature gate', () => {
		it('is disabled by default', () => {
			expect(signalCrossTimeframeCooldown.isEnabled()).toBe(false);
		});
		it('is enabled only with the exact "true" value', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			expect(signalCrossTimeframeCooldown.isEnabled()).toBe(true);
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = '1';
			expect(signalCrossTimeframeCooldown.isEnabled()).toBe(false);
		});
	});

	describe('buildCrossTimeframeKey', () => {
		it('normalizes case and joins exchange/symbol/side', () => {
			expect(buildCrossTimeframeKey({ exchange: 'binance', symbol: 'EthUsdt', side: 'compra' }))
				.toBe('BINANCE|ETHUSDT|COMPRA');
		});
		it('ignores timeframe so D and 240 share the same key', () => {
			const a = buildCrossTimeframeKey({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' });
			const b = buildCrossTimeframeKey({ exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '240', side: 'SELL' });
			expect(a).toBe(b);
		});
		it('returns null without symbol or side', () => {
			expect(buildCrossTimeframeKey({ symbol: null, side: 'BUY' })).toBeNull();
			expect(buildCrossTimeframeKey({ symbol: 'BTCUSDT', side: null })).toBeNull();
		});
	});

	describe('window math', () => {
		it('defaults to 60_000 ms when ALERT_CROSS_TF_WINDOW_MS is unset', () => {
			const cooldown = createSignalCrossTimeframeCooldown();
			expect(cooldown.resolveWindowMs()).toBe(DEFAULT_WINDOW_MS);
		});
		it('reads ALERT_CROSS_TF_WINDOW_MS from the runtime config (clamping happens in the Remote Config schema)', () => {
			process.env.ALERT_CROSS_TF_WINDOW_MS = '0';
			const c1 = createSignalCrossTimeframeCooldown();
			expect(c1.resolveWindowMs()).toBe(MIN_WINDOW_MS);

			process.env.ALERT_CROSS_TF_WINDOW_MS = '600000';
			const c2 = createSignalCrossTimeframeCooldown();
			expect(c2.resolveWindowMs()).toBe(MAX_WINDOW_MS);

			process.env.ALERT_CROSS_TF_WINDOW_MS = '90000';
			const c3 = createSignalCrossTimeframeCooldown();
			expect(c3.resolveWindowMs()).toBe(90000);
		});
	});

	describe('cross-timeframe suppression', () => {
		it('suppresses the second of two same-side signals on a different timeframe inside the window', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const first = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const second = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '240', side: 'SELL' };
			expect(cooldown.check(first, t0).suppressed).toBe(false);
			cooldown.record(first, t0);
			const verdict = cooldown.check(second, t0 + 400);
			expect(verdict.suppressed).toBe(true);
			expect(verdict.reason).toBe(SUPPRESSION_REASON);
			expect(verdict.priorTimeframe).toBe('1D');
			expect(verdict.incomingTimeframe).toBe('240');
		});

		it('does NOT suppress the same-side repeat on the SAME timeframe (owned by signalRepeatCooldown)', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const first = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const second = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			cooldown.record(first, t0);
			const verdict = cooldown.check(second, t0 + 100);
			expect(verdict.suppressed).toBe(false);
		});

		it('always allows opposite-side flips through and clears the prior entry', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const sell = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const buy = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '240', side: 'BUY' };
			cooldown.record(sell, t0);
			expect(cooldown.check(buy, t0 + 50).suppressed).toBe(false);
			cooldown.record(buy, t0 + 50);
			// After opposite-side flip, the prior SELL key is cleared
			expect(cooldown.check(sell, t0 + 60).suppressed).toBe(false);
		});

		it('does not suppress when the prior entry is outside the window', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const first = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const second = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '240', side: 'SELL' };
			cooldown.record(first, t0);
			expect(cooldown.check(second, t0 + DEFAULT_WINDOW_MS + 1).suppressed).toBe(false);
		});

		it('ALERT_CROSS_TF_WINDOW_MS=0 disables the rule even when the gate is on', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			process.env.ALERT_CROSS_TF_WINDOW_MS = '0';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const first = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const second = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '240', side: 'SELL' };
			cooldown.record(first, t0);
			expect(cooldown.check(second, t0 + 1).suppressed).toBe(false);
		});

		it('does NOT suppress across different exchanges for the same symbol', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const first = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const second = { exchange: 'KRAKEN', symbol: 'BTCUSDT', timeframe: '240', side: 'SELL' };
			cooldown.record(first, t0);
			expect(cooldown.check(second, t0 + 100).suppressed).toBe(false);
		});

		it('is disabled when ENABLE_ALERT_CROSS_TF_SUPPRESSION is unset', () => {
			expect(signalCrossTimeframeCooldown.isEnabled()).toBe(false);
		});
	});

	describe('fail-open behavior', () => {
		it('does not suppress when the store read throws', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const throwingStore = new Map();
			throwingStore.get = () => {
				throw new Error('store unavailable');
			};
			const cooldown = createSignalCrossTimeframeCooldown({ store: throwingStore });
			const signal = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			expect(cooldown.check(signal).suppressed).toBe(false);
		});

		it('does not throw when the store write fails', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const throwingStore = new Map();
			throwingStore.set = () => {
				throw new Error('store read-only');
			};
			const cooldown = createSignalCrossTimeframeCooldown({ store: throwingStore });
			const signal = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			expect(() => cooldown.record(signal, 1_700_000_000_000)).not.toThrow();
		});
	});

	describe('counters and stats', () => {
		it('recordSuppression increments suppressedCount and lastSuppressedAt', () => {
			process.env.ENABLE_ALERT_CROSS_TF_SUPPRESSION = 'true';
			const cooldown = createSignalCrossTimeframeCooldown();
			const t0 = 1_700_000_000_000;
			const first = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '1D', side: 'SELL' };
			const second = { exchange: 'BINANCE', symbol: 'BTCUSDT', timeframe: '240', side: 'SELL' };
			cooldown.record(first, t0);
			const verdict = cooldown.check(second, t0 + 100);
			expect(verdict.suppressed).toBe(true);
			cooldown.recordSuppression();
			const stats = cooldown.getStats(t0 + 100);
			expect(stats.suppressedCount).toBe(1);
			expect(typeof stats.lastSuppressedAt).toBe('string');
			expect(stats.activeTrackedSignals).toBe(1);
		});

		it('exposes SUPPRESSION_REASON as the cross_timeframe_duplicate sentinel', () => {
			expect(SUPPRESSION_REASON).toBe('cross_timeframe_duplicate');
			expect(signalCrossTimeframeCooldown.suppressionReason).toBe(SUPPRESSION_REASON);
		});
	});
});
