/**
 * SnoozeService unit tests
 *
 * Verifies the operator-initiated global incident snooze service:
 *  - activation with default and custom channels
 *  - duration clamping (1 minute floor, 6 hour ceiling)
 *  - automatic expiry
 *  - cancel
 *  - isSnoozed checks per channel
 *  - subscription events
 *  - resetForTesting isolation
 */

const { SnoozeService, MIN_DURATION_MS, MAX_DURATION_MS, VALID_CHANNEL_NAMES } = require('../../src/services/notification/SnoozeService');

describe('SnoozeService', () => {
	let now;
	let service;

	beforeEach(() => {
		now = 1_700_000_000_000;
		service = new SnoozeService({ clock: () => now });
	});

	afterEach(() => {
		service.resetForTesting();
	});

	describe('activate', () => {
		it('activates with a valid duration and default channels', () => {
			const result = service.activate({ durationMs: 5 * 60 * 1000, reason: 'flash crash' });
			expect(result.ok).toBe(true);
			expect(result.snooze.durationMs).toBe(5 * 60 * 1000);
			expect(result.snooze.reason).toBe('flash crash');
			expect(result.snooze.channels).toEqual(['telegram', 'whatsapp', 'discord']);
			expect(service.isSnoozed('telegram')).toBe(true);
		});

		it('clamps durations below the minimum to the floor', () => {
			const result = service.activate({ durationMs: 1000 });
			expect(result.ok).toBe(true);
			expect(result.snooze.durationMs).toBe(MIN_DURATION_MS);
		});

		it('clamps durations above the maximum to the ceiling', () => {
			const result = service.activate({ durationMs: 24 * 60 * 60 * 1000 });
			expect(result.ok).toBe(true);
			expect(result.snooze.durationMs).toBe(MAX_DURATION_MS);
		});

		it('rejects non-finite durations', () => {
			const result = service.activate({ durationMs: 'nope' });
			expect(result.ok).toBe(false);
			expect(result.error).toBe('INVALID_DURATION');
		});

		it('rejects non-array channels', () => {
			const result = service.activate({ durationMs: 60_000, channels: 'telegram' });
			expect(result.ok).toBe(false);
			expect(result.error).toBe('INVALID_CHANNELS');
		});

		it('filters out unknown channel names', () => {
			const result = service.activate({
				durationMs: 60_000,
				channels: ['telegram', 'unknown', 'discord'],
			});
			expect(result.ok).toBe(true);
			expect(result.snooze.channels).toEqual(['telegram', 'discord']);
		});

		it('deduplicates channels and lowercases names', () => {
			const result = service.activate({
				durationMs: 60_000,
				channels: ['TELEGRAM', 'telegram', 'Whatsapp'],
			});
			expect(result.ok).toBe(true);
			expect(result.snooze.channels).toEqual(['telegram', 'whatsapp']);
		});

		it('truncates long reasons to 200 chars', () => {
			const longReason = 'a'.repeat(500);
			const result = service.activate({ durationMs: 60_000, reason: longReason });
			expect(result.ok).toBe(true);
			expect(result.snooze.reason.length).toBe(200);
		});
	});

	describe('cancel', () => {
		it('cancels an active snooze', () => {
			service.activate({ durationMs: 60_000 });
			const result = service.cancel();
			expect(result.ok).toBe(true);
			expect(result.snooze).toEqual({ active: false });
			expect(service.isSnoozed('telegram')).toBe(false);
		});

		it('returns { active: false } when there is no active snooze', () => {
			const result = service.cancel();
			expect(result.ok).toBe(true);
			expect(result.snooze).toEqual({ active: false });
		});
	});

	describe('isSnoozed', () => {
		it('returns true only for channels in the active set', () => {
			service.activate({ durationMs: 60_000, channels: ['telegram'] });
			expect(service.isSnoozed('telegram')).toBe(true);
			expect(service.isSnoozed('whatsapp')).toBe(false);
			expect(service.isSnoozed('discord')).toBe(false);
		});

		it('returns false for unknown channel names', () => {
			service.activate({ durationMs: 60_000 });
			expect(service.isSnoozed('signal')).toBe(false);
			expect(service.isSnoozed(null)).toBe(false);
		});
	});

	describe('getStatus', () => {
		it('returns { active: false } when no snooze is active', () => {
			expect(service.getStatus()).toEqual({ active: false });
		});

		it('returns a status object when a snooze is active', () => {
			service.activate({ durationMs: 60_000, reason: 'test' });
			const status = service.getStatus();
			expect(status.active).toBe(true);
			expect(status.reason).toBe('test');
			expect(status.channels).toEqual(['telegram', 'whatsapp', 'discord']);
			expect(typeof status.expiresAt).toBe('string');
			expect(typeof status.activatedAt).toBe('string');
		});
	});

	describe('automatic expiry', () => {
		it('clears the active snooze once the clock passes expiresAt', () => {
			service.activate({ durationMs: 60_000, reason: 'temp' });
			expect(service.isSnoozed('telegram')).toBe(true);
			now += 61_000;
			expect(service.isSnoozed('telegram')).toBe(false);
			expect(service.getActive()).toBeNull();
		});

		it('emits an "expired" event when the snooze auto-expires', () => {
			const events = [];
			service.subscribe((evt) => events.push(evt));
			service.activate({ durationMs: 60_000, reason: 'will expire' });
			now += 61_000;
			// Trigger expiry via a state read
			service.getActive();
			expect(events.some((e) => e.type === 'expired')).toBe(true);
		});
	});

	describe('subscribe', () => {
		it('emits activated and cancelled events', () => {
			const events = [];
			const unsubscribe = service.subscribe((evt) => events.push(evt));
			service.activate({ durationMs: 60_000, reason: 'a' });
			service.cancel();
			unsubscribe();
			service.activate({ durationMs: 60_000, reason: 'b' });
			expect(events.map((e) => e.type)).toEqual(['activated', 'cancelled']);
		});

		it('isolates listener errors so other listeners still fire', () => {
			const events = [];
			service.subscribe(() => { throw new Error('boom'); });
			service.subscribe((evt) => events.push(evt));
			service.activate({ durationMs: 60_000 });
			expect(events).toHaveLength(1);
		});

		it('returns a noop unsubscribe for invalid listeners', () => {
			const fn = service.subscribe(null);
			expect(typeof fn).toBe('function');
			expect(() => fn()).not.toThrow();
		});
	});

	describe('module constants', () => {
		it('exposes known channel names', () => {
			expect(VALID_CHANNEL_NAMES.has('telegram')).toBe(true);
			expect(VALID_CHANNEL_NAMES.has('whatsapp')).toBe(true);
			expect(VALID_CHANNEL_NAMES.has('discord')).toBe(true);
		});

		it('exposes the min and max duration bounds', () => {
			expect(MIN_DURATION_MS).toBe(60_000);
			expect(MAX_DURATION_MS).toBe(6 * 60 * 60 * 1000);
		});
	});
});
