'use strict';

const {
	ChatSubscriptionService,
	ChatSubscriptionValidationError,
	MAX_SUBSCRIPTIONS_PER_CHAT,
} = require('../../src/services/chatSubscriptions/ChatSubscriptionService');

describe('ChatSubscriptionService', () => {
	let service;
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		delete process.env.CHAT_SUBSCRIPTION_MIN_INTERVAL_MS;
		service = new ChatSubscriptionService({ minIntervalMs: 60 * 60 * 1000 });
	});

	afterEach(() => {
		process.env = savedEnv;
		service.resetForTests();
	});

	describe('validateParams', () => {
		it('accepts a scanner subscription with default scans', () => {
			const out = service.validateParams('scanner', { exchange: 'BINANCE', timeframe: '4h' });
			expect(out.exchange).toBe('BINANCE');
			expect(out.timeframe).toBe('4h');
			expect(Array.isArray(out.scans)).toBe(true);
		});

		it('rejects unknown type', () => {
			expect(() => service.validateParams('foo', {})).toThrow(ChatSubscriptionValidationError);
		});

		it('rejects unknown timeframe', () => {
			expect(() => service.validateParams('scanner', { timeframe: '7y' })).toThrow(/Unsupported timeframe/);
		});

		it('rejects empty scans list', () => {
			expect(() => service.validateParams('scanner', { scans: [] })).toThrow(/scans must contain/);
		});

		it('normalizes analysis symbols to upper case and dedupes', () => {
			const out = service.validateParams('analysis', { symbols: ['btcusdt', 'BTCUSDT', 'ethusdt'] });
			expect(out.symbols).toEqual(['BTCUSDT', 'ETHUSDT']);
		});

		it('rejects malformed symbols', () => {
			expect(() => service.validateParams('analysis', { symbols: ['!!!'] })).toThrow(/Invalid symbol/);
		});
	});

	describe('validateInterval', () => {
		it('parses 4h to 4 hours', () => {
			const r = service.validateInterval('4h');
			expect(r.intervalMs).toBe(4 * 3600 * 1000);
			expect(r.clamped).toBe(false);
		});

		it('clamps below the minimum', () => {
			const r = service.validateInterval('5m');
			expect(r.intervalMs).toBe(60 * 60 * 1000);
			expect(r.clamped).toBe(true);
		});

		it('rejects missing interval', () => {
			expect(() => service.validateInterval(undefined)).toThrow(/interval is required/);
		});

		it('rejects malformed interval', () => {
			expect(() => service.validateInterval('four hours')).toThrow(/interval must match/);
		});
	});

	describe('createSubscription', () => {
		it('creates a new subscription and persists in memory', async () => {
			const { subscription, created, clamped } = await service.createSubscription({
				chatId: 'chat-1',
				type: 'scanner',
				params: { scans: 'top_gainers,top_losers' },
				intervalMs: '4h',
			});
			expect(created).toBe(true);
			expect(clamped).toBe(false);
			expect(subscription.chatId).toBe('chat-1');
			expect(subscription.type).toBe('scanner');
			expect(subscription.intervalMs).toBe(4 * 3600 * 1000);
			expect(subscription.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
		});

		it('returns the existing subscription when the same request is replayed', async () => {
			const first = await service.createSubscription({
				chatId: 'chat-1',
				type: 'scanner',
				params: { scans: 'top_gainers' },
				intervalMs: '4h',
			});
			const second = await service.createSubscription({
				chatId: 'chat-1',
				type: 'scanner',
				params: { scans: 'top_gainers' },
				intervalMs: '4h',
			});
			expect(second.created).toBe(false);
			expect(second.subscription.subscriptionId).toBe(first.subscription.subscriptionId);
		});

		it('rejects when the chat has too many subscriptions', async () => {
			for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_CHAT; i += 1) {
				await service.createSubscription({
					chatId: 'chat-busy',
					type: 'analysis',
					params: { symbols: `BINANCE:SYM${i}` },
					intervalMs: '4h',
				});
			}
			await expect(
				service.createSubscription({
					chatId: 'chat-busy',
					type: 'analysis',
					params: { symbols: 'BINANCE:NEW' },
					intervalMs: '4h',
				}),
			).rejects.toThrow(/already has/);
		});
	});

	describe('listSubscriptions', () => {
		it('orders subscriptions by nextRunAt ascending', async () => {
			await service.createSubscription({
				chatId: 'chat-1',
				type: 'scanner',
				params: { scans: 'top_gainers' },
				intervalMs: '6h',
			});
			await service.createSubscription({
				chatId: 'chat-1',
				type: 'analysis',
				params: { symbols: 'BINANCE:BTCUSDT' },
				intervalMs: '12h',
			});
			const list = await service.listSubscriptions({ chatId: 'chat-1' });
			expect(list).toHaveLength(2);
			expect(new Date(list[0].nextRunAt).getTime()).toBeLessThanOrEqual(new Date(list[1].nextRunAt).getTime());
		});

		it('honors the limit argument', async () => {
			for (let i = 0; i < 3; i += 1) {
				await service.createSubscription({
					chatId: 'chat-1',
					type: 'analysis',
					params: { symbols: `BINANCE:SYM${i}` },
					intervalMs: '4h',
				});
			}
			const list = await service.listSubscriptions({ chatId: 'chat-1', limit: 2 });
			expect(list).toHaveLength(2);
		});
	});

	describe('deleteSubscription', () => {
		it('removes a single subscription by id', async () => {
			const { subscription } = await service.createSubscription({
				chatId: 'chat-1',
				type: 'scanner',
				params: { scans: 'top_gainers' },
				intervalMs: '4h',
			});
			const result = await service.deleteSubscription({ chatId: 'chat-1', subscriptionId: subscription.subscriptionId });
			expect(result.deleted).toBe(1);
			const list = await service.listSubscriptions({ chatId: 'chat-1' });
			expect(list).toHaveLength(0);
		});

		it('removes all subscriptions when all=true', async () => {
			for (let i = 0; i < 3; i += 1) {
				await service.createSubscription({
					chatId: 'chat-2',
					type: 'analysis',
					params: { symbols: `BINANCE:SYM${i}` },
					intervalMs: '4h',
				});
			}
			const result = await service.deleteSubscription({ chatId: 'chat-2', all: true });
			expect(result.deleted).toBe(3);
		});
	});

	describe('markRunResult', () => {
		it('updates lastJobId, summary (truncated), and nextRunAt', async () => {
			const { subscription } = await service.createSubscription({
				chatId: 'chat-1',
				type: 'scanner',
				params: { scans: 'top_gainers' },
				intervalMs: '4h',
			});
			await service.markRunResult({
				chatId: 'chat-1',
				subscriptionId: subscription.subscriptionId,
				jobId: 'job-42',
				summary: 'x'.repeat(500),
			});
			const list = await service.listSubscriptions({ chatId: 'chat-1' });
			expect(list[0].lastJobId).toBe('job-42');
			expect(list[0].lastResultSummary).toHaveLength(100);
		});
	});
});
