'use strict';

const alertStorageService = require('../../src/services/storage/AlertStorageService');
const {
	UserPriceAlertService,
	userPriceAlertService,
	parseUserPriceAlertInput,
	normalizeOperator,
	UserPriceAlertError,
	stripUndefinedFieldsDeep,
} = require('../../src/services/alerts/UserPriceAlertService');
const fetchPriceModule = require('../../src/controllers/commands/handlers/core/fetchPriceCryptoSymbol');

describe('UserPriceAlertService - Unit Tests', () => {
	let service;
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_USER_PRICE_ALERTS = 'true';
		process.env.USER_PRICE_ALERT_WORKER_ROLE = 'web';
		process.env.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS = '60000';
		process.env.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT = '50';
		process.env.USER_PRICE_ALERT_MAX_PER_CHAT = '5';

		service = new UserPriceAlertService();
		service._resetForTesting();
	});

	afterEach(async () => {
		if (service) {
			await service.stopWorker({ drain: false });
		}
		process.env = savedEnv;
		jest.restoreAllMocks();
	});

	describe('Input Parsing & Operator Normalization', () => {
		it('normalizes valid operators', () => {
			expect(normalizeOperator('<')).toBe('<');
			expect(normalizeOperator('<=')).toBe('<=');
			expect(normalizeOperator('>')).toBe('>');
			expect(normalizeOperator('>=')).toBe('>=');
			expect(normalizeOperator('menor')).toBe('<');
			expect(normalizeOperator('mayor')).toBe('>');
			expect(normalizeOperator('debajo')).toBe('<');
			expect(normalizeOperator('encima')).toBe('>');
			expect(normalizeOperator('invalid')).toBe(null);
		});

		it('parses separated args: SYMBOL OPERATOR PRICE', () => {
			const parsed = parseUserPriceAlertInput(['BTCUSDT', '<', '60000']);
			expect(parsed.valid).toBe(true);
			expect(parsed.rawSymbol).toBe('BTCUSDT');
			expect(parsed.operator).toBe('<');
			expect(parsed.targetPrice).toBe(60000);
		});

		it('parses combined operator and price: SYMBOL <60000', () => {
			const parsed = parseUserPriceAlertInput(['BTCUSDT', '<60000']);
			expect(parsed.valid).toBe(true);
			expect(parsed.rawSymbol).toBe('BTCUSDT');
			expect(parsed.operator).toBe('<');
			expect(parsed.targetPrice).toBe(60000);
		});

		it('parses implicit operator when current price is provided', () => {
			// When target price is lower than current price, default to '<'
			const parsedLower = parseUserPriceAlertInput(['BTCUSDT', '55000'], { currentPrice: 60000 });
			expect(parsedLower.valid).toBe(true);
			expect(parsedLower.operator).toBe('<');
			expect(parsedLower.targetPrice).toBe(55000);

			// When target price is higher than current price, default to '>'
			const parsedHigher = parseUserPriceAlertInput(['BTCUSDT', '65000'], { currentPrice: 60000 });
			expect(parsedHigher.valid).toBe(true);
			expect(parsedHigher.operator).toBe('>');
			expect(parsedHigher.targetPrice).toBe(65000);
		});

		it('handles formatted numbers with commas (e.g. 60,000.50 or 60.000,50)', () => {
			const parsed1 = parseUserPriceAlertInput(['BTCUSDT', '<', '60,000.50']);
			expect(parsed1.valid).toBe(true);
			expect(parsed1.targetPrice).toBe(60000.5);

			const parsed2 = parseUserPriceAlertInput(['ETHUSDT', '>', '3,500']);
			expect(parsed2.valid).toBe(true);
			expect(parsed2.targetPrice).toBe(3500);
		});

		it('rejects invalid prices or missing symbols', () => {
			expect(parseUserPriceAlertInput([]).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT']).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT', '<', 'not-a-number']).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT', '<', '-100']).valid).toBe(false);
			expect(parseUserPriceAlertInput(['BTCUSDT', '<', '0']).valid).toBe(false);
		});
	});

	describe('Alert Creation & Scoping', () => {
		it('creates an active armed alert in memory when Firestore is not configured', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: '12345',
				telegramThreadId: 10,
				symbol: 'BTCUSDT',
				rawSymbol: 'BINANCE:BTCUSDT',
				exchange: 'BINANCE',
				assetClass: 'crypto',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			expect(alert).toBeDefined();
			expect(alert.id).toBeDefined();
			expect(alert.chatId).toBe('12345');
			expect(alert.telegramThreadId).toBe(10);
			expect(alert.symbol).toBe('BTCUSDT');
			expect(alert.operator).toBe('<');
			expect(alert.targetPrice).toBe(60000);
			expect(alert.initialPrice).toBe(64000);
			expect(alert.status).toBe('armed');
			expect(alert.createdAt).toBeDefined();

			const list = await service.listAlerts({ chatId: '12345' });
			expect(list.length).toBe(1);
			expect(list[0].id).toBe(alert.id);
		});

		it('enforces per-chat active alert quota', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);
			process.env.USER_PRICE_ALERT_MAX_PER_CHAT = '2';

			await service.createAlert({
				chatId: 'chat-quota',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});
			await service.createAlert({
				chatId: 'chat-quota',
				symbol: 'ETHUSDT',
				operator: '>',
				targetPrice: 3500,
				initialPrice: 3000,
			});

			await expect(
				service.createAlert({
					chatId: 'chat-quota',
					symbol: 'SOLUSDT',
					operator: '>',
					targetPrice: 200,
					initialPrice: 150,
				})
			).rejects.toThrow(/Límite de alertas activas alcanzado/i);
		});

		it('allows cancelling an existing alert', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: 'chat-cancel',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			const cancelled = await service.cancelAlert({
				chatId: 'chat-cancel',
				alertId: alert.id,
			});

			expect(cancelled.status).toBe('cancelled');
			expect(cancelled.cancelledAt).toBeDefined();

			const activeList = await service.listAlerts({ chatId: 'chat-cancel', status: 'armed' });
			expect(activeList.length).toBe(0);
		});

		it('rejects cancelling an alert belonging to a different chat', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: 'chat-owner',
				symbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			await expect(
				service.cancelAlert({
					chatId: 'other-chat',
					alertId: alert.id,
				})
			).rejects.toThrow(/No se encontró una alerta activa con ese ID/i);
		});
	});

	describe('Evaluation Loop & Notification Triggering', () => {
		it('evaluates armed alerts and triggers notifications when threshold is crossed', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const mockBot = {
				telegram: {
					sendMessage: jest.fn().mockResolvedValue({ message_id: 99 }),
				},
			};
			service.setBotGetter(() => mockBot);

			// Alert 1: BTCUSDT < 60000 (Crossed if price is 59000)
			await service.createAlert({
				chatId: 'chat-eval-1',
				telegramThreadId: 5,
				symbol: 'BTCUSDT',
				rawSymbol: 'BTCUSDT',
				operator: '<',
				targetPrice: 60000,
				initialPrice: 64000,
			});

			// Alert 2: ETHUSDT > 3500 (Not crossed if price is 3200)
			await service.createAlert({
				chatId: 'chat-eval-2',
				symbol: 'ETHUSDT',
				rawSymbol: 'ETHUSDT',
				operator: '>',
				targetPrice: 3500,
				initialPrice: 3000,
			});

			// Mock price resolver
			const mockPrices = {
				BTCUSDT: { symbol: 'BTCUSDT', price: 59000, assetClass: 'crypto' },
				ETHUSDT: { symbol: 'ETHUSDT', price: 3200, assetClass: 'crypto' },
			};
			jest.spyOn(service, '_fetchCurrentPrice').mockImplementation(async (item) => {
				return mockPrices[item.symbol] || { symbol: item.symbol, price: 100 };
			});

			const results = await service.evaluateAlerts();

			expect(results.evaluatedCount).toBe(2);
			expect(results.triggeredCount).toBe(1);
			expect(results.errorsCount).toBe(0);

			// Check that mockBot sent message for BTCUSDT
			expect(mockBot.telegram.sendMessage).toHaveBeenCalledTimes(1);
			const [chatId, text, options] = mockBot.telegram.sendMessage.mock.calls[0];
			expect(chatId).toBe('chat-eval-1');
			expect(text).toContain('BTCUSDT');
			expect(text).toContain('59');
			expect(options.message_thread_id).toBe(5);
			expect(options.parse_mode).toBe('MarkdownV2');

			// Verify status updated to triggered
			const activeList = await service.listAlerts({ chatId: 'chat-eval-1', status: 'armed' });
			expect(activeList.length).toBe(0);
		});

		it('marks expired alerts without sending notifications', async () => {
			jest.spyOn(alertStorageService, 'getFirestore').mockReturnValue(null);

			const alert = await service.createAlert({
				chatId: 'chat-expired',
				symbol: 'SOLUSDT',
				operator: '>',
				targetPrice: 200,
				initialPrice: 150,
			});

			// Manually age alert expiresAt to the past
			alert.expiresAt = new Date(Date.now() - 10000).toISOString();

			const results = await service.evaluateAlerts();
			expect(results.triggeredCount).toBe(0);
			expect(alert.status).toBe('expired');
		});
	});

	describe('Worker Gating and Status', () => {
		it('reports correct status when enabled and configured', () => {
			const status = service.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.ready).toBe(true);
			expect(status.role).toBe('web');
			expect(status.intervalMs).toBe(60000);
			expect(status.batchLimit).toBe(50);
		});

		it('reports disabled status when ENABLE_USER_PRICE_ALERTS is false', () => {
			process.env.ENABLE_USER_PRICE_ALERTS = 'false';
			const status = service.getStatus();
			expect(status.enabled).toBe(false);
			expect(status.ready).toBe(false);
		});
	});
});
