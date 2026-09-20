'use strict';

const {
	createTelegramActionStore,
	shortIdFor,
	SHORT_ID_LENGTH,
	DEFAULT_MAX_ENTRIES,
} = require('../../src/services/alerts/telegramActionStore');

describe('telegramActionStore', () => {
	describe('shortIdFor', () => {
		it('returns deterministic 8-character base32 IDs', () => {
			const id = shortIdFor('alert-abc-123');
			expect(id).toHaveLength(SHORT_ID_LENGTH);
			expect(id).toMatch(/^[0-9A-Z]+$/);
			expect(shortIdFor('alert-abc-123')).toBe(id);
		});

		it('returns distinct IDs for different alertIds', () => {
			const a = shortIdFor('alert-1');
			const b = shortIdFor('alert-2');
			expect(a).not.toBe(b);
		});

		it('rejects empty or non-string alertId', () => {
			expect(() => shortIdFor('')).toThrow(TypeError);
			expect(() => shortIdFor('   ')).toThrow(TypeError);
			expect(() => shortIdFor(null)).toThrow(TypeError);
			expect(() => shortIdFor(undefined)).toThrow(TypeError);
			expect(() => shortIdFor(42)).toThrow(TypeError);
		});
	});

	describe('createTelegramActionStore', () => {
		let clock;
		let now;

		beforeEach(() => {
			now = 1_700_000_000_000;
			clock = jest.fn(() => now);
		});

		it('registers a shortId and resolves it back to the alertId', () => {
			const store = createTelegramActionStore({ now: clock });
			const shortId = store.register('alert-xyz', { chatId: 'chat-1', threadId: 42, messageIds: ['m1', 'm2'] });
			expect(shortId).toHaveLength(SHORT_ID_LENGTH);

			const entry = store.lookup(shortId);
			expect(entry).toMatchObject({
				alertId: 'alert-xyz',
				shortId,
				chatId: 'chat-1',
				threadId: 42,
				messageIds: ['m1', 'm2'],
			});
		});

		it('returns null for an unknown shortId without throwing', () => {
			const store = createTelegramActionStore({ now: clock });
			expect(store.lookup('ZZZZZZZZ')).toBeNull();
		});

		it('expires entries after the configured TTL', () => {
			const store = createTelegramActionStore({ ttlMs: 1000, now: clock });
			const shortId = store.register('alert-ttl');
			now += 999;
			expect(store.lookup(shortId)).not.toBeNull();
			now += 2;
			expect(store.lookup(shortId)).toBeNull();
		});

		it('re-registration refreshes the existing entry instead of duplicating', () => {
			const store = createTelegramActionStore({ maxEntries: 5, now: clock });
			const first = store.register('alert-dup');
			const second = store.register('alert-dup');
			expect(first).toBe(second);
			expect(store.size()).toBe(1);
		});

		it('evicts the least-recently-touched entry when maxEntries is reached', () => {
			const store = createTelegramActionStore({ maxEntries: 3, now: clock });
			const a = store.register('alert-a');
			now += 10;
			const b = store.register('alert-b');
			now += 10;
			const c = store.register('alert-c');
			now += 10;

			// Touch `a` so it becomes most-recently-touched
			store.lookup(a);
			now += 10;

			// Inserting a 4th entry should evict `b` (oldest by insertion order)
			store.register('alert-d');
			expect(store.size()).toBe(3);
			expect(store.lookup(a)).not.toBeNull();
			expect(store.lookup(b)).toBeNull();
			expect(store.lookup(c)).not.toBeNull();
		});

		it('exposes a snapshot of current entries', () => {
			const store = createTelegramActionStore({ now: clock });
			store.register('alert-snap-1', { chatId: 'c1' });
			store.register('alert-snap-2', { chatId: 'c2' });
			const snapshot = store.snapshot();
			expect(snapshot).toHaveLength(2);
			const alertIds = snapshot.map((entry) => entry.alertId).sort();
			expect(alertIds).toEqual(['alert-snap-1', 'alert-snap-2']);
		});

		it('rejects empty alertId without throwing', () => {
			const store = createTelegramActionStore({ now: clock });
			expect(store.register('')).toBeNull();
			expect(store.register(null)).toBeNull();
			expect(store.register(undefined)).toBeNull();
			expect(store.register(42)).toBeNull();
			expect(store.size()).toBe(0);
		});

		it('clears all entries via clear()', () => {
			const store = createTelegramActionStore({ now: clock });
			store.register('alert-x');
			store.register('alert-y');
			store.clear();
			expect(store.size()).toBe(0);
		});

		it('uses default constants when options are not provided', () => {
			const store = createTelegramActionStore();
			expect(store._maxEntries).toBe(DEFAULT_MAX_ENTRIES);
		});

		it('handles non-integer maxEntries and non-positive ttlMs by using defaults', () => {
			const store = createTelegramActionStore({ maxEntries: -1, ttlMs: 0 });
			expect(store._maxEntries).toBe(DEFAULT_MAX_ENTRIES);
			expect(store._ttlMs).toBeGreaterThan(0);
		});
	});
});
