'use strict';

const { createWhatsAppCommandContext, TELEGRAM_COMMAND_DELEGATES } = require('../../src/services/notification/whatsappCommandContext');

describe('createWhatsAppCommandContext (#886)', () => {
	function build(overrides = {}) {
		const sends = [];
		const whatsAppService = {
			send: jest.fn(async (payload) => {
				sends.push(payload);
				return { success: true, messageId: 'msg-1' };
			}),
		};
		const context = createWhatsAppCommandContext({
			chatId: '120363422033474991@g.us',
			command: 'analisis',
			args: 'BINANCE:BTCUSDT',
			whatsAppService,
			...overrides,
		});
		return { context, sends, whatsAppService };
	}

	test('builds the Telegram command text the shared handlers parse', () => {
		const { context } = build();
		expect(context.message.text).toBe('/analisis BINANCE:BTCUSDT');
		expect(context.update.message.chat.id).toBe('120363422033474991@g.us');
	});

	test('omits trailing whitespace when a command has no arguments', () => {
		const { context } = build({ command: 'scanner', args: '' });
		expect(context.message.text).toBe('/scanner');
	});

	test('exposes no telegram handle so readiness warnings and validation errors reach WhatsApp', () => {
		const { context } = build();
		expect(context.telegram).toBeUndefined();
		expect(typeof context.reply).toBe('function');
	});

	test('routes the notification override to WhatsApp only', () => {
		const { context } = build();
		expect(context.notificationRouting).toEqual({
			channels: ['whatsapp'],
			whatsappChatId: '120363422033474991@g.us',
		});
	});

	test('reply() forwards the body to WhatsAppService for the originating chat', async () => {
		const { context, sends } = build();
		await context.reply('Job job-1 creado para expanded-analysis. Estado: pending.');
		expect(sends).toEqual([
			{ text: 'Job job-1 creado para expanded-analysis. Estado: pending.', whatsappChatId: '120363422033474991@g.us' },
		]);
	});

	test('reply() ignores parse_mode because WhatsAppService strips MarkdownV2 escapes itself', async () => {
		const { context, sends } = build();
		await context.reply('*📊 Rendimiento* \\(BTCUSDT\\)', { parse_mode: 'MarkdownV2' });
		expect(sends[0].text).toBe('*📊 Rendimiento* \\(BTCUSDT\\)');
	});

	test('reply() propagates a send failure so the caller can surface it', async () => {
		const whatsAppService = { send: jest.fn().mockRejectedValue(new Error('greenapi down')) };
		const context = createWhatsAppCommandContext({
			chatId: '120363422033474991@g.us',
			command: 'analisis',
			args: '',
			whatsAppService,
		});
		await expect(context.reply('hola')).rejects.toThrow('greenapi down');
	});

	test('resolves to null for a non-string body so a malformed reply cannot reach GreenAPI', async () => {
		const { context } = build();
		await expect(context.reply(undefined)).resolves.toBeNull();
		await expect(context.reply(null)).resolves.toBeNull();
	});

	test('does not expose the raw WhatsApp API key or webhook URL on the context', () => {
		const { context } = build();
		expect(JSON.stringify(context)).not.toContain('webhook');
	});
});

describe('TELEGRAM_COMMAND_DELEGATES (#886)', () => {
	test('maps every WhatsApp command and alias to a Telegram handler name', () => {
		expect(Object.keys(TELEGRAM_COMMAND_DELEGATES).sort()).toEqual([
			'analisis',
			'news',
			'noticias',
			'outcomes',
			'rendimiento',
			'scanner',
		]);
	});

	test('resolves each alias to the same handler name used by Telegram', () => {
		expect(TELEGRAM_COMMAND_DELEGATES['analisis'].handlerName).toBe('expandedAnalysisCmd');
		expect(TELEGRAM_COMMAND_DELEGATES['scanner'].handlerName).toBe('marketScannerCmd');
		expect(TELEGRAM_COMMAND_DELEGATES['noticias'].handlerName).toBe('newsMonitorCmd');
		expect(TELEGRAM_COMMAND_DELEGATES['news'].handlerName).toBe('newsMonitorCmd');
		expect(TELEGRAM_COMMAND_DELEGATES['outcomes'].handlerName).toBe('outcomesCommand');
		expect(TELEGRAM_COMMAND_DELEGATES['rendimiento'].handlerName).toBe('outcomesCommand');
	});

	test('keeps command names free of the WhatsApp prefix so the shared parser sees a Telegram verb', () => {
		Object.values(TELEGRAM_COMMAND_DELEGATES).forEach((entry) => {
			expect(entry.command).not.toMatch(/^[!/]/);
		});
	});
});