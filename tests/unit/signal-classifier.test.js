'use strict';

/**
 * Deterministic, channel-neutral signal classification.
 *
 * The assertions below use REAL alert payloads (the shapes TradingView webhooks
 * and manual operator messages actually produce in production) rather than
 * synthetic keyword fixtures, because production evidence showed 100% of stored
 * alerts landing in `unknown` while the marker flag was ON.
 */
const {
	classifySignal,
	SignalClassMetrics,
	signalClassMetrics,
} = require('../../src/services/alerts/signalClassifier');

describe('signalClassifier', () => {
	describe('classifies realistic production payloads', () => {
		it.each([
			// Breakout: explicit breakout vocabulary and price breaking structure.
			['BTCUSDT broke resistance with strong volume', 'breakout'],
			['BINANCE:BTCUSDT breakout', 'breakout'],
			['BTCUSDT breakout confirmed', 'breakout'],
			['Bitcoin breaks resistance', 'breakout'],
			['BTC is breaking resistance at $90k with huge volume', 'breakout'],
			['SOL breakout 200', 'breakout'],
			// Volume spike: volume is the primary subject of the alert.
			['BTCUSDT volume spike above 20-period average', 'volume_spike'],
			['ETHUSDT sudden volume explosion on support', 'volume_spike'],
			// Mean reversion: stretched/extremes language.
			['ETHUSDT oversold bounce', 'mean_reversion'],
			['BTCUSDT RSI deeply oversold at key support', 'mean_reversion'],
			['ETHUSDT overbought rejection at resistance', 'mean_reversion'],
			// Reversal: a directional flip is the subject.
			['BINANCE:ETHUSDT reversal', 'reversal'],
			['BTCUSDT bearish reversal after double top', 'reversal'],
			// Trend continuation: trend/continuation vocabulary.
			['BTCUSDT uptrend continuation on 4h', 'trend_continuation'],
			['ETHUSDT trend continuation entry', 'trend_continuation'],
			// News event: an external, headline-driven catalyst.
			['BTCUSDT: Bitcoin surges on positive news', 'news_event'],
			['ETHUSDT surges after SEC approves spot ETF', 'news_event'],
			['SOLUSDT announced partnership with BlackRock', 'news_event'],
			// Manual: operator-authored notes.
			['manual review of BTCUSDT position sizing', 'manual'],
			['nota manual: revisar posicion BTCUSDT', 'manual'],
		])('classifies %j as %s', (text, expected) => {
			expect(classifySignal(text)).toBe(expected);
		});

		it('classifies a descriptive TradingView-style alert that previously returned unknown', () => {
			// Before classification existed, this production payload shape was
			// persisted as `unknown`, which is why the live badge marker never
			// rendered despite the flag being ON.
			expect(classifySignal('BTCUSDT broke resistance with strong volume')).toBe('breakout');
		});

		it('resolves precedence when several signals appear in one payload', () => {
			// "strong volume" is a modifier; the structural break is the subject.
			expect(classifySignal('BTCUSDT broke resistance with strong volume')).toBe('breakout');
			// A headline catalyst outranks the price move it describes.
			expect(classifySignal('BTCUSDT broke resistance after SEC approves spot ETF')).toBe('news_event');
			// An oversold extreme outranks a bare "reversal" word nearby.
			expect(classifySignal('ETHUSDT overbought rejection at resistance')).toBe('mean_reversion');
		});

		it('prefers a caller-supplied explicit class over the derived one', () => {
			expect(classifySignal('BTCUSDT breakout confirmed', { explicit: 'news_event' })).toBe('news_event');
		});

		it('normalizes an explicit class case-insensitively', () => {
			expect(classifySignal('SOLUSDT random', { explicit: ' BREAKOUT ' })).toBe('breakout');
		});
	});

	describe('keeps unknown honest', () => {
		it.each([
			'',
			'   ',
			'hello',
			'BTCUSDT',
			'12345',
			null,
			undefined,
			42,
			{},
			[],
			'🚀🚀🚀',
			// A raw TradingView alert with no setup wording is genuinely
			// unclassifiable: forcing a class here would break the "unknown
			// stays honest" rule.
			'BINANCE:ETHUSDT (4h) COMPRA',
			'BTCUSDT(240) pasó a señal de VENTA',
		])('returns unknown for unclassifiable payload %j', (text) => {
			expect(classifySignal(text)).toBe('unknown');
		});

		it('does not force a class when an explicit class is invalid', () => {
			// An out-of-enum explicit value must not be trusted, and must not
			// crash ingest — it falls back to derivation, then to unknown.
			expect(classifySignal('hello world', { explicit: 'not-a-class' })).toBe('unknown');
		});

		it('falls back to unknown when the explicit class is a wrong type', () => {
			expect(classifySignal('hello world', { explicit: { nested: true } })).toBe('unknown');
		});
	});

	describe('determinism and channel neutrality', () => {
		it('returns an identical result for repeated calls on the same input', () => {
			const text = 'BTCUSDT broke resistance with strong volume';
			const results = Array.from({ length: 25 }, () => classifySignal(text));
			expect(new Set(results).size).toBe(1);
		});

		it('is case and whitespace insensitive', () => {
			expect(classifySignal('  btcusdt   BROKE   resistance  ')).toBe(
				classifySignal('BTCUSDT broke resistance'),
			);
		});

		it('only ever returns enum members', () => {
			const samples = [
				'breakout', 'mean reversion', 'trend', 'reversal', 'volume',
				'news', 'manual', 'BUY BTCUSDT', 'BTCUSDT(240) pasó a señal de VENTA',
			];
			const allowed = new Set([
				'breakout', 'mean_reversion', 'trend_continuation', 'reversal',
				'volume_spike', 'news_event', 'manual', 'unknown',
			]);
			for (const sample of samples) {
				expect(allowed.has(classifySignal(sample))).toBe(true);
			}
		});
	});

	describe('SignalClassMetrics', () => {
		let metrics;
		beforeEach(() => {
			metrics = new SignalClassMetrics();
		});

		it('is null before any classification is recorded', () => {
			expect(metrics.getSnapshot()).toBeNull();
		});

		it('reports a zero population rate for a recorded unknown alert', () => {
			metrics.record('unknown');
			const snapshot = metrics.getSnapshot();
			expect(snapshot.classifiedAlerts).toBe(0);
			expect(snapshot.unknownAlerts).toBe(1);
			expect(snapshot.totalAlerts).toBe(1);
			expect(snapshot.populationRate).toBe(0);
		});

		it('reports a partial population rate and never leaks alert text', () => {
			metrics.record('breakout');
			metrics.record('unknown');
			const snapshot = metrics.getSnapshot();
			expect(snapshot.totalAlerts).toBe(2);
			expect(snapshot.classifiedAlerts).toBe(1);
			expect(snapshot.populationRate).toBe(0.5);
			expect(snapshot.byClass).toEqual({ breakout: 1, unknown: 1 });
			expect(JSON.stringify(snapshot)).not.toMatch(/BTCUSDT/i);
		});

		it('reports a full population rate when every alert classifies', () => {
			metrics.record('breakout');
			metrics.record('reversal');
			expect(metrics.getSnapshot().populationRate).toBe(1);
		});

		it('is fail-open for malformed input', () => {
			expect(() => metrics.record(undefined)).not.toThrow();
			expect(() => metrics.record({ nested: 1 })).not.toThrow();
			expect(() => metrics.record('')).not.toThrow();
			expect(metrics.getSnapshot()).toBeNull();
		});

		it('ignores out-of-enum classes and does not corrupt totals', () => {
			metrics.record('breakout');
			metrics.record('not-a-real-class');
			const snapshot = metrics.getSnapshot();
			expect(snapshot.totalAlerts).toBe(1);
			expect(snapshot.byClass).toEqual({ breakout: 1 });
		});

		it('exposes a reset for deterministic tests', () => {
			metrics.record('breakout');
			metrics.reset();
			expect(metrics.getSnapshot()).toBeNull();
		});
	});

	describe('singleton metrics service', () => {
		afterEach(() => {
			signalClassMetrics.reset();
		});

		it('records classifications from the classifier itself', () => {
			// The singleton is process-wide and the earlier cases above also
			// classify, so start from a clean window.
			signalClassMetrics.reset();
			classifySignal('BTCUSDT breakout confirmed');
			classifySignal('hello there');
			const snapshot = signalClassMetrics.getSnapshot();
			expect(snapshot.totalAlerts).toBe(2);
			expect(snapshot.classifiedAlerts).toBe(1);
			expect(snapshot.byClass.breakout).toBe(1);
		});
	});
	describe('word-boundary matching (#858 review)', () => {
		// A bare substring match classified ordinary prose as a signal class, which
		// pollutes byClass analytics and misleads trader filtering - the exact thing
		// this classification exists to serve.
		it.each([
			['pago las manualidades del prestamo', 'manual'],
			['the newsroom was quiet today', 'news_event'],
			['el informe de ceomania', 'unknown'],
		])('does not match a phrase hidden inside a longer word: %s', (text) => {
			expect(classifySignal(text)).toBe('unknown');
		});

		it('still matches genuine standalone phrases', () => {
			expect(classifySignal('compra manual')).toBe('manual');
			expect(classifySignal('CEO announces merger')).toBe('news_event');
			expect(classifySignal('volumen fuerte')).toBe('volume_spike');
		});

		it('matches multi-word phrases across arbitrary spacing', () => {
			expect(classifySignal('break   out now')).toBe('breakout');
			expect(classifySignal('volumen   fuerte')).toBe('volume_spike');
		});
	});
});
