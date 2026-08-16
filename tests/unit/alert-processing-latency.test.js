/* global jest, describe, it, beforeEach, expect */

jest.mock('../../src/controllers/webhooks/handlers/alert/grounding', () => ({
	enrichAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../src/lib/validation', () => ({
	validateAlert: jest.fn((text) => ({ text })),
}));

jest.mock('../../src/services/storage/AlertStorageService', () => ({
	extractSymbolAndExchange: jest.fn(() => ({ symbol: 'BTCUSDT', exchange: 'BINANCE' })),
	saveAlert: jest.fn().mockResolvedValue('alert-id'),
}));

jest.mock('../../src/services/notification/NotificationManager', () => jest.fn().mockImplementation(() => ({
	validateAll: jest.fn().mockResolvedValue([]),
	getEnabledChannels: jest.fn().mockReturnValue(['telegram']),
	sendToAll: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
	sendToChannels: jest.fn().mockResolvedValue([{ channel: 'telegram', success: true }]),
})));

jest.mock('../../src/services/notification/TelegramService', () => jest.fn());
jest.mock('../../src/services/notification/WhatsAppService', () => jest.fn());
jest.mock('../../src/services/notification/DiscordService', () => jest.fn());
jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(() => false),
}));

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const { postAlert } = require('../../src/controllers/webhooks/handlers/alert/alert');

function buildResponse() {
	const response = {
		json: jest.fn(),
		status: jest.fn(),
		send: jest.fn(),
	};
	response.status.mockReturnValue(response);
	response.json.mockReturnValue(response);
	response.send.mockReturnValue(response);
	return response;
}

describe('alert processing latency persistence', () => {
	beforeEach(() => {
		process.env.ENABLE_GEMINI_GROUNDING = 'false';
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'false';
		process.env.ENABLE_TELEGRAM_BOT = 'false';
		process.env.ENABLE_WHATSAPP_ALERTS = 'false';
		process.env.ENABLE_DISCORD_ALERTS = 'false';
		jest.clearAllMocks();
	});

	it('passes a bounded non-negative integer processing time to storage', async () => {
		const response = buildResponse();
		const handler = postAlert({});

		await handler({
			body: { text: 'BINANCE:BTCUSDT' },
			query: {},
		}, response);

		const saveParams = alertStorageService.saveAlert.mock.calls[0][0];
		expect(Number.isSafeInteger(saveParams.processingTimeMs)).toBe(true);
		expect(saveParams.processingTimeMs).toBeGreaterThanOrEqual(0);
	});
});
