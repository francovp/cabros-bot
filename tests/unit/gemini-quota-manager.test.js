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
});
