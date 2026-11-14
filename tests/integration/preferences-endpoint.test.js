'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { chatPreferenceService } = require('../../src/services/preferences/ChatPreferenceService');

describe('Chat Preferences Endpoints Integration Tests', () => {
	const API_KEY = 'test-api-key';
	let savedEnv;
	let store = {};

	beforeAll(() => {
		app.use('/api', getRoutes(() => ({})));
	});

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.WEBHOOK_API_KEY = API_KEY;
		process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES = 'true';

		store = {};

		const mockDb = {
			collection: jest.fn(() => ({
				doc: jest.fn((docId) => ({
					get: jest.fn().mockImplementation(async () => {
						const data = store[docId];
						return {
							exists: Boolean(data),
							data: () => data || null,
						};
					}),
					set: jest.fn().mockImplementation(async (payload) => {
						store[docId] = { ...store[docId], ...payload };
						return {};
					}),
					delete: jest.fn().mockImplementation(async () => {
						delete store[docId];
						return {};
					}),
				})),
			})),
		};

		chatPreferenceService.setDb(mockDb);
		chatPreferenceService.clearCache();
	});

	afterEach(() => {
		process.env = savedEnv;
		chatPreferenceService.clearCache();
	});

	describe('Authentication', () => {
		it('rejects GET /api/preferences/telegram/123 without auth', async () => {
			const res = await request(app).get('/api/preferences/telegram/123');
			expect(res.status).toBe(401);
		});

		it('rejects PUT /api/preferences/telegram/123 without auth', async () => {
			const res = await request(app)
				.put('/api/preferences/telegram/123')
				.send({ minConfidence: 0.8 });
			expect(res.status).toBe(401);
		});

		it('rejects DELETE /api/preferences/telegram/123 without auth', async () => {
			const res = await request(app).delete('/api/preferences/telegram/123');
			expect(res.status).toBe(401);
		});
	});

	describe('GET /api/preferences/:channel/:chatId', () => {
		it('returns default preferences for unconfigured chat', async () => {
			const res = await request(app)
				.get('/api/preferences/telegram/999888')
				.set('x-api-key', API_KEY);

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.data).toMatchObject({
				chatId: '999888',
				channel: 'telegram',
				symbolFilter: [],
				symbolExclude: [],
				categories: [],
				minConfidence: 0,
				quietHoursStart: null,
				quietHoursEnd: null,
				timezone: 'America/Santiago',
			});
		});

		it('returns 400 for invalid channel', async () => {
			const res = await request(app)
				.get('/api/preferences/slack/999888')
				.set('x-api-key', API_KEY);

			expect(res.status).toBe(400);
			expect(res.body.success).toBe(false);
			expect(res.body.error).toContain('Canal inválido');
		});
	});

	describe('PUT /api/preferences/:channel/:chatId', () => {
		it('updates preferences successfully', async () => {
			const res = await request(app)
				.put('/api/preferences/telegram/123456')
				.set('x-api-key', API_KEY)
				.send({
					symbolFilter: ['BTCUSDT', 'ETHUSDT'],
					symbolExclude: ['DOGEUSDT'],
					categories: ['scanner', 'news'],
					minConfidence: 0.75,
					quietHoursStart: 22,
					quietHoursEnd: 8,
					timezone: 'America/New_York',
				});

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.data).toMatchObject({
				chatId: '123456',
				channel: 'telegram',
				symbolFilter: ['BTCUSDT', 'ETHUSDT'],
				symbolExclude: ['DOGEUSDT'],
				categories: ['scanner', 'news'],
				minConfidence: 0.75,
				quietHoursStart: 22,
				quietHoursEnd: 8,
				timezone: 'America/New_York',
			});

			// Verify subsequent GET retrieves updated values
			const getRes = await request(app)
				.get('/api/preferences/telegram/123456')
				.set('x-api-key', API_KEY);

			expect(getRes.status).toBe(200);
			expect(getRes.body.data.minConfidence).toBe(0.75);
			expect(getRes.body.data.symbolFilter).toEqual(['BTCUSDT', 'ETHUSDT']);
		});

		it('rejects non-object request body with 400', async () => {
			const res = await request(app)
				.put('/api/preferences/telegram/123456')
				.set('x-api-key', API_KEY)
				.send([1, 2, 3]);

			expect(res.status).toBe(400);
			expect(res.body.success).toBe(false);
		});
	});

	describe('DELETE /api/preferences/:channel/:chatId', () => {
		it('deletes stored preferences and reverts to defaults', async () => {
			// Pre-populate
			await request(app)
				.put('/api/preferences/telegram/123456')
				.set('x-api-key', API_KEY)
				.send({ symbolFilter: ['SOLUSDT'] });

			const deleteRes = await request(app)
				.delete('/api/preferences/telegram/123456')
				.set('x-api-key', API_KEY);

			expect(deleteRes.status).toBe(200);
			expect(deleteRes.body.success).toBe(true);

			// Check defaults
			const getRes = await request(app)
				.get('/api/preferences/telegram/123456')
				.set('x-api-key', API_KEY);

			expect(getRes.status).toBe(200);
			expect(getRes.body.data.symbolFilter).toEqual([]);
		});
	});
});
