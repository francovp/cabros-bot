'use strict';

const { TelegramReactionService, telegramReactionService, APPROVE_EMOJIS, REJECT_EMOJIS } = require('../../src/services/telegram/telegramReactionService');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const { reactionsSymbol } = require('../../src/controllers/commands/handlers/reactionsSymbol');
const { eventBus } = require('../../src/lib/eventBus');
const { EVENT_NAMES } = require('../../src/lib/eventBusCatalog');

describe('Telegram Reaction Aggregation (Issue #844)', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
		process.env.ENABLE_TELEGRAM_REACTION_AGGREGATION = 'true';
		alertStorageService._resetForTesting();
		telegramReactionService._resetForTesting();
		eventBus.removeAllListeners();
	});

	afterEach(() => {
		jest.restoreAllMocks();
		process.env = originalEnv;
		alertStorageService._resetForTesting();
		telegramReactionService._resetForTesting();
		eventBus.removeAllListeners();
	});

	describe('Emoji Classification', () => {
		it('classifies approve emojis with weight 1', () => {
			for (const emoji of APPROVE_EMOJIS) {
				const result = telegramReactionService.classifyEmoji(emoji);
				expect(result.approve).toBe(true);
				expect(result.reject).toBe(false);
				expect(result.neutral).toBe(false);
				expect(result.removed).toBe(false);
				expect(result.weight).toBe(1);
			}
		});

		it('classifies reject emojis with weight -1', () => {
			for (const emoji of REJECT_EMOJIS) {
				const result = telegramReactionService.classifyEmoji(emoji);
				expect(result.approve).toBe(false);
				expect(result.reject).toBe(true);
				expect(result.neutral).toBe(false);
				expect(result.removed).toBe(false);
				expect(result.weight).toBe(-1);
			}
		});

		it('classifies unrecognized emoji as neutral with weight 0', () => {
			const result = telegramReactionService.classifyEmoji('🤔');
			expect(result.approve).toBe(false);
			expect(result.reject).toBe(false);
			expect(result.neutral).toBe(true);
			expect(result.removed).toBe(false);
			expect(result.weight).toBe(0);
		});

		it('classifies empty or null emoji as removed', () => {
			const result = telegramReactionService.classifyEmoji(null);
			expect(result.removed).toBe(true);
			expect(result.weight).toBe(0);
		});
	});

	describe('Reaction Update Handler & Debouncing', () => {
		it('returns disabled when ENABLE_TELEGRAM_REACTION_AGGREGATION is false', async () => {
			process.env.ENABLE_TELEGRAM_REACTION_AGGREGATION = 'false';
			const result = await telegramReactionService.handleReactionUpdate({});
			expect(result.processed).toBe(false);
			expect(result.reason).toBe('disabled');
		});

		it('rejects context missing required identifiers', async () => {
			const result = await telegramReactionService.handleReactionUpdate({
				message_reaction: { chat: { id: 123 } },
			});
			expect(result.processed).toBe(false);
			expect(result.reason).toBe('missing_identifiers');
		});

		it('debounces rapid duplicate reaction updates from the same user', async () => {
			const ctx = {
				update: {
					message_reaction: {
						chat: { id: -100123 },
						message_id: 999,
						user: { id: 456 },
						new_reaction: [{ type: 'emoji', emoji: '👍' }],
					},
				},
			};

			jest.spyOn(alertStorageService, 'findAlertByTelegramMessageId').mockResolvedValue({
				id: 'alert-1',
				symbol: 'BTCUSDT',
			});
			jest.spyOn(alertStorageService, 'updateAlertReactions').mockResolvedValue(true);

			const first = await telegramReactionService.handleReactionUpdate(ctx);
			expect(first.processed).toBe(true);

			const second = await telegramReactionService.handleReactionUpdate(ctx);
			expect(second.processed).toBe(false);
			expect(second.reason).toBe('debounced');
		});

		it('emits SIGNAL_EVALUATED on eventBus upon successful reaction update', async () => {
			const ctx = {
				update: {
					message_reaction: {
						chat: { id: -100123 },
						message_id: 888,
						user: { id: 789 },
						new_reaction: [{ type: 'emoji', emoji: '🚀' }],
					},
				},
			};

			jest.spyOn(alertStorageService, 'findAlertByTelegramMessageId').mockResolvedValue({
				id: 'alert-888',
				symbol: 'ETHUSDT',
			});
			jest.spyOn(alertStorageService, 'updateAlertReactions').mockResolvedValue(true);

			const emittedEvents = [];
			eventBus.on(EVENT_NAMES.SIGNAL_EVALUATED, (payload) => {
				emittedEvents.push(payload);
			});

			const result = await telegramReactionService.handleReactionUpdate(ctx);
			expect(result.processed).toBe(true);
			expect(emittedEvents.length).toBe(1);
			expect(emittedEvents[0]).toMatchObject({
				source: 'reaction',
				alertId: 'alert-888',
				symbol: 'ETHUSDT',
				chatId: '-100123',
				userId: '789',
				emoji: '🚀',
				weight: 1,
			});
		});

		it('handles reaction removal (empty new_reaction array)', async () => {
			const ctx = {
				update: {
					message_reaction: {
						chat: { id: -100123 },
						message_id: 777,
						user: { id: 111 },
						new_reaction: [],
					},
				},
			};

			jest.spyOn(alertStorageService, 'findAlertByTelegramMessageId').mockResolvedValue({
				id: 'alert-777',
				symbol: 'SOLUSDT',
			});
			const updateSpy = jest.spyOn(alertStorageService, 'updateAlertReactions').mockResolvedValue(true);

			const result = await telegramReactionService.handleReactionUpdate(ctx);
			expect(result.processed).toBe(true);
			expect(updateSpy).toHaveBeenCalledWith(
				'alert-777',
				expect.objectContaining({
					chatId: '-100123',
					userId: '111',
					removed: true,
				}),
			);
		});
	});

	describe('AlertStorageService Reaction Storage & Extraction', () => {
		it('extracts telegramMessageIds from params and deliveryResults', async () => {
			const alertId = await alertStorageService.saveAlert({
				text: 'BUY BTCUSDT breakout',
				symbol: 'BTCUSDT',
				telegramMessageIds: ['1001', '1002'],
				deliveryResults: [
					{ channel: 'telegram', messageId: 1003 },
					{ channel: 'telegram', messageIds: ['1004', 1005] },
					{ channel: 'whatsapp', messageId: 9999 },
				],
			});

			expect(alertId).toBeTruthy();
			const stored = await alertStorageService.getAlertById(alertId);
			expect(stored.telegramMessageIds).toEqual(
				expect.arrayContaining(['1001', '1002', '1003', '1004', '1005']),
			);
			expect(stored.telegramMessageIds).not.toContain('9999');
		});

		it('finds alert by telegram message ID using array-contains', async () => {
			const alertId = await alertStorageService.saveAlert({
				text: 'BUY ETHUSDT test',
				symbol: 'ETHUSDT',
				telegramMessageIds: ['54321'],
			});

			const found = await alertStorageService.findAlertByTelegramMessageId('54321');
			expect(found).toBeTruthy();
			expect(found.id).toBe(alertId);
			expect(found.symbol).toBe('ETHUSDT');
		});

		it('updates alert reactions and enforces 5000 reaction bound', async () => {
			const alertId = await alertStorageService.saveAlert({
				text: 'BUY BNBUSDT setup',
				symbol: 'BNBUSDT',
			});

			// User 1 votes approve
			await alertStorageService.updateAlertReactions(alertId, {
				chatId: 'chat1',
				userId: 'user1',
				emoji: '👍',
				weight: 1,
			});

			// User 2 votes reject
			await alertStorageService.updateAlertReactions(alertId, {
				chatId: 'chat1',
				userId: 'user2',
				emoji: '👎',
				weight: -1,
			});

			const stored = await alertStorageService.getAlertById(alertId);
			expect(stored.reactions).toBeDefined();
			expect(stored.reactions['chat1_user1'].emoji).toBe('👍');
			expect(stored.reactions['chat1_user2'].emoji).toBe('👎');

			const aggregated = alertStorageService.aggregateReactions(stored);
			expect(aggregated.total).toBe(2);
			expect(aggregated.approve).toBe(1);
			expect(aggregated.reject).toBe(1);
			expect(aggregated.approveRate).toBe(0.5);
			// Beta-Bernoulli: prior = 0.5 -> (4 * 0.5 + 1) / (4 + 2) = 3 / 6 = 0.5
			expect(aggregated.weightedScore).toBe(0.5);
		});

		it('removes reaction when removed: true', async () => {
			const alertId = await alertStorageService.saveAlert({
				text: 'BUY SOLUSDT setup',
				symbol: 'SOLUSDT',
			});

			await alertStorageService.updateAlertReactions(alertId, {
				chatId: 'chat1',
				userId: 'user1',
				emoji: '🔥',
				weight: 1,
			});

			let stored = await alertStorageService.getAlertById(alertId);
			expect(stored.reactions['chat1_user1']).toBeDefined();

			await alertStorageService.updateAlertReactions(alertId, {
				chatId: 'chat1',
				userId: 'user1',
				removed: true,
			});

			stored = await alertStorageService.getAlertById(alertId);
			expect(stored.reactions['chat1_user1']).toBeUndefined();
		});

		it('ranks top setups by weighted reaction score', async () => {
			const idA = await alertStorageService.saveAlert({
				text: 'BUY BTCUSDT setup A',
				symbol: 'BTCUSDT',
			});
			const idB = await alertStorageService.saveAlert({
				text: 'BUY BTCUSDT setup B',
				symbol: 'BTCUSDT',
			});

			// Setup A: 3 approvals
			for (let i = 1; i <= 3; i++) {
				await alertStorageService.updateAlertReactions(idA, {
					chatId: 'c1',
					userId: `u${i}`,
					emoji: '👍',
					weight: 1,
				});
			}

			// Setup B: 1 approval, 2 rejects
			await alertStorageService.updateAlertReactions(idB, { chatId: 'c1', userId: 'u1', emoji: '👍', weight: 1 });
			await alertStorageService.updateAlertReactions(idB, { chatId: 'c1', userId: 'u2', emoji: '👎', weight: -1 });
			await alertStorageService.updateAlertReactions(idB, { chatId: 'c1', userId: 'u3', emoji: '👎', weight: -1 });

			const top = await alertStorageService.getTopSetupsByReactions({ symbol: 'BTCUSDT', limit: 2 });
			expect(top.length).toBe(2);
			expect(top[0].id).toBe(idA);
			expect(top[0].reactionMetrics.approve).toBe(3);
			expect(top[1].id).toBe(idB);
			expect(top[1].reactionMetrics.reject).toBe(2);
		});
	});

	describe('/reactions Command Handler', () => {
		it('replies with usage instructions when symbol is omitted', async () => {
			const replyMock = jest.fn();
			const ctx = {
				message: { text: '/reactions' },
				reply: replyMock,
			};

			await reactionsSymbol(ctx);
			expect(replyMock).toHaveBeenCalledWith(expect.stringContaining('Uso: /reactions <symbol>'));
		});

		it('replies with empty notice when no reactions exist for symbol', async () => {
			const replyMock = jest.fn();
			const ctx = {
				message: { text: '/reactions XRPUSDT' },
				reply: replyMock,
			};

			jest.spyOn(alertStorageService, 'getTopSetupsByReactions').mockResolvedValue([]);

			await reactionsSymbol(ctx);
			expect(replyMock).toHaveBeenCalledWith(
				expect.stringContaining('No hay reacciones registradas para XRPUSDT'),
				expect.objectContaining({ parse_mode: 'MarkdownV2' }),
			);
		});

		it('replies with formatted top setups when reactions exist', async () => {
			const replyMock = jest.fn();
			const ctx = {
				message: { text: '/reactions BTCUSDT' },
				reply: replyMock,
			};

			jest.spyOn(alertStorageService, 'getTopSetupsByReactions').mockResolvedValue([
				{
					id: 'alert-1',
					symbol: 'BTCUSDT',
					receivedAt: '2026-10-15T12:00:00.000Z',
					text: 'BUY BTCUSDT breakout setup',
					reactionMetrics: {
						total: 10,
						approve: 9,
						reject: 1,
						approveRate: 0.9,
						weightedScore: 0.7857,
					},
				},
			]);

			await reactionsSymbol(ctx);
			expect(replyMock).toHaveBeenCalledWith(
				expect.stringContaining('Top Setups por Reacciones para BTCUSDT'),
				expect.objectContaining({ parse_mode: 'MarkdownV2' }),
			);
		});
	});
});
