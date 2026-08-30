/* global jest, describe, it, expect, beforeEach */

const {
	createSignalFlipGuard,
	signalFlipGuard,
	DEFAULT_COOLDOWN_HOURS,
	HOUR_MS,
	buildFlipKey,
	oppositeOf,
} = require('../../src/services/alerts/signalFlipGuard');

describe('signalFlipGuard', () => {
	beforeEach(() => {
		delete process.env.ENABLE_ALERT_FLIP_GUARD;
		delete process.env.ALERT_FLIP_COOLDOWN_HOURS;
	});

	describe('feature gate', () => {
		it('is disabled by default', () => {
			expect(signalFlipGuard.isEnabled()).toBe(false);
			process.env.ENABLE_ALERT_FLIP_GUARD = 'false';
			expect(signalFlipGuard.isEnabled()).toBe(false);
		});

		it('is enabled only with the exact "true" value', () => {
			process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
			expect(signalFlipGuard.isEnabled()).toBe(true);
		});
	});

	describe('buildFlipKey', () => {
		it('normalizes case and joins three dimensions', () => {
			expect(buildFlipKey({ exchange: 'binance', symbol: 'EthUsdt', timeframe: '4H' }))
				.toBe('BINANCE|ETHUSDT|4h');
		});

		it('treats missing exchange as an empty segment', () => {
			expect(buildFlipKey({ symbol: 'NVDA', timeframe: '1D' }))
				.toBe('|NVDA|1d');
		});

		it('returns null without a symbol', () => {
			expect(buildFlipKey({ exchange: 'BINANCE', timeframe: '4h' })).toBeNull();
		});
	});

	describe('oppositeOf', () => {
		it('maps BUY to SELL and SELL to BUY', () => {
			expect(oppositeOf('BUY')).toBe('SELL');
			expect(oppositeOf('SELL')).toBe('BUY');
		});

		it('returns null for unknown sides', () => {
			expect(oppositeOf('HOLD')).toBeNull();
			expect(oppositeOf(null)).toBeNull();
		});
	});

	describe('cooldown hours', () => {
		it('defaults to 24 hours when ALERT_FLIP_COOLDOWN_HOURS is unset', () => {
			const guard = createSignalFlipGuard();
			expect(guard.resolveCooldownHours()).toBe(DEFAULT_COOLDOWN_HOURS);
		});

		it('honors ALERT_FLIP_COOLDOWN_HOURS via runtime config', () => {
			process.env.ALERT_FLIP_COOLDOWN_HOURS = '12';
			const guard = createSignalFlipGuard();
			expect(guard.resolveCooldownHours()).toBe(12);
		});

		it('falls back to default for malformed values', () => {
			process.env.ALERT_FLIP_COOLDOWN_HOURS = 'not-a-number';
			const guard = createSignalFlipGuard();
			expect(guard.resolveCooldownHours()).toBe(DEFAULT_COOLDOWN_HOURS);
		});

		it('clamps values outside 1-168 to the default', () => {
			process.env.ALERT_FLIP_COOLDOWN_HOURS = '0';
			expect(createSignalFlipGuard().resolveCooldownHours()).toBe(DEFAULT_COOLDOWN_HOURS);
			process.env.ALERT_FLIP_COOLDOWN_HOURS = '500';
			expect(createSignalFlipGuard().resolveCooldownHours()).toBe(DEFAULT_COOLDOWN_HOURS);
		});
	});

	describe('evaluate', () => {
		beforeEach(() => {
			process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
		});

		it('returns annotated=true when prior fire was the opposite side within the window', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			guard.recordFire({ ...signal, side: 'SELL' }, 1_000_000);
			const verdict = guard.evaluate(signal, 1_000_000 + 6 * HOUR_MS);
			expect(verdict.annotated).toBe(true);
			expect(verdict.previousDirection).toBe('SELL');
			expect(verdict.hoursDelta).toBe(6);
		});

		it('returns annotated=false when prior fire is the same side', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			guard.recordFire(signal, 1_000_000);
			expect(guard.evaluate(signal, 1_000_000 + 60_000).annotated).toBe(false);
		});

		it('returns annotated=false when prior fire is outside the cooldown window', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			guard.recordFire({ ...signal, side: 'SELL' }, 1_000_000);
			const verdict = guard.evaluate(signal, 1_000_000 + 25 * HOUR_MS);
			expect(verdict.annotated).toBe(false);
			expect(verdict.previousDirection).toBe('SELL');
		});

		it('does not annotate when the feature is disabled', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			guard.recordFire({ ...signal, side: 'SELL' }, 1_000_000);
			process.env.ENABLE_ALERT_FLIP_GUARD = 'false';
			expect(guard.evaluate(signal, 1_000_000 + 1000).annotated).toBe(false);
		});

		it('returns annotated=false when no prior fire exists', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			expect(guard.evaluate(signal, 1_000_000).annotated).toBe(false);
		});
	});

	describe('fail-open semantics', () => {
		beforeEach(() => {
			process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
		});

		it('returns no annotation when the store throws on read', () => {
			const throwingStore = {
				get() { throw new Error('store unavailable'); },
				set() { throw new Error('store unavailable'); },
			};
			const guard = createSignalFlipGuard({ store: throwingStore });
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			const verdict = guard.evaluate(signal);
			expect(verdict.annotated).toBe(false);
		});

		it('treats a missing store as fail-open', () => {
			const guard = createSignalFlipGuard({ store: null });
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			expect(guard.evaluate(signal).annotated).toBe(false);
			// recordFire with no store should not throw.
			expect(() => guard.recordFire(signal)).not.toThrow();
		});

		it('recordFire swallows write errors without breaking later reads', () => {
			const throwingStore = {
				get() { return null; },
				set() { throw new Error('store write failed'); },
			};
			const guard = createSignalFlipGuard({ store: throwingStore });
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'SELL' };
			expect(() => guard.recordFire(signal)).not.toThrow();
			expect(guard.evaluate({ ...signal, side: 'BUY' }).annotated).toBe(false);
		});
	});

	describe('stats and counters', () => {
		beforeEach(() => {
			process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
		});

		it('tracks annotation counters and active keys', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'SELL' };
			guard.recordFire(signal, 1_000_000);
			guard.recordAnnotation();
			const verdict = guard.evaluate({ ...signal, side: 'BUY' }, 1_000_000 + 1_000);
			expect(verdict.annotated).toBe(true);
			const stats = guard.getStats(1_000_000 + 1_000);
			expect(stats.annotatedCount).toBe(1);
			expect(stats.cooldownHours).toBe(DEFAULT_COOLDOWN_HOURS);
			expect(stats.activeTrackedKeys).toBe(1);
		});

		it('reset clears counters and tracked keys', () => {
			const guard = createSignalFlipGuard();
			const signal = { exchange: 'BINANCE', symbol: 'ETHUSDT', timeframe: '4h', side: 'BUY' };
			guard.recordFire({ ...signal, side: 'SELL' }, 1_000_000);
			guard.recordAnnotation();
			guard.reset();
			const stats = guard.getStats(1_000_000 + 1_000);
			expect(stats.annotatedCount).toBe(0);
			expect(stats.activeTrackedKeys).toBe(0);
		});
	});

	describe('eviction', () => {
		beforeEach(() => {
			process.env.ENABLE_ALERT_FLIP_GUARD = 'true';
		});

		it('drops keys outside the cooldown window', () => {
			const guard = createSignalFlipGuard();
			guard.recordFire({ exchange: 'BINANCE', symbol: 'A', timeframe: '4h', side: 'BUY' }, 1_000_000);
			guard.recordFire({ exchange: 'BINANCE', symbol: 'B', timeframe: '4h', side: 'SELL' }, 1_000_000);
			const future = 1_000_000 + DEFAULT_COOLDOWN_HOURS * HOUR_MS + 1_000;
			expect(guard.getStats(future).activeTrackedKeys).toBe(0);
		});
	});
});