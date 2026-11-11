'use strict';

/**
 * Issue #886 — WhatsApp command parity.
 *
 * `createTradingViewJobCommand` hard-codes `telegramChatId` from the Telegraf chat
 * id, so a job created from the WhatsApp bridge would be routed to a Telegram chat
 * id shaped like a GreenAPI chat id. These tests pin the additive
 * `context.notificationRouting` override that lets a non-Telegram caller choose the
 * delivery destination while leaving every Telegram call byte-identical.
 */

const mockCreateJob = jest.fn();
const mockValidateJobRequest = jest.fn();

jest.mock('../../src/services/jobs/JobService', () => ({
	jobService: {
		createJob: (...args) => mockCreateJob(...args),
		validateJobRequest: (...args) => mockValidateJobRequest(...args),
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

const {
	expandedAnalysisCmd,
	marketScannerCmd,
	resolveJobRouting,
} = require('../../src/controllers/commands');

function telegramContext(text, chatId) {
	const replies = [];
	return {
		replies,
		context: {
			message: { text },
			update: { message: { chat: { id: chatId } } },
			reply: jest.fn(async (message) => {
				replies.push(message);
			}),
		},
	};
}

describe('resolveJobRouting', () => {
	test('defaults to the Telegraf chat id when no override is present', () => {
		expect(resolveJobRouting({}, 12345)).toEqual({ telegramChatId: '12345' });
	});

	test('returns an empty object when there is no chat id and no override', () => {
		expect(resolveJobRouting({}, undefined)).toEqual({});
		expect(resolveJobRouting({}, null)).toEqual({});
	});

	test('honors an explicit notificationRouting override', () => {
		expect(
			resolveJobRouting({ notificationRouting: { channels: ['whatsapp'], whatsappChatId: '120363@g.us' } }, 12345),
		).toEqual({ channels: ['whatsapp'], whatsappChatId: '120363@g.us' });
	});

	test('ignores a non-object override so a malformed caller cannot erase routing', () => {
		expect(resolveJobRouting({ notificationRouting: 'whatsapp' }, 12345)).toEqual({ telegramChatId: '12345' });
		expect(resolveJobRouting({ notificationRouting: null }, 12345)).toEqual({ telegramChatId: '12345' });
	});
});

describe('createTradingViewJobCommand routing (#886)', () => {
	beforeEach(() => {
		mockCreateJob.mockReset();
		mockValidateJobRequest.mockReset();
		mockCreateJob.mockResolvedValue({ jobId: 'job-1', status: 'pending' });
	});

	test('/analisis keeps telegramChatId for Telegram callers', async () => {
		const { context, replies } = telegramContext('/analisis BINANCE:BTCUSDT', 987654);

		await expandedAnalysisCmd(context);

		expect(mockCreateJob).toHaveBeenCalledTimes(1);
		const [type, payload] = mockCreateJob.mock.calls[0];
		expect(type).toBe('expanded-analysis');
		expect(payload).toMatchObject({ symbols: ['BINANCE:BTCUSDT'], telegramChatId: '987654' });
		expect(payload.whatsappChatId).toBeUndefined();
		expect(payload.channels).toBeUndefined();
		expect(replies).toEqual(['Job job-1 creado para expanded-analysis. Estado: pending.']);
	});

	test('/analisis routes a WhatsApp-originated job to WhatsApp instead of Telegram', async () => {
		const { context } = telegramContext('/analisis BINANCE:BTCUSDT', '120363422033474991@g.us');
		context.notificationRouting = { channels: ['whatsapp'], whatsappChatId: '120363422033474991@g.us' };

		await expandedAnalysisCmd(context);

		expect(mockCreateJob).toHaveBeenCalledTimes(1);
		const [type, payload] = mockCreateJob.mock.calls[0];
		expect(type).toBe('expanded-analysis');
		expect(payload.symbols).toEqual(['BINANCE:BTCUSDT']);
		expect(payload.channels).toEqual(['whatsapp']);
		expect(payload.whatsappChatId).toBe('120363422033474991@g.us');
		expect(payload.telegramChatId).toBeUndefined();
	});

	test('/scanner routes a WhatsApp-originated job to WhatsApp instead of Telegram', async () => {
		const { context } = telegramContext('/scanner exchange=BINANCE', '120363422033474991@g.us');
		context.notificationRouting = { channels: ['whatsapp'], whatsappChatId: '120363422033474991@g.us' };

		await marketScannerCmd(context);

		expect(mockCreateJob).toHaveBeenCalledTimes(1);
		const [type, payload] = mockCreateJob.mock.calls[0];
		expect(type).toBe('market-scanner');
		expect(payload.exchange).toBe('BINANCE');
		expect(payload.channels).toEqual(['whatsapp']);
		expect(payload.whatsappChatId).toBe('120363422033474991@g.us');
		expect(payload.telegramChatId).toBeUndefined();
	});
});