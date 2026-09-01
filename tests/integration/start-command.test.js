'use strict';

const chatEnrollmentsService = require('../../src/services/enrollments/ChatEnrollmentsService');

function buildContext({ chatId = 100, chatType = 'private', startPayload } = {}) {
	const ctx = {
		chat: { id: chatId, type: chatType },
		update: {
			message: {
				chat: { id: chatId, type: chatType },
			},
		},
		reply: jest.fn().mockResolvedValue(undefined),
		botInfo: { username: 'cabros_test_bot' },
	};
	if (startPayload !== undefined) ctx.startPayload = startPayload;
	return ctx;
}

describe('/start command with deep-link payload', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = {
			ENABLE_CHAT_ENROLLMENTS: process.env.ENABLE_CHAT_ENROLLMENTS,
			FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
			GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
			FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
		};
		chatEnrollmentsService._resetForTesting();
		delete process.env.ENABLE_CHAT_ENROLLMENTS;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete process.env.FIREBASE_PROJECT_ID;
	});

	afterEach(() => {
		chatEnrollmentsService._resetForTesting();
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	it('sends a Spanish generic welcome when no payload is supplied', async () => {
		const { createStartCommand } = require('../../src/controllers/commands/handlers/start/startCommand');
		const handler = createStartCommand();
		const ctx = buildContext({ startPayload: '' });

		await handler(ctx);

		expect(ctx.reply).toHaveBeenCalledTimes(1);
		const [text, options] = ctx.reply.mock.calls[0];
		expect(text).toMatch(/¡Hola!/);
		expect(options.parse_mode).toBe('MarkdownV2');
		expect(options.reply_markup.inline_keyboard).toEqual(
			expect.arrayContaining([
				expect.arrayContaining([
					expect.objectContaining({ url: expect.stringContaining('?startgroup=enroll') }),
				]),
			]),
		);
	});

	it('sends the enrolled copy for t.me/<bot>?start=enroll and persists when enabled', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
		chatEnrollmentsService._resetForTesting();
		const { createStartCommand } = require('../../src/controllers/commands/handlers/start/startCommand');
		const handler = createStartCommand();
		const ctx = buildContext({ chatId: 555, startPayload: 'enroll' });

		await handler(ctx);

		const persisted = await chatEnrollmentsService.getByChatId('555', { includeChatId: true });
		expect(persisted).toMatchObject({ chatId: '555', chatType: 'private' });
		const [text] = ctx.reply.mock.calls[0];
		expect(text).toMatch(/registré/);
	});

	it('falls back to generic welcome when the payload is invalid', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
		chatEnrollmentsService._resetForTesting();
		const { createStartCommand } = require('../../src/controllers/commands/handlers/start/startCommand');
		const handler = createStartCommand();
		const ctx = buildContext({ chatId: 777, startPayload: 'lang=zz&foo=bar' });

		await handler(ctx);

		const [text] = ctx.reply.mock.calls[0];
		expect(text).toMatch(/¡Hola!/);
		const persisted = await chatEnrollmentsService.getByChatId('777', { includeChatId: true });
		expect(persisted).toBeNull();
	});

	it('captures language, watchlist, and ref tokens and persists them', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
		chatEnrollmentsService._resetForTesting();
		const { createStartCommand } = require('../../src/controllers/commands/handlers/start/startCommand');
		const handler = createStartCommand();
		const ctx = buildContext({ chatId: 888, chatType: 'group', startPayload: 'lang=es&watch=BTCUSDT,ETHUSDT&ref=launch' });

		await handler(ctx);

		const persisted = await chatEnrollmentsService.getByChatId('888', { includeChatId: true });
		expect(persisted).toMatchObject({
			chatId: '888',
			chatType: 'group',
			language: 'es',
			watchlist: ['BTCUSDT', 'ETHUSDT'],
			refSource: 'launch',
		});
	});

	it('does not persist when enrollment storage is disabled', async () => {
		const { createStartCommand } = require('../../src/controllers/commands/handlers/start/startCommand');
		const handler = createStartCommand();
		const ctx = buildContext({ chatId: 999, startPayload: 'enroll' });

		await handler(ctx);

		expect(chatEnrollmentsService.isEnabled()).toBe(false);
		const persisted = await chatEnrollmentsService.getByChatId('999', { includeChatId: true });
		expect(persisted).toBeNull();
	});

	it('never echoes the raw payload back to the chat', async () => {
		process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
		chatEnrollmentsService._resetForTesting();
		const { createStartCommand } = require('../../src/controllers/commands/handlers/start/startCommand');
		const handler = createStartCommand();
		const ctx = buildContext({ chatId: 1234, startPayload: 'enroll&secret-token=ABCD' });

		await handler(ctx);

		const [text] = ctx.reply.mock.calls[0];
		expect(text).not.toMatch(/ABCD/);
		expect(text).not.toMatch(/secret-token/);
	});
});
