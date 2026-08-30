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
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
	});

	afterEach(() => {
		jest.useRealTimers();
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_FIRESTORE_JOB_STORAGE;
		delete process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.ALERT_STORAGE_RETENTION_DAYS;
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

		it('does not initialize Firestore when only retired ENABLE_SHADOW_MODE_OUTCOME_TRACKING is true', () => {
			process.env.ENABLE_SHADOW_MODE_OUTCOME_TRACKING = 'true';
			const result = AlertStorageService.getFirestore();
			expect(mockInitializeApp).not.toHaveBeenCalled();
			expect(result).toBeNull();
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

		it('initializes Firestore when only Firebase Remote Config is enabled', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
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

		it('does not save alerts when only signal outcome tracking is enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

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
				expiresAt: expect.anything(),
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
				tradingViewEnrichmentApplied: false,
			});
		});

		it('persists news-monitor alert with source, eventCategory, confidence, and dedupStatus', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const docId = 'news-doc-123';
			mockAdd.mockResolvedValueOnce({ id: docId });

			const params = buildParams({
				text: 'BTCUSDT: Bitcoin surges on positive news',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				source: 'news-monitor',
				eventCategory: 'price_surge',
				confidence: 0.85,
				sentimentScore: 0.75,
				dedupStatus: 'fresh',
				enriched: true,
				enrichmentData: { originalText: 'BTCUSDT: Bitcoin surges on positive news', summary: 'Bullish momentum' },
				tokenUsage: { total: 350, formattedSummary: '350 tokens' },
				deliveryResults: [{ channel: 'telegram', success: true }],
				channels: ['telegram', 'whatsapp'],
				processingTimeMs: 120,
			});

			const result = await AlertStorageService.saveAlert(params);

			expect(result).toBe(docId);
			expect(mockCollection).toHaveBeenCalledWith('alerts');
			expect(mockAdd).toHaveBeenCalledWith({
				receivedAt: expect.anything(),
				expiresAt: expect.anything(),
				text: 'BTCUSDT: Bitcoin surges on positive news',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				source: 'news-monitor',
				eventCategory: 'price_surge',
				confidence: 0.85,
				sentimentScore: 0.75,
				dedupStatus: 'fresh',
				enriched: true,
				enrichmentData: { originalText: 'BTCUSDT: Bitcoin surges on positive news', summary: 'Bullish momentum' },
				tokenUsage: { total: 350, formattedSummary: '350 tokens' },
				deliveryResults: [{ channel: 'telegram', success: true }],
				channels: ['telegram', 'whatsapp'],
				useTradingViewData: false,
				tradingViewEnrichmentApplied: false,
				processingTimeMs: 120,
			});
		});

		it('persists sanitized flipContext when provided', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'flip-doc-1' });
			const params = buildParams({
				text: 'BINANCE:BTCUSDT(60) cambió a señal de COMPRA',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				flipContext: {
					previousDirection: 'SELL',
					previousAt: '2026-08-25T20:01:00.000Z',
					hoursDelta: 12,
					timeframe: '1h',
					exchange: 'BINANCE',
					symbol: 'BTCUSDT',
				},
			});
			await AlertStorageService.saveAlert(params);
			const callArgs = mockAdd.mock.calls[0][0];
			expect(callArgs.flipContext).toEqual({
				previousDirection: 'SELL',
				previousAt: '2026-08-25T20:01:00.000Z',
				hoursDelta: 12,
				timeframe: '1h',
				exchange: 'BINANCE',
				symbol: 'BTCUSDT',
			});
		});

		it('omits flipContext when previousDirection is invalid', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'flip-doc-2' });
			const params = buildParams({
				flipContext: {
					previousDirection: 'HOLD',
					previousAt: '2026-08-25T20:01:00.000Z',
					hoursDelta: 12,
				},
			});
			await AlertStorageService.saveAlert(params);
			expect(mockAdd.mock.calls[0][0].flipContext).toBeUndefined();
		});

		it('rounds and clamps negative flipContext.hoursDelta to null', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'flip-doc-3' });
			const params = buildParams({
				flipContext: {
					previousDirection: 'BUY',
					previousAt: '2026-08-25T20:01:00.000Z',
					hoursDelta: -1,
				},
			});
			await AlertStorageService.saveAlert(params);
			expect(mockAdd.mock.calls[0][0].flipContext).toBeUndefined();
		});

		it('persists telegramThreadId and channel destination overrides', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const docId = 'topic-doc-123';
			mockAdd.mockResolvedValueOnce({ id: docId });

			const params = buildParams({
				text: 'BTCUSDT signal in topic',
				source: 'webhook-signal',
				telegramChatId: 'chat-99',
				telegramThreadId: 456,
				whatsappChatId: '120363422033474991@g.us',
				discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
			});

			const result = await AlertStorageService.saveAlert(params);

			expect(result).toBe(docId);
			expect(mockCollection).toHaveBeenCalledWith('alerts');
			expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
				source: 'webhook-signal',
				telegramChatId: 'chat-99',
				telegramThreadId: 456,
				whatsappChatId: '120363422033474991@g.us',
				discordWebhookUrl: 'https://discord.com/api/webhooks/123/token',
			}));
		});

		it('strips nested undefined properties before persisting without serialization errors', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'sanitized-alert' });

			const result = await AlertStorageService.saveAlert(buildParams({
				enriched: true,
				enrichmentData: {
					sentiment: 'bullish',
					sentiment_score: 0.55,
					sentiment_score_raw: 0.9,
					technical_levels: { supports: ['100k'], resistances: undefined },
					insights: ['RSI > 70', undefined],
				},
				tokenUsage: { inputTokens: 10, outputTokens: undefined, formattedSummary: null },
				deliveryResults: [
					{ channel: 'telegram', success: true, messageId: 't1', error: undefined },
					{ channel: 'whatsapp', success: false, messageId: undefined, errorCode: 'TIMEOUT' },
				],
			}));

			const containsUndefined = (value) => {
				if (value === undefined) {
					return true;
				}
				if (Array.isArray(value)) {
					return value.some(containsUndefined);
				}
				if (value && typeof value === 'object') {
					return Object.values(value).some(containsUndefined);
				}
				return false;
			};

			expect(result).toBe('sanitized-alert');
			const document = mockAdd.mock.calls[0][0];
			expect(document.enrichmentData).toEqual(expect.objectContaining({
				sentiment_score: 0.55,
				sentiment_score_raw: 0.9,
			}));
			expect(document.enrichmentData.technical_levels).toEqual({ supports: ['100k'] });
			expect(document.enrichmentData.technical_levels).not.toHaveProperty('resistances');
			expect(document.enrichmentData.insights).toEqual(['RSI > 70']);
			expect(document.tokenUsage).toEqual({ inputTokens: 10, formattedSummary: null });
			expect(document.tokenUsage).not.toHaveProperty('outputTokens');
			expect(document.deliveryResults[0]).not.toHaveProperty('error');
			expect(document.deliveryResults[1]).not.toHaveProperty('messageId');
			expect(document.deliveryResults[1]).toHaveProperty('errorCode', 'TIMEOUT');
			expect(containsUndefined({
				enrichmentData: document.enrichmentData,
				tokenUsage: document.tokenUsage,
				deliveryResults: document.deliveryResults,
			})).toBe(false);
		});

		it('preserves nested class instances while stripping sibling undefined fields', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'sentinel-alert' });
			class ProviderSentinel {
				constructor(marker) {
					this.marker = marker;
				}
			}

			await AlertStorageService.saveAlert(buildParams({
				enriched: true,
				enrichmentData: {
					sentiment: 'bullish',
					providerRef: new ProviderSentinel('keep-me'),
				},
			}));

			const document = mockAdd.mock.calls.at(-1)[0];
			expect(document.enrichmentData.providerRef).toBeInstanceOf(ProviderSentinel);
			expect(document.enrichmentData.providerRef.marker).toBe('keep-me');
			expect(document.enrichmentData.sentiment).toBe('bullish');
		});

		it('adds the default retention expiry to new alert documents', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockAdd.mockResolvedValueOnce({ id: 'retained-alert' });

			await AlertStorageService.saveAlert(buildParams());

			expect(mockAdd.mock.calls[0][0].expiresAt.toDate()).toEqual(new Date('2026-11-11T00:00:00.000Z'));
		});

		it('falls back to the default retention when the setting is invalid', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ALERT_STORAGE_RETENTION_DAYS = 'not-a-number';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockAdd.mockResolvedValueOnce({ id: 'retained-alert' });
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			await AlertStorageService.saveAlert(buildParams());

			expect(mockAdd.mock.calls[0][0].expiresAt.toDate()).toEqual(new Date('2026-11-11T00:00:00.000Z'));
			expect(warnSpy).toHaveBeenCalledWith(
				'[AlertStorageService] Invalid ALERT_STORAGE_RETENTION_DAYS configuration, using default',
			);
			warnSpy.mockRestore();
		});

		it('persists only bounded non-negative integer processing latency', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValue({ id: 'latency-id' });

			await AlertStorageService.saveAlert(buildParams({ processingTimeMs: 250 }));

			expect(mockAdd.mock.calls[0][0].processingTimeMs).toBe(250);

			for (const processingTimeMs of [-1, 12.5, '250', Infinity, 24 * 60 * 60 * 1000 + 1, null, undefined]) {
				await AlertStorageService.saveAlert(buildParams({ processingTimeMs }));
				expect(mockAdd.mock.calls.at(-1)[0]).not.toHaveProperty('processingTimeMs');
			}
		});

		it('persists sanitized requestId when provided', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id-request-id' });

			await AlertStorageService.saveAlert(buildParams({
				requestId: '  req-trace-abc-123  ',
			}));

			expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
				requestId: 'req-trace-abc-123',
			}));
		});

		it('omits requestId when not a non-empty string', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id-no-req-id' });

			await AlertStorageService.saveAlert(buildParams({
				requestId: '   ',
			}));

			expect(mockAdd.mock.calls.at(-1)[0]).not.toHaveProperty('requestId');
		});

		it('persists requested and successfully applied TradingView enrichment separately', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id-tradingview' });

			await AlertStorageService.saveAlert(buildParams({
				useTradingViewData: true,
				tradingViewEnrichmentApplied: true,
				enriched: true,
				enrichmentData: { tradingViewEnrichmentApplied: true },
			}));

			expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
				useTradingViewData: true,
				tradingViewEnrichmentApplied: true,
			}));
		});

		it('persists sanitized TradingView enrichment outcome status', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id-partial-tradingview' });

			await AlertStorageService.saveAlert(buildParams({
				useTradingViewData: true,
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'partial',
				enriched: true,
				enrichmentData: { tradingViewEnrichmentStatus: 'partial' },
			}));

			expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
				tradingViewEnrichmentStatus: 'partial',
			}));
		});

		it('persists only safe prompt provenance fields with enriched alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id-provenance' });

			await AlertStorageService.saveAlert(buildParams({
				enriched: true,
				enrichmentData: {
					promptProvenance: {
						name: 'alert-enrichment',
						source: 'langfuse',
						label: 'production',
						version: 12,
						content: 'private prompt content must not persist',
					},
				},
			}));

			expect(mockAdd.mock.calls[0][0].enrichmentData).toEqual({
				promptProvenance: {
					name: 'alert-enrichment',
					source: 'langfuse',
					label: 'production',
					version: 12,
					schemaDriftDetected: false,
				},
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

		it('truncates text longer than 20000 characters and flags truncation metadata', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id1' });
			const longText = 'x'.repeat(25000);

			await AlertStorageService.saveAlert(buildParams({ text: longText }));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.text.length).toBe(20000);
			expect(calledWith.truncated).toBe(true);
			expect(calledWith.originalLength).toBe(25000);
		});

		it('does not flag truncation when text is within the 20000 character limit', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id1b' });
			const shortText = 'x'.repeat(15000);

			await AlertStorageService.saveAlert(buildParams({ text: shortText }));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.text.length).toBe(15000);
			expect(calledWith.truncated).toBeUndefined();
			expect(calledWith.originalLength).toBeUndefined();
		});

		it('stores empty array when deliveryResults is not an array', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'id2' });

			await AlertStorageService.saveAlert(buildParams({ deliveryResults: undefined }));

			const calledWith = mockAdd.mock.calls[0][0];
			expect(calledWith.deliveryResults).toEqual([]);
		});

		it('defaults source to "webhook" when not provided', async () => {
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
			expect(mockLimit).toHaveBeenCalledWith(100);
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
					tradingViewEnrichmentApplied: false,
				},
			]);
			expect(result.hasMore).toBe(true);
			expect(parseAlertPaginationCursor(result.nextBefore)).toEqual({
				type: 'composite',
				receivedAt: '2026-06-06T12:00:00.000Z',
				documentId: 'alert-1',
			});
		});

		it('exposes truncated flag and originalLength in /api/alerts list responses', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('expanded-truncated-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'expanded-analysis',
						text: 'x'.repeat(20000),
						truncated: true,
						originalLength: 24513,
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({ limit: 1 });

			expect(result.alerts[0]).toMatchObject({
				id: 'expanded-truncated-1',
				truncated: true,
				originalLength: 24513,
			});
			expect(result.alerts[0].text).toHaveLength(20000);
		});

		it('omits truncated flag in /api/alerts list responses when stored text fits within the cap', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('webhook-fine', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						text: 'short alert',
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({ limit: 1 });

			expect(result.alerts[0]).not.toHaveProperty('truncated');
			expect(result.alerts[0]).not.toHaveProperty('originalLength');
		});

		it('hides expired alerts and ages legacy records from receivedAt', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('expired-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
					}),
					buildQueryDoc('active-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
					}),
					buildQueryDoc('legacy-expired-alert', {
						receivedAt: buildTimestamp('2026-05-01T00:00:00.000Z'),
					}),
					buildQueryDoc('legacy-active-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({ limit: 10 });

			expect(result.alerts.map(alert => alert.id)).toEqual(['active-alert', 'legacy-active-alert']);
		});

		it('uses bounded scan batches for small retention-filtered pages', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			const expiredBatch = Array.from({ length: 100 }, (_, index) => buildQueryDoc(`expired-${index}`, {
				receivedAt: buildTimestamp('2026-08-12T12:00:00.000Z'),
				expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
			}));
			mockGet
				.mockResolvedValueOnce({ empty: false, docs: expiredBatch })
				.mockResolvedValueOnce({
					empty: false,
					docs: [buildQueryDoc('active-alert', {
						receivedAt: buildTimestamp('2026-08-12T11:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
					})],
				});

			const result = await AlertStorageService.listAlerts({ limit: 1 });

			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(result.alerts.map(alert => alert.id)).toEqual(['active-alert']);
		});

		it('keeps scanning batches until it finds enough filtered alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const mismatchBatch = Array.from({ length: 100 }, (_, index) => buildQueryDoc(`alert-${index}`, {
				receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
				text: `Mismatch ${index}`,
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				deliveryResults: [],
				source: 'webhook',
				useTradingViewData: false,
			}));
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: mismatchBatch,
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
				tradingViewEnrichmentApplied: false,
			});
		});

		it('returns requestId when present on the document', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockResolvedValueOnce(buildDocSnapshot('alert-with-req-id', {
				receivedAt: buildTimestamp('2026-06-06T10:30:00.000Z'),
				text: 'Stored alert with requestId',
				requestId: 'req-observable-123',
			}));

			const result = await AlertStorageService.getAlertById('alert-with-req-id');
			expect(result).toMatchObject({
				id: 'alert-with-req-id',
				requestId: 'req-observable-123',
			});
		});

		it('returns null for an expired alert document', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockDocGet.mockResolvedValueOnce(buildDocSnapshot('expired-alert', {
				receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
				expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
			}));

			await expect(AlertStorageService.getAlertById('expired-alert')).resolves.toBeNull();
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
				idempotencyKeyHash,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
				replayedAt: expect.anything(),
				expiresAt: expect.anything(),
				source: 'alert-replay',
			});
			expect(JSON.stringify(mockDocSet.mock.calls[0][0])).not.toContain(idempotencyKey);
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
				tradingViewEnrichmentApplied: false,
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

		it('excludes expired alerts from exports', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('expired-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
						source: 'webhook',
					}),
					buildQueryDoc('active-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-08-01T00:00:00.000Z',
				to: '2026-08-14T00:00:00.000Z',
				limit: 10,
			});

			expect(result.alerts.map(alert => alert.id)).toEqual(['active-alert']);
		});

		it('keeps paging unfiltered exports after retention filtering', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			const expiredBatch = Array.from({ length: 100 }, (_, index) => buildQueryDoc(`expired-${index}`, {
				receivedAt: buildTimestamp('2026-08-12T12:00:00.000Z'),
				expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
			}));
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: expiredBatch,
				})
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('active-first', {
							receivedAt: buildTimestamp('2026-08-12T11:00:00.000Z'),
							expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
						}),
						buildQueryDoc('active-second', {
							receivedAt: buildTimestamp('2026-08-12T10:00:00.000Z'),
							expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
						}),
					],
				});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-08-01T00:00:00.000Z',
				to: '2026-08-14T00:00:00.000Z',
				limit: 2,
			});

			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(result.alerts.map(alert => alert.id)).toEqual(['active-first', 'active-second']);
		});

		it('pages filtered exports through the full window and caps the result', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const firstPageLastTimestamp = buildTimestamp('2026-06-06T11:00:00.000Z');
			const firstPageDocs = [
				...Array.from({ length: 98 }, (_, index) => buildQueryDoc(`scanner-${index}`, {
					receivedAt: firstPageLastTimestamp,
					enriched: true,
					source: 'scanner',
				})),
				buildQueryDoc('newer-scanner', {
					receivedAt: firstPageLastTimestamp,
					enriched: true,
					source: 'scanner',
				}),
				buildQueryDoc('webhook-btc', {
					receivedAt: firstPageLastTimestamp,
					enriched: true,
					source: 'webhook',
				}),
			];
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: firstPageDocs,
				})
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('webhook-eth', {
							receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
							enriched: true,
							source: 'webhook',
						}),
						buildQueryDoc('webhook-sol', {
							receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
							enriched: true,
							source: 'webhook',
						}),
					],
				});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 2,
				source: 'webhook',
				enriched: true,
			});

			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(mockStartAfter).toHaveBeenCalledWith(firstPageLastTimestamp, 'webhook-btc');
			expect(result.alerts.map(alert => alert.id)).toEqual(['webhook-btc', 'webhook-eth']);
		});

		it('includes requestId in exported records when present on the document', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-req-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						requestId: 'trace-export-999',
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result.alerts[0]).toMatchObject({
				id: 'alert-req-1',
				requestId: 'trace-export-999',
			});
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

		it('exposes truncated flag and originalLength in export when stored text was clipped', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('expanded-truncated-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'expanded-analysis',
						text: 'x'.repeat(20000),
						truncated: true,
						originalLength: 24513,
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				includeText: true,
			});

			// Export layer additionally caps raw text at MAX_EXPORT_TEXT_LENGTH (1000) for
			// safety, but the storage-layer truncation flag and originalLength are
			// preserved so consumers can detect the 20,000-character clip.
			expect(result.alerts[0]).toMatchObject({
				id: 'expanded-truncated-1',
				truncated: true,
				originalLength: 24513,
			});
			expect(result.alerts[0].text.length).toBeLessThanOrEqual(1000);
		});

		it('omits truncated flag in export when stored text fits within the cap', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('webhook-fine', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						text: 'short alert',
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				includeText: true,
			});

			expect(result.alerts[0]).not.toHaveProperty('truncated');
			expect(result.alerts[0]).not.toHaveProperty('originalLength');
		});
	});

		describe('summarizeAlerts()', () => {
		it('counts recorded, not-applicable, and legacy unrecorded TradingView outcomes separately', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('full-alert', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						useTradingViewData: true,
						tradingViewEnrichmentStatus: 'full',
					}),
					buildQueryDoc('partial-alert', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						useTradingViewData: true,
						tradingViewEnrichmentStatus: 'partial',
					}),
					buildQueryDoc('failed-alert', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						useTradingViewData: true,
						tradingViewEnrichmentStatus: 'failed',
					}),
					buildQueryDoc('not-applicable-alert', {
						receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
						useTradingViewData: false,
					}),
					buildQueryDoc('unrecorded-alert', {
						receivedAt: buildTimestamp('2026-06-06T08:00:00.000Z'),
						useTradingViewData: true,
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(result.enrichment.tradingViewStatusCounts).toEqual({
				full: 1,
				partial: 1,
				failed: 1,
				not_applicable: 1,
				unrecorded: 1,
			});
		});

		it('preserves zero latency, accepts legacy latency, and ignores invalid values', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('zero-latency', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						processingTimeMs: 0,
						processing_time_ms: 900,
					}),
					buildQueryDoc('new-latency', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						processingTimeMs: 100,
					}),
					buildQueryDoc('legacy-latency', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						processing_time_ms: 200,
					}),
					buildQueryDoc('invalid-latency', {
						receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
						processingTimeMs: -1,
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(result.latency.averageProcessingMs).toBe(100);
		});

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
						tradingViewEnrichmentApplied: true,
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
					tradingViewDataApplied: 1,
					withoutTradingViewData: 1,
				},
				enrichment: {
					enrichedAlerts: 1,
					plainAlerts: 1,
					tradingViewStatusCounts: {
						full: 0,
						partial: 0,
						failed: 0,
						not_applicable: 1,
						unrecorded: 1,
					},
					riskMetadataCoverage: {
						denominator: 1,
						fields: {
							invalidation_level: { populated: 0, percentage: 0 },
							target_level: { populated: 0, percentage: 0 },
							setup_type: { populated: 0, percentage: 0 },
							risk_reward_ratio: { populated: 0, percentage: 0 },
						},
						byPromptProvenance: [
							{
								provenance: null,
								denominator: 1,
								fields: {
									invalidation_level: { populated: 0, percentage: 0 },
									target_level: { populated: 0, percentage: 0 },
									setup_type: { populated: 0, percentage: 0 },
									risk_reward_ratio: { populated: 0, percentage: 0 },
								},
							},
						],
					},
					evidenceCoverage: {
						denominator: 1,
						zeroSources: { populated: 1, percentage: 100 },
						oneToTwoSources: { populated: 0, percentage: 0 },
						threePlusSources: { populated: 0, percentage: 0 },
						totalSourceCount: 0,
						averageSourceCount: 0,
						byPromptProvenance: [
							{
								provenance: null,
								denominator: 1,
								zeroSources: { populated: 1, percentage: 100 },
								oneToTwoSources: { populated: 0, percentage: 0 },
								threePlusSources: { populated: 0, percentage: 0 },
								totalSourceCount: 0,
								averageSourceCount: 0,
							},
						],
					},
					tokenUsage: {
						inputTokens: 10,
						outputTokens: 20,
						totalTokens: 30,
						totalCost: 0.001,
					},
					flipRate: {
						totalAlerts: 2,
						flippedAlerts: 0,
						flipRatePercent: 0,
						byPreviousDirection: { BUY: 0, SELL: 0 },
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

		it('excludes expired alerts from summaries', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('expired-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
						source: 'webhook',
					}),
					buildQueryDoc('active-alert', {
						receivedAt: buildTimestamp('2026-08-12T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-08-01T00:00:00.000Z',
				to: '2026-08-14T00:00:00.000Z',
				limit: 10,
			});

			expect(result.totalAlerts).toBe(1);
		});

		it('keeps paging unfiltered summaries after retention filtering', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			const expiredBatch = Array.from({ length: 100 }, (_, index) => buildQueryDoc(`expired-${index}`, {
				receivedAt: buildTimestamp('2026-08-12T12:00:00.000Z'),
				expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
			}));
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: expiredBatch,
				})
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('active-first', {
							receivedAt: buildTimestamp('2026-08-12T11:00:00.000Z'),
							expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
						}),
						buildQueryDoc('active-second', {
							receivedAt: buildTimestamp('2026-08-12T10:00:00.000Z'),
							expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
						}),
					],
				});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-08-01T00:00:00.000Z',
				to: '2026-08-14T00:00:00.000Z',
				limit: 2,
			});

			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(result.totalAlerts).toBe(2);
		});

		it('applies source and enriched filters before aggregating', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('matching-alert', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						enriched: true,
						source: 'webhook',
						text: 'BINANCE:BTCUSDT',
					}),
					buildQueryDoc('wrong-source', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						enriched: true,
						source: 'scanner',
						text: 'BINANCE:ETHUSDT',
					}),
					buildQueryDoc('wrong-enrichment', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						enriched: false,
						source: 'webhook',
						text: 'BINANCE:SOLUSDT',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
				source: 'webhook',
				enriched: true,
			});

			expect(result.totalAlerts).toBe(1);
			expect(result.bySource).toEqual({ webhook: 1 });
			expect(result.bySymbol).toEqual({ BTCUSDT: 1 });
			expect(result.byFeatureFlag.enriched).toBe(1);
			expect(result.byFeatureFlag.plain).toBe(0);
		});

		it('pages through bounded alerts until filtered summaries reach the limit', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const newerTimestamp = buildTimestamp('2026-06-06T12:00:00.000Z');
			const firstPageDocs = [
				...Array.from({ length: 99 }, (_, index) => buildQueryDoc(`newer-scanner-${index}`, {
					receivedAt: newerTimestamp,
					enriched: true,
					source: 'scanner',
				})),
				buildQueryDoc('newer-scanner', {
					receivedAt: newerTimestamp,
					enriched: true,
					source: 'scanner',
				}),
			];
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: firstPageDocs,
				})
				.mockResolvedValueOnce({
					empty: false,
					docs: [buildQueryDoc('older-webhook', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						enriched: true,
						source: 'webhook',
						text: 'BINANCE:BTCUSDT',
					})],
				});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 1,
				source: 'webhook',
				enriched: true,
			});

			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(mockStartAfter).toHaveBeenCalledWith(newerTimestamp, 'newer-scanner');
			expect(result.totalAlerts).toBe(1);
			expect(result.bySource).toEqual({ webhook: 1 });
		});

		it('caps filtered summary pages at the remaining limit', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const firstPageDocs = [
				...Array.from({ length: 98 }, (_, index) => buildQueryDoc(`newer-scanner-${index}`, {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					enriched: true,
					source: 'scanner',
				})),
				buildQueryDoc('newer-scanner', {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					enriched: true,
					source: 'scanner',
				}),
				buildQueryDoc('webhook-btc', {
					receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
					enriched: true,
					source: 'webhook',
					text: 'BINANCE:BTCUSDT',
				}),
			];
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: firstPageDocs,
				})
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('webhook-eth', {
							receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
							enriched: true,
							source: 'webhook',
							text: 'BINANCE:ETHUSDT',
						}),
						buildQueryDoc('webhook-sol', {
							receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
							enriched: true,
							source: 'webhook',
							text: 'BINANCE:SOLUSDT',
						}),
					],
				});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 2,
				source: 'webhook',
				enriched: true,
			});

			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(result.totalAlerts).toBe(2);
			expect(result.bySymbol).toEqual({ BTCUSDT: 1, ETHUSDT: 1 });
		});

		it('measures risk metadata coverage by safe prompt provenance and ignores invalid values', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-langfuse', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						enriched: true,
						enrichmentData: {
							promptProvenance: {
								name: 'alert-enrichment',
								source: 'langfuse',
								label: 'production',
								version: 12,
							},
							invalidation_level: '$80,000',
							target_level: 90000,
							setup_type: 'breakout',
							risk_reward_ratio: '2:1',
						},
						source: 'webhook',
					}),
					buildQueryDoc('alert-local', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						enriched: true,
						enrichmentData: {
							promptProvenance: {
								name: 'alert-enrichment',
								source: 'local',
								label: null,
								version: null,
							},
							invalidation_level: { price: 80000 },
							target_level: '   ',
							setup_type: 'scalp',
							risk_reward_ratio: Number.NaN,
						},
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(result.enrichment.riskMetadataCoverage).toEqual({
				denominator: 2,
				fields: {
					invalidation_level: { populated: 1, percentage: 50 },
					target_level: { populated: 1, percentage: 50 },
					setup_type: { populated: 1, percentage: 50 },
					risk_reward_ratio: { populated: 1, percentage: 50 },
				},
				byPromptProvenance: [
					{
						provenance: {
							name: 'alert-enrichment',
							source: 'langfuse',
							label: 'production',
							version: 12,
							schemaDriftDetected: false,
						},
						denominator: 1,
						fields: {
							invalidation_level: { populated: 1, percentage: 100 },
							target_level: { populated: 1, percentage: 100 },
							setup_type: { populated: 1, percentage: 100 },
							risk_reward_ratio: { populated: 1, percentage: 100 },
						},
					},
					{
						provenance: {
							name: 'alert-enrichment',
							source: 'local',
							label: null,
							version: null,
							schemaDriftDetected: false,
						},
						denominator: 1,
						fields: {
							invalidation_level: { populated: 0, percentage: 0 },
							target_level: { populated: 0, percentage: 0 },
							setup_type: { populated: 0, percentage: 0 },
							risk_reward_ratio: { populated: 0, percentage: 0 },
						},
					},
				],
			});
		});

		it('aggregates evidenceCoverage across zero-, low-, and high-source enriched alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					// 0 sources (missing sources field — legacy) — counted as zeroSources
					buildQueryDoc('alert-no-sources', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						enriched: true,
						enrichmentData: { symbol: 'BTCUSDT' },
						source: 'webhook',
					}),
					// 1 source — oneToTwoSources
					buildQueryDoc('alert-one-source', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						enriched: true,
						enrichmentData: { symbol: 'ETHUSDT', sources: [{ url: 'https://a.com' }] },
						source: 'webhook',
					}),
					// 3 sources — threePlusSources
					buildQueryDoc('alert-three-sources', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						enriched: true,
						enrichmentData: {
							symbol: 'SOLUSDT',
							sources: [
								{ url: 'https://a.com' },
								{ url: 'https://b.com' },
								{ url: 'https://c.com' },
							],
						},
						source: 'webhook',
					}),
					// plain alert — must not count toward evidenceCoverage
					buildQueryDoc('alert-plain', {
						receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
						enriched: false,
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(result.enrichment.evidenceCoverage).toEqual({
				denominator: 3,
				zeroSources: { populated: 1, percentage: Number(((1 / 3) * 100).toFixed(2)) },
				oneToTwoSources: { populated: 1, percentage: Number(((1 / 3) * 100).toFixed(2)) },
				threePlusSources: { populated: 1, percentage: Number(((1 / 3) * 100).toFixed(2)) },
				totalSourceCount: 4, // 0 + 1 + 3
				averageSourceCount: Number((4 / 3).toFixed(2)),
				byPromptProvenance: [
					{
						provenance: null,
						denominator: 3,
						zeroSources: { populated: 1, percentage: Number(((1 / 3) * 100).toFixed(2)) },
						oneToTwoSources: { populated: 1, percentage: Number(((1 / 3) * 100).toFixed(2)) },
						threePlusSources: { populated: 1, percentage: Number(((1 / 3) * 100).toFixed(2)) },
						totalSourceCount: 4,
						averageSourceCount: Number((4 / 3).toFixed(2)),
					},
				],
			});
		});

		it('evidenceCoverage groups by prompt provenance and handles schema drift', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					// langfuse-sourced prompt — 3 sources
					buildQueryDoc('alert-lf', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						enriched: true,
						enrichmentData: {
							symbol: 'BTCUSDT',
							sources: ['a', 'b', 'c'],
							promptProvenance: {
								name: 'alert-enrichment',
								source: 'langfuse',
								label: 'production',
								version: 12,
							},
						},
						source: 'webhook',
					}),
					// local fallback — 0 sources
					buildQueryDoc('alert-local', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						enriched: true,
						enrichmentData: {
							symbol: 'ETHUSDT',
							sources: [],
							promptProvenance: {
								name: 'alert-enrichment',
								source: 'local',
								label: null,
								version: null,
							},
						},
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			// Top-level bucket covers both
			expect(result.enrichment.evidenceCoverage.denominator).toBe(2);
			expect(result.enrichment.evidenceCoverage.threePlusSources.populated).toBe(1);
			expect(result.enrichment.evidenceCoverage.zeroSources.populated).toBe(1);
			expect(result.enrichment.evidenceCoverage.averageSourceCount).toBe(1.5);

			// Per-provenance grouping
			const provenanceGroups = result.enrichment.evidenceCoverage.byPromptProvenance;
			expect(provenanceGroups).toHaveLength(2);

			const lfGroup = provenanceGroups.find(g => g.provenance && g.provenance.source === 'langfuse');
			expect(lfGroup.denominator).toBe(1);
			expect(lfGroup.threePlusSources.populated).toBe(1);
			expect(lfGroup.averageSourceCount).toBe(3);

			const localGroup = provenanceGroups.find(g => g.provenance && g.provenance.source === 'local');
			expect(localGroup.denominator).toBe(1);
			expect(localGroup.zeroSources.populated).toBe(1);
			expect(localGroup.averageSourceCount).toBe(0);
		});

		it('evidenceCoverage treats numeric sources field as count and is zero-safe with no enriched alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					// numeric sources field (non-array) treated as count
					buildQueryDoc('alert-numeric', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						enriched: true,
						enrichmentData: { symbol: 'BTCUSDT', sources: 5 },
						source: 'webhook',
					}),
					// non-enriched only — evidenceCoverage denominator must stay 0
					buildQueryDoc('alert-plain', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						enriched: false,
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			// numeric sources: 5 → threePlusSources
			expect(result.enrichment.evidenceCoverage.denominator).toBe(1);
			expect(result.enrichment.evidenceCoverage.threePlusSources.populated).toBe(1);
			expect(result.enrichment.evidenceCoverage.averageSourceCount).toBe(5);
		});

		it('evidenceCoverage denominator is 0 and percentages are 0 when no enriched alerts exist', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('plain-only', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						enriched: false,
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(result.enrichment.evidenceCoverage).toEqual({
				denominator: 0,
				zeroSources: { populated: 0, percentage: 0 },
				oneToTwoSources: { populated: 0, percentage: 0 },
				threePlusSources: { populated: 0, percentage: 0 },
				totalSourceCount: 0,
				averageSourceCount: 0,
				byPromptProvenance: [],
			});
		});

		it('populates bySymbol metrics from plain alert text strings when candidate object properties are missing', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'BINANCE:ETHUSDT(D) alert triggered',
						enriched: false,
						deliveryResults: [],
						source: 'webhook',
					}),
					buildQueryDoc('alert-2', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						text: 'BATS:TSM(D) cambió a señal de VENTA',
						enriched: false,
						deliveryResults: [],
						source: 'webhook',
					}),
					buildQueryDoc('alert-3', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						text: 'SPCFD:SPX(D) alert triggered',
						enriched: false,
						deliveryResults: [],
						source: 'webhook',
					}),
					buildQueryDoc('alert-4', {
						receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
						text: 'Alerta sin simbolo',
						enriched: false,
						deliveryResults: [],
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result.bySymbol).toEqual({
				ETHUSDT: 1,
				TSM: 1,
				SPX: 1,
				unknown: 1,
			});
		});

		it('aggregates flipRate from stored flipContext across alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('flip-1', {
						receivedAt: buildTimestamp('2026-08-25T20:01:00.000Z'),
						enriched: false,
						source: 'webhook',
						text: 'BINANCE:ETHUSDT(60) cambió a señal de COMPRA',
						flipContext: {
							previousDirection: 'SELL',
							previousAt: '2026-08-25T18:01:00.000Z',
							hoursDelta: 2,
						},
					}),
					buildQueryDoc('flip-2', {
						receivedAt: buildTimestamp('2026-08-25T21:01:00.000Z'),
						enriched: false,
						source: 'webhook',
						text: 'BINANCE:ETHUSDT(60) cambió a señal de VENTA',
						flipContext: {
							previousDirection: 'BUY',
							previousAt: '2026-08-25T20:01:00.000Z',
							hoursDelta: 1,
						},
					}),
					buildQueryDoc('plain', {
						receivedAt: buildTimestamp('2026-08-25T22:01:00.000Z'),
						enriched: false,
						source: 'webhook',
						text: 'BINANCE:BTCUSDT(60) cambió a señal de COMPRA',
					}),
				],
			});
			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-08-25T00:00:00.000Z',
				to: '2026-08-26T00:00:00.000Z',
				limit: 100,
			});
			expect(result.enrichment.flipRate.totalAlerts).toBe(3);
			expect(result.enrichment.flipRate.flippedAlerts).toBe(2);
			expect(result.enrichment.flipRate.flipRatePercent).toBe(66.67);
			expect(result.enrichment.flipRate.byPreviousDirection).toEqual({ BUY: 1, SELL: 1 });
		});

		it('flipRate is zero-safe when no alerts carry flipContext', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('plain-only', {
						receivedAt: buildTimestamp('2026-08-25T20:01:00.000Z'),
						enriched: false,
						source: 'webhook',
						text: 'BINANCE:BTCUSDT(60) cambió a señal de COMPRA',
					}),
				],
			});
			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-08-25T00:00:00.000Z',
				to: '2026-08-26T00:00:00.000Z',
				limit: 100,
			});
			expect(result.enrichment.flipRate).toEqual({
				totalAlerts: 1,
				flippedAlerts: 0,
				flipRatePercent: 0,
				byPreviousDirection: { BUY: 0, SELL: 0 },
			});
		});
	});

	describe('symbol extraction helpers', () => {
		describe('parseSymbolFromText()', () => {
			it('extracts symbol and exchange from deterministic TradingView alert formats', () => {
				expect(AlertStorageService.parseSymbolFromText('BINANCE:ETHUSDT(D)')).toEqual({
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
				});
				expect(AlertStorageService.parseSymbolFromText('BATS:TSM(D)')).toEqual({
					symbol: 'TSM',
					exchange: 'BATS',
				});
				expect(AlertStorageService.parseSymbolFromText('SPCFD:SPX(D)')).toEqual({
					symbol: 'SPX',
					exchange: 'SPCFD',
				});
				expect(AlertStorageService.parseSymbolFromText('BATS:TSM(D) cambió a señal de VENTA')).toEqual({
					symbol: 'TSM',
					exchange: 'BATS',
				});
				expect(AlertStorageService.parseSymbolFromText('BINANCE:BTCUSDT')).toEqual({
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
				});
				expect(AlertStorageService.parseSymbolFromText('BTCUSDT(1h)')).toEqual({
					symbol: 'BTCUSDT',
					exchange: null,
				});
			});

			it('extracts underscore-delimited exchange prefixes', () => {
				expect(AlertStorageService.parseSymbolFromText('FX_IDC:USDCLP(D) cambió a señal de VENTA')).toEqual({
					symbol: 'USDCLP',
					exchange: 'FX_IDC',
				});
			});

			it('returns null for unmatched text and safely falls back to unknown', () => {
				expect(AlertStorageService.parseSymbolFromText('Alerta de prueba sin simbolo')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText(null)).toBeNull();
			});
		});

		describe('extractSymbolAndExchange()', () => {
			it('prefers candidate object properties when available', () => {
				expect(AlertStorageService.extractSymbolAndExchange({ symbol: 'BATS:AAPL' })).toEqual({
					symbol: 'AAPL',
					exchange: 'BATS',
				});
				expect(AlertStorageService.extractSymbolAndExchange({
					enrichmentData: { symbol: 'ETHUSDT', exchange: 'BINANCE' },
				})).toEqual({
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
				});
			});

			it('parses from raw alert text when candidate object properties are absent', () => {
				expect(AlertStorageService.extractSymbolAndExchange({
					text: 'BATS:TSM(D) cambió a señal de VENTA',
				})).toEqual({
					symbol: 'TSM',
					exchange: 'BATS',
				});
			});

			it('returns unknown symbol and null exchange when no symbol pattern matches', () => {
				expect(AlertStorageService.extractSymbolAndExchange({ text: 'Not a symbol alert' })).toEqual({
					symbol: 'unknown',
					exchange: null,
				});
			});
		});
	});
});
