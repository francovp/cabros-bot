'use strict';

const { EventBus, createEventBus } = require('../../src/lib/eventBus');
const { EVENT_NAMES, isKnownEvent } = require('../../src/lib/eventBusCatalog');

describe('event bus', () => {
	let bus;
	let warnSpy;

	beforeEach(() => {
		bus = createEventBus({ asyncTimeoutMs: 200 });
		warnSpy = jest.fn();
		bus._logger = { warn: warnSpy };
	});

	afterEach(() => {
		bus.resetForTesting();
	});

	describe('on/off', () => {
		it('invokes registered handlers in insertion order', () => {
			const calls = [];
			bus.on('test.event', (payload) => {
				calls.push(['first', payload]);
				return 'first';
			});
			bus.on('test.event', (payload) => {
				calls.push(['second', payload]);
				return 'second';
			});

			const results = bus.emit('test.event', { value: 1 });

			expect(results).toEqual(['first', 'second']);
			expect(calls).toEqual([
				['first', { value: 1 }],
				['second', { value: 1 }],
			]);
		});

		it('returns an unsubscribe function that removes the handler', () => {
			const handler = jest.fn();
			const off = bus.on('test.event', handler);

			bus.emit('test.event', { value: 1 });
			expect(handler).toHaveBeenCalledTimes(1);

			off();
			bus.emit('test.event', { value: 2 });
			expect(handler).toHaveBeenCalledTimes(1);
		});

		it('tolerates calling unsubscribe twice', () => {
			const handler = jest.fn();
			const off = bus.on('test.event', handler);

			expect(off()).toBe(true);
			expect(off()).toBe(false);
			expect(() => bus.emit('test.event', {})).not.toThrow();
		});

		it('drops a bucket with zero subscribers on remove', () => {
			const handler = jest.fn();
			bus.on('test.event', handler);

			bus.off('test.event', handler);

			expect(bus.listenerCount('test.event')).toBe(0);
			expect(bus.eventNames()).not.toContain('test.event');
		});

		it('rejects non-string event names', () => {
			expect(() => bus.on('', () => {})).toThrow(TypeError);
			expect(() => bus.on(null, () => {})).toThrow(TypeError);
			expect(() => bus.on(123, () => {})).toThrow(TypeError);
		});

		it('rejects non-function handlers', () => {
			expect(() => bus.on('test.event', null)).toThrow(TypeError);
			expect(() => bus.on('test.event', 'not-a-fn')).toThrow(TypeError);
		});
	});

	describe('once', () => {
		it('invokes the handler once and then unsubscribes', () => {
			const handler = jest.fn();
			bus.once('test.event', handler);

			bus.emit('test.event', { value: 1 });
			bus.emit('test.event', { value: 2 });

			expect(handler).toHaveBeenCalledTimes(1);
			expect(handler).toHaveBeenCalledWith({ value: 1 }, 'test.event');
			expect(bus.listenerCount('test.event')).toBe(0);
		});
	});

	describe('emit', () => {
		it('returns an empty array when no handlers are registered', () => {
			expect(bus.emit('unheard.event', { value: 1 })).toEqual([]);
		});

		it('isolates handler errors so they cannot break the caller', () => {
			const after = jest.fn();
			bus.on('test.event', () => {
				throw new Error('boom');
			});
			bus.on('test.event', after);

			const results = bus.emit('test.event', { value: 1 });

			expect(results).toHaveLength(2);
			expect(after).toHaveBeenCalledTimes(1);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(warnSpy.mock.calls[0][0]).toMatch(/handler .* failed/);
		});

		it('isolates async-handler errors when invoked synchronously', () => {
			const after = jest.fn();
			bus.on('test.event', () => Promise.reject(new Error('async-boom')));
			bus.on('test.event', after);

			expect(() => bus.emit('test.event', {})).not.toThrow();
			expect(after).toHaveBeenCalledTimes(1);
		});

		it('does not mutate handler insertion order during dispatch', () => {
			const calls = [];
			const handlerA = () => {
				calls.push('A');
				bus.on('test.event', handlerC);
			};
			const handlerB = () => calls.push('B');
			const handlerC = () => calls.push('C');

			bus.on('test.event', handlerA);
			bus.on('test.event', handlerB);

			bus.emit('test.event', {});

			expect(calls).toEqual(['A', 'B']);
		});
	});

	describe('emitAsync', () => {
		it('awaits every handler and returns insertion-ordered results', async () => {
			bus.on('test.event', async (payload) => {
				await new Promise((resolve) => setTimeout(resolve, 30));
				return 'first-result';
			});
			bus.on('test.event', async (payload) => {
				return 'second-result';
			});

			const settled = await bus.emitAsync('test.event', { value: 1 });

			// Result array is insertion-ordered (parallel execution means the
			// actual order handlers finish in can vary, but each result
			// remains aligned with its subscriber).
			expect(settled).toEqual([
				{ value: 'first-result' },
				{ value: 'second-result' },
			]);
		});

		it('isolates handler errors so other handlers still run', async () => {
			const ok = jest.fn(async () => 'ok');
			const failing = jest.fn(async () => {
				throw new Error('async-boom');
			});

			bus.on('test.event', failing);
			bus.on('test.event', ok);

			const settled = await bus.emitAsync('test.event', {});

			expect(ok).toHaveBeenCalledTimes(1);
			expect(failing).toHaveBeenCalledTimes(1);
			expect(settled).toHaveLength(2);
			expect(settled[0]).toEqual({ error: expect.any(Error) });
			expect(settled[1]).toEqual({ value: 'ok' });
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});

		it('treats a slow handler as a timeout without affecting other handlers', async () => {
			const fast = jest.fn(async () => 'fast');
			const slow = () => new Promise(() => {});

			bus.on('test.event', slow);
			bus.on('test.event', fast);

			const settled = await bus.emitAsync('test.event', {});

			expect(fast).toHaveBeenCalledTimes(1);
			expect(settled).toHaveLength(2);
			expect(settled[0].error.code).toBe('EVENT_BUS_HANDLER_TIMEOUT');
			expect(settled[1]).toEqual({ value: 'fast' });
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});

		it('honors a per-call timeout override', async () => {
			bus.on('test.event', () => new Promise((resolve) => setTimeout(resolve, 100)));

			const settled = await bus.emitAsync('test.event', {}, { timeoutMs: 25 });

			expect(settled).toHaveLength(1);
			expect(settled[0].error.code).toBe('EVENT_BUS_HANDLER_TIMEOUT');
		});

		it('returns an empty array when no handlers are registered', async () => {
			await expect(bus.emitAsync('unheard.event', { value: 1 })).resolves.toEqual([]);
		});

		it('does not leak unhandled rejections when handlers reject synchronously', async () => {
			const unhandled = jest.fn();
			process.once('unhandledRejection', unhandled);

			bus.on('test.event', () => {
				throw new Error('sync-boom');
			});

			await bus.emitAsync('test.event', {});

			await new Promise((resolve) => setImmediate(resolve));

			expect(unhandled).not.toHaveBeenCalled();
		});
	});

	describe('listenerCount and eventNames', () => {
		it('reports the subscriber count per event', () => {
			bus.on('a', () => {});
			bus.on('a', () => {});
			bus.on('b', () => {});

			expect(bus.listenerCount('a')).toBe(2);
			expect(bus.listenerCount('b')).toBe(1);
			expect(bus.listenerCount('missing')).toBe(0);
		});

		it('returns sorted event names', () => {
			bus.on('zeta', () => {});
			bus.on('alpha', () => {});
			bus.on('mu', () => {});

			expect(bus.eventNames()).toEqual(['alpha', 'mu', 'zeta']);
		});
	});

	describe('removeAllListeners', () => {
		it('drops every subscriber when called without an event name', () => {
			bus.on('a', () => {});
			bus.on('b', () => {});

			bus.removeAllListeners();

			expect(bus.eventNames()).toEqual([]);
		});

		it('drops a single event bucket when called with a name', () => {
			bus.on('a', () => {});
			bus.on('b', () => {});

			bus.removeAllListeners('a');

			expect(bus.eventNames()).toEqual(['b']);
		});
	});

	describe('catalog integration', () => {
		it('exposes the documented event names', () => {
			expect(EVENT_NAMES.ALERT_RECEIVED).toBe('alert.received');
			expect(EVENT_NAMES.ALERT_DELIVERED).toBe('alert.delivered');
			expect(EVENT_NAMES.JOB_COMPLETED).toBe('job.completed');
			expect(EVENT_NAMES.SIGNAL_EVALUATED).toBe('signal.evaluated');
		});

		it('isKnownEvent recognises documented names', () => {
			expect(isKnownEvent(EVENT_NAMES.ALERT_RECEIVED)).toBe(true);
			expect(isKnownEvent('alert.does_not_exist')).toBe(false);
			expect(isKnownEvent(undefined)).toBe(false);
		});
	});

	describe('default singleton', () => {
		afterEach(() => {
			const { eventBus } = require('../../src/lib/eventBus');
			eventBus.resetForTesting();
		});

		it('shares subscribers across requires', () => {
			const { eventBus: a } = require('../../src/lib/eventBus');
			const { eventBus: b } = require('../../src/lib/eventBus');
			expect(a).toBe(b);

			const handler = jest.fn();
			a.on('shared.event', handler);

			expect(b.listenerCount('shared.event')).toBe(1);
			b.emit('shared.event', { ping: true });

			expect(handler).toHaveBeenCalledTimes(1);
		});
	});

	describe('EventBus class direct usage', () => {
		it('creates independent instances when constructed directly', () => {
			const a = new EventBus();
			const b = new EventBus();
			const handler = jest.fn();
			a.on('test.event', handler);

			b.emit('test.event', {});

			expect(handler).not.toHaveBeenCalled();
			a.resetForTesting();
			b.resetForTesting();
		});
	});
});
