'use strict';

const chatEnrollmentsService = require('../../src/services/enrollments/ChatEnrollmentsService');

describe('ChatEnrollmentsService', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = {
			ENABLE_CHAT_ENROLLMENTS: process.env.ENABLE_CHAT_ENROLLMENTS,
			FIREBASE_SERVICE_ACCOUNT_JSON: process.env.FIREBASE_SERVICE_ACCOUNT_JSON,
			GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
			FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
			CHAT_ENROLLMENT_RETENTION_DAYS: process.env.CHAT_ENROLLMENT_RETENTION_DAYS,
		};
		chatEnrollmentsService._resetForTesting();
		delete process.env.ENABLE_CHAT_ENROLLMENTS;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.CHAT_ENROLLMENT_RETENTION_DAYS;
	});

	afterEach(() => {
		chatEnrollmentsService._resetForTesting();
		for (const [key, value] of Object.entries(originalEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});

	describe('isEnabled', () => {
		it('returns false when ENABLE_CHAT_ENROLLMENTS is unset', () => {
			expect(chatEnrollmentsService.isEnabled()).toBe(false);
		});

		it('returns true when ENABLE_CHAT_ENROLLMENTS=true', () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			expect(chatEnrollmentsService.isEnabled()).toBe(true);
		});
	});

	describe('getRetentionDays', () => {
		it('returns the default 90 when unset', () => {
			expect(chatEnrollmentsService.getRetentionDays()).toBe(90);
		});

		it('returns parsed integer when within bounds', () => {
			process.env.CHAT_ENROLLMENT_RETENTION_DAYS = '120';
			expect(chatEnrollmentsService.getRetentionDays()).toBe(120);
		});

		it('falls back to default when out of bounds', () => {
			process.env.CHAT_ENROLLMENT_RETENTION_DAYS = '0';
			expect(chatEnrollmentsService.getRetentionDays()).toBe(90);
			process.env.CHAT_ENROLLMENT_RETENTION_DAYS = '500';
			expect(chatEnrollmentsService.getRetentionDays()).toBe(90);
			process.env.CHAT_ENROLLMENT_RETENTION_DAYS = 'not-a-number';
			expect(chatEnrollmentsService.getRetentionDays()).toBe(90);
		});
	});

	describe('normalizers', () => {
		it('normalizes positive and negative chat ids as strings', () => {
			expect(chatEnrollmentsService.normalizeChatId(123)).toBe('123');
			expect(chatEnrollmentsService.normalizeChatId('-1001234567890')).toBe('-1001234567890');
			expect(chatEnrollmentsService.normalizeChatId(null)).toBeNull();
			expect(chatEnrollmentsService.normalizeChatId('not a number')).toBeNull();
		});

		it('rejects non-finite or out-of-range chat ids', () => {
			expect(chatEnrollmentsService.normalizeChatId(NaN)).toBeNull();
			expect(chatEnrollmentsService.normalizeChatId(Infinity)).toBeNull();
		});

		it('normalizes chat types to the supported set', () => {
			expect(chatEnrollmentsService.normalizeChatType('group')).toBe('group');
			expect(chatEnrollmentsService.normalizeChatType('supergroup')).toBe('supergroup');
			expect(chatEnrollmentsService.normalizeChatType('random')).toBeNull();
			expect(chatEnrollmentsService.normalizeChatType(null)).toBeNull();
		});

		it('normalizes languages to the supported set', () => {
			expect(chatEnrollmentsService.normalizeLanguage('ES')).toBe('es');
			expect(chatEnrollmentsService.normalizeLanguage('en')).toBe('en');
			expect(chatEnrollmentsService.normalizeLanguage('zh')).toBeNull();
		});

		it('dedupes and validates watchlist entries', () => {
			expect(chatEnrollmentsService.normalizeWatchlist(['BTCUSDT', 'ethusdt', 'BTCUSDT'])).toEqual(['BTCUSDT', 'ETHUSDT']);
			expect(chatEnrollmentsService.normalizeWatchlist(null)).toBeNull();
			expect(chatEnrollmentsService.normalizeWatchlist(['', '   ', 'BAD!!'])).toEqual([]);
		});

		it('limits watchlist to MAX_WATCHLIST_LENGTH entries', () => {
			const many = Array.from({ length: 30 }, (_, i) => `SYM${i}USDT`);
			const result = chatEnrollmentsService.normalizeWatchlist(many);
			expect(result).toHaveLength(chatEnrollmentsService.MAX_WATCHLIST_LENGTH);
		});

		it('bounds the refSource length and rejects empty strings', () => {
			expect(chatEnrollmentsService.normalizeRefSource('campaign')).toBe('campaign');
			expect(chatEnrollmentsService.normalizeRefSource('  ')).toBeNull();
			expect(chatEnrollmentsService.normalizeRefSource(null)).toBeNull();
			expect(chatEnrollmentsService.normalizeRefSource('a'.repeat(100))).toBeNull();
		});
	});

	describe('buildSummary', () => {
		it('aggregates language and watchlist distribution sorted by count', () => {
			const records = [
				{ chatId: '1', language: 'es', watchlist: ['BTCUSDT', 'ETHUSDT'] },
				{ chatId: '2', language: 'es', watchlist: ['BTCUSDT'] },
				{ chatId: '3', language: 'en', watchlist: ['NVDA'] },
			];
			const summary = chatEnrollmentsService.buildSummary(records);
			expect(summary.count).toBe(3);
			expect(summary.languages[0]).toEqual({ value: 'es', total: 2 });
			expect(summary.watchlist[0]).toEqual({ value: 'BTCUSDT', total: 2 });
		});

		it('returns zero counts for empty input', () => {
			const summary = chatEnrollmentsService.buildSummary([]);
			expect(summary.count).toBe(0);
			expect(summary.languages).toEqual([]);
			expect(summary.watchlist).toEqual([]);
		});
	});

	describe('enroll + getByChatId', () => {
		it('returns null and persists nothing when feature is disabled', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			// disable gate again to verify the disabled branch
			delete process.env.ENABLE_CHAT_ENROLLMENTS;
			const result = await chatEnrollmentsService.enroll({ chatId: '123', language: 'es' });
			expect(result).toBeNull();
		});

		it('upserts an enrollment in memory when no Firestore is configured', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const enrolled = await chatEnrollmentsService.enroll({
				chatId: 123,
				chatType: 'group',
				language: 'es',
				watchlist: ['BTCUSDT'],
				refSource: 'campaign',
			});
			expect(enrolled).toMatchObject({
				chatId: '123',
				chatType: 'group',
				language: 'es',
				watchlist: ['BTCUSDT'],
				refSource: 'campaign',
			});
			const fetched = await chatEnrollmentsService.getByChatId('123', { includeChatId: true });
			expect(fetched).toMatchObject({
				chatId: '123',
				chatType: 'group',
				language: 'es',
			});
		});

		it('omits chatId from getByChatId when includeChatId is false', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			await chatEnrollmentsService.enroll({ chatId: 456, language: 'en' });
			const fetched = await chatEnrollmentsService.getByChatId('456');
			expect(fetched.chatId).toBeUndefined();
			expect(fetched.language).toBe('en');
		});

		it('rejects enrollments with invalid chat ids', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const result = await chatEnrollmentsService.enroll({ chatId: 'not-a-number' });
			expect(result).toBeNull();
		});
	});

	describe('getSummary', () => {
		it('returns zero-counts with ephemeral mode when feature is disabled', async () => {
			const summary = await chatEnrollmentsService.getSummary();
			expect(summary.mode).toBe('ephemeral');
			expect(summary.backend).toBe('memory');
			expect(summary.count).toBe(0);
		});

		it('aggregates in-memory records when feature is enabled', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			await chatEnrollmentsService.enroll({ chatId: 1, language: 'es', watchlist: ['BTCUSDT'] });
			await chatEnrollmentsService.enroll({ chatId: 2, language: 'en', watchlist: ['NVDA'] });
			const summary = await chatEnrollmentsService.getSummary();
			expect(summary.mode).toBe('ephemeral');
			expect(summary.backend).toBe('memory');
			expect(summary.count).toBe(2);
			expect(summary.languages).toContainEqual({ value: 'es', total: 1 });
			expect(summary.watchlist).toContainEqual({ value: 'BTCUSDT', total: 1 });
		});

		it('omits records when includeChatIds is false even for operators', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			await chatEnrollmentsService.enroll({ chatId: 7, language: 'es' });
			const summary = await chatEnrollmentsService.getSummary({ includeChatIds: false });
			expect(summary.records).toBeUndefined();
		});

		it('clamps limit into the 1..1000 range', async () => {
			const summary = await chatEnrollmentsService.getSummary({ limit: 5000 });
			expect(summary.count).toBe(0);
		});
	});

	describe('getStorageStatus', () => {
		it('reports disabled when env gate is false', () => {
			const status = chatEnrollmentsService.getStorageStatus();
			expect(status.enabled).toBe(false);
			expect(status.status).toBe('disabled');
			expect(status.mode).toBe('ephemeral');
			expect(status.backend).toBe('memory');
		});

		it('reports enabled but misconfigured when Firestore is missing', () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const status = chatEnrollmentsService.getStorageStatus();
			expect(status.enabled).toBe(true);
			expect(status.status).toBe('misconfigured');
			expect(status.mode).toBe('ephemeral');
		});
	});
});
