/**
 * Unit tests for the GlobalAlertBudget service.
 *
 * Verifies:
 * - Default behavior with no config: enabled=false, reserve() always allows
 * - Cap enforcement: reserve() returns allowed=false once the cap is reached
 * - Rolling 24h window: entries older than 24h are pruned
 * - dryRun() returns current usage without incrementing
 * - resetForTesting() clears the counter
 * - getStatus() / dryRun() shape (used, capacity, remaining, resetAt)
 * - notifyAdminBudgetExceeded() respects cooldown (5 minutes)
 */

const { GlobalAlertBudget, globalAlertBudget, notifyAdminBudgetExceeded, resetAdminPageCooldownForTesting } = require('../../src/services/notifications/globalAlertBudget');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('GlobalAlertBudget', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = {
			GLOBAL_ALERT_BUDGET_PER_24H: process.env.GLOBAL_ALERT_BUDGET_PER_24H,
			ENABLE_GLOBAL_ALERT_BUDGET: process.env.ENABLE_GLOBAL_ALERT_BUDGET,
			TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID: process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID,
		};
		globalAlertBudget.resetForTesting();
	});

	afterEach(() => {
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		globalAlertBudget.resetForTesting();
	});

	it('uses the default capacity when no env var is set', () => {
		delete process.env.GLOBAL_ALERT_BUDGET_PER_24H;
		const status = globalAlertBudget.dryRun();
		expect(status.capacity).toBe(500);
	});

	it('parses a non-default capacity from the env var', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '42';
		const status = globalAlertBudget.dryRun();
		expect(status.capacity).toBe(42);
	});

	it('falls back to the default capacity when env var is non-finite', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = 'not-a-number';
		const status = globalAlertBudget.dryRun();
		expect(status.capacity).toBe(500);
	});

	it('falls back to the default capacity when env var is negative', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '-5';
		const status = globalAlertBudget.dryRun();
		expect(status.capacity).toBe(500);
	});

	it('treats a zero capacity as disabled (allowed always)', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '0';
		const reservation = globalAlertBudget.reserve();
		expect(reservation.allowed).toBe(true);
		expect(reservation.capacity).toBe(0);
		expect(globalAlertBudget.isEnabled()).toBe(false);
	});

	it('returns allowed=true and increments the counter when below the cap', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		const r1 = globalAlertBudget.reserve();
		expect(r1.allowed).toBe(true);
		expect(r1.used).toBe(1);
		expect(r1.remaining).toBe(4);
		expect(r1.capacity).toBe(5);
		expect(typeof r1.resetAt).toBe('string');

		const r2 = globalAlertBudget.reserve();
		expect(r2.allowed).toBe(true);
		expect(r2.used).toBe(2);
		expect(r2.remaining).toBe(3);
	});

	it('returns allowed=false once the cap is reached', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '3';
		globalAlertBudget.reserve();
		globalAlertBudget.reserve();
		globalAlertBudget.reserve();
		const blocked = globalAlertBudget.reserve();
		expect(blocked.allowed).toBe(false);
		expect(blocked.used).toBe(3);
		expect(blocked.remaining).toBe(0);
		expect(blocked.capacity).toBe(3);
	});

	it('does not increment when reserve() rejects', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '2';
		globalAlertBudget.reserve();
		globalAlertBudget.reserve();
		const blocked1 = globalAlertBudget.reserve();
		const blocked2 = globalAlertBudget.reserve();
		expect(blocked1.allowed).toBe(false);
		expect(blocked1.used).toBe(2);
		expect(blocked2.allowed).toBe(false);
		expect(blocked2.used).toBe(2);
	});

	it('prunes entries older than 24 hours', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '10';
		const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000);
		globalAlertBudget.entries.push({ timestamp: oldTimestamp, count: 1 });
		globalAlertBudget.entries.push({ timestamp: oldTimestamp, count: 1 });
		const status = globalAlertBudget.dryRun();
		expect(status.used).toBe(0);
	});

	it('keeps entries within the 24h window', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '10';
		const recentTimestamp = Date.now() - (1 * 60 * 60 * 1000);
		globalAlertBudget.entries.push({ timestamp: recentTimestamp, count: 1 });
		globalAlertBudget.entries.push({ timestamp: recentTimestamp, count: 1 });
		const status = globalAlertBudget.dryRun();
		expect(status.used).toBe(2);
	});

	it('dryRun() does not increment the counter', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		const before = globalAlertBudget.dryRun();
		globalAlertBudget.dryRun();
		globalAlertBudget.dryRun();
		const after = globalAlertBudget.dryRun();
		expect(before.used).toBe(0);
		expect(after.used).toBe(0);
	});

	it('getStatus() and dryRun() return equivalent shape', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		const dry = globalAlertBudget.dryRun();
		const status = globalAlertBudget.getStatus();
		expect(status).toEqual(dry);
	});

	it('resetForTesting() clears all entries', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		globalAlertBudget.reserve();
		globalAlertBudget.reserve();
		expect(globalAlertBudget.dryRun().used).toBe(2);
		globalAlertBudget.resetForTesting();
		expect(globalAlertBudget.dryRun().used).toBe(0);
	});

	it('exposes the same shape regardless of enabled/disabled state', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '5';
		const enabled = globalAlertBudget.dryRun();
		expect(enabled).toEqual(expect.objectContaining({
			used: expect.any(Number),
			capacity: expect.any(Number),
			remaining: expect.any(Number),
			resetAt: expect.any(String),
		}));

		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '0';
		const disabled = globalAlertBudget.dryRun();
		expect(disabled).toEqual(expect.objectContaining({
			used: expect.any(Number),
			capacity: expect.any(Number),
			remaining: expect.any(Number),
			resetAt: expect.any(String),
		}));
		expect(disabled.enabled).toBe(false);
	});

	it('falls back to the default capacity when env var exceeds the schema max', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = String(2_000_000);
		const status = globalAlertBudget.dryRun();
		expect(status.capacity).toBe(500);
	});

	it('accepts a capacity at the maximum allowed value', () => {
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '1000000';
		const status = globalAlertBudget.dryRun();
		expect(status.capacity).toBe(1000000);
	});

	it('isolates instances constructed directly', () => {
		const a = new GlobalAlertBudget();
		const b = new GlobalAlertBudget();
		process.env.GLOBAL_ALERT_BUDGET_PER_24H = '10';
		a.reserve();
		a.reserve();
		expect(a.dryRun().used).toBe(2);
		expect(b.dryRun().used).toBe(0);
	});
});

describe('notifyAdminBudgetExceeded', () => {
	const originalChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	let sendMock;

	beforeEach(() => {
		resetAdminPageCooldownForTesting();
		sendMock = jest.fn().mockResolvedValue({ success: true, channel: 'telegram' });
	});

	afterEach(() => {
		if (originalChatId === undefined) {
			delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		} else {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = originalChatId;
		}
	});

	it('does nothing when TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID is unset', async () => {
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		await notifyAdminBudgetExceeded({
			used: 100,
			capacity: 100,
			resetAt: new Date().toISOString(),
			telegramService: { send: sendMock },
		});
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('does nothing when telegramService is not provided', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		await notifyAdminBudgetExceeded({
			used: 100,
			capacity: 100,
			resetAt: new Date().toISOString(),
			telegramService: null,
		});
		expect(sendMock).not.toHaveBeenCalled();
	});

	it('sends a single page when budget is exceeded', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		await notifyAdminBudgetExceeded({
			used: 100,
			capacity: 100,
			resetAt: '2030-01-01T00:00:00.000Z',
			telegramService: { send: sendMock },
		});
		expect(sendMock).toHaveBeenCalledTimes(1);
		expect(sendMock.mock.calls[0][0]).toEqual(expect.objectContaining({
			telegramChatId: '-100-admin',
			parseMode: 'MarkdownV2',
		}));
		expect(sendMock.mock.calls[0][0].text).toContain('100 / 100');
	});

	it('respects a 5-minute cooldown between pages', async () => {
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		const realNow = Date.now;
		let nowMs = 1_700_000_000_000;
		const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
		try {
			await notifyAdminBudgetExceeded({
				used: 100, capacity: 100, resetAt: '2030-01-01T00:00:00.000Z',
				telegramService: { send: sendMock },
			});
			expect(sendMock).toHaveBeenCalledTimes(1);
			nowMs += 60 * 1000;
			await notifyAdminBudgetExceeded({
				used: 100, capacity: 100, resetAt: '2030-01-01T00:00:00.000Z',
				telegramService: { send: sendMock },
			});
			expect(sendMock).toHaveBeenCalledTimes(1);
			nowMs += 6 * 60 * 1000;
			await notifyAdminBudgetExceeded({
				used: 100, capacity: 100, resetAt: '2030-01-01T00:00:00.000Z',
				telegramService: { send: sendMock },
			});
			expect(sendMock).toHaveBeenCalledTimes(2);
		} finally {
			nowSpy.mockRestore();
			Date.now = realNow;
		}
	});
});

describe('RemoteConfigService PARAMETER_SCHEMA includes the global alert budget', () => {
	it('exposes the GLOBAL_ALERT_BUDGET_PER_24H entry', () => {
		const { PARAMETER_SCHEMA } = require('../../src/services/remoteConfig/RemoteConfigService');
		expect(PARAMETER_SCHEMA.GLOBAL_ALERT_BUDGET_PER_24H).toEqual(expect.objectContaining({
			type: 'number',
			defaultValue: 500,
			integer: true,
			min: 0,
			max: 1000000,
		}));
	});
});
