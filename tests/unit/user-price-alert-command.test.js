'use strict';

const { userPriceAlertCmd, buildAlertHelpMessage } = require('../../src/controllers/commands/handlers/core/userPriceAlertHandler');
const { userPriceAlertService, UserPriceAlertError } = require('../../src/services/alerts/UserPriceAlertService');
const fetchPriceModule = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');
const sentryService = require('../../src/services/monitoring/SentryService');

describe('User price alert Telegram command (/alerta)', () => {
	let context;
	let fetchCryptoSpy;
	let fetchEquitySpy;

	beforeEach(() => {
		userPriceAlertService._resetForTesting();
		context = {
			message: {
				text: '/alerta',
				chat: { id: 123456 },
				message_thread_id: 42,
			},
			update: {
				message: {
					chat: { id: 123456 },
					message_thread_id: 42,
				},
			},
			from: { id: 789 },
			reply: jest.fn().mockResolvedValue(true),
		};

		fetchCryptoSpy = jest.spyOn(fetchPriceModule, 'fetchCryptoPrice').mockResolvedValue({
			symbol: 'BTCUSDT',
			price: 65000,
			change24h: 2.5,
			high24h: 66000,
			low24h: 64000,
		});

		fetchEquitySpy = jest.spyOn(fetchPriceModule, 'fetchEquityPrice').mockResolvedValue({
			symbol: 'NVDA',
			exchange: 'NASDAQ',
			price: 130,
			change24h: 1.2,
		});
	});

	afterEach(() => {
		jest.restoreAllMocks();
	});

	it('replies with help guide when no arguments or help subcommand is provided', async () => {
		context.message.text = '/alerta';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [text, options] = context.reply.mock.calls[0];
		expect(text).toContain('Alertas de Precio Personalizadas');
		expect(text).toContain('/alerta <simbolo> <operador> <precio>');
		expect(options).toEqual({ parse_mode: 'MarkdownV2', message_thread_id: 42 });

		context.reply.mockClear();
		context.message.text = '/alerta help';
		await userPriceAlertCmd(context);
		expect(context.reply).toHaveBeenCalledTimes(1);
	});

	it('creates a crypto price alert when given symbol, operator, and price', async () => {
		context.message.text = '/alerta BTCUSDT < 60000';
		await userPriceAlertCmd(context);

		expect(fetchCryptoSpy).toHaveBeenCalledWith('BTCUSDT');
		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText, options] = context.reply.mock.calls[0];
		expect(replyText).toContain('Alerta de precio creada');
		expect(replyText).toContain('BTCUSDT');
		expect(replyText).toContain('< 60,000');
		expect(options).toEqual({ parse_mode: 'MarkdownV2', message_thread_id: 42 });

		const activeAlerts = await userPriceAlertService.listAlerts({ chatId: '123456', status: 'armed' });
		expect(activeAlerts.length).toBe(1);
		expect(activeAlerts[0].symbol).toBe('BTCUSDT');
		expect(activeAlerts[0].operator).toBe('<');
		expect(activeAlerts[0].targetPrice).toBe(60000);
		expect(activeAlerts[0].telegramThreadId).toBe(42);
	});

	it('creates an equity price alert when given equity symbol', async () => {
		context.message.text = '/alerta NASDAQ:NVDA > 140';
		await userPriceAlertCmd(context);

		expect(fetchEquitySpy).toHaveBeenCalledWith('NVDA', 'NASDAQ');
		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('Alerta de precio creada');
		expect(replyText).toContain('NVDA');
		expect(replyText).toContain('> 140');
	});

	it('lists active alerts for the current chat', async () => {
		// Create 2 alerts
		await userPriceAlertService.createAlert({
			chatId: '123456',
			symbol: 'BTCUSDT',
			operator: '<',
			targetPrice: 60000,
			initialPrice: 65000,
		});
		await userPriceAlertService.createAlert({
			chatId: '123456',
			symbol: 'ETHUSDT',
			operator: '>=',
			targetPrice: 4000,
			initialPrice: 3500,
		});

		context.message.text = '/alerta list';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('Tus Alertas de Precio Activas');
		expect(replyText).toContain('BTCUSDT < 60,000');
		expect(replyText).toContain('ETHUSDT >= 4,000');
	});

	it('replies friendly when no active alerts exist for list', async () => {
		context.message.text = '/alerta list';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('No tienes alertas de precio activas');
	});

	it('cancels an active alert by ID', async () => {
		const created = await userPriceAlertService.createAlert({
			chatId: '123456',
			symbol: 'BTCUSDT',
			operator: '<',
			targetPrice: 60000,
			initialPrice: 65000,
		});

		context.message.text = `/alerta cancel ${created.id}`;
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('Alerta cancelada exitosamente');
		expect(replyText).toContain(created.id);

		const active = await userPriceAlertService.listAlerts({ chatId: '123456', status: 'armed' });
		expect(active.length).toBe(0);
	});

	it('replies with guidance if cancel is called without alert ID', async () => {
		context.message.text = '/alerta cancel';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('indica el ID de la alerta a cancelar');
	});

	it('handles invalid or unsupported symbol/exchange gracefully', async () => {
		context.message.text = '/alerta UNKNOWNEXCHANGE:BTC < 100';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('no soportado para consulta de precios');
	});

	it('handles price fetch failure gracefully', async () => {
		fetchCryptoSpy.mockRejectedValueOnce(new Error('Network error on Binance'));
		context.message.text = '/alerta BTCUSDT < 50000';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('No se pudo obtener el precio actual');
	});

	it('handles quota limit exceeded gracefully', async () => {
		const maxQuota = 20;
		for (let i = 0; i < maxQuota; i++) {
			await userPriceAlertService.createAlert({
				chatId: '123456',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 50000 - i,
				initialPrice: 65000,
			});
		}

		context.message.text = '/alerta BTCUSDT < 40000';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('Límite de alertas activas alcanzado');
	});

	it('handles unexpected exceptions fail-safely and logs to Sentry', async () => {
		const captureSpy = jest.spyOn(sentryService, 'captureRuntimeError').mockImplementation(() => {});
		jest.spyOn(userPriceAlertService, 'createAlert').mockRejectedValueOnce(new Error('Fatal explosion'));

		context.message.text = '/alerta BTCUSDT < 50000';
		await userPriceAlertCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const [replyText] = context.reply.mock.calls[0];
		expect(replyText).toContain('Ocurrió un error al procesar tu alerta');
		expect(captureSpy).toHaveBeenCalled();
	});
});
