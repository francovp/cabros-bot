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
const { __mockAdd: mockAdd, __mockCollection: mockCollection, __mockInitializeApp: mockInitializeApp, __mockCert: mockCert } = admin;

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
});
