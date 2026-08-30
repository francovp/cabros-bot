'use strict';

const { userPriceAlertService } = require('../../src/services/alerts/UserPriceAlertService');
const fetchPriceModule = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');

describe('User Price Alerts Integration', () => {
	let botMock;
	let sendTelegramMock;
	let fetchCryptoSpy;
	let fetchEquitySpy;

	beforeEach(() => {
		process.env.ENABLE_USER_PRICE_ALERTS = 'true';
		userPriceAlertService._resetForTesting();

		sendTelegramMock = jest.fn().mockResolvedValue({ message_id: 999 });
		botMock = {
			telegram: {
				sendMessage: sendTelegramMock,
			},
		};
		userPriceAlertService.setBotGetter(() => botMock);

		fetchCryptoSpy = jest.spyOn(fetchPriceModule, 'fetchCryptoPrice').mockImplementation(async (symbol) => {
			if (symbol === 'BTCUSDT') {
				return { symbol: 'BTCUSDT', price: 58000, change24h: -3.5 };
			}
			if (symbol === 'ETHUSDT') {
				return { symbol: 'ETHUSDT', price: 3600, change24h: 4.2 };
			}
			return { symbol, price: 100, change24h: 0 };
		});

		fetchEquitySpy = jest.spyOn(fetchPriceModule, 'fetchEquityPrice').mockImplementation(async (symbol) => {
			if (symbol === 'NVDA') {
				return { symbol: 'NVDA', exchange: 'NASDAQ', price: 145, change24h: 3.1 };
			}
			return { symbol, price: 50, change24h: 0 };
		});
	});

	afterEach(async () => {
		await userPriceAlertService.stopWorker();
		jest.restoreAllMocks();
		delete process.env.ENABLE_USER_PRICE_ALERTS;
	});

	it('creates alerts, evaluates conditions, and fires notifications with Telegram MarkdownV2', async () => {
		// 1. Create 3 alerts:
		// Alert 1: BTCUSDT < 60000 (Trigger condition met since price is 58,000)
		// Alert 2: ETHUSDT < 3000 (Trigger condition NOT met since price is 3,600)
		// Alert 3: NVDA >= 140 (Trigger condition met since price is 145)
		const btcAlert = await userPriceAlertService.createAlert({
			chatId: '987654',
			telegramThreadId: 101,
			symbol: 'BTCUSDT',
			rawSymbol: 'BTCUSDT',
			operator: '<',
			targetPrice: 60000,
			initialPrice: 65000,
			userId: 111,
		});

		const ethAlert = await userPriceAlertService.createAlert({
			chatId: '987654',
			symbol: 'ETHUSDT',
			rawSymbol: 'ETHUSDT',
			operator: '<',
			targetPrice: 3000,
			initialPrice: 3500,
			userId: 111,
		});

		const nvdaAlert = await userPriceAlertService.createAlert({
			chatId: '987654',
			symbol: 'NVDA',
			rawSymbol: 'NASDAQ:NVDA',
			exchange: 'NASDAQ',
			assetClass: 'equity',
			operator: '>=',
			targetPrice: 140,
			initialPrice: 130,
			userId: 111,
		});

		// 2. Run evaluation sweep
		const sweepResults = await userPriceAlertService.evaluateAlerts({ maxBatch: 10 });
		expect(sweepResults.evaluatedCount).toBe(3);
		expect(sweepResults.triggeredCount).toBe(2);
		expect(sweepResults.errorsCount).toBe(0);

		// 3. Verify notifications sent via Telegram
		expect(sendTelegramMock).toHaveBeenCalledTimes(2);

		// Verify BTC notification details
		const btcCall = sendTelegramMock.mock.calls.find(c => c[0] === '987654' && c[1].includes('BTCUSDT'));
		expect(btcCall).toBeDefined();
		expect(btcCall[1]).toContain('🔔 *Alerta de Precio Activada*');
		expect(btcCall[1]).toContain('• Símbolo: `BTCUSDT`');
		expect(btcCall[1]).toContain('• Condición: `< 60,000`');
		expect(btcCall[1]).toContain('• Precio actual: *58,000*');
		expect(btcCall[2]).toEqual({
			parse_mode: 'MarkdownV2',
			message_thread_id: 101,
		});

		// Verify NVDA notification details
		const nvdaCall = sendTelegramMock.mock.calls.find(c => c[0] === '987654' && c[1].includes('NVDA'));
		expect(nvdaCall).toBeDefined();
		expect(nvdaCall[1]).toContain('• Símbolo: `NVDA`');
		expect(nvdaCall[1]).toContain('• Condición: `>= 140`');
		expect(nvdaCall[1]).toContain('• Precio actual: *145*');

		// 4. Verify statuses
		const updatedBtc = await userPriceAlertService.getAlert(btcAlert.id);
		expect(updatedBtc.status).toBe('triggered');
		expect(updatedBtc.triggeredPrice).toBe(58000);
		expect(updatedBtc.triggeredAt).toBeDefined();

		const updatedEth = await userPriceAlertService.getAlert(ethAlert.id);
		expect(updatedEth.status).toBe('armed');

		const updatedNvda = await userPriceAlertService.getAlert(nvdaAlert.id);
		expect(updatedNvda.status).toBe('triggered');

		// 5. Active list should only contain ETH alert
		const activeList = await userPriceAlertService.listAlerts({ chatId: '987654', status: 'armed' });
		expect(activeList.length).toBe(1);
		expect(activeList[0].id).toBe(ethAlert.id);
	});

	it('manages worker lifecycle cleanly', async () => {
		userPriceAlertService.startWorker({ intervalMs: 50000 });
		expect(userPriceAlertService.getStatus().running).toBe(true);

		await userPriceAlertService.stopWorker();
		expect(userPriceAlertService.getStatus().running).toBe(false);
	});
});
