/**
 * NotificationManager snooze short-circuit tests
 *
 * Verifies that the operator-initiated snooze correctly short-circuits
 * `sendToAll` and `sendToChannels` dispatch and surfaces SNOOZED SendResults
 * for the suppressed channels while letting other channels continue.
 */

const NotificationManager = require('../../src/services/notification/NotificationManager');
const { snoozeService } = require('../../src/services/notification/SnoozeService');
const { resetForTesting } = require('../../src/lib/backgroundTaskTracker');

function makeTelegramStub() {
	return {
		name: 'telegram',
		isEnabled: () => true,
		send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'tg-1' }),
	};
}

function makeWhatsappStub() {
	return {
		name: 'whatsapp',
		isEnabled: () => true,
		send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-1' }),
	};
}

describe('NotificationManager snooze integration', () => {
	afterEach(() => {
		snoozeService.resetForTesting();
		resetForTesting();
		jest.restoreAllMocks();
	});

	it('short-circuits all channels when sendToAll is fully snoozed', async () => {
		const telegram = makeTelegramStub();
		const whatsapp = makeWhatsappStub();
		const manager = new NotificationManager(telegram, whatsapp);

		snoozeService.activate({ durationMs: 60_000, reason: 'incident' });
		const results = await manager.sendToAll({ text: 'alert' });

		expect(telegram.send).not.toHaveBeenCalled();
		expect(whatsapp.send).not.toHaveBeenCalled();
		expect(results).toHaveLength(2);
		for (const r of results) {
			expect(r.success).toBe(false);
			expect(r.category).toBe('SNOOZED');
			expect(typeof r.snoozedUntil).toBe('string');
		}
	});

	it('lets non-snoozed channels continue to dispatch', async () => {
		const telegram = makeTelegramStub();
		const whatsapp = makeWhatsappStub();
		const manager = new NotificationManager(telegram, whatsapp);

		snoozeService.activate({
			durationMs: 60_000,
			reason: 'only telegram',
			channels: ['telegram'],
		});

		const results = await manager.sendToAll({ text: 'alert' });
		expect(telegram.send).not.toHaveBeenCalled();
		expect(whatsapp.send).toHaveBeenCalledTimes(1);
		const snoozed = results.find((r) => r.channel === 'telegram');
		const delivered = results.find((r) => r.channel === 'whatsapp');
		expect(snoozed.category).toBe('SNOOZED');
		expect(delivered.success).toBe(true);
	});

	it('short-circuits sendToChannels when the only requested channel is snoozed', async () => {
		const telegram = makeTelegramStub();
		const whatsapp = makeWhatsappStub();
		const manager = new NotificationManager(telegram, whatsapp);

		snoozeService.activate({ durationMs: 60_000, reason: 'tg only' });
		const results = await manager.sendToChannels({ text: 'alert' }, ['telegram']);
		expect(telegram.send).not.toHaveBeenCalled();
		expect(results).toHaveLength(1);
		expect(results[0].category).toBe('SNOOZED');
	});

	it('returns SNOOZED results and dispatches the rest when sendToChannels mixes snoozed and clear channels', async () => {
		const telegram = makeTelegramStub();
		const whatsapp = makeWhatsappStub();
		const manager = new NotificationManager(telegram, whatsapp);

		snoozeService.activate({
			durationMs: 60_000,
			channels: ['whatsapp'],
		});

		const results = await manager.sendToChannels(
			{ text: 'alert' },
			['telegram', 'whatsapp'],
		);
		expect(telegram.send).toHaveBeenCalledTimes(1);
		expect(whatsapp.send).not.toHaveBeenCalled();
		const snoozed = results.find((r) => r.channel === 'whatsapp');
		const delivered = results.find((r) => r.channel === 'telegram');
		expect(snoozed.category).toBe('SNOOZED');
		expect(delivered.success).toBe(true);
	});

	it('does not invoke any channel when no snooze is active', async () => {
		const telegram = makeTelegramStub();
		const whatsapp = makeWhatsappStub();
		const manager = new NotificationManager(telegram, whatsapp);

		const results = await manager.sendToAll({ text: 'alert' });
		expect(telegram.send).toHaveBeenCalledTimes(1);
		expect(whatsapp.send).toHaveBeenCalledTimes(1);
		expect(results.every((r) => r.success)).toBe(true);
	});
});
