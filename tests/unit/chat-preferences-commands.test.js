'use strict';

const { chatPreferenceService } = require('../../src/services/preferences/ChatPreferenceService');
const {
	preferenciasCmd,
	filtroCmd,
	silencioCmd,
	umbralCmd,
	categoriasCmd,
} = require('../../src/controllers/commands');

describe('Telegram Chat Preferences Commands', () => {
	let context;
	let mockDb;
	let preferencesStore;

	beforeEach(() => {
		preferencesStore = {};
		mockDb = {
			collection: jest.fn(() => ({
				doc: jest.fn((docId) => ({
					get: jest.fn().mockImplementation(async () => {
						const data = preferencesStore[docId];
						return {
							exists: Boolean(data),
							data: () => data || null,
						};
					}),
					set: jest.fn().mockImplementation(async (payload) => {
						preferencesStore[docId] = { ...preferencesStore[docId], ...payload };
						return {};
					}),
					delete: jest.fn().mockImplementation(async () => {
						delete preferencesStore[docId];
						return {};
					}),
				})),
			})),
		};

		chatPreferenceService._setFirestoreForTesting(mockDb);
		chatPreferenceService._clearCacheForTesting();

		context = {
			update: {
				message: {
					chat: { id: 123456 },
				},
			},
			message: {
				text: '/preferencias',
			},
			reply: jest.fn().mockResolvedValue({}),
		};
	});

	afterEach(() => {
		jest.clearAllMocks();
	});

	it('replies with current preferences on /preferencias', async () => {
		await preferenciasCmd(context);
		expect(context.reply).toHaveBeenCalledTimes(1);
		const replyText = context.reply.mock.calls[0][0];
		expect(replyText).toContain('Preferencias');
		expect(context.reply.mock.calls[0][1]).toEqual({ parse_mode: 'MarkdownV2' });
	});

	it('updates symbolFilter on /filtro BTC,ETH', async () => {
		context.message.text = '/filtro BTCUSDT, ETHUSDT';
		await filtroCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const replyText = context.reply.mock.calls[0][0];
		expect(replyText).toContain('BTCUSDT');
		expect(replyText).toContain('ETHUSDT');

		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.symbolFilter).toEqual(['BTCUSDT', 'ETHUSDT']);
	});

	it('clears symbolFilter on /filtro clear', async () => {
		await chatPreferenceService.setPreferences('123456', 'telegram', { symbolFilter: ['BTCUSDT'] });

		context.message.text = '/filtro clear';
		await filtroCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.symbolFilter).toEqual([]);
	});

	it('updates symbolExclude on /filtro excluir DOGEUSDT', async () => {
		context.message.text = '/filtro excluir DOGEUSDT';
		await filtroCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.symbolExclude).toEqual(['DOGEUSDT']);
	});

	it('sets quiet hours on /silencio 23,7', async () => {
		context.message.text = '/silencio 23,7';
		await silencioCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.quietHoursStart).toBe(23);
		expect(prefs.quietHoursEnd).toBe(7);
	});

	it('clears quiet hours on /silencio off', async () => {
		await chatPreferenceService.setPreferences('123456', 'telegram', { quietHoursStart: 23, quietHoursEnd: 7 });

		context.message.text = '/silencio off';
		await silencioCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.quietHoursStart).toBeNull();
		expect(prefs.quietHoursEnd).toBeNull();
	});

	it('sets min confidence on /umbral 0.8', async () => {
		context.message.text = '/umbral 0.8';
		await umbralCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.minConfidence).toBe(0.8);
	});

	it('clears min confidence on /umbral off', async () => {
		await chatPreferenceService.setPreferences('123456', 'telegram', { minConfidence: 0.8 });

		context.message.text = '/umbral off';
		await umbralCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.minConfidence).toBe(0);
	});

	it('sets categories on /categorias scanner,news', async () => {
		context.message.text = '/categorias scanner,news';
		await categoriasCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.categories).toEqual(['scanner', 'news']);
	});

	it('clears categories on /categorias all', async () => {
		await chatPreferenceService.setPreferences('123456', 'telegram', { categories: ['scanner'] });

		context.message.text = '/categorias all';
		await categoriasCmd(context);

		expect(context.reply).toHaveBeenCalledTimes(1);
		const prefs = await chatPreferenceService.getPreferences('123456', 'telegram');
		expect(prefs.categories).toEqual([]);
	});
});
