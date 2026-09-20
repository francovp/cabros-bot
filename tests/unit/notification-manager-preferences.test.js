'use strict';

const NotificationManager = require('../../src/services/notification/NotificationManager');
const { chatPreferenceService } = require('../../src/services/preferences/ChatPreferenceService');
const sentryService = require('../../src/services/monitoring/SentryService');
const { notificationRedriveService } = require('../../src/services/notification/NotificationRedriveService');
const { getDeliveredChannels } = require('../../src/services/notification/requestRouting');

describe('NotificationManager chat preference filtering', () => {
	let telegramService;
	let whatsappService;
	let manager;

	beforeEach(() => {
		telegramService = {
			name: 'telegram',
			chatId: '111',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'telegram', messageId: 'tg-1' }),
		};
		whatsappService = {
			name: 'whatsapp',
			chatId: '222',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({ success: true, channel: 'whatsapp', messageId: 'wa-1' }),
		};
		manager = new NotificationManager(telegramService, whatsappService);
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('skips channel delivery when chat preferences filter the alert', async () => {
		jest.spyOn(chatPreferenceService, 'shouldDeliverAlert').mockImplementation(async ({ channel }) => {
			if (channel === 'telegram') {
				return { deliver: false, reason: 'quiet_hours' };
			}
			return { deliver: true };
		});

		const results = await manager.sendToAll({ text: 'BTC pump', symbol: 'BTCUSDT' });

		expect(telegramService.send).not.toHaveBeenCalled();
		expect(whatsappService.send).toHaveBeenCalledTimes(1);

		const tgResult = results.find((r) => r.channel === 'telegram');
		expect(tgResult).toMatchObject({
			channel: 'telegram',
			success: true,
			skipped: true,
			reason: 'PREFERENCE_FILTER',
			filterReason: 'quiet_hours',
		});

		const waResult = results.find((r) => r.channel === 'whatsapp');
		expect(waResult).toMatchObject({
			channel: 'whatsapp',
			success: true,
			messageId: 'wa-1',
		});

		// getDeliveredChannels should only return non-skipped channels
		const delivered = getDeliveredChannels(results);
		expect(delivered).toEqual(['whatsapp']);
	});

	it('bypasses preference checks when bypassPreferences is true', async () => {
		jest.spyOn(chatPreferenceService, 'shouldDeliverAlert').mockImplementation(async () => {
			return { deliver: false, reason: 'min_confidence' };
		});

		const results = await manager.sendToChannels(
			{ text: 'Urgent alert', symbol: 'BTCUSDT' },
			['telegram'],
			{ bypassPreferences: true },
		);

		expect(telegramService.send).toHaveBeenCalledTimes(1);
		expect(results[0].success).toBe(true);
		expect(results[0].skipped).toBeUndefined();
	});
});
