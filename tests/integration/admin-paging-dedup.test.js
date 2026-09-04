const request = require('supertest');
const express = require('express');
const { adminPagingDeduplicator } = require('../../src/services/notification/adminPagingDeduplicator');
const NotificationManager = require('../../src/services/notification/NotificationManager');
const TelegramService = require('../../src/services/notification/TelegramService');
const { getRoutes } = require('../../src/routes');

describe('Admin Paging Deduplication Integration', () => {
	const originalAdminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	const originalDedupTtl = process.env.ADMIN_PAGE_DEDUP_TTL_MS;
	let app;

	beforeEach(() => {
		adminPagingDeduplicator.reset();
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100-admin';
		process.env.ADMIN_PAGE_DEDUP_TTL_MS = '300000'; // 5 minutes

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes());
	});

	afterEach(() => {
		adminPagingDeduplicator.reset();
		if (originalAdminChatId === undefined) {
			delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		} else {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = originalAdminChatId;
		}
		if (originalDedupTtl === undefined) {
			delete process.env.ADMIN_PAGE_DEDUP_TTL_MS;
		} else {
			process.env.ADMIN_PAGE_DEDUP_TTL_MS = originalDedupTtl;
		}
	});

	it('suppresses a burst of 10 identical Telegram 429 failures in 60s yielding 1 admin page and 9 dedupHits', async () => {
		const sentAdminPages = [];
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockImplementation((payload) => {
				if (payload.telegramChatId === '-100-admin') {
					sentAdminPages.push(payload);
					return Promise.resolve({ success: true, channel: 'telegram', messageId: `admin-${sentAdminPages.length}` });
				}
				return Promise.resolve({
					success: false,
					channel: 'telegram',
					statusCode: 429,
					category: 'RATE_LIMITED',
					error: 'Too Many Requests',
				});
			}),
		};

		const notificationManager = new NotificationManager(telegramService);

		// Execute 10 failed sends in a burst
		for (let i = 0; i < 10; i++) {
			await notificationManager.sendToAll({
				text: 'BTC Breakout Alert',
				requestId: 'req-burst-429',
			});
		}

		// Exactly 1 admin page sent
		expect(sentAdminPages).toHaveLength(1);
		expect(sentAdminPages[0].text).toContain('Notification delivery failure');
		expect(sentAdminPages[0].text).toContain('Failed channels: telegram');
		expect(sentAdminPages[0].text).toContain('Request ID: req-burst-429');

		// Status reports 9 dedupHits
		const status = adminPagingDeduplicator.getStatus();
		expect(status.enabled).toBe(true);
		expect(status.dedupHits).toBe(9);
		expect(status.dedupWindowMs).toBe(300000);
		expect(status.lastDedupAt).toBeDefined();
		expect(typeof status.lastDedupAt).toBe('string');

		// Verify /api/status exposes the same metric
		const res = await request(app).get('/api/status');
		expect(res.status).toBe(200);
		expect(res.body.dependencies.telegramAdminPaging).toEqual({
			enabled: true,
			dedupHits: 9,
			dedupWindowMs: 300000,
			lastDedupAt: status.lastDedupAt,
		});
	});

	it('does not suppress a second distinct failure with different requestId or channel within the TTL', async () => {
		const sentAdminPages = [];
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockImplementation((payload) => {
				if (payload.telegramChatId === '-100-admin') {
					sentAdminPages.push(payload);
					return Promise.resolve({ success: true, channel: 'telegram', messageId: `admin-${sentAdminPages.length}` });
				}
				return Promise.resolve({
					success: false,
					channel: 'telegram',
					statusCode: 429,
					category: 'RATE_LIMITED',
					error: 'Too Many Requests',
				});
			}),
		};

		const whatsappService = {
			name: 'whatsapp',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockResolvedValue({
				success: false,
				channel: 'whatsapp',
				statusCode: 503,
				category: 'PROVIDER_ERROR',
				error: 'Service Unavailable',
			}),
		};

		const notificationManager = new NotificationManager(telegramService, whatsappService);

		// First failure: Telegram 429 with req-1
		await notificationManager.sendToChannels({
			text: 'Alert 1',
			requestId: 'req-1',
		}, ['telegram']);
		expect(sentAdminPages).toHaveLength(1);

		// Second failure: Same channel & error, but DIFFERENT requestId req-2 -> NOT suppressed
		await notificationManager.sendToChannels({
			text: 'Alert 2',
			requestId: 'req-2',
		}, ['telegram']);
		expect(sentAdminPages).toHaveLength(2);

		// Third failure: WhatsApp failure (different channel) -> NOT suppressed
		await notificationManager.sendToChannels({
			text: 'Alert 3',
			requestId: 'req-1',
		}, ['whatsapp']);
		expect(sentAdminPages).toHaveLength(3);

		expect(adminPagingDeduplicator.getStatus().dedupHits).toBe(0);

		// Fourth attempt: Repeat of First failure (same channel, req-1, 429) -> SUPPRESSED
		await notificationManager.sendToChannels({
			text: 'Alert 1 repeat',
			requestId: 'req-1',
		}, ['telegram']);
		expect(sentAdminPages).toHaveLength(3);
		expect(adminPagingDeduplicator.getStatus().dedupHits).toBe(1);
	});

	it('allows a subsequent page after TTL expiration', async () => {
		const sentAdminPages = [];
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockImplementation((payload) => {
				if (payload.telegramChatId === '-100-admin') {
					sentAdminPages.push(payload);
					return Promise.resolve({ success: true, channel: 'telegram', messageId: `admin-${sentAdminPages.length}` });
				}
				return Promise.resolve({
					success: false,
					channel: 'telegram',
					statusCode: 429,
					category: 'RATE_LIMITED',
					error: 'Too Many Requests',
				});
			}),
		};

		const notificationManager = new NotificationManager(telegramService);

		let currentTime = 1000000;
		const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => currentTime);

		try {
			// First failure at t=1,000,000
			await notificationManager.sendToAll({ text: 'Alert', requestId: 'req-ttl' });
			expect(sentAdminPages).toHaveLength(1);

			// Duplicate at t=1,000,010 (10s later) -> suppressed
			currentTime += 10000;
			await notificationManager.sendToAll({ text: 'Alert', requestId: 'req-ttl' });
			expect(sentAdminPages).toHaveLength(1);
			expect(adminPagingDeduplicator.getStatus().dedupHits).toBe(1);

			// Duplicate at t=1,300,001 (300.001s later, TTL=300s expired) -> sent!
			currentTime += 300001;
			await notificationManager.sendToAll({ text: 'Alert', requestId: 'req-ttl' });
			expect(sentAdminPages).toHaveLength(2);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it('does not suppress any failures when ADMIN_PAGE_DEDUP_TTL_MS=0 (disabled mode)', async () => {
		process.env.ADMIN_PAGE_DEDUP_TTL_MS = '0';
		const sentAdminPages = [];
		const telegramService = {
			name: 'telegram',
			isEnabled: jest.fn(() => true),
			send: jest.fn().mockImplementation((payload) => {
				if (payload.telegramChatId === '-100-admin') {
					sentAdminPages.push(payload);
					return Promise.resolve({ success: true, channel: 'telegram', messageId: `admin-${sentAdminPages.length}` });
				}
				return Promise.resolve({
					success: false,
					channel: 'telegram',
					statusCode: 429,
					category: 'RATE_LIMITED',
					error: 'Too Many Requests',
				});
			}),
		};

		const notificationManager = new NotificationManager(telegramService);

		for (let i = 0; i < 5; i++) {
			await notificationManager.sendToAll({
				text: 'Alert',
				requestId: 'req-disabled',
			});
		}

		// When disabled, all 5 attempts trigger admin notifications
		expect(sentAdminPages).toHaveLength(5);
		expect(adminPagingDeduplicator.getStatus().enabled).toBe(false);
		expect(adminPagingDeduplicator.getStatus().dedupHits).toBe(0);
	});

	it('TelegramService directly suppresses duplicate admin pages if not checked by caller', async () => {
		const callApiMock = jest.fn().mockResolvedValue({ ok: true, result: { message_id: 123 } });
		const mockBot = {
			telegram: {
				callApi: callApiMock,
				sendMessage: jest.fn(),
			},
		};

		const telegramService = new TelegramService({
			bot: mockBot,
			chatId: '-100-public',
		});
		telegramService.enabled = true;

		// Send 1st admin page directly
		const res1 = await telegramService.send({
			text: 'Admin failure page',
			telegramChatId: '-100-admin',
			category: 'RATE_LIMITED',
			channel: 'telegram',
			requestId: 'req-direct',
			errorCode: 429,
		});
		expect(res1.success).toBe(true);
		expect(callApiMock).toHaveBeenCalledTimes(1);

		// Send 2nd duplicate admin page directly
		const res2 = await telegramService.send({
			text: 'Admin failure page',
			telegramChatId: '-100-admin',
			category: 'RATE_LIMITED',
			channel: 'telegram',
			requestId: 'req-direct',
			errorCode: 429,
		});
		expect(res2.success).toBe(true);
		expect(res2.suppressed).toBe(true);
		expect(res2.dedup).toBe(true);
		// callApi was NOT called a second time
		expect(callApiMock).toHaveBeenCalledTimes(1);
		expect(adminPagingDeduplicator.getStatus().dedupHits).toBe(1);
	});
});
