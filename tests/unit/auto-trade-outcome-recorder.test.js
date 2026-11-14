'use strict';

const mockRecordOrderFills = jest.fn();
const mockRecordMutation = jest.fn();
const mockBroadcast = jest.fn();
const mockSend = jest.fn();
const mockIsEnabled = jest.fn();

jest.mock('../../src/services/trading/TradeLedgerService', () => ({
	tradeLedgerService: { recordOrderFills: (...a) => mockRecordOrderFills(...a) },
}));
jest.mock('../../src/services/trading/BinanceOrderAuditService', () => ({
	binanceOrderAuditService: { recordMutation: (...a) => mockRecordMutation(...a) },
}));
jest.mock('../../src/services/sse/AdminSseService', () => ({
	adminSseService: { broadcast: (...a) => mockBroadcast(...a) },
}));
jest.mock('../../src/controllers/webhooks/handlers/alert/alert', () => ({
	getNotificationManager: () => ({
		channels: new Map([['telegram', { send: (...a) => mockSend(...a), isEnabled: () => mockIsEnabled() }]]),
	}),
}));

const { recordAutoTradeOutcome } = require('../../src/services/trading/autoTradeOutcomeRecorder');

const order = { symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', quoteOrderQty: 100, origin: 'auto_trade' };
const filled = {
	orderId: 7, symbol: 'BTCUSDT', side: 'BUY', type: 'MARKET', status: 'FILLED',
	executedQty: '0.002', cummulativeQuoteQty: '100', clientOrderId: 'c1',
};
const reservation = { id: 'res-1' };

beforeEach(() => {
	jest.clearAllMocks();
	process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100';
	mockRecordOrderFills.mockResolvedValue(true);
	mockRecordMutation.mockResolvedValue(null);
	mockSend.mockResolvedValue({ success: true });
	mockIsEnabled.mockReturnValue(true);
});

afterAll(() => {
	delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
});

describe('recordAutoTradeOutcome (#1494)', () => {
	it('records ledger, one audit record, notification and SSE for a submitted order', async () => {
		await recordAutoTradeOutcome({
			status: 'submitted', order, reservation, signalId: 'sig-1',
			result: { dryRun: false, environment: 'live', order: filled },
		});
		expect(mockRecordOrderFills).toHaveBeenCalledWith(expect.objectContaining({
			environment: 'live', order: filled, origin: 'auto_trade', alertId: 'sig-1',
		}));
		expect(mockRecordMutation).toHaveBeenCalledTimes(1);
		expect(mockRecordMutation).toHaveBeenCalledWith(expect.objectContaining({
			status: 'FILLED', origin: 'auto_trade', binanceOrderId: 7,
		}));
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockSend.mock.calls[0][0]).toMatchObject({ telegramChatId: '-100' });
		expect(mockSend.mock.calls[0][0].text).toContain('Avg price: 50000');
		expect(mockBroadcast).toHaveBeenCalledWith('auto-trade-outcome', expect.objectContaining({
			status: 'submitted', symbol: 'BTCUSDT', avgPrice: '50000',
		}));
	});

	it('audits and notifies a failed order without a ledger write', async () => {
		await recordAutoTradeOutcome({
			status: 'failed', order, reservation,
			error: Object.assign(new Error('nope'), { code: 'BINANCE_ORDER_REJECTED' }),
		});
		expect(mockRecordOrderFills).not.toHaveBeenCalled();
		expect(mockRecordMutation).toHaveBeenCalledTimes(1);
		expect(mockRecordMutation).toHaveBeenCalledWith(expect.objectContaining({
			status: 'rejected', errorCode: 'BINANCE_ORDER_REJECTED',
		}));
		expect(mockSend.mock.calls[0][0].text).toContain('BINANCE_ORDER_REJECTED');
	});

	it('links the reconciliation endpoint for an unknown outcome', async () => {
		await recordAutoTradeOutcome({
			status: 'unknown', order, reservation,
			error: Object.assign(new Error('?'), { code: 'BINANCE_ORDER_STATUS_UNKNOWN' }),
		});
		expect(mockRecordMutation).toHaveBeenCalledWith(expect.objectContaining({ status: 'ambiguous' }));
		expect(mockSend.mock.calls[0][0].text).toContain('/api/trading/binance/reconciliation/res-1');
	});

	it('is fail-open when ledger, audit, notification and SSE all fail', async () => {
		mockRecordOrderFills.mockRejectedValue(new Error('ledger'));
		mockRecordMutation.mockRejectedValue(new Error('audit'));
		mockSend.mockRejectedValue(new Error('tg'));
		mockBroadcast.mockImplementation(() => { throw new Error('sse'); });
		await expect(recordAutoTradeOutcome({
			status: 'submitted', order, reservation,
			result: { dryRun: false, environment: 'live', order: filled },
		})).resolves.toBeUndefined();
		expect(mockRecordMutation).toHaveBeenCalledTimes(1);
		expect(mockSend).toHaveBeenCalledTimes(1);
		expect(mockBroadcast).toHaveBeenCalledTimes(1);
	});

	it('skips Telegram when no admin chat is configured but still audits and broadcasts', async () => {
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		await recordAutoTradeOutcome({
			status: 'failed', order, reservation, error: Object.assign(new Error('x'), { code: 'X' }),
		});
		expect(mockSend).not.toHaveBeenCalled();
		expect(mockRecordMutation).toHaveBeenCalledTimes(1);
		expect(mockBroadcast).toHaveBeenCalledTimes(1);
	});
});
