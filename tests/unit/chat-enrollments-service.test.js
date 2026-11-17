'use strict';

const fs = require('fs');
const path = require('path');

const chatEnrollmentsService = require('../../src/services/enrollments/ChatEnrollmentsService');
const { firestoreWriteMetricsService } = require('../../src/services/storage/FirestoreWriteMetricsService');

describe('ChatEnrollmentsService', () => {
	it('ships a Firestore TTL policy for enrollment retention', () => {
		const indexes = JSON.parse(fs.readFileSync(path.join(__dirname, '../../firestore.indexes.json'), 'utf8'));
		expect(indexes.fieldOverrides).toContainEqual(expect.objectContaining({
			collectionGroup: 'chatEnrollments', fieldPath: 'expiresAt', ttl: true,
		}));
	});
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
		firestoreWriteMetricsService.resetForTesting();
		delete process.env.ENABLE_CHAT_ENROLLMENTS;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.CHAT_ENROLLMENT_RETENTION_DAYS;
	});

	afterEach(() => {
		chatEnrollmentsService._resetForTesting();
		firestoreWriteMetricsService.resetForTesting();
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
			const many = Array.from({ length: 60 }, (_, i) => `SYM${i}USDT`);
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
		it('returns the newer durable snapshot when clock skew skips the requested update', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const durableTime = Date.now() + 60_000;
			const durableExpiry = durableTime + 86_400_000;
			const set = jest.fn();
			chatEnrollmentsService._setFirestoreForTesting({
				collection: () => ({ doc: () => ({}) }),
				runTransaction: async (work) => work({
					get: async () => ({ exists: true, data: () => ({ chatType: 'group', language: 'es',
						watchlist: ['NASDAQ:NVDA'], refSource: 'stored', enrolledAt: { toMillis: () => durableTime },
						expiresAt: { toMillis: () => durableExpiry } }) }), set,
				}),
			});
			const result = await chatEnrollmentsService.enroll({ chatId: 42, language: 'en' });
			expect(set).not.toHaveBeenCalled();
			expect(result).toMatchObject({ chatId: '42', chatType: 'group', language: 'es',
				watchlist: ['NASDAQ:NVDA'], refSource: 'stored', enrolledAt: durableTime });
			expect(await chatEnrollmentsService.getByChatId(42)).toMatchObject({ language: 'es', enrolledAt: durableTime });
			expect(chatEnrollmentsService.getStorageStatus()).toMatchObject({ ready: true, mode: 'durable' });
		});
		it.each([false, true])('keeps newer cached preferences when an older read resolves (write fails: %s)', async (failWrite) => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			let releaseRead;
			const old = { language: 'es', enrolledAt: { toMillis: () => 1 } };
			chatEnrollmentsService._setFirestoreForTesting({
				collection: () => ({ doc: () => ({ get: () => new Promise((resolve) => { releaseRead = () => resolve({ exists: true, data: () => old }); }) }) }),
				runTransaction: async (work) => {
					if (failWrite) throw new Error('unavailable');
					return work({ get: async () => ({ exists: true, data: () => old }), set: () => {} });
				},
			});
			const reading = chatEnrollmentsService.getByChatId(42);
			await chatEnrollmentsService.enroll({ chatId: 42, language: 'en' });
			releaseRead();
			expect((await reading).language).toBe('en');
			expect((await chatEnrollmentsService.getByChatId(42)).language).toBe('en');
		});

		it('leaves expired document deletion to TTL so renewal cannot race a stale delete', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const remove = jest.fn().mockResolvedValue();
			chatEnrollmentsService._setFirestoreForTesting({ collection: () => ({ doc: () => ({
				get: async () => ({ exists: true, data: () => ({ enrolledAt: { toMillis: () => 1 }, expiresAt: { toMillis: () => 2 } }) }),
				delete: remove,
			}) }) });
			expect(await chatEnrollmentsService.getByChatId(42)).toBeNull();
			expect(remove).not.toHaveBeenCalled();
		});

		it('hides expired in-memory enrollments before Firestore TTL cleanup', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const clock = jest.spyOn(Date, 'now').mockReturnValue(1000);
			try {
				await chatEnrollmentsService.enroll({ chatId: 99, language: 'es' });
				clock.mockReturnValue(1000 + 91 * 24 * 60 * 60 * 1000);
				expect(await chatEnrollmentsService.getByChatId(99)).toBeNull();
				expect((await chatEnrollmentsService.getSummary()).count).toBe(0);
			} finally {
				clock.mockRestore();
			}
		});
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

		it('keeps pending local preference changes when storage recovers', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			let stored = { language: 'es', refSource: 'before', enrolledAt: { toMillis: () => 1 } };
			let unavailable = true;
			chatEnrollmentsService._setFirestoreForTesting({
				collection: () => ({ doc: () => ({}) }),
				runTransaction: async (work) => {
					if (unavailable) throw new Error('unavailable');
					return work({ get: async () => ({ exists: true, data: () => stored }), set: (_ref, payload) => { stored = payload; } });
				},
			});
			await chatEnrollmentsService.enroll({ chatId: 42, language: 'en' });
			unavailable = false;
			stored.refSource = 'changed-on-other-replica';
			await chatEnrollmentsService.enroll({ chatId: 42 });
			expect(stored.language).toBe('en');
			expect(stored.refSource).toBe('changed-on-other-replica');
			expect((await chatEnrollmentsService.getByChatId(42)).language).toBe('en');
		});

		it('does not let an older delayed write replace a newer enrollment', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			let stored = null;
			let releaseFirst;
			let writes = 0;
			const db = {
				collection: () => ({ doc: () => ({
					set: (payload) => {
						writes += 1;
						if (writes === 1) return new Promise((resolve) => {
							releaseFirst = () => { stored = payload; resolve(); };
						});
						stored = payload;
						return Promise.resolve();
					},
				}) }),
				runTransaction: async (work) => {
					writes += 1;
					if (writes === 1) await new Promise((resolve) => { releaseFirst = resolve; });
					await work({
						get: async () => ({ exists: Boolean(stored), data: () => stored }),
						set: (_ref, payload) => { stored = payload; },
					});
				},
			};
			chatEnrollmentsService._setFirestoreForTesting(db);
			const first = chatEnrollmentsService.enroll({ chatId: 42, language: 'es' });
			const second = chatEnrollmentsService.enroll({ chatId: 42, language: 'en' });
			await second;
			releaseFirst();
			await first;
			expect(stored.language).toBe('en');
		});
	});

	describe('getSummary', () => {
		it('includes a failed Firestore write in the bounded memory fallback', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			chatEnrollmentsService._setFirestoreForTesting({
				collection: () => ({
					doc: () => ({}),
					limit: () => ({ get: () => Promise.resolve({ size: 0, forEach: () => {} }) }),
				}),
				runTransaction: () => Promise.reject(new Error('unavailable')),
			});
			await chatEnrollmentsService.enroll({ chatId: 42, language: 'es' });
			const summary = await chatEnrollmentsService.getSummary({ includeChatIds: true });
			expect(summary.count).toBe(1);
			expect(summary.records[0].chatId).toBe('42');
			expect(summary.mode).toBe('ephemeral');
			expect(chatEnrollmentsService.getStorageStatus().status).toBe('degraded');
		});

		it('caps the in-memory enrollment cache', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			for (let chatId = 1; chatId <= 1002; chatId += 1) {
				await chatEnrollmentsService.enroll({ chatId });
			}
			expect(chatEnrollmentsService.getStorageStatus().count).toBe(1000);
			expect(await chatEnrollmentsService.getByChatId(1)).toBeNull();
		});
		it('does not retain failed writes for records evicted during concurrent starts', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const failures = new Map();
			chatEnrollmentsService._setFirestoreForTesting({
				collection: () => ({
					doc: (chatId) => ({ id: chatId }),
					limit: () => ({ get: () => Promise.resolve({ size: 0, forEach: () => {} }) }),
				}),
				runTransaction: (work) => work({
					get: (ref) => Number(ref.id) <= 2
						? new Promise((_, reject) => failures.set(ref.id, reject))
						: Promise.resolve({ exists: false }),
					set: () => {},
				}),
			});
			const pending = Array.from({ length: 1002 }, (_, index) =>
				chatEnrollmentsService.enroll({ chatId: index + 1 }));
			failures.get('1')(new Error('unavailable'));
			failures.get('2')(new Error('unavailable'));
			await Promise.all(pending);
			expect(chatEnrollmentsService.getStorageStatus().count).toBe(1000);
			await chatEnrollmentsService.getSummary();
			expect(chatEnrollmentsService.getStorageStatus().status).toBe('ready');
		});
		it('respects the requested scan limit', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			await chatEnrollmentsService.enroll({ chatId: 1 });
			await chatEnrollmentsService.enroll({ chatId: 2 });
			await chatEnrollmentsService.enroll({ chatId: 3 });
			const summary = await chatEnrollmentsService.getSummary({ limit: 2, includeChatIds: true });
			expect(summary.count).toBe(2);
			expect(summary.records).toHaveLength(2);
			expect(summary.partial).toBe(true);
		});
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
		it.each(['document', 'list'])('records sanitized %s read failures and recovery in shared health', async (operation) => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			const get = jest.fn().mockRejectedValueOnce(Object.assign(new Error('private-provider-detail'), { code: 7 }))
				.mockResolvedValueOnce({ exists: false, size: 0, forEach: () => {} });
			chatEnrollmentsService._setFirestoreForTesting({ collection: () => ({
				doc: () => ({ get }), limit: () => ({ get }),
			}) });
			const read = () => operation === 'document'
				? chatEnrollmentsService.getByChatId(42) : chatEnrollmentsService.getSummary();
			await read();
			expect(firestoreWriteMetricsService.getReadSnapshot()).toMatchObject({
				readHealth: 'degraded', readsFailed: 1, lastErrorCategory: 'permission_denied',
				byDomain: { chatEnrollments: { failure: 1 } },
			});
			expect(JSON.stringify(firestoreWriteMetricsService.getReadSnapshot())).not.toContain('private-provider-detail');
			await read();
			expect(firestoreWriteMetricsService.getReadSnapshot()).toMatchObject({
				readHealth: 'healthy', readsFailed: 1, readsSucceeded: 1, consecutiveReadFailures: 0,
			});
		});
		it('keeps Firestore unverified until a successful operation and degrades after a failed read', async () => {
			process.env.ENABLE_CHAT_ENROLLMENTS = 'true';
			chatEnrollmentsService._setFirestoreForTesting({ collection: () => ({
				limit: () => ({ get: () => Promise.reject(new Error('unavailable')) }),
			}) });
			expect(chatEnrollmentsService.getStorageStatus().status).toBe('unverified');
			await chatEnrollmentsService.getSummary();
			expect(chatEnrollmentsService.getStorageStatus().status).toBe('degraded');
		});
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
