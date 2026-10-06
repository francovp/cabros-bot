'use strict';

/**
 * Issue #886 acceptance — `!analisis BINANCE:BTCUSDT` on an allowlisted WhatsApp chat
 * creates a job and replies with the jobId/status, matching Telegram `/analisis`.
 *
 * This exercises the real `src/controllers/commands.js` handlers through the real
 * bridge (only the job store and the MCP readiness probe are doubled), so it proves
 * the delegation path really reaches `jobService.createJob` with WhatsApp routing.
 */

const mockCreateJob = jest.fn();
const mockValidateJobRequest = jest.fn();

jest.mock('../../src/services/jobs/JobService', () => ({
	jobService: {
		createJob: (...args) => mockCreateJob(...args),
		validateJobRequest: (...args) => mockValidateJobRequest(...args),
		getJob: jest.fn(),
		listJobs: jest.fn(async () => []),
	},
}));

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		getStatus: () => ({ status: 'ready' }),
		syncDurableStatus: async () => {},
	},
}));

jest.mock('../../src/lib/maintenanceMode', () => ({
	isMaintenanceModeEnabled: () => false,
	sendMaintenanceReply: jest.fn(),
}));

const WhatsAppCommandBridgeService = require('../../src/services/notification/WhatsAppCommandBridgeService');

describe('WhatsApp bridge → real Telegram handlers (#886)', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		process.env.ENABLE_WHATSAPP_COMMANDS = 'true';
		process.env.WHATSAPP_API_URL = 'https://api.green-api.com/waInstance1/sendMessage/';
		process.env.WHATSAPP_API_KEY = 'green-api-token';
		process.env.WHATSAPP_COMMAND_CHAT_IDS = '120363422033474991@g.us';
		process.env.EXPANDED_ANALYSIS_ALERT_SYMBOLS = 'BINANCE:BTCUSDT';
		mockCreateJob.mockReset();
		mockValidateJobRequest.mockReset();
		mockCreateJob.mockResolvedValue({ jobId: 'job-77', status: 'pending' });
	});

	afterEach(() => {
		process.env = originalEnv;
		jest.restoreAllMocks();
	});

	function buildService() {
		const sends = [];
		const whatsAppService = {
			send: jest.fn(async (payload) => {
				sends.push(payload);
				return { success: true, messageId: 'msg-1' };
			}),
		};
		const service = new WhatsAppCommandBridgeService({ whatsAppService });
		return { service, sends, whatsAppService };
	}

	function notification(text) {
		return {
			receiptId: 4242,
			body: {
				typeWebhook: 'incomingMessageReceived',
				senderData: { chatId: '120363422033474991@g.us' },
				messageData: { textMessageData: { textMessage: text } },
			},
		};
	}

	test('!analisis BINANCE:BTCUSDT creates a job and replies with its jobId and status', async () => {
		const { service, sends } = buildService();

		const handled = await service.handleNotification(notification('!analisis BINANCE:BTCUSDT'));

		expect(handled).toMatchObject({ action: 'executed', command: 'analisis' });
		expect(mockCreateJob).toHaveBeenCalledTimes(1);

		const [type, payload] = mockCreateJob.mock.calls[0];
		expect(type).toBe('expanded-analysis');
		expect(payload.symbols).toEqual(['BINANCE:BTCUSDT']);
		expect(sends).toEqual([
			{ text: 'Job job-77 creado para expanded-analysis. Estado: pending.', whatsappChatId: '120363422033474991@g.us' },
		]);
	});

	test('the created job is routed to the WhatsApp chat and never to Telegram', async () => {
		const { service } = buildService();

		await service.handleNotification(notification('!analisis BINANCE:BTCUSDT'));

		const [, payload] = mockCreateJob.mock.calls[0];
		expect(payload.channels).toEqual(['whatsapp']);
		expect(payload.whatsappChatId).toBe('120363422033474991@g.us');
		expect(payload.telegramChatId).toBeUndefined();
	});

	test('!scanner creates a market-scanner job routed to WhatsApp', async () => {
		const { service, sends } = buildService();
		mockCreateJob.mockResolvedValue({ jobId: 'job-88', status: 'queued' });

		const handled = await service.handleNotification(notification('!scanner exchange=BINANCE timeframe=4h'));

		expect(handled).toMatchObject({ action: 'executed', command: 'scanner' });
		const [type, payload] = mockCreateJob.mock.calls[0];
		expect(type).toBe('market-scanner');
		expect(payload.exchange).toBe('BINANCE');
		expect(payload.timeframe).toBe('4h');
		expect(payload.whatsappChatId).toBe('120363422033474991@g.us');
		expect(sends[0].text).toBe('Job job-88 creado para market-scanner. Estado: queued.');
	});

	test('an invalid !analisis request replies with the shared validation error and creates no job', async () => {
		const { service, sends } = buildService();
		mockValidateJobRequest.mockImplementation(() => {
			const error = new Error('timeoutMs must be a positive integer');
			error.statusCode = 400;
			throw error;
		});

		await service.handleNotification(notification('!analisis BINANCE:BTCUSDT timeoutMs=abc'));

		expect(mockCreateJob).not.toHaveBeenCalled();
		expect(sends[0].text).toContain('timeoutMs must be a positive integer');
		expect(sends[0].whatsappChatId).toBe('120363422033474991@g.us');
	});

	test('!help advertises the parity commands over WhatsApp', async () => {
		const { service, sends } = buildService();

		await service.handleNotification(notification('!help'));

		['!precio', '!analisis', '!scanner', '!noticias', '!outcomes', '!help'].forEach((command) => {
			expect(sends[0].text).toContain(command);
		});
	});
});