'use strict';

const geminiQuotaManager = require('../../src/services/grounding/geminiQuotaManager');
const { GeminiQuotaManager } = geminiQuotaManager;

describe('GeminiQuotaManager', () => {
	beforeEach(() => {
		geminiQuotaManager.resetForTesting();
		jest.useRealTimers();
	});

	afterEach(() => {
		geminiQuotaManager.resetForTesting();
	});

	it('correctly identifies Gemini quota 429 errors', () => {
		expect(geminiQuotaManager.isQuotaError({ status: 429 })).toBe(true);
		expect(geminiQuotaManager.isQuotaError({ statusCode: 429 })).toBe(true);
		expect(geminiQuotaManager.isQuotaError({ code: 429 })).toBe(true);
		expect(geminiQuotaManager.isQuotaError({ message: 'RESOURCE_EXHAUSTED: quota exceeded' })).toBe(true);
		expect(geminiQuotaManager.isQuotaError({ message: 'Rate limit exceeded 429' })).toBe(true);
		expect(geminiQuotaManager.isQuotaError({ status: 500, message: 'Internal Server Error' })).toBe(false);
		expect(geminiQuotaManager.isQuotaError(null)).toBe(false);
	});

	it('extracts retry delay from error properties and JSON messages', () => {
		expect(geminiQuotaManager.extractRetryDelayMs({ retryDelay: 5000 })).toBe(5000);
		expect(geminiQuotaManager.extractRetryDelayMs({ retryAfter: 3000 })).toBe(3000);
		expect(geminiQuotaManager.extractRetryDelayMs({ message: 'Quota exceeded. "retryDelay": "4.5s"' })).toBe(4500);
		expect(geminiQuotaManager.extractRetryDelayMs({ message: 'Quota exceeded. "retry-after": "6000ms"' })).toBe(6000);
		expect(geminiQuotaManager.extractRetryDelayMs({}, 1, 1000)).toBe(1000);
		expect(geminiQuotaManager.extractRetryDelayMs({}, 2, 1000)).toBe(2000);
		expect(geminiQuotaManager.extractRetryDelayMs({}, 3, 1000)).toBe(4000);
	});

	it('activates and extends quota cooldown on 429 error', () => {
		expect(geminiQuotaManager.isCooldownActive()).toBe(false);

		const delay = geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 3000 });
		expect(delay).toBe(3000);
		expect(geminiQuotaManager.isCooldownActive()).toBe(true);
		expect(geminiQuotaManager.getRemainingCooldownMs()).toBeGreaterThan(0);
		expect(geminiQuotaManager.getRemainingCooldownMs()).toBeLessThanOrEqual(3000);
	});

	it('waits for active cooldown if within budget', async () => {
		jest.useFakeTimers();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 500 });

		const waitPromise = geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: 1000 });
		expect(geminiQuotaManager.isCooldownActive()).toBe(true);

		jest.advanceTimersByTime(505);
		await expect(waitPromise).resolves.toBe(true);
		expect(geminiQuotaManager.isCooldownActive()).toBe(false);
		jest.useRealTimers();
	});

	it('returns false or throws error if remaining cooldown exceeds budget', async () => {
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 10000 });

		const result = await geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: 2000, throwOnExceeded: false });
		expect(result).toBe(false);

		await expect(
			geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: 2000, throwOnExceeded: true })
		).rejects.toThrow('Gemini quota cooldown');
	});

	it('rechecks shared deadline when concurrent 429 extends cooldown while waiting within budget', async () => {
		jest.useFakeTimers();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 500 });

		const waitPromise = geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: 2000 });
		expect(geminiQuotaManager.isCooldownActive()).toBe(true);

		// Advance past first cooldown, but trigger an extension before/at wake
		jest.advanceTimersByTime(250);
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 500 });

		jest.advanceTimersByTime(255);
		expect(geminiQuotaManager.isCooldownActive()).toBe(true);

		jest.advanceTimersByTime(250);
		await expect(waitPromise).resolves.toBe(true);
		expect(geminiQuotaManager.isCooldownActive()).toBe(false);
		jest.useRealTimers();
	});

	it('rechecks shared deadline and throws when concurrent 429 extends cooldown beyond maxWaitMs', async () => {
		jest.useFakeTimers();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 500 });

		const waitPromise = geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: 800, throwOnExceeded: true });
		expect(geminiQuotaManager.isCooldownActive()).toBe(true);

		// Trigger an extension that pushes cooldown beyond maxWaitMs
		jest.advanceTimersByTime(250);
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 1000 });

		jest.advanceTimersByTime(255);
		await expect(waitPromise).rejects.toThrow('Gemini quota cooldown');
		jest.useRealTimers();
	});

	it('returns false when concurrent 429 extends cooldown beyond maxWaitMs and throwOnExceeded is false', async () => {
		jest.useFakeTimers();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 500 });

		const waitPromise = geminiQuotaManager.waitForCooldownIfNeeded({ maxWaitMs: 800, throwOnExceeded: false });
		expect(geminiQuotaManager.isCooldownActive()).toBe(true);

		jest.advanceTimersByTime(250);
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 1000 });

		jest.advanceTimersByTime(255);
		await expect(waitPromise).resolves.toBe(false);
		jest.useRealTimers();
	});

	it('returns initial snapshot when no cooldowns have occurred', () => {
		const snapshot = geminiQuotaManager.getSnapshot();
		expect(snapshot).toEqual({
			cooldownActive: false,
			remainingCooldownMs: 0,
			lastTriggeredAt: null,
			triggersTotal: 0,
			braveFallbacksDuringCooldown: 0,
			lastBraveFallbackAt: null,
		});
	});

	it('tracks active cooldown, lastTriggeredAt, and triggersTotal in snapshot', () => {
		const before = Date.now();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 4000 });
		const after = Date.now();

		const snapshot = geminiQuotaManager.getSnapshot();
		expect(snapshot.cooldownActive).toBe(true);
		expect(snapshot.remainingCooldownMs).toBeGreaterThan(0);
		expect(snapshot.remainingCooldownMs).toBeLessThanOrEqual(4000);
		expect(snapshot.triggersTotal).toBe(1);
		expect(snapshot.lastTriggeredAt).not.toBeNull();

		const triggeredTime = new Date(snapshot.lastTriggeredAt).getTime();
		expect(triggeredTime).toBeGreaterThanOrEqual(before);
		expect(triggeredTime).toBeLessThanOrEqual(after);

		// Second trigger increments triggersTotal
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 6000 });
		const snapshot2 = geminiQuotaManager.getSnapshot();
		expect(snapshot2.triggersTotal).toBe(2);
	});

	it('records brave fallbacks during cooldown and exposes them in snapshot', () => {
		expect(geminiQuotaManager.getSnapshot().braveFallbacksDuringCooldown).toBe(0);
		expect(geminiQuotaManager.getSnapshot().lastBraveFallbackAt).toBeNull();

		geminiQuotaManager.recordBraveFallbackDuringCooldown();
		const snapshot = geminiQuotaManager.getSnapshot();
		expect(snapshot.braveFallbacksDuringCooldown).toBe(1);
		expect(snapshot.lastBraveFallbackAt).not.toBeNull();

		geminiQuotaManager.recordBraveFallbackDuringCooldown();
		expect(geminiQuotaManager.getSnapshot().braveFallbacksDuringCooldown).toBe(2);
	});

	it('preserves historical counters and timestamps after cooldown expires', () => {
		jest.useFakeTimers();
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 1000 });
		geminiQuotaManager.recordBraveFallbackDuringCooldown();

		jest.advanceTimersByTime(1500);

		const snapshot = geminiQuotaManager.getSnapshot();
		expect(snapshot.cooldownActive).toBe(false);
		expect(snapshot.remainingCooldownMs).toBe(0);
		expect(snapshot.triggersTotal).toBe(1);
		expect(snapshot.lastTriggeredAt).not.toBeNull();
		expect(snapshot.braveFallbacksDuringCooldown).toBe(1);
		expect(snapshot.lastBraveFallbackAt).not.toBeNull();
		jest.useRealTimers();
	});

	it('resets all snapshot counters and state on resetForTesting', () => {
		geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 5000 });
		geminiQuotaManager.recordBraveFallbackDuringCooldown();
		geminiQuotaManager.resetForTesting();

		expect(geminiQuotaManager.getSnapshot()).toEqual({
			cooldownActive: false,
			remainingCooldownMs: 0,
			lastTriggeredAt: null,
			triggersTotal: 0,
			braveFallbacksDuringCooldown: 0,
			lastBraveFallbackAt: null,
		});
	});
});

