'use strict';

const {
	normalizePresetDestinations,
	resolveScannerPresetRouting,
} = require('../../src/services/scannerPresets/scannerPresetRouting');

describe('scanner preset destinations', () => {
	it('normalizes unique valid destinations and defaults new presets to inherit', () => {
		const destinations = normalizePresetDestinations({
			telegramChatIds: ['-1001234567890', '-1001234567890'],
			whatsappChatIds: ['56912345678@c.us'],
			discordWebhookUrls: ['https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
		});

		expect(destinations).toEqual({
			telegramChatIds: ['-1001234567890'],
			whatsappChatIds: ['56912345678@c.us'],
			discordWebhookUrls: ['https://discord.com/api/webhooks/123456789012345678/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'],
		});
	});

	it('accepts the destination cap and rejects one entry over it', () => {
		const atLimit = Array.from({ length: 20 }, (_, index) => `-${1000000000000 + index}`);
		const overLimit = [...atLimit, '-1000000000020'];

		expect(normalizePresetDestinations({ telegramChatIds: atLimit }).telegramChatIds).toHaveLength(20);
		expect(() => normalizePresetDestinations({ telegramChatIds: overLimit })).toThrow(expect.objectContaining({
			code: 'INVALID_DESTINATIONS',
		}));
	});

	it.each([
		[{ telegramChatIds: ['not-a-chat'] }, 'telegramChatIds'],
		[{ whatsappChatIds: ['bad@c.us'] }, 'whatsappChatIds'],
		[{ discordWebhookUrls: ['http://discord.com/api/webhooks/123456789012345678/token'] }, 'discordWebhookUrls'],
		[{ discordWebhookUrls: ['https://example.com/api/webhooks/123456789012345678/token'] }, 'discordWebhookUrls'],
		[{ telegramChatIds: '123456789' }, 'telegramChatIds'],
		[{ unknown: ['value'] }, 'unknown'],
	])('rejects invalid destination input with INVALID_DESTINATIONS (%j)', (destinations, field) => {
		expect(() => normalizePresetDestinations(destinations)).toThrow(expect.objectContaining({
			code: 'INVALID_DESTINATIONS',
			details: expect.objectContaining({ field: `destinations.${field}` }),
		}));
	});

	it('resolves preset mode only to saved destinations and keeps an explicit channel list', () => {
		const routing = resolveScannerPresetRouting({
			mode: 'preset',
			destinations: { telegramChatIds: ['-1001234567890'] },
		}, {});

		expect(routing).toEqual({
			channels: ['telegram'],
			destinations: { telegramChatIds: ['-1001234567890'] },
		});
	});

	it('lets per-request channels and destinations override preset destinations', () => {
		const routing = resolveScannerPresetRouting({
			mode: 'preset',
			destinations: {
				telegramChatIds: ['-1001234567890'],
				whatsappChatIds: ['56912345678@c.us'],
			},
		}, {
			channels: ['telegram'],
			telegramChatId: '-1009876543210',
			telegramThreadId: 7,
		});

		expect(routing).toEqual({
			channels: ['telegram'],
			destinations: { telegramChatIds: ['-1009876543210'] },
			telegramThreadId: 7,
		});
	});

	it('rejects an explicit channel filter with no configured preset destination', () => {
		expect(() => resolveScannerPresetRouting({
			mode: 'preset',
			destinations: { telegramChatIds: ['-1001234567890'] },
		}, { channels: ['whatsapp'] })).toThrow(expect.objectContaining({
			code: 'INVALID_REQUEST',
			statusCode: 400,
		}));
	});

	it('keeps inherit broadcast and mode-less legacy preset routing compatible', () => {
		expect(resolveScannerPresetRouting({ mode: 'inherit' }, {})).toEqual({});
		expect(resolveScannerPresetRouting({
			channels: ['telegram'],
			telegramChatId: '-1001234567890',
		}, {})).toEqual({
			channels: ['telegram'],
			telegramChatId: '-1001234567890',
		});
	});
});
