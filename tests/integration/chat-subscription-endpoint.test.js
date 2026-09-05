'use strict';

const request = require('supertest');
const express = require('express');

const {
	chatSubscriptionService,
} = require('../../src/services/chatSubscriptions/ChatSubscriptionService');
const authModule = require('../../src/lib/auth');
const adminAuthModule = require('../../src/lib/adminAuth');

describe('chat subscription endpoints', () => {
	let app;
	let originalValidateApiKey;
	let originalAdminAuth;
	let savedEnv;

	beforeAll(() => {
		savedEnv = { ...process.env };
		process.env.WEBHOOK_API_KEY = 'test-api-key';
		process.env.ENABLE_FIREBASE_ADMIN_AUTH = 'false';
		process.env.CHAT_SUBSCRIPTION_MIN_INTERVAL_MS = '3600000';

		originalValidateApiKey = authModule.validateApiKey;
		originalAdminAuth = adminAuthModule.validateAdminAccess;
		authModule.validateApiKey = (req, res, next) => {
			if (req.headers['x-api-key'] === 'test-api-key') return next();
			return res.status(401).json({ error: 'unauthorized' });
		};
		adminAuthModule.validateAdminAccess = (req, res, next) => {
			if (req.headers['x-api-key'] === 'test-api-key') {
				req.adminRole = 'admin.operator';
				return next();
			}
			return res.status(401).json({ error: 'unauthorized' });
		};

		app = express();
		app.use(express.json());
		const routes = require('../../src/routes').getRoutes(null);
		app.use('/api', routes);
	});

	afterAll(() => {
		authModule.validateApiKey = originalValidateApiKey;
		adminAuthModule.validateAdminAccess = originalAdminAuth;
		process.env = savedEnv;
	});

	beforeEach(() => {
		chatSubscriptionService.resetForTests();
	});

	it('rejects missing API key', async () => {
		const res = await request(app).get('/api/chat-subscriptions?chatId=chat-1');
		expect(res.status).toBe(401);
	});

	it('creates, lists, and deletes a chat subscription', async () => {
		const create = await request(app)
			.post('/api/chat-subscriptions')
			.set('x-api-key', 'test-api-key')
			.send({
				chatId: 'chat-int-1',
				type: 'scanner',
				params: { scans: 'top_gainers,top_losers', exchange: 'BINANCE', timeframe: '4h' },
				interval: '4h',
			});
		expect(create.status).toBe(201);
		expect(create.body.subscription.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
		expect(create.body.subscription.type).toBe('scanner');

		const list = await request(app)
			.get('/api/chat-subscriptions?chatId=chat-int-1')
			.set('x-api-key', 'test-api-key');
		expect(list.status).toBe(200);
		expect(list.body.count).toBe(1);
		expect(list.body.subscriptions[0].subscriptionId).toBe(create.body.subscription.subscriptionId);

		const replay = await request(app)
			.post('/api/chat-subscriptions')
			.set('x-api-key', 'test-api-key')
			.send({
				chatId: 'chat-int-1',
				type: 'scanner',
				params: { scans: 'top_gainers,top_losers', exchange: 'BINANCE', timeframe: '4h' },
				interval: '4h',
			});
		expect(replay.status).toBe(200);
		expect(replay.body.replayed).toBe(true);
		expect(replay.body.subscription.subscriptionId).toBe(create.body.subscription.subscriptionId);

		const del = await request(app)
			.delete(`/api/chat-subscriptions/${create.body.subscription.subscriptionId}`)
			.set('x-api-key', 'test-api-key')
			.send({ chatId: 'chat-int-1' });
		expect(del.status).toBe(200);
		expect(del.body.deleted).toBe(1);

		const finalList = await request(app)
			.get('/api/chat-subscriptions?chatId=chat-int-1')
			.set('x-api-key', 'test-api-key');
		expect(finalList.body.count).toBe(0);
	});

	it('clamps intervals below the floor and surfaces the flag', async () => {
		const res = await request(app)
			.post('/api/chat-subscriptions')
			.set('x-api-key', 'test-api-key')
			.send({
				chatId: 'chat-clamp',
				type: 'analysis',
				params: { symbols: 'BINANCE:BTCUSDT' },
				interval: '5m',
			});
		expect(res.status).toBe(201);
		expect(res.body.clamped).toBe(true);
		expect(res.body.subscription.intervalMs).toBe(60 * 60 * 1000);
	});

	it('returns 400 on invalid type', async () => {
		const res = await request(app)
			.post('/api/chat-subscriptions')
			.set('x-api-key', 'test-api-key')
			.send({
				chatId: 'chat-bad',
				type: 'invalid',
				params: {},
				interval: '4h',
			});
		expect(res.status).toBe(400);
	});

	it('rejects chatId mismatch on delete', async () => {
		const create = await request(app)
			.post('/api/chat-subscriptions')
			.set('x-api-key', 'test-api-key')
			.send({
				chatId: 'chat-A',
				type: 'scanner',
				params: { scans: 'top_gainers' },
				interval: '4h',
			});
		expect(create.status).toBe(201);
		const del = await request(app)
			.delete(`/api/chat-subscriptions/${create.body.subscription.subscriptionId}`)
			.set('x-api-key', 'test-api-key')
			.send({ chatId: 'chat-B' });
		expect(del.body.deleted).toBe(0);
	});
});
