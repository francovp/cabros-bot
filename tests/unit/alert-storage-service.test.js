'use strict';

/**
 * Unit tests for AlertStorageService
 * Tests Firestore persistence of /api/webhook/alert payloads.
 *
 * firebase-admin is redirected to __mocks__/firebase-admin.js via moduleNameMapper
 * in jest.config.js (required for pnpm worktree where firebase-admin lives in
 * the parent repo's node_modules, not in the worktree directory).
 */

// The moduleNameMapper in jest.config.js ensures this resolves to __mocks__/firebase-admin.js
const admin = require('firebase-admin');
const crypto = require('crypto');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const { parseAlertPaginationCursor } = require('../../src/services/storage/alertPaginationCursor');

// ── Shorthand references to mock internals ──────────────────────────────────
const {
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockGet: mockGet,
	__mockDocGet: mockDocGet,
	__mockDocSet: mockDocSet,
	__mockWhere: mockWhere,
	__mockOrderBy: mockOrderBy,
	__mockLimit: mockLimit,
	__mockStartAfter: mockStartAfter,
	__mockInitializeApp: mockInitializeApp,
	__mockCert: mockCert,
	__mockTimestampFromDate: mockTimestampFromDate,
	__mockDocumentId: mockDocumentId,
} = admin;

function buildTimestamp(isoString) {
	return {
		toDate: () => new Date(isoString),
	};
}

function buildQueryDoc(id, data) {
	return {
		id,
		data: () => data,
	};
}

function buildDocSnapshot(id, data) {
	return {
		exists: Boolean(data),
		id,
		data: () => data,
	};
}

// ── Test suite ───────────────────────────────────────────────────────────────

describe('AlertStorageService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		admin.__resetApps();
		// Reset the Firestore db singleton between tests
		AlertStorageService._resetForTesting();
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
	});

	afterEach(() => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	});

	// ── getFirestore ────────────────────────────────────────────────────────

	describe('getFirestore()', () => {
		it('returns null when ENABLE_FIRESTORE_ALERT_STORAGE is not set', () => {
			const result = AlertStorageService.getFirestore();
			expect(result).toBeNull();
			expect(mockInitializeApp).not.toHaveBeenCalled();
		});

		it('returns null when ENABLE_FIRESTORE_ALERT_STORAGE is "false"', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const result = AlertStorageService.getFirestore();
			expect(result).toBeNull();
		});

		it('initializes firebase-admin and returns Firestore instance when enabled', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const result = AlertStorageService.getFirestore();
			expect(mockInitializeApp).toHaveBeenCalledTimes(1);
			expect(result).not.toBeNull();
			expect(result.collection).toBeDefined();
		});

		it('initializes Firestore when only ENABLE_SHADOW_MODE_OUTCOME_TRACKING is true', () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			const result = AlertStorageService.getFirestore();
			expect(mockInitializeApp).toHaveBeenCalledTimes(1);
			expect(result).not.toBeNull();
			expect(result.collection).toBeDefined();
		});

		it('initializes Firestore when only ENABLE_SIGNAL_OUTCOME_TRACKING is true', () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const result = AlertStorageService.getFirestore();
			expect(mockInitializeApp).toHaveBeenCalledTimes(1);
			expect(result).not.toBeNull();
			expect(result.collection).toBeDefined();
		});

		it('initializes Firestore when only ENABLE_FIRESTORE_JOB_STORAGE is true', () => {
			process.env.ENABLE_FIRESTORE_JOB_STORAGE = 'true';
			const result = AlertStorageService.getFirestore();
			expect(mockInitializeApp).toHaveBeenCalledTimes(1);
			expect(result).not.toBeNull();
			expect(result.collection).toBeDefined();
		});

		it('uses FIREBASE_SERVICE_ACCOUNT_JSON when set', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const serviceAccount = { type: 'service_account', project_id: 'test-project' };
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify(serviceAccount);

			AlertStorageService.getFirestore();

			expect(mockCert).toHaveBeenCalledWith(serviceAccount);
			expect(mockInitializeApp).toHaveBeenCalledWith(
				expect.objectContaining({ credential: expect.anything() }),
			);
		});

		it('passes FIREBASE_PROJECT_ID to initializeApp when set', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.FIREBASE_PROJECT_ID = 'my-project';

			AlertStorageService.getFirestore();

			expect(mockInitializeApp).toHaveBeenCalledWith(
				expect.objectContaining({ projectId: 'my-project' }),
			);
		});

		it('does not call initializeApp when admin.apps is already populated', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			admin.__setApps([{ name: '[DEFAULT]' }]);

			AlertStorageService.getFirestore();

			expect(mockInitializeApp).not.toHaveBeenCalled();
		});

		it('returns null and logs a warning when initializeApp throws', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockInitializeApp.mockImplementationOnce(() => {
				throw new Error('Bad credentials');
			});
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			const result = AlertStorageService.getFirestore();

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[AlertStorageService]'),
				expect.stringContaining('Bad credentials'),
			);
			warnSpy.mockRestore();
		});
	});

	// ── saveAlert ────────────────────────────────────────────────────────────

	describe('saveAlert()', () => {
		const buildParams = (overrides = {}) => ({
			text: 'BTC above 100k',
			enriched: false,
			enrichmentData: null,
			tokenUsage: null,
			deliveryResults: [{ channel: 'telegram', success: true }],
			useTradingViewData: false,
			...overrides,
		});

		it('returns null without calling Firestore when storage is disabled', async () => {
			const result = await AlertStorageService.saveAlert(buildParams());
			expect(result).toBeNull();
			expect(mockAdd).not.toHaveBeenCalled();
		});

		it('does not save alerts when only signal outcome tracking is enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const result = await AlertStorageService.saveAlert(buildParams());

			expect(result).toBeNull();
			expect(mockAdd).not.toHaveBeenCalled();
		});

		it('does not save alerts when only legacy shadow-mode tracking is enabled', async () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';

			const result = await AlertStorageService.saveAlert(buildParams());

			expect(result).toBeNull();
			expect(mockAdd).not.toHaveBeenCalled();
		});

		it('calls collection("alerts").add() with correctly shaped document', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const docId = 'abc123';
			mockAdd.mockResolvedValueOnce({ id: docId });

			const params = buildParams({
				text: 'ETH breakout',
				enriched: true,
				enrichmentData: { sentiment: 'bullish', insights: ['RSI > 70'] },
				tokenUsage: { total: 500, formattedSummary: '500 tokens' },
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: false },
				],
				channels: ['telegram'],
				useTradingViewData: true,
			});

			const result = await AlertStorageService.saveAlert(params);

			expect(result).toBe(docId);
			expect(mockCollection).toHaveBeenCalledWith('alerts');
			expect(mockAdd).toHaveBeenCalledWith({
				receivedAt: expect.anything(), // serverTimestamp sentinel
				text: 'ETH breakout',
				enriched: true,
				enrichmentData: { sentiment: 'bullish', insights: ['RSI > 70'] },
				tokenUsage: { total: 500, formattedSummary: '500 tokens' },
				deliveryResults: [
					{ channel: 'telegram', success: true },
					{ channel: 'whatsapp', success: false },
				],
				channels: ['telegram'],
				source: 'webhook',
				useTradingViewData: true,
			});
		});

		it('persists requested channels for stored alert exports and replays', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id-channels' });

			await AlertStorageService.saveAlert(buildParams({
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
			}));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.channels).toEqual(['telegram']);
		});

		it('truncates text longer than 20000 characters', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id1' });
			const longText = 'x'.repeat(25000);

			await AlertStorageService.saveAlert(buildParams({ text: longText }));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.text.length).toBe(20000);
		});

		it('stores empty array when deliveryResults is not an array', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id2' });

			await AlertStorageService.saveAlert(buildParams({ deliveryResults: undefined }));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.deliveryResults).toEqual([]);
		});

		it('always sets source to "webhook"', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id3' });

			await AlertStorageService.saveAlert(buildParams());

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.source).toBe('webhook');
		});

		it('returns null and logs a warning (does not throw) when add() rejects', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockRejectedValueOnce(new Error('Quota exceeded'));
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await AlertStorageService.saveAlert(buildParams());

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[AlertStorageService]'),
				expect.stringContaining('Quota exceeded'),
			);
			warnSpy.mockRestore();
		});

		it('coerces non-boolean enriched to boolean', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id4' });

			await AlertStorageService.saveAlert(buildParams({ enriched: 1 }));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.enriched).toBe(true);
		});
	});

	describe('listAlerts()', () => {
		it('returns null when alert storage is disabled', async () => {
			const result = await AlertStorageService.listAlerts({ limit: 10 });
			expect(result).toBeNull();
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('throws STORAGE_UNAVAILABLE when Firestore initialization fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockInitializeApp.mockImplementationOnce(() => {
				throw new Error('Bad credentials');
			});

			await expect(AlertStorageService.listAlerts({ limit: 10 })).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('throws INVALID_REQUEST when the before cursor is malformed', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			await expect(AlertStorageService.listAlerts({
				limit: 10,
				before: 'not-a-valid-cursor',
			})).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				message: AlertStorageService.INVALID_CURSOR_MESSAGE,
			});
		});

		it('lists alerts with formatted output and pagination metadata', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'BTC alert',
						enriched: true,
						enrichmentData: { sentiment: 'bullish' },
						tokenUsage: { totalTokens: 42 },
						channels: ['telegram'],
						deliveryResults: [{ channel: 'telegram', success: true }],
						source: 'webhook',
						useTradingViewData: false,
					}),
					buildQueryDoc('alert-2', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						text: 'ETH alert',
						enriched: false,
						enrichmentData: null,
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: true,
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({ limit: 1 });

			expect(mockCollection).toHaveBeenCalledWith('alerts');
			expect(mockOrderBy).toHaveBeenNthCalledWith(1, 'receivedAt', 'desc');
			expect(mockDocumentId).toHaveBeenCalledTimes(1);
			expect(mockOrderBy).toHaveBeenNthCalledWith(2, '__name__', 'desc');
			expect(mockLimit).toHaveBeenCalledWith(2);
			expect(result.alerts).toEqual([
				{
					id: 'alert-1',
					receivedAt: '2026-06-06T12:00:00.000Z',
					text: 'BTC alert',
					enriched: true,
					enrichmentData: { sentiment: 'bullish' },
					tokenUsage: { totalTokens: 42 },
					channels: ['telegram'],
					deliveryResults: [{ channel: 'telegram', success: true }],
					source: 'webhook',
					useTradingViewData: false,
				},
			]);
			expect(result.hasMore).toBe(true);
			expect(parseAlertPaginationCursor(result.nextBefore)).toEqual({
				type: 'composite',
				receivedAt: '2026-06-06T12:00:00.000Z',
				documentId: 'alert-1',
			});
		});

		it('keeps scanning batches until it finds enough filtered alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('alert-1', {
							receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
							text: 'Mismatch',
							enriched: false,
							enrichmentData: null,
							tokenUsage: null,
							deliveryResults: [],
							source: 'webhook',
							useTradingViewData: false,
						}),
						buildQueryDoc('alert-1b', {
							receivedAt: buildTimestamp('2026-06-06T11:30:00.000Z'),
							text: 'Second mismatch',
							enriched: false,
							enrichmentData: null,
							tokenUsage: null,
							deliveryResults: [],
							source: 'webhook',
							useTradingViewData: false,
						}),
					],
				})
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('alert-2', {
							receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
							text: 'Match',
							enriched: true,
							enrichmentData: { sentiment: 'bullish' },
							tokenUsage: null,
							deliveryResults: [],
							source: 'webhook',
							useTradingViewData: false,
						}),
					],
				});

			const result = await AlertStorageService.listAlerts({
				limit: 1,
				before: '2026-06-06T13:00:00.000Z',
				source: 'webhook',
				enriched: true,
			});

			expect(mockTimestampFromDate).toHaveBeenCalledWith(new Date('2026-06-06T13:00:00.000Z'));
			expect(mockWhere).toHaveBeenCalledWith('receivedAt', '<', expect.anything());
			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(result.alerts).toHaveLength(1);
			expect(result.alerts[0].id).toBe('alert-2');
		});

		it('uses the opaque nextBefore cursor to continue within tied timestamps', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-b', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'Newest tie',
						enriched: true,
						enrichmentData: null,
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: false,
					}),
					buildQueryDoc('alert-a', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'Older tie',
						enriched: true,
						enrichmentData: null,
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: false,
					}),
				],
			});

			const firstPage = await AlertStorageService.listAlerts({ limit: 1 });

			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-a', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'Older tie',
						enriched: true,
						enrichmentData: null,
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: false,
					}),
				],
			});

			const secondPage = await AlertStorageService.listAlerts({
				limit: 1,
				before: firstPage.nextBefore,
			});

			expect(mockStartAfter).toHaveBeenCalledWith(expect.anything(), 'alert-b');
			expect(secondPage.alerts[0].id).toBe('alert-a');
		});

		it('throws STORAGE_UNAVAILABLE when Firestore reads fail', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockRejectedValueOnce(new Error('Permission denied'));

			await expect(AlertStorageService.listAlerts({ limit: 10 })).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});
	});

	describe('getAlertById()', () => {
		it('throws STORAGE_UNAVAILABLE when Firestore initialization fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockInitializeApp.mockImplementationOnce(() => {
				throw new Error('Bad credentials');
			});

			await expect(AlertStorageService.getAlertById('alert-123')).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('returns null when the alert document does not exist', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockResolvedValueOnce(buildDocSnapshot('missing-alert', null));

			const result = await AlertStorageService.getAlertById('missing-alert');

			expect(result).toBeNull();
		});

		it('returns a formatted alert when the document exists', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockResolvedValueOnce(buildDocSnapshot('alert-123', {
				receivedAt: buildTimestamp('2026-06-06T10:30:00.000Z'),
				text: 'Stored alert',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
				source: 'webhook',
				useTradingViewData: true,
			}));

			const result = await AlertStorageService.getAlertById('alert-123');

			expect(result).toEqual({
				id: 'alert-123',
				receivedAt: '2026-06-06T10:30:00.000Z',
				text: 'Stored alert',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
				source: 'webhook',
				useTradingViewData: true,
			});
		});

		it('throws STORAGE_UNAVAILABLE when Firestore detail reads fail', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockRejectedValueOnce(new Error('Permission denied'));

			await expect(AlertStorageService.getAlertById('alert-123')).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});
	});

	describe('saveReplayAttempt()', () => {
		it('stores replay attempts using a hashed idempotency key document ID', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const idempotencyKey = 'replay/key-1';
			const idempotencyKeyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');

			const result = await AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
			});

			expect(result).toBe(`alert-123_${idempotencyKeyHash}`);
			expect(mockCollection).toHaveBeenCalledWith('alertReplays');
			expect(mockDocSet).toHaveBeenCalledWith({
				alertId: 'alert-123',
				idempotencyKey,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
				replayedAt: expect.anything(),
				source: 'alert-replay',
			});
		});

		it('uses a bounded replay document ID for long idempotency keys', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const idempotencyKey = 'a'.repeat(10_000);

			const result = await AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey,
				channels: [],
				deliveryResults: [],
			});

			expect(result).toMatch(/^alert-123_[a-f0-9]{64}$/);
			expect(result).toHaveLength('alert-123_'.length + 64);
		});

		it('throws STORAGE_UNAVAILABLE when replay audit storage fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocSet.mockRejectedValueOnce(new Error('permission denied'));

			await expect(AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey: 'replay-key-2',
				channels: ['telegram'],
				deliveryResults: [],
			})).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});
	});

	describe('exportAlerts()', () => {
		it('returns null when alert storage is disabled', async () => {
			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result).toBeNull();
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('requires a bounded from/to window', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			await expect(AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
			})).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				message: 'Export requests require bounded from and to ISO-8601 timestamps.',
			});
		});

		it('rejects export windows over 31 days', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			await expect(AlertStorageService.exportAlerts({
				from: '2026-05-01T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			})).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				message: 'Invalid export window. Maximum export window is 31 days.',
			});
		});

		it('exports safe records with compact delivery and token fields', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: `BTC breakout ${'x'.repeat(1200)}`,
						enriched: true,
						enrichmentData: { providerSecret: 'must-not-export' },
						tokenUsage: {
							promptTokens: 10,
							completionTokens: 20,
							total: 30,
							totalCost: 0.001,
							apiKey: 'must-not-export',
						},
						deliveryResults: [
							{
								channel: 'telegram',
								success: true,
								messageId: 'tg-1',
								requestHeaders: { authorization: 'Bearer secret' },
							},
							{
								channel: 'whatsapp',
								success: false,
								errorCode: 'PROVIDER_LIMIT',
								statusCode: 429,
								rawProviderResponse: { token: 'secret' },
							},
						],
						source: 'webhook',
						useTradingViewData: true,
					}),
					buildQueryDoc('alert-2', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						text: 'Plain alert',
						enriched: false,
						enrichmentData: null,
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: false,
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 2000,
				source: 'webhook',
				enriched: true,
				includeText: true,
			});

			expect(mockCollection).toHaveBeenCalledWith('alerts');
			expect(mockWhere).toHaveBeenCalledWith('receivedAt', '>=', expect.anything());
			expect(mockWhere).toHaveBeenCalledWith('receivedAt', '<=', expect.anything());
			expect(mockOrderBy).toHaveBeenCalledWith('receivedAt', 'desc');
			expect(mockLimit).toHaveBeenCalledWith(1000);
			expect(result.window).toEqual({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 1000,
				maxDays: 31,
			});
			expect(result.alerts).toHaveLength(1);
			expect(result.alerts[0]).toEqual({
				id: 'alert-1',
				receivedAt: '2026-06-06T12:00:00.000Z',
				source: 'webhook',
				enriched: true,
				useTradingViewData: true,
				deliveryResults: [
					{ channel: 'telegram', success: true, messageId: 'tg-1', errorCode: null, statusCode: null },
					{ channel: 'whatsapp', success: false, messageId: null, errorCode: 'PROVIDER_LIMIT', statusCode: 429 },
				],
				tokenUsage: {
					inputTokens: 10,
					outputTokens: 20,
					totalTokens: 30,
					totalCost: 0.001,
				},
				text: expect.stringMatching(/^BTC breakout /),
			});
			expect(result.alerts[0].text.length).toBe(1000);
			expect(JSON.stringify(result)).not.toContain('must-not-export');
			expect(JSON.stringify(result)).not.toContain('authorization');
			expect(JSON.stringify(result)).not.toContain('rawProviderResponse');
		});

		it('throws STORAGE_UNAVAILABLE when Firestore export reads fail', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockRejectedValueOnce(new Error('Permission denied'));

			await expect(AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			})).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});
	});

	describe('summarizeAlerts()', () => {
		it('aggregates bounded alert analytics without exposing raw alert text', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'BTC raw alert text should not leak',
						enriched: true,
						enrichmentData: { symbol: 'BTCUSDT' },
						tokenUsage: {
							inputTokens: 10,
							outputTokens: 20,
							totalTokens: 30,
							totalCost: 0.001,
						},
						deliveryResults: [
							{ channel: 'telegram', success: true, latencyMs: 100 },
							{ channel: 'whatsapp', success: true, latencyMs: 150 },
						],
						source: 'webhook',
						useTradingViewData: true,
						processingTimeMs: 250,
					}),
					buildQueryDoc('alert-2', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						text: 'ETH raw alert text should not leak',
						enriched: false,
						enrichmentData: { symbol: 'ETHUSDT' },
						tokenUsage: null,
						deliveryResults: [
							{ channel: 'telegram', success: false, latencyMs: 200 },
						],
						source: 'webhook',
						useTradingViewData: false,
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(mockCollection).toHaveBeenCalledWith('alerts');
			expect(mockWhere).toHaveBeenCalledWith('receivedAt', '>=', expect.anything());
			expect(mockWhere).toHaveBeenCalledWith('receivedAt', '<=', expect.anything());
			expect(mockOrderBy).toHaveBeenCalledWith('receivedAt', 'desc');
			expect(mockLimit).toHaveBeenCalledWith(200);
			expect(result).toEqual({
				window: {
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
					maxDays: 31,
				},
				totalAlerts: 2,
				bySource: { webhook: 2 },
				bySymbol: { BTCUSDT: 1, ETHUSDT: 1 },
				byFeatureFlag: {
					enriched: 1,
					plain: 1,
					tradingViewData: 1,
					withoutTradingViewData: 1,
				},
				enrichment: {
					enrichedAlerts: 1,
					plainAlerts: 1,
					tokenUsage: {
						inputTokens: 10,
						outputTokens: 20,
						totalTokens: 30,
						totalCost: 0.001,
					},
				},
				delivery: {
					totalSuccess: 2,
					totalFailure: 1,
					byChannel: {
						telegram: { total: 2, success: 1, failure: 1 },
						whatsapp: { total: 1, success: 1, failure: 0 },
					},
				},
				latency: {
					averageProcessingMs: 250,
					averageDeliveryMs: 150,
				},
			});
			expect(JSON.stringify(result)).not.toContain('raw alert text');
		});
	});
});
