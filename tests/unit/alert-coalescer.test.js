const { AlertCoalescer, fingerprint } = require('../../src/services/alerts/alertCoalescer');

describe('AlertCoalescer', () => {
	let cache;
	beforeEach(() => { cache = new AlertCoalescer({ maxEntries: 2, pendingMs: 180000 }); });
	afterEach(() => {
		cache.reset();
		jest.useRealTimers();
	});
	it('hashes equivalent object order but preserves distinct payloads', () => {
		expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 }));
		expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
	});
	it('waits for delivery, then returns the original request ID', async () => {
		const owner = await cache.acquire('key', 'first', 5000);
		const waiting = cache.acquire('key', 'second', 5000);
		cache.finish(owner, true);
		expect(await waiting).toEqual({ originalRequestId: 'first' });
	});
	it('coalesces a duplicate that arrived inside the window even when delivery is slow', async () => {
		jest.useFakeTimers();
		const owner = await cache.acquire('key', 'first', 5000);
		const waiting = cache.acquire('key', 'second', 5000);
		jest.advanceTimersByTime(6000);
		cache.finish(owner, true);
		expect(await waiting).toEqual({ originalRequestId: 'first' });
	});
	it('starts a new delivery when arrival is outside a pending original window', async () => {
		jest.useFakeTimers();
		const original = await cache.acquire('key', 'first', 5000);
		const insideWaiter = cache.acquire('key', 'inside', 5000);
		jest.advanceTimersByTime(6000);
		const outside = cache.acquire('key', 'outside', 5000);
		let outsideSettled = false;
		let insideSettled = false;
		outside.then(() => { outsideSettled = true; });
		insideWaiter.then(() => { insideSettled = true; });
		await Promise.resolve();
		expect(outsideSettled).toBe(true);
		const replacement = await outside;
		expect(replacement.entry.requestId).toBe('outside');
		expect(insideSettled).toBe(false);
		cache.finish(original, true);
		expect(await insideWaiter).toEqual({ originalRequestId: 'first' });
		expect(cache.entries.get('key')).toBe(replacement.entry);
		cache.finish(replacement, true);
		expect(await cache.acquire('key', 'later', 5000)).toEqual({ originalRequestId: 'outside' });
	});
	it('serializes waiting retries after the original fails', async () => {
		const original = await cache.acquire('key', 'first', 5000);
		const firstWaiter = cache.acquire('key', 'second', 5000);
		const secondWaiter = cache.acquire('key', 'third', 5000);
		cache.finish(original, false);
		await Promise.resolve();
		await Promise.resolve();
		const retryEntry = cache.entries.get('key');
		expect(retryEntry).toBeDefined();
		expect(['second', 'third']).toContain(retryEntry.requestId);
		cache.finish({ key: 'key', entry: retryEntry }, true);
		const outcomes = await Promise.all([firstWaiter, secondWaiter]);
		expect(outcomes.filter(outcome => outcome?.entry)).toHaveLength(1);
		expect(outcomes.filter(outcome => outcome?.originalRequestId === retryEntry.requestId)).toHaveLength(1);
	});
	it('releases failed delivery and ignores a stale owner', async () => {
		const owner = await cache.acquire('key', 'first', 5000);
		cache.finish(owner, false);
		const retry = await cache.acquire('key', 'retry', 5000);
		cache.finish(owner, false);
		cache.finish(retry, true);
		expect(await cache.acquire('key', 'third', 5000)).toEqual({ originalRequestId: 'retry' });
	});
	it('expires delivered entries and evicts old entries without exceeding the bound', async () => {
		jest.useFakeTimers();
		const first = await cache.acquire('first', '1', 5000);
		cache.finish(first, true);
		jest.advanceTimersByTime(5000);
		const renewed = await cache.acquire('first', '2', 5000);
		expect(renewed.entry.requestId).toBe('2');
		await cache.acquire('second', '3', 5000);
		await cache.acquire('third', '4', 5000);
		expect(cache.entries.size).toBe(2);
		expect(cache.entries.has('first')).toBe(false);
	});
	it('expires pending claims after 180 seconds and releases waiters', async () => {
		jest.useFakeTimers();
		await cache.acquire('key', 'first', 5000);
		const waiting = cache.acquire('key', 'second', 5000);
		await jest.advanceTimersByTimeAsync(180000);
		expect((await waiting).entry.requestId).toBe('second');
	});
	it('stops a waiting request when its request deadline is aborted', async () => {
		await cache.acquire('key', 'first', 5000);
		const controller = new AbortController();
		const waiting = cache.acquire('key', 'second', 5000, controller.signal);
		controller.abort();
		expect(await waiting).toBeNull();
	});
});
