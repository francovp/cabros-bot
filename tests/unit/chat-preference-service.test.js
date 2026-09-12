'use strict';

const admin = require('firebase-admin');

describe('ChatPreferenceService', () => {
	let ChatPreferenceService;
	let chatPreferenceService;
	let mockFirestore;
	let mockCollection;
	let mockDoc;
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES = 'true';
		delete process.env.CHAT_PREFERENCES_RETENTION_DAYS;
		delete process.env.CHAT_PREFERENCES_CACHE_TTL_MS;

		mockDoc = {
			get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
			set: jest.fn().mockResolvedValue({}),
			delete: jest.fn().mockResolvedValue({}),
		};
		mockCollection = {
			doc: jest.fn(() => mockDoc),
		};
		mockFirestore = {
			collection: jest.fn(() => mockCollection),
		};

		jest.isolateModules(() => {
			const mod = require('../../src/services/preferences/ChatPreferenceService');
			ChatPreferenceService = mod.ChatPreferenceService;
			chatPreferenceService = mod.chatPreferenceService;
		});

		chatPreferenceService._setFirestoreForTesting(mockFirestore);
		chatPreferenceService._clearCacheForTesting();
	});

	afterEach(() => {
		process.env = { ...savedEnv };
		jest.clearAllMocks();
	});

	describe('defaults and status', () => {
		it('returns default preferences for a chatId and channel', () => {
			const defaults = chatPreferenceService.getDefaultPreferences('123456', 'telegram');
			expect(defaults).toEqual({
				chatId: '123456',
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

		it('reports correct status when enabled with firestore client', () => {
			const status = chatPreferenceService.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.status).toBeDefined();
		});

		it('reports disabled when feature flag is off', () => {
			process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES = 'false';
			expect(chatPreferenceService.isEnabled()).toBe(false);
			const status = chatPreferenceService.getStatus();
			expect(status.enabled).toBe(false);
			expect(status.ready).toBe(false);
		});
	});

	describe('validation and sanitization', () => {
		it('normalizes symbols to uppercase and trims whitespace', () => {
			const sanitized = chatPreferenceService.sanitizePreferences({
				symbolFilter: [' btcusdt ', 'eth/usdt', 'sol-usdt'],
				symbolExclude: ['dogeusdt '],
			});
			expect(sanitized.symbolFilter).toEqual(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
			expect(sanitized.symbolExclude).toEqual(['DOGEUSDT']);
		});

		it('validates minConfidence within [0, 1] range and converts percentage', () => {
			expect(chatPreferenceService.sanitizePreferences({ minConfidence: 80 }).minConfidence).toBe(0.8);
			expect(chatPreferenceService.sanitizePreferences({ minConfidence: 0.75 }).minConfidence).toBe(0.75);
			expect(chatPreferenceService.sanitizePreferences({ minConfidence: -0.5 }).minConfidence).toBe(0);
			expect(chatPreferenceService.sanitizePreferences({ minConfidence: 1.5 }).minConfidence).toBe(1);
			expect(chatPreferenceService.sanitizePreferences({ minConfidence: 'invalid' }).minConfidence).toBe(0);
		});

		it('validates quiet hours as integers between 0 and 23', () => {
			const valid = chatPreferenceService.sanitizePreferences({ quietHoursStart: 23, quietHoursEnd: 7 });
			expect(valid.quietHoursStart).toBe(23);
			expect(valid.quietHoursEnd).toBe(7);

			const invalid = chatPreferenceService.sanitizePreferences({ quietHoursStart: 25, quietHoursEnd: -1 });
			expect(invalid.quietHoursStart).toBeNull();
			expect(invalid.quietHoursEnd).toBeNull();
		});

		it('validates timezone or falls back to America/Santiago', () => {
			const valid = chatPreferenceService.sanitizePreferences({ timezone: 'UTC' });
			expect(valid.timezone).toBe('UTC');

			const invalid = chatPreferenceService.sanitizePreferences({ timezone: 'Invalid/Zone' });
			expect(invalid.timezone).toBe('America/Santiago');
		});

		it('normalizes categories to lowercase and filters allowed ones', () => {
			const sanitized = chatPreferenceService.sanitizePreferences({
				categories: ['SCANNER', 'News', 'invalid_cat', 'Core'],
			});
			expect(sanitized.categories).toEqual(['scanner', 'news', 'core']);
		});
	});

	describe('persistence and caching', () => {
		it('reads from Firestore and caches the result', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					chatId: '123456',
					channel: 'telegram',
					symbolFilter: ['BTCUSDT'],
					symbolExclude: [],
					categories: ['scanner'],
					minConfidence: 0.8,
					quietHoursStart: 22,
					quietHoursEnd: 6,
					timezone: 'America/Santiago',
				}),
			});

			const pref1 = await chatPreferenceService.getPreferences('123456', 'telegram');
			expect(mockDoc.get).toHaveBeenCalledTimes(1);
			expect(pref1.symbolFilter).toEqual(['BTCUSDT']);
			expect(pref1.minConfidence).toBe(0.8);

			// Second call should hit in-memory cache
			const pref2 = await chatPreferenceService.getPreferences('123456', 'telegram');
			expect(mockDoc.get).toHaveBeenCalledTimes(1);
			expect(pref2.symbolFilter).toEqual(['BTCUSDT']);
		});

		it('returns default preferences if doc does not exist', async () => {
			mockDoc.get.mockResolvedValueOnce({ exists: false, data: () => null });

			const pref = await chatPreferenceService.getPreferences('999', 'telegram');
			expect(pref.symbolFilter).toEqual([]);
			expect(pref.chatId).toBe('999');
		});

		it('updates preferences in Firestore and refreshes cache', async () => {
			mockDoc.get.mockResolvedValueOnce({ exists: false, data: () => null });

			const updated = await chatPreferenceService.setPreferences('123456', 'telegram', {
				symbolFilter: ['ETHUSDT'],
				minConfidence: 0.9,
			});

			expect(mockCollection.doc).toHaveBeenCalledWith('telegram_123456');
			expect(mockDoc.set).toHaveBeenCalledTimes(1);
			expect(updated.symbolFilter).toEqual(['ETHUSDT']);
			expect(updated.minConfidence).toBe(0.9);

			mockDoc.get.mockClear();
			// Cache should now have updated data without calling Firestore get
			const cached = await chatPreferenceService.getPreferences('123456', 'telegram');
			expect(mockDoc.get).not.toHaveBeenCalled();
			expect(cached.symbolFilter).toEqual(['ETHUSDT']);
		});

		it('deletes preferences from Firestore and evicts cache', async () => {
			mockDoc.get.mockResolvedValueOnce({ exists: false, data: () => null });
			await chatPreferenceService.setPreferences('123456', 'telegram', { symbolFilter: ['BTCUSDT'] });

			mockDoc.get.mockClear();
			await chatPreferenceService.deletePreferences('123456', 'telegram');
			expect(mockDoc.delete).toHaveBeenCalledTimes(1);

			// Cache is cleared, next get calls Firestore
			await chatPreferenceService.getPreferences('123456', 'telegram');
			expect(mockDoc.get).toHaveBeenCalledTimes(1);
		});

		it('fails open on Firestore errors and returns defaults without throwing', async () => {
			mockDoc.get.mockRejectedValueOnce(new Error('Firestore unavailable'));

			const pref = await chatPreferenceService.getPreferences('123456', 'telegram');
			expect(pref.symbolFilter).toEqual([]);
		});
	});

	describe('shouldDeliverAlert evaluation', () => {
		it('delivers unconditionally when feature is disabled', async () => {
			process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES = 'false';
			const result = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: { symbol: 'BTCUSDT' },
			});
			expect(result).toEqual({ deliver: true });
		});

		it('delivers unconditionally when bypassPreferences or isProbe is set', async () => {
			const result = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: { symbol: 'BTCUSDT' },
				options: { bypassPreferences: true },
			});
			expect(result).toEqual({ deliver: true });
		});

		it('filters out alerts during quiet hours (overnight)', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					quietHoursStart: 23,
					quietHoursEnd: 7,
					timezone: 'UTC',
				}),
			});

			// At 02:00 UTC (inside 23:00-07:00 window)
			const quietTime = new Date('2026-09-12T02:00:00Z');
			const resultQuiet = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: { symbol: 'BTCUSDT' },
				now: quietTime,
			});
			expect(resultQuiet).toEqual({ deliver: false, reason: 'quiet_hours' });

			// At 14:00 UTC (outside quiet window)
			const activeTime = new Date('2026-09-12T14:00:00Z');
			const resultActive = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: { symbol: 'BTCUSDT' },
				now: activeTime,
			});
			expect(resultActive).toEqual({ deliver: true });
		});

		it('filters out alerts during daytime quiet hours', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					quietHoursStart: 9,
					quietHoursEnd: 17,
					timezone: 'UTC',
				}),
			});

			// At 12:00 UTC (inside 09:00-17:00 window)
			const quietTime = new Date('2026-09-12T12:00:00Z');
			const result = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: { symbol: 'BTCUSDT' },
				now: quietTime,
			});
			expect(result).toEqual({ deliver: false, reason: 'quiet_hours' });
		});

		it('filters out alerts below minConfidence', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					minConfidence: 0.8,
				}),
			});

			const lowConfidenceAlert = {
				symbol: 'BTCUSDT',
				confidence: 0.65,
			};
			const resultLow = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: lowConfidenceAlert,
			});
			expect(resultLow).toEqual({ deliver: false, reason: 'min_confidence' });

			const highConfidenceAlert = {
				symbol: 'BTCUSDT',
				confidence: 0.85,
			};
			const resultHigh = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: highConfidenceAlert,
			});
			expect(resultHigh).toEqual({ deliver: true });
		});

		it('passes alerts without confidence score (fail-open for unrated alerts)', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					minConfidence: 0.8,
				}),
			});

			const unratedAlert = { symbol: 'BTCUSDT' };
			const result = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: unratedAlert,
			});
			expect(result).toEqual({ deliver: true });
		});

		it('filters out symbols not in symbolFilter inclusion list', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					symbolFilter: ['BTCUSDT', 'ETHUSDT'],
				}),
			});

			// Matching symbol
			const matchAlert = { symbol: 'BINANCE:BTCUSDT' };
			const resultMatch = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: matchAlert,
			});
			expect(resultMatch).toEqual({ deliver: true });

			// Non-matching symbol
			const mismatchAlert = { symbol: 'SOLUSDT' };
			const resultMismatch = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: mismatchAlert,
			});
			expect(resultMismatch).toEqual({ deliver: false, reason: 'symbol_not_matched' });
		});

		it('filters out symbols in symbolExclude list', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					symbolExclude: ['DOGEUSDT', 'SHIBUSDT'],
				}),
			});

			const excludedAlert = { symbol: 'DOGEUSDT' };
			const resultExcluded = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: excludedAlert,
			});
			expect(resultExcluded).toEqual({ deliver: false, reason: 'symbol_excluded' });

			const allowedAlert = { symbol: 'BTCUSDT' };
			const resultAllowed = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: allowedAlert,
			});
			expect(resultAllowed).toEqual({ deliver: true });
		});

		it('filters out alerts with excluded category', async () => {
			mockDoc.get.mockResolvedValueOnce({
				exists: true,
				data: () => ({
					categories: ['scanner', 'news'],
				}),
			});

			// Allowed category
			const scannerAlert = { category: 'scanner', symbol: 'BTCUSDT' };
			const resultScanner = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: scannerAlert,
			});
			expect(resultScanner).toEqual({ deliver: true });

			// Excluded category
			const coreAlert = { category: 'core', symbol: 'BTCUSDT' };
			const resultCore = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: coreAlert,
			});
			expect(resultCore).toEqual({ deliver: false, reason: 'category_excluded' });
		});

		it('fails open on any internal error during delivery evaluation', async () => {
			mockDoc.get.mockRejectedValueOnce(new Error('Unexpected Firestore crash'));

			const result = await chatPreferenceService.shouldDeliverAlert({
				chatId: '123456',
				channel: 'telegram',
				alert: { symbol: 'BTCUSDT' },
			});
			expect(result).toEqual({ deliver: true });
		});
	});
});
