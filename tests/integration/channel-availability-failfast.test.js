/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');

jest.mock('@sentry/node', () => ({
	init: jest.fn(),
	captureException: jest.fn(),
	captureMessage: jest.fn(),
	withScope: jest.fn(),
	getCurrentHub: jest.fn(() => ({ getScope: () => ({ setContext: jest.fn() }) })),
	getClient: jest.fn(() => ({})),
}));

jest.mock('undici', () => ({
	fetch: jest.fn(),
	Agent: jest.fn(),
}));

const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const sentryService = require('../../src/services/monitoring/SentryService');
const { getPromptService } = require('../../src/services/prompts');

function saveEnv() {
	return Object.fromEntries(Object.entries(process.env));
}

function restoreEnv(saved) {
	for (const key of Object.keys(saved)) {
		process.env[key] = saved[key];
	}
	for (const key of Object.keys(process.env)) {
		if (!(key in saved)) {
			delete process.env[key];
		}
	}
}

describe('Channel availability fail-fast (GH-854)', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			ENABLE_DISCORD_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'false',
		});

		jest.clearAllMocks();
		sentryService._resetForTesting && sentryService._resetForTesting();
		if (getPromptService && typeof getPromptService().clearCache === 'function') {
			getPromptService().clearCache();
		}

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		restoreEnv(savedEnv);
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('returns 400 before enrichment when an explicitly requested channel is disabled', async () => {
		// Mock the enrichment entry to fail loudly if it runs after we already 400.
		const groundingModule = require('../../src/services/grounding/grounding');
		const enrichSpy = jest.fn();
		groundingModule.groundAlert = enrichSpy;
		try {
			await request(app)
				.post('/api/webhook/alert')
				.set('x-api-key', 'test-key')
				.send({ text: 'BINANCE:ETHUSDT (4h) COMPRA — test', channels: ['whatsapp'] })
				.expect(400);
		} finally {
			// Restore default export regardless of test outcome.
			delete groundingModule.groundAlert;
		}

		// Fail-fast assertion: enrichment must not be invoked when channels
		// validation rejects the request up-front.
		expect(enrichSpy).not.toHaveBeenCalled();
	});

	it('still validates a valid explicit channel request through the normal flow', async () => {
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (4h) COMPRA — test', channels: ['telegram'] })
			.expect(200);

		expect(response.body.deliveredChannels).toEqual(['telegram']);
	});

	it('does not enforce fail-fast for legacy broadcasts (channels omitted)', async () => {
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'BINANCE:ETHUSDT (4h) COMPRA — test' })
			.expect(200);

		expect(response.body.deliveredChannels).toEqual(['telegram']);
	});
});
