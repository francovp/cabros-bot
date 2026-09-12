/* global jest, describe, it, expect, beforeEach */

const {
	createBurstAggregator,
	hashRouting,
	DEFAULT_WINDOW_MS,
	DEFAULT_MIN_SIGNALS,
} = require('../../src/services/alerts/burstAggregator');

function createFakeTimer() {
	let now = 1_700_000_000_000;
	const scheduled = [];
	let nextId = 1;

	function schedule(callback, ms) {
		const id = nextId++;
		const handle = {
			id,
			ms,
			fire() {
				try {
					callback();
				} catch (_) {}
			},
		};
		scheduled.push(handle);
		return handle;
	}

	function cancel(handle) {
		const index = scheduled.indexOf(handle);
		if (index >= 0) scheduled.splice(index, 1);
	}

	function advance(ms) {
		now += ms;
		const fireOrder = scheduled.slice();
		for (const handle of fireOrder) {
			handle.fire();
			const index = scheduled.indexOf(handle);
			if (index >= 0) scheduled.splice(index, 1);
		}
	}

	function setNow(ms) {
		now = ms;
	}

	function nowMs() {
		return now;
	}

	return { schedule, cancel, advance, setNow, nowMs, pendingCount: () => scheduled.length };
}

function makeRouting(overrides = {}) {
	return {
		channels: undefined,
		telegramChatId: undefined,
		telegramThreadId: undefined,
		whatsappChatId: undefined,
		discordWebhookUrl: undefined,
		...overrides,
	};
}

function makeAlert(symbol, side, timeframe = '4h', exchange = 'BINANCE') {
	const sideLabel = side === 'BUY' ? 'COMPRA' : side === 'SELL' ? 'VENTA' : side;
	return `${exchange}:${symbol} (${timeframe}) cambió a señal de ${sideLabel}`;
}

describe('burstAggregator', () => {
	let originalEnabled;
	let originalWindow;
	let originalMin;

	beforeEach(() => {
		originalEnabled = process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION;
		originalWindow = process.env.ALERT_BURST_WINDOW_MS;
		originalMin = process.env.ALERT_BURST_MIN_SIGNALS;
		process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
	});

	afterEachRestore();

	function afterEachRestore() {
		if (originalEnabled === undefined) {
			delete process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION;
		} else {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = originalEnabled;
		}
		if (originalWindow === undefined) {
			delete process.env.ALERT_BURST_WINDOW_MS;
		} else {
			process.env.ALERT_BURST_WINDOW_MS = originalWindow;
		}
		if (originalMin === undefined) {
			delete process.env.ALERT_BURST_MIN_SIGNALS;
		} else {
			process.env.ALERT_BURST_MIN_SIGNALS = originalMin;
		}
	}

	describe('feature gate', () => {
		it('rejects when disabled', () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'false';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const verdict = aggregator.accept({ text: makeAlert('BTCUSDT', 'BUY'), routing: makeRouting() });
			expect(verdict.accepted).toBe(false);
			expect(verdict.reason).toBe('disabled');
		});

		it('is enabled only when flag is exactly "true"', () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			expect(aggregator.isEnabled()).toBe(true);
		});
	});

	describe('window state machine', () => {
		it('aggregates a same-direction burst of >= MIN_SIGNALS into one onComplete call', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '3';
			process.env.ALERT_BURST_WINDOW_MS = '3000';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const onComplete = jest.fn();
			const onFlush1 = jest.fn();
			const onFlush2 = jest.fn();
			const onFlush3 = jest.fn();
			const routing = makeRouting({ channels: ['telegram'] });

			const v1 = aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL', '4h'), routing, requestId: 'a1', onFlush: onFlush1, onComplete });
			expect(v1.pending).toBe(true);
			const v2 = aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL', '240'), routing, requestId: 'a2', onFlush: onFlush2, onComplete });
			expect(v2.pending).toBe(true);
			const v3 = aggregator.accept({ text: makeAlert('BNBUSDT', 'SELL', 'D'), routing, requestId: 'a3', onFlush: onFlush3, onComplete });
			expect(v3.pending).toBe(true);

			expect(onComplete).not.toHaveBeenCalled();
			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(onComplete).toHaveBeenCalledTimes(1);
			const [, payload, metadata] = onComplete.mock.calls[0];
			expect(payload.signalCount).toBe(3);
			expect(payload.side).toBe('SELL');
			expect(payload.constituentAlertIds).toEqual(['a1', 'a2', 'a3']);
			expect(metadata.individualDeliveries).toHaveLength(3);
			expect(metadata.individualDeliveries[0].burstAggregateId).toBeDefined();

			expect(onFlush1).not.toHaveBeenCalled();
			expect(onFlush2).not.toHaveBeenCalled();
			expect(onFlush3).not.toHaveBeenCalled();
		});

		it('falls back to individual delivery when burst has fewer than MIN_SIGNALS signals', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '3';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const onComplete = jest.fn();
			const onFlush1 = jest.fn();
			const onFlush2 = jest.fn();
			const routing = makeRouting();

			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing, requestId: 'a1', onFlush: onFlush1, onComplete });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing, requestId: 'a2', onFlush: onFlush2, onComplete });

			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(onComplete).not.toHaveBeenCalled();
			expect(onFlush1).toHaveBeenCalledTimes(1);
			expect(onFlush2).toHaveBeenCalledTimes(1);
			expect(onFlush1.mock.calls[0][0]).toEqual({ aggregated: false });
		});
	});

	describe('side isolation', () => {
		it('keeps SELL and BUY windows separate and aggregates independently', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const sellComplete = jest.fn();
			const buyComplete = jest.fn();
			const sellOnFlush1 = jest.fn();
			const sellOnFlush2 = jest.fn();
			const buyOnFlush1 = jest.fn();
			const buyOnFlush2 = jest.fn();
			const routing = makeRouting();

			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing, requestId: 's1', onFlush: sellOnFlush1, onComplete: sellComplete });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'BUY'), routing, requestId: 'b1', onFlush: buyOnFlush1, onComplete: buyComplete });
			aggregator.accept({ text: makeAlert('BNBUSDT', 'SELL'), routing, requestId: 's2', onFlush: sellOnFlush2, onComplete: sellComplete });
			aggregator.accept({ text: makeAlert('SOLUSDT', 'BUY'), routing, requestId: 'b2', onFlush: buyOnFlush2, onComplete: buyComplete });

			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(sellComplete).toHaveBeenCalledTimes(1);
			expect(buyComplete).toHaveBeenCalledTimes(1);
			expect(sellComplete.mock.calls[0][1].side).toBe('SELL');
			expect(buyComplete.mock.calls[0][1].side).toBe('BUY');
			expect(sellOnFlush1).not.toHaveBeenCalled();
			expect(buyOnFlush1).not.toHaveBeenCalled();
		});
	});

	describe('routing isolation', () => {
		it('separates alerts with different telegramChatId into different windows', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const completeA = jest.fn();
			const completeB = jest.fn();
			const routingA = makeRouting({ telegramChatId: '-100AAA' });
			const routingB = makeRouting({ telegramChatId: '-100BBB' });

			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing: routingA, requestId: 'a1', onComplete: completeA });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'BUY'), routing: routingB, requestId: 'b1', onComplete: completeB });
			aggregator.accept({ text: makeAlert('BNBUSDT', 'SELL'), routing: routingA, requestId: 'a2', onComplete: completeA });
			aggregator.accept({ text: makeAlert('SOLUSDT', 'BUY'), routing: routingB, requestId: 'b2', onComplete: completeB });

			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(completeA).toHaveBeenCalledTimes(1);
			expect(completeA.mock.calls[0][1].signalCount).toBe(2);
			expect(completeB).toHaveBeenCalledTimes(1);
			expect(completeB.mock.calls[0][1].signalCount).toBe(2);
		});

		it('separates alerts with different channel lists into different windows', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const completeA = jest.fn();
			const completeB = jest.fn();
			const routingA = makeRouting({ channels: ['telegram'] });
			const routingB = makeRouting({ channels: ['whatsapp'] });

			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing: routingA, requestId: 'a1', onComplete: completeA });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing: routingB, requestId: 'b1', onComplete: completeB });
			aggregator.accept({ text: makeAlert('BNBUSDT', 'SELL'), routing: routingA, requestId: 'a2', onComplete: completeA });
			aggregator.accept({ text: makeAlert('SOLUSDT', 'SELL'), routing: routingB, requestId: 'b2', onComplete: completeB });

			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(completeA).toHaveBeenCalledTimes(1);
			expect(completeB).toHaveBeenCalledTimes(1);
		});

		it('considers channel arrays order-insensitive for the same routing', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const complete = jest.fn();
			const routingA = makeRouting({ channels: ['telegram', 'whatsapp'] });
			const routingB = makeRouting({ channels: ['whatsapp', 'telegram'] });

			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing: routingA, requestId: 'a1', onComplete: complete });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing: routingB, requestId: 'a2', onComplete: complete });

			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(complete).toHaveBeenCalledTimes(1);
			expect(complete.mock.calls[0][1].signalCount).toBe(2);
		});
	});

	describe('parse and timeframe gates', () => {
		it('returns reason=unparsed for non-signal text', () => {
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const verdict = aggregator.accept({ text: 'no signal here', routing: makeRouting() });
			expect(verdict.accepted).toBe(false);
			expect(verdict.reason).toBe('unparsed');
		});

		it('returns reason=invalid_text for empty or non-string input', () => {
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			expect(aggregator.accept({ text: '', routing: makeRouting() }).reason).toBe('invalid_text');
			expect(aggregator.accept({ text: null, routing: makeRouting() }).reason).toBe('invalid_text');
		});

		it('does not aggregate alerts whose timeframe has no bar mapping', () => {
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const onFlush1 = jest.fn();
			const onFlush2 = jest.fn();
			const routing = makeRouting();
			aggregator.accept({ text: 'BINANCE:BTCUSDT (3M) señal VENTA', routing, requestId: 'x1', onFlush: onFlush1 });
			aggregator.accept({ text: 'BINANCE:BTCUSDT (3M) señal VENTA', routing, requestId: 'x2', onFlush: onFlush2 });
			expect(onFlush1).not.toHaveBeenCalled();
			expect(onFlush2).not.toHaveBeenCalled();
		});
	});

	describe('fail-open', () => {
		it('returns aggregated=false with reason=store_error when timer scheduling throws', () => {
			const aggregator = createBurstAggregator({
				schedule: () => { throw new Error('boom'); },
				cancel: () => {},
				now: () => 1_700_000_000_000,
			});
			const onFlush = jest.fn();
			const verdict = aggregator.accept({ text: makeAlert('BTCUSDT', 'BUY'), routing: makeRouting(), onFlush });
			expect(['store_error', 'unparsed']).toContain(verdict.reason);
		});

		it('falls back to individual delivery when onComplete throws', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const onFlush1 = jest.fn();
			const onFlush2 = jest.fn();
			const onComplete = jest.fn(() => { throw new Error('boom'); });
			const routing = makeRouting();
			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing, requestId: 'a1', onFlush: onFlush1, onComplete });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing, requestId: 'a2', onFlush: onFlush2, onComplete });

			timer.advance(DEFAULT_WINDOW_MS + 100);

			expect(onComplete).toHaveBeenCalledTimes(1);
			expect(onFlush1).toHaveBeenCalledTimes(1);
			expect(onFlush2).toHaveBeenCalledTimes(1);
		});
	});

	describe('shutdown flush', () => {
		it('flushes all open windows immediately on flushAll()', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const onComplete1 = jest.fn();
			const onComplete2 = jest.fn();
			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing: makeRouting({ telegramChatId: 'A' }), requestId: 'a1', onComplete: onComplete1 });
			aggregator.accept({ text: makeAlert('BTCUSDT', 'BUY'), routing: makeRouting({ telegramChatId: 'B' }), requestId: 'b1', onComplete: onComplete2 });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing: makeRouting({ telegramChatId: 'A' }), requestId: 'a2', onComplete: onComplete1 });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'BUY'), routing: makeRouting({ telegramChatId: 'B' }), requestId: 'b2', onComplete: onComplete2 });

			const result = aggregator.flushAll();
			expect(result.flushedWindows).toBe(2);
			expect(onComplete1).toHaveBeenCalledTimes(1);
			expect(onComplete2).toHaveBeenCalledTimes(1);
		});
	});

	describe('configuration bounds', () => {
		it('clamps ALERT_BURST_WINDOW_MS to [1000, 15000]', () => {
			const aggregator = createBurstAggregator({ now: () => 0 });
			// RemoteConfigService clamps env inputs to schema bounds; the
			// runtime helper therefore exposes the schema-bounded value.
			process.env.ALERT_BURST_WINDOW_MS = '0';
			expect(aggregator.getStats().windowMs).toBe(DEFAULT_WINDOW_MS);
			process.env.ALERT_BURST_WINDOW_MS = '99999';
			expect(aggregator.getStats().windowMs).toBe(DEFAULT_WINDOW_MS);
			process.env.ALERT_BURST_WINDOW_MS = '5000';
			expect(aggregator.getStats().windowMs).toBe(5000);
		});

		it('clamps ALERT_BURST_MIN_SIGNALS to [2, 20]', () => {
			const aggregator = createBurstAggregator({ now: () => 0 });
			process.env.ALERT_BURST_MIN_SIGNALS = '0';
			expect(aggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
			process.env.ALERT_BURST_MIN_SIGNALS = '999';
			expect(aggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
			process.env.ALERT_BURST_MIN_SIGNALS = '5';
			expect(aggregator.getStats().minSignals).toBe(5);
		});

		it('falls back to defaults for malformed values', () => {
			const aggregator = createBurstAggregator({ now: () => 0 });
			process.env.ALERT_BURST_WINDOW_MS = 'NaN';
			process.env.ALERT_BURST_MIN_SIGNALS = 'NaN';
			expect(aggregator.getStats().windowMs).toBe(DEFAULT_WINDOW_MS);
			expect(aggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
		});
	});

	describe('hashRouting', () => {
		it('produces stable hashes for semantically equal routing objects', () => {
			const r1 = makeRouting({ channels: ['telegram', 'whatsapp'], telegramChatId: '-100A' });
			const r2 = makeRouting({ channels: ['whatsapp', 'telegram'], telegramChatId: '-100A' });
			expect(hashRouting(r1)).toBe(hashRouting(r2));
		});

		it('produces distinct hashes for different destinations', () => {
			const r1 = makeRouting({ telegramChatId: '-100A' });
			const r2 = makeRouting({ telegramChatId: '-100B' });
			expect(hashRouting(r1)).not.toBe(hashRouting(r2));
		});
	});

	describe('stats', () => {
		it('increments aggregatedCount and flushedCount counters correctly', () => {
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			const onComplete = jest.fn();
			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing: makeRouting(), requestId: 'a1', onComplete });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing: makeRouting(), requestId: 'a2', onComplete });
			timer.advance(DEFAULT_WINDOW_MS + 100);
			expect(aggregator.getStats().aggregatedCount).toBe(1);

			aggregator.accept({ text: makeAlert('BTCUSDT', 'BUY'), routing: makeRouting(), requestId: 'b1', onFlush: jest.fn() });
			timer.advance(DEFAULT_WINDOW_MS + 100);
			expect(aggregator.getStats().flushedCount).toBe(1);
		});

		it('exposes activeWindows count of buffered windows', () => {
			const timer = createFakeTimer();
			const aggregator = createBurstAggregator({ schedule: timer.schedule, cancel: timer.cancel, now: timer.nowMs });
			expect(aggregator.getStats().activeWindows).toBe(0);
			aggregator.accept({ text: makeAlert('BTCUSDT', 'SELL'), routing: makeRouting({ telegramChatId: 'A' }) });
			aggregator.accept({ text: makeAlert('ETHUSDT', 'SELL'), routing: makeRouting({ telegramChatId: 'A' }) });
			expect(aggregator.getStats().activeWindows).toBe(1);
		});
	});
});
