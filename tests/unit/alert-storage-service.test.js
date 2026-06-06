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
const AlertStorageService = require('../../src/services/storage/AlertStorageService');

// ── Shorthand references to mock internals ──────────────────────────────────
const {
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockGet: mockGet,
	__mockDocGet: mockDocGet,
	__mockWhere: mockWhere,
	__mockOrderBy: mockOrderBy,
	__mockLimit: mockLimit,
	__mockInitializeApp: mockInitializeApp,
	__mockCert: mockCert,
	__mockTimestampFromDate: mockTimestampFromDate,
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
	});

	afterEach(() => {
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
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
				source: 'webhook',
				useTradingViewData: true,
			});
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
			expect(mockOrderBy).toHaveBeenCalledWith('receivedAt', 'desc');
			expect(mockLimit).toHaveBeenCalledWith(2);
			expect(result).toEqual({
				alerts: [
					{
						id: 'alert-1',
						receivedAt: '2026-06-06T12:00:00.000Z',
						text: 'BTC alert',
						enriched: true,
						enrichmentData: { sentiment: 'bullish' },
						tokenUsage: { totalTokens: 42 },
						deliveryResults: [{ channel: 'telegram', success: true }],
						source: 'webhook',
						useTradingViewData: false,
					},
				],
				hasMore: true,
				nextBefore: '2026-06-06T12:00:00.000Z',
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
	});

	describe('getAlertById()', () => {
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
				deliveryResults: [{ channel: 'telegram', success: true }],
				source: 'webhook',
				useTradingViewData: true,
			});
		});
	});
});
