'use strict';

const { LlmConcurrencyGate } = require('../../src/services/llm/LlmConcurrencyGate');

describe('LlmConcurrencyGate', () => {
	let gate;

	beforeEach(() => {
		jest.useFakeTimers();
		gate = new LlmConcurrencyGate();
	});

	afterEach(() => {
		// Defensive: clear any leaked timers so fake timers do not survive.
		gate.resetForTesting();
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('defaults to unbounded concurrency with zero queue timeout', () => {
		expect(gate.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
		expect(gate.queueTimeoutMs).toBe(0);
		const snap = gate.getSnapshot();
		expect(snap.maxConcurrent).toBeNull();
		expect(snap.queueTimeoutMs).toBe(0);
		expect(snap.inFlight).toBe(0);
		expect(snap.queueDepth).toBe(0);
	});

	it('acquires and releases a slot under capacity', async () => {
		gate.configure({ maxConcurrent: 2 });
		const release1 = await gate.acquire();
		const release2 = await gate.acquire();
		expect(gate.getSnapshot().inFlight).toBe(2);

		release1();
		expect(gate.getSnapshot().inFlight).toBe(1);
		release2();
		expect(gate.getSnapshot().inFlight).toBe(0);
	});

	it('sheds excess callers immediately when queue timeout is zero', async () => {
		gate.configure({ maxConcurrent: 1 });
		await gate.acquire();
		await expect(gate.acquire()).rejects.toMatchObject({
			code: 'LLM_GATE_SHED',
			status: 503,
			shed: true,
		});
		expect(gate.getSnapshot().shedTotal).toBe(1);
	});

	it('queues excess callers and resolves when a slot frees up', async () => {
		gate.configure({ maxConcurrent: 1, queueTimeoutMs: 100 });
		const release = await gate.acquire();
		expect(gate.getSnapshot().inFlight).toBe(1);
		// Take a queue spot.
		const acquirePromise = gate.acquire();
		expect(gate.getSnapshot().queueDepth).toBe(1);
		// Release the slot so the queued acquire resolves on the next microtask.
		release();
		await Promise.resolve();
		await Promise.resolve();
		const release2 = await acquirePromise;
		expect(typeof release2).toBe('function');
		expect(gate.getSnapshot().inFlight).toBe(1);
		release2();
		expect(gate.getSnapshot().inFlight).toBe(0);
	});

	it('times out queued callers when the queue timeout elapses', async () => {
		gate.configure({ maxConcurrent: 1, queueTimeoutMs: 20 });
		await gate.acquire();
		const queuedPromise = gate.acquire();
		// Attach the rejection handler up front so jest does not flag unhandled rejection.
		const settled = queuedPromise.catch((error) => error);
		jest.advanceTimersByTime(25);
		const error = await settled;
		expect(error).toMatchObject({
			code: 'LLM_GATE_TIMEOUT',
			status: 503,
			timedOut: true,
		});
		expect(gate.getSnapshot().timeoutTotal).toBe(1);
	});

	it('drains queued callers FIFO when slots free up', async () => {
		gate.configure({ maxConcurrent: 1, queueTimeoutMs: 200 });
		const release = await gate.acquire();
		const w1 = gate.acquire();
		const w2 = gate.acquire();
		const w3 = gate.acquire();
		release();
		await Promise.resolve();
		await Promise.resolve();
		const r1 = await w1;
		expect(gate.getSnapshot().inFlight).toBe(1);
		r1();
		await Promise.resolve();
		const r2 = await w2;
		expect(gate.getSnapshot().inFlight).toBe(1);
		r2();
		await Promise.resolve();
		const r3 = await w3;
		expect(gate.getSnapshot().inFlight).toBe(1);
		r3();
		expect(gate.getSnapshot().inFlight).toBe(0);
	});

	it('counts shed/timeout/acquired totals in the snapshot', async () => {
		gate.configure({ maxConcurrent: 1, queueTimeoutMs: 5 });
		const release = await gate.acquire();
		// First: queue a timeout.
		const queuedPromise = gate.acquire();
		const settled = queuedPromise.catch((error) => error);
		jest.advanceTimersByTime(10);
		await settled;
		expect(gate.getSnapshot().timeoutTotal).toBe(1);
		// Release + a fresh acquire so we have 2 acquires.
		release();
		await gate.acquire();
		// Now shed attempt.
		await expect(gate.acquire({ timeoutMs: 0 })).rejects.toMatchObject({ code: 'LLM_GATE_SHED' });
		const snap = gate.getSnapshot();
		expect(snap.acquiredTotal).toBe(2);
		expect(snap.timeoutTotal).toBe(1);
		expect(snap.shedTotal).toBe(1);
	});

	it('rejects invalid configure() values and preserves existing state', () => {
		gate.configure({ maxConcurrent: 3, queueTimeoutMs: 100 });
		expect(gate.maxConcurrent).toBe(3);
		expect(gate.queueTimeoutMs).toBe(100);

		gate.configure({ maxConcurrent: -1 });
		expect(gate.maxConcurrent).toBe(3);
		gate.configure({ maxConcurrent: 100000 });
		expect(gate.maxConcurrent).toBe(3);
		gate.configure({ queueTimeoutMs: -5 });
		expect(gate.queueTimeoutMs).toBe(100);
		gate.configure({ queueTimeoutMs: 9999999 });
		expect(gate.queueTimeoutMs).toBe(100);
		gate.configure({ maxConcurrent: 'not-a-number' });
		expect(gate.maxConcurrent).toBe(3);
	});

	it('release is idempotent', async () => {
		gate.configure({ maxConcurrent: 1 });
		const release = await gate.acquire();
		expect(gate.getSnapshot().inFlight).toBe(1);
		release();
		expect(gate.getSnapshot().inFlight).toBe(0);
		release();
		expect(gate.getSnapshot().inFlight).toBe(0);
	});

	it('resetForTesting rejects queued waiters and zeroes counters', async () => {
		gate.configure({ maxConcurrent: 1, queueTimeoutMs: 100 });
		await gate.acquire();
		const w1 = gate.acquire();
		const w2 = gate.acquire();
		const settled = Promise.allSettled([w1, w2]);
		gate.resetForTesting();
		const results = await settled;
		expect(results[0].status).toBe('rejected');
		expect(results[0].reason.code).toBe('LLM_GATE_RESET');
		expect(results[1].status).toBe('rejected');
		expect(gate.getSnapshot().inFlight).toBe(0);
		expect(gate.getSnapshot().queueDepth).toBe(0);
	});
});

describe('LlmConcurrencyGate - review feedback', () => {
	let g;

	beforeEach(() => {
		jest.useFakeTimers();
		g = new LlmConcurrencyGate();
	});

	afterEach(() => {
		g.resetForTesting();
		jest.clearAllTimers();
		jest.useRealTimers();
	});

	it('accepts the unbounded sentinel and resets to Infinity', () => {
		g.configure({ maxConcurrent: 5, queueTimeoutMs: 50 });
		expect(g.maxConcurrent).toBe(5);
		g.configure({ maxConcurrent: Infinity });
		expect(g.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
		g.configure({ maxConcurrent: null });
		expect(g.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
		g.configure({ maxConcurrent: undefined });
		expect(g.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
		g.configure({ maxConcurrent: '' });
		expect(g.maxConcurrent).toBe(Number.POSITIVE_INFINITY);
	});

	it('cancels queued acquisition when the caller signal aborts', async () => {
		g.configure({ maxConcurrent: 1, queueTimeoutMs: 5000 });
		await g.acquire();
		const controller = new AbortController();
		const queuedPromise = g.acquire({ signal: controller.signal });
		const settled = queuedPromise.catch((error) => error);
		controller.abort(new Error('caller-deadline'));
		const error = await settled;
		expect(error).toMatchObject({ code: 'LLM_GATE_ABORTED' });
		expect(g.getSnapshot().abortedTotal).toBe(1);
		expect(g.getSnapshot().queueDepth).toBe(0);
	});

	it('rejects immediately when caller signal is already aborted before queueing', async () => {
		g.configure({ maxConcurrent: 1, queueTimeoutMs: 5000 });
		await g.acquire();
		const controller = new AbortController();
		controller.abort(new Error('already-dead'));
		await expect(g.acquire({ signal: controller.signal })).rejects.toMatchObject({
			code: 'LLM_GATE_ABORTED',
		});
		expect(g.getSnapshot().abortedTotal).toBe(1);
		expect(g.getSnapshot().queueDepth).toBe(0);
	});

	it('skips already-aborted waiters during drain', async () => {
		g.configure({ maxConcurrent: 1, queueTimeoutMs: 5000 });
		const release = await g.acquire();
		const c1 = new AbortController();
		const c2 = new AbortController();
		const w1 = g.acquire({ signal: c1.signal });
		const w2 = g.acquire({ signal: c2.signal });
		const s1 = w1.catch((e) => e);
		const s2 = w2.catch((e) => e);
		// Abort w1 before releasing the slot. w1 should be rejected; w2 should drain.
		c1.abort(new Error('abort-1'));
		const err1 = await s1;
		expect(err1).toMatchObject({ code: 'LLM_GATE_ABORTED' });
		release();
		await Promise.resolve();
		await Promise.resolve();
		const r2 = await w2;
		expect(typeof r2).toBe('function');
		r2();
	});

	it('exposes abortedTotal in the snapshot', () => {
		const snap = g.getSnapshot();
		expect(snap.abortedTotal).toBe(0);
	});

	it('handles standard controller.abort() without arguments (DOMException) without throwing TypeError or mutating signal.reason', async () => {
		g.configure({ maxConcurrent: 1, queueTimeoutMs: 5000 });
		await g.acquire();
		const controller = new AbortController();
		const queuedPromise = g.acquire({ signal: controller.signal });
		const settled = queuedPromise.catch((error) => error);
		controller.abort(); // signal.reason is a DOMException with read-only code
		const error = await settled;
		expect(error).toMatchObject({ code: 'LLM_GATE_ABORTED' });
		expect(error.cause).toBe(controller.signal.reason);
		expect(g.getSnapshot().abortedTotal).toBe(1);
		expect(g.getSnapshot().queueDepth).toBe(0);
	});

	it('drains queued callers FIFO when maxConcurrent is increased or reset to unbounded', async () => {
		g.configure({ maxConcurrent: 1, queueTimeoutMs: 5000 });
		const release0 = await g.acquire();
		expect(g.getSnapshot().inFlight).toBe(1);

		const w1 = g.acquire();
		const w2 = g.acquire();
		expect(g.getSnapshot().queueDepth).toBe(2);

		// Raise capacity to 3 - both queued callers should drain immediately
		g.configure({ maxConcurrent: 3 });
		await Promise.resolve();
		await Promise.resolve();

		const [r1, r2] = await Promise.all([w1, w2]);
		expect(typeof r1).toBe('function');
		expect(typeof r2).toBe('function');
		expect(g.getSnapshot().inFlight).toBe(3);
		expect(g.getSnapshot().queueDepth).toBe(0);

		release0();
		r1();
		r2();
		expect(g.getSnapshot().inFlight).toBe(0);
	});
});
