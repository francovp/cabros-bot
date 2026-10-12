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
const fs = require('fs');
const os = require('os');
const path = require('path');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const { parseAlertPaginationCursor } = require('../../src/services/storage/alertPaginationCursor');
const { firestoreWriteMetricsService } = require('../../src/services/storage/FirestoreWriteMetricsService');

// ── Shorthand references to mock internals ──────────────────────────────────
const {
	__mockAdd: mockAdd,
	__mockCollection: mockCollection,
	__mockGet: mockGet,
	__mockDocGet: mockDocGet,
	__mockDocSet: mockDocSet,
	__mockBatch: mockBatch,
	__mockBatchCommit: mockBatchCommit,
	__mockBatchDelete: mockBatchDelete,
	__mockBatchSet: mockBatchSet,
	__mockBatchUpdate: mockBatchUpdate,
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
		jest.useFakeTimers().setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
		admin.__resetApps();
		// Reset the Firestore db singleton between tests
		AlertStorageService._resetForTesting();
		delete process.env.ENABLE_FIRESTORE_ALERT_STORAGE;
		delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
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

		it('initializes Firestore when only ENABLE_TOKEN_COST_BUDGET is true', () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
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

		it('initializes durable storage from an authorized-user ADC file with FIREBASE_PROJECT_ID', () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.FIREBASE_PROJECT_ID = 'my-project';
			const adcFile = path.join(os.tmpdir(), `cabros-adc-${process.pid}-${Date.now()}.json`);
			fs.writeFileSync(adcFile, JSON.stringify({
				type: 'authorized_user',
				client_id: '123.apps.googleusercontent.com',
				client_secret: 'not-a-real-secret',
				refresh_token: 'not-a-real-refresh-token',
			}));
			process.env.GOOGLE_APPLICATION_CREDENTIALS = adcFile;

			try {
				const result = AlertStorageService.getFirestore();

				expect(result).not.toBeNull();
				expect(mockCert).not.toHaveBeenCalled();
				expect(mockInitializeApp).toHaveBeenCalledWith({
					credential: { type: 'application_default_credential' },
					projectId: 'my-project',
				});
			} finally {
				fs.unlinkSync(adcFile);
				delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
			}
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

		it('records a failed alert write when Firestore initialization is unavailable', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockInitializeApp.mockImplementationOnce(() => {
				throw new Error('Bad credentials');
			});
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			await expect(AlertStorageService.saveAlert({
				text: 'BTC above 100k',
				enriched: false,
				enrichmentData: null,
				tokenUsage: null,
				channels: ['telegram'],
				deliveryResults: [],
				useTradingViewData: false,
			})).resolves.toBeNull();

			expect(firestoreWriteMetricsService.getSnapshot()).toMatchObject({
				writesAttempted: 1,
				writesSucceeded: 0,
				writesFailed: 1,
				byDomain: { alerts: { failure: 1 } },
			});
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
				text: 'BINANCE:ETHUSDT(4h) breakout',
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
				text: 'BINANCE:ETHUSDT(4h) breakout',
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				signalClass: 'unknown',
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

		// Regression (issue #222): symbol must be captured at WRITE time so stored
		// alerts are indexed by symbol instead of falling back to `unknown`.
		it('captures the symbol at write time from plain alert text', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'doc-symbol-write' });

			await AlertStorageService.saveAlert(buildParams({
				text: 'BINANCE:ETHUSDT(D) cambió a señal de VENTA',
			}));

			expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
			}));
		});

		// Regression (issue #222): "53" reached bySymbol in production analytics.
		it('rejects non-ASCII digits and astral characters as symbols', () => {
		// `\d` is ASCII-only, so Arabic-Indic / fullwidth digits used to pass the
		// numeric guard and become symbols - the exact bug class it exists to stop.
			expect(AlertStorageService.extractSymbolAndExchange({ symbol: '٥٣' }).symbol).toBe('unknown');
			expect(AlertStorageService.extractSymbolAndExchange({ symbol: '５３' }).symbol).toBe('unknown');
			// A single astral character counts as 2 UTF-16 units, so a length check
			// alone would admit it as a "2 character" symbol.
			expect(AlertStorageService.extractSymbolAndExchange({ symbol: '𝔅' }).symbol).toBe('unknown');
		});

		it('does not extract uppercase prose words that merely end in a crypto suffix', () => {
		// deriveAssetContext matches on crypto SUFFIXES. A plausible-looking fake
		// ticker is worse than `unknown` because it silently corrupts bySymbol.
			for (const text of [
				'AEROSOL prices rose after the announcement',
				'PARASOL broke out to new highs',
				'CARETH broke resistance',
				'CoinDesk says BTC dominance rising',
			]) {
				expect(AlertStorageService.extractSymbolAndExchange({ text }).symbol).toBe('unknown');
			}
		});

		it('does not fabricate an exchange for alerts that named no venue', () => {
		// deriveAssetContext synthesises "BINANCE" for any USDT pair; persisting that
		// would attribute an alert to a venue that was never stated.
			const parsed = AlertStorageService.extractSymbolAndExchange({ text: 'ETHUSDT(1h) BUY' });
			expect(parsed.exchange).toBeNull();

			// A real venue prefix is still captured.
			const explicit = AlertStorageService.extractSymbolAndExchange({ text: 'BINANCE:ETHUSDT(4h)' });
			expect(explicit).toEqual({ symbol: 'ETHUSDT', exchange: 'BINANCE' });
		});

		it('never persists a numeric-only or single-character symbol at write time', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'doc-numeric' });

			await AlertStorageService.saveAlert(buildParams({
				text: 'Momentum shifted after 53 candles on the higher timeframe',
				symbol: '53',
				exchange: 'NASDAQ',
			}));

			const document = mockAdd.mock.calls[0][0];
			expect(document.symbol).toBeUndefined();
			expect(document.exchange).toBeUndefined();
		});

		it('still persists the alert when extraction is not possible', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockAdd.mockResolvedValueOnce({ id: 'doc-unknown' });

			const result = await AlertStorageService.saveAlert(buildParams({
				text: 'Alerta sin simbolo reconocible',
			}));

			expect(result).toBe('doc-unknown');
			const document = mockAdd.mock.calls[0][0];
			expect(document.text).toBe('Alerta sin simbolo reconocible');
			expect(document.symbol).toBeUndefined();
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
				signalClass: 'unknown',
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

		it('persists signalClass when provided and valid', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const docId = 'signal-class-doc';
			mockAdd.mockResolvedValueOnce({ id: docId });

			const params = buildParams({
				text: 'BTCUSDT breakout confirmed',
				signalClass: 'breakout',
			});

			const result = await AlertStorageService.saveAlert(params);

			expect(result).toBe(docId);
			expect(mockAdd).toHaveBeenCalledWith(expect.objectContaining({
				signalClass: 'breakout',
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

		describe('current_price, price_currency, and deterministic R:R (GH-599)', () => {
			function captureSaveCall() {
				return mockAdd.mock.calls[mockAdd.mock.calls.length - 1][0];
			}

			it('persists current_price and price_currency from enrichmentData', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-price' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					enrichmentData: {
						current_price: 64863.03,
						price_currency: 'USD',
						sentiment: 'BULLISH',
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData).toEqual(expect.objectContaining({
					current_price: 64863.03,
					price_currency: 'USD',
				}));
			});

			it('strips invalid current_price values during sanitization', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-bad-price' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					enrichmentData: {
						current_price: -100,
						price_currency: 'USD',
						sentiment: 'BULLISH',
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData).not.toHaveProperty('current_price');
				expect(doc.enrichmentData).not.toHaveProperty('price_currency');
			});

			it('strips an invalid price_currency without dropping the underlying price', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-bad-currency' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					enrichmentData: {
						current_price: 50000,
						price_currency: 'us dollars',
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData.current_price).toBe(50000);
				expect(doc.enrichmentData).not.toHaveProperty('price_currency');
			});

			it('computes risk_reward_ratio deterministically for a BUY signal when entry/invalidation/target are present', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-buy' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					side: 'BUY',
					enrichmentData: {
						current_price: 100,
						invalidation_level: 90,
						target_level: 130,
						sentiment: 'BULLISH',
					},
				}));

				const doc = captureSaveCall();
				// (target - entry) / (entry - invalidation) = (130 - 100) / (100 - 90) = 30 / 10 = 3.0
				expect(doc.enrichmentData.risk_reward_ratio).toBe(3);
				expect(doc.enrichmentData.risk_reward_ratio_source).toBe('computed');
			});

			it('computes risk_reward_ratio directionally for a SELL signal', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-sell' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					side: 'SELL',
					enrichmentData: {
						current_price: 100,
						invalidation_level: 120,
						target_level: 70,
						sentiment: 'BEARISH',
					},
				}));

				const doc = captureSaveCall();
				// (entry - target) / (invalidation - entry) = (100 - 70) / (120 - 100) = 30 / 20 = 1.5
				expect(doc.enrichmentData.risk_reward_ratio).toBe(1.5);
				expect(doc.enrichmentData.risk_reward_ratio_source).toBe('computed');
			});

			it.each([0, -2])('recomputes a non-positive numeric ratio %s', async (ratio) => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-invalid-ratio' });
				await AlertStorageService.saveAlert(buildParams({
					enriched: true, side: 'BUY',
					enrichmentData: { current_price: 100, invalidation_level: 90, target_level: 130, risk_reward_ratio: ratio },
				}));
				expect(captureSaveCall().enrichmentData).toMatchObject({ risk_reward_ratio: 3, risk_reward_ratio_source: 'computed' });
			});

			// A real ratio below 5e-5 rounds to 0 at the 4-decimal readability limit. `0` fails the
			// `existingIsValid` test, so persisting it would mean re-deriving on every read and
			// counting a zero as populated coverage — indistinguishable from a genuine 0.0
			// grade. Such a ratio is not actionable either, so it is dropped rather than stored.
			it('does not persist a ratio that rounding would collapse to zero', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-subprecision' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true, side: 'BUY',
					enrichmentData: { current_price: 100, invalidation_level: 50, target_level: 100.0001 },
				}));

				const doc = captureSaveCall().enrichmentData;
				// True R:R = 0.0001 / 50 = 2e-6, which `toFixed(4)` renders as 0.
				expect(doc.risk_reward_ratio).toBeUndefined();
				expect(doc.risk_reward_ratio_source).toBeUndefined();
				// The entry and levels the ratio was derived from are still preserved.
				expect(doc.current_price).toBe(100);
				expect(doc.invalidation_level).toBe(50);
			});

			it('does not overwrite an existing valid risk_reward_ratio from the model', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-preserve' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					side: 'BUY',
					enrichmentData: {
						current_price: 100,
						invalidation_level: 90,
						target_level: 130,
						risk_reward_ratio: 2.5,
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData.risk_reward_ratio).toBe(2.5);
				expect(doc.enrichmentData).not.toHaveProperty('risk_reward_ratio_source');
			});

			it('computes R:R from currency-formatted risk levels', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-formatted' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					side: 'BUY',
					enrichmentData: {
						current_price: 85000,
						invalidation_level: '$80,000',
						target_level: '$90,000',
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData.risk_reward_ratio).toBe(1);
				expect(doc.enrichmentData.risk_reward_ratio_source).toBe('computed');
			});

			it('preserves a non-empty string risk_reward_ratio from the model', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-string' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					side: 'BUY',
					enrichmentData: {
						current_price: 100,
						invalidation_level: 90,
						target_level: 130,
						risk_reward_ratio: '2.5:1',
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData.risk_reward_ratio).toBe('2.5:1');
				expect(doc.enrichmentData).not.toHaveProperty('risk_reward_ratio_source');
			});

			it('does not compute R:R when entry is missing', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-no-entry' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					side: 'BUY',
					enrichmentData: {
						invalidation_level: 90,
						target_level: 130,
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData).not.toHaveProperty('risk_reward_ratio');
				expect(doc.enrichmentData).not.toHaveProperty('risk_reward_ratio_source');
			});

			it('does not compute R:R when the side is missing for a valid BUY/SELL pair', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockAdd.mockResolvedValueOnce({ id: 'gh599-rr-no-side' });

				await AlertStorageService.saveAlert(buildParams({
					enriched: true,
					enrichmentData: {
						current_price: 100,
						invalidation_level: 90,
						target_level: 130,
					},
				}));

				const doc = captureSaveCall();
				expect(doc.enrichmentData).not.toHaveProperty('risk_reward_ratio');
				expect(doc.enrichmentData).not.toHaveProperty('risk_reward_ratio_source');
			});
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
						text: 'BINANCE:BTCUSDT(1h) alert',
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
					text: 'BINANCE:BTCUSDT(1h) alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					signalClass: 'unknown',
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

		it('projects sanitized enrichmentData and enrichmentSummary when include=enrichment_summary is requested', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-enriched-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'BTC breakout',
						enriched: true,
						enrichmentData: {
							sentiment: '  BULLISH  ',
							sentiment_score: 0.85,
							setup_type: 'breakout',
							invalidation_level: 64200,
							target_level: 68500,
							risk_reward_ratio: 2.5,
							sources: [
								'https://coindesk.com/article/1',
								{ url: 'https://cointelegraph.com/news/2' },
								'invalid-url',
							],
							tradingViewEnrichmentApplied: true,
							tradingViewEnrichmentStatus: 'full',
							promptProvenance: {
								name: 'crypto-sentiment',
								source: 'langfuse',
								label: 'production',
								version: 2,
								secretToken: 'do-not-leak',
							},
							internalSecret: 'sensitive-gemini-key',
							rawAnalysis: 'unbounded raw text',
						},
						channels: ['telegram'],
						deliveryResults: [{ channel: 'telegram', success: true }],
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({
				limit: 1,
				include: ['enrichment_summary'],
			});

			expect(result.alerts).toHaveLength(1);
			const alert = result.alerts[0];

			const expectedProjection = {
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				setup_type: 'breakout',
				invalidation_level: 64200,
				target_level: 68500,
				risk_reward_ratio: 2.5,
				sourceCount: 3,
				sourceDomains: ['coindesk.com', 'cointelegraph.com'],
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				promptProvenance: {
					name: 'crypto-sentiment',
					source: 'langfuse',
					label: 'production',
					version: 2,
					schemaDriftDetected: false,
				},
			};

			expect(alert.enrichmentData).toEqual(expectedProjection);
			expect(alert.enrichmentSummary).toEqual(expectedProjection);
			expect(alert.enrichmentData).not.toHaveProperty('internalSecret');
			expect(alert.enrichmentData).not.toHaveProperty('rawAnalysis');
			expect(alert.enrichmentData.promptProvenance).not.toHaveProperty('secretToken');
		});

		it('returns null enrichment projection for unenriched alerts when include=enrichment_summary is requested', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-plain-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'Plain alert',
						enriched: false,
						enrichmentData: null,
						channels: ['telegram'],
						deliveryResults: [{ channel: 'telegram', success: true }],
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({
				limit: 1,
				includeEnrichmentSummary: true,
			});

			expect(result.alerts).toHaveLength(1);
			expect(result.alerts[0].enrichmentData).toBeNull();
			expect(result.alerts[0].enrichmentSummary).toBeNull();
		});

		it('preserves raw doc enrichmentData and omits enrichmentSummary when include is not requested', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-raw-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'Alert with raw enrichment',
						enriched: true,
						enrichmentData: {
							customField: 'unmodified-payload',
						},
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({ limit: 1 });
			expect(result.alerts[0].enrichmentData).toEqual({
				customField: 'unmodified-payload',
			});
			expect(result.alerts[0]).not.toHaveProperty('enrichmentSummary');
		});

		it('hides expired alerts, ages legacy records, and preserves archived records', async () => {
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
					buildQueryDoc('archived-alert', {
						receivedAt: buildTimestamp('2025-01-01T00:00:00.000Z'),
						expiresAt: buildTimestamp('2025-02-01T00:00:00.000Z'),
						retentionPolicy: 'archive',
					}),
				],
			});

			const result = await AlertStorageService.listAlerts({ limit: 10 });

			expect(result.alerts.map(alert => alert.id)).toEqual(['active-alert', 'legacy-active-alert', 'archived-alert']);
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

		it('filters alerts by symbol, eventCategory, and exchange individually and in combination', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const sampleDocs = [
				buildQueryDoc('alert-btc-binance-surge', {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					text: 'BTC surge alert',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					eventCategory: 'price_surge',
					source: 'webhook',
				}),
				buildQueryDoc('alert-eth-binance-surge', {
					receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
					text: 'ETH surge alert',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					eventCategory: 'price_surge',
					source: 'webhook',
				}),
				buildQueryDoc('alert-btc-coinbase-whale', {
					receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
					text: 'BTC whale alert',
					symbol: 'BTCUSDT',
					exchange: 'COINBASE',
					eventCategory: 'whale_movement',
					source: 'webhook',
				}),
				buildQueryDoc('alert-sol-binance-whale', {
					receivedAt: buildTimestamp('2026-06-06T09:00:00.000Z'),
					text: 'SOL whale alert',
					symbol: 'SOLUSDT',
					exchange: 'BINANCE',
					eventCategory: 'whale_movement',
					source: 'webhook',
				}),
			];

			// 1. Filter by symbol (case-insensitive)
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const bySymbol = await AlertStorageService.listAlerts({ limit: 10, symbol: 'btcusdt' });
			expect(bySymbol.alerts.map(a => a.id)).toEqual(['alert-btc-binance-surge', 'alert-btc-coinbase-whale']);

			// 2. Filter by symbol with exchange prefix
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byPrefixedSymbol = await AlertStorageService.listAlerts({ limit: 10, symbol: 'BINANCE:BTCUSDT' });
			expect(byPrefixedSymbol.alerts.map(a => a.id)).toEqual(['alert-btc-binance-surge']);

			// 3. Filter by exchange (case-insensitive)
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byExchange = await AlertStorageService.listAlerts({ limit: 10, exchange: 'coinbase' });
			expect(byExchange.alerts.map(a => a.id)).toEqual(['alert-btc-coinbase-whale']);

			// 4. Filter by eventCategory (case-insensitive)
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byCategory = await AlertStorageService.listAlerts({ limit: 10, eventCategory: 'PRICE_SURGE' });
			expect(byCategory.alerts.map(a => a.id)).toEqual(['alert-btc-binance-surge', 'alert-eth-binance-surge']);

			// 5. Combined filters
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const combined = await AlertStorageService.listAlerts({
				limit: 10,
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				eventCategory: 'price_surge',
			});
			expect(combined.alerts.map(a => a.id)).toEqual(['alert-btc-binance-surge']);
		});

		it('filters alerts by signalClass individually and with comma-separated multi-values', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const sampleDocs = [
				buildQueryDoc('alert-breakout', {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					text: 'Breakout alert',
					signalClass: 'breakout',
					source: 'webhook',
				}),
				buildQueryDoc('alert-reversal', {
					receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
					text: 'Reversal alert',
					signalClass: 'reversal',
					source: 'webhook',
				}),
				buildQueryDoc('alert-unknown-legacy', {
					receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
					text: 'Legacy alert without signalClass',
					source: 'webhook',
				}),
			];

			// Single value
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const bySingle = await AlertStorageService.listAlerts({ limit: 10, signalClass: 'breakout' });
			expect(bySingle.alerts.map(a => a.id)).toEqual(['alert-breakout']);

			// Comma-separated multi-value
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byMulti = await AlertStorageService.listAlerts({ limit: 10, signalClass: 'breakout,reversal' });
			expect(byMulti.alerts.map(a => a.id)).toEqual(['alert-breakout', 'alert-reversal']);

			// Legacy alert matches 'unknown'
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byUnknown = await AlertStorageService.listAlerts({ limit: 10, signalClass: 'unknown' });
			expect(byUnknown.alerts.map(a => a.id)).toEqual(['alert-unknown-legacy']);
		});

		it('filters list by eventCategory from nested enrichmentData.event_category and populates eventCategory on formatted output', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			const sampleDocs = [
				buildQueryDoc('alert-nested-cat', {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					text: 'BTC breakout',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					enrichmentData: {
						event_category: 'price_surge',
					},
					source: 'webhook',
				}),
				buildQueryDoc('alert-other-cat', {
					receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
					text: 'ETH news',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					enrichmentData: {
						event_category: 'regulatory',
					},
					source: 'webhook',
				}),
			];

			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const result = await AlertStorageService.listAlerts({ limit: 10, eventCategory: 'price_surge' });
			expect(result.alerts).toHaveLength(1);
			expect(result.alerts[0].id).toBe('alert-nested-cat');
			expect(result.alerts[0].eventCategory).toBe('price_surge');
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

		describe('current_price read fields (GH-599)', () => {
			it('surfaces currentPrice and priceCurrency on stored enriched alerts', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: [buildQueryDoc('gh599-read', {
						receivedAt: buildTimestamp('2026-08-25T12:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-23T12:00:00.000Z'),
						text: 'ETHUSDT pasó a señal de COMPRA',
						enriched: true,
						enrichmentData: {
							current_price: 3240.51,
							price_currency: 'USDT',
						},
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: false,
						tradingViewEnrichmentApplied: false,
					})],
				});

				const result = await AlertStorageService.listAlerts({ limit: 1 });
				expect(result.alerts[0].currentPrice).toBe(3240.51);
				expect(result.alerts[0].priceCurrency).toBe('USDT');
			});

			it('omits the read fields when stored price is missing or invalid', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: [buildQueryDoc('gh599-read-bad', {
						receivedAt: buildTimestamp('2026-08-25T12:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-23T12:00:00.000Z'),
						text: 'ETHUSDT pasó a señal de COMPRA',
						enriched: true,
						enrichmentData: {
							current_price: -10,
							price_currency: 'us dollars',
						},
						tokenUsage: null,
						deliveryResults: [],
						source: 'webhook',
						useTradingViewData: false,
						tradingViewEnrichmentApplied: false,
					})],
				});

				const result = await AlertStorageService.listAlerts({ limit: 1 });
				expect(result.alerts[0]).not.toHaveProperty('currentPrice');
				expect(result.alerts[0]).not.toHaveProperty('priceCurrency');
			});
		});

		// ── Issue #1285 ──────────────────────────────────────────────────────
		// Production returned 503 on every read endpoint while writes succeeded
		// 29/29. `listCollections()` and write/init success both reported the
		// dependency healthy, and the response message blamed credentials that
		// were demonstrably working. The suite below pins the four fixes.

		it('declares the composite Firestore index required by the ordered alerts read', () => {
			const fs = require('fs');
			const path = require('path');
			const indexes = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../firestore.indexes.json'), 'utf8'));
			// Firestore applies a *free* final `__name__` ASC sort, so ordering by
			// `__name__` DESC on top of `receivedAt` DESC needs this composite. The
			// mock makes `orderBy` a no-op, so only this declaration can catch a
			// missing index.
			const alertIndex = indexes.indexes.find(index => index.collectionGroup === 'alerts'
				&& index.fields.some(field => field.fieldPath === 'receivedAt' && field.order === 'DESCENDING')
				&& index.fields.some(field => field.fieldPath === '__name__' && field.order === 'DESCENDING'));

			expect(alertIndex).toBeDefined();
		});

		it('classifies a rejected query as failed_precondition and flags the missing index', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const missingIndexError = new Error(
				'9 FAILED_PRECONDITION: The query requires an index. You can create an index here: '
				+ 'https://console.firebase.google.com/project/cabros-bot/databases/(default)/indexes',
			);
			missingIndexError.code = 9;
			mockGet.mockRejectedValueOnce(missingIndexError);

			const error = await AlertStorageService.listAlerts({ limit: 10 }).catch(err => err);

			expect(error).toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
				category: 'failed_precondition',
				missingIndex: true,
			});
		});

		it('no longer blames credentials when the client initialized but the query was rejected', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const denied = new Error('7 PERMISSION_DENIED: Missing or insufficient permissions.');
			denied.code = 7;
			mockGet.mockRejectedValueOnce(denied);

			const error = await AlertStorageService.listAlerts({ limit: 10 }).catch(err => err);

			expect(error.message).not.toMatch(/Check Firestore credentials and project configuration/);
			expect(error.message).toContain('permission denied');
		});

		it('still blames credentials when the client itself failed to initialize', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockInitializeApp.mockImplementationOnce(() => {
				throw new Error('Bad credentials');
			});

			const error = await AlertStorageService.listAlerts({ limit: 10 }).catch(err => err);

			expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE', category: 'uninitialized' });
			expect(error.message).toContain('Check Firestore credentials and project configuration');
		});

		it('records the read failure so status can report the read path as degraded', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const denied = new Error('7 PERMISSION_DENIED');
			denied.code = 7;
			mockGet.mockRejectedValueOnce(denied);

			await expect(AlertStorageService.listAlerts({ limit: 10 })).rejects.toThrow();

			const snapshot = firestoreWriteMetricsService.getReadSnapshot();
			expect(snapshot).toMatchObject({
				readsAttempted: 1,
				readsFailed: 1,
				readHealth: 'degraded',
				lastErrorCategory: 'permission_denied',
			});
		});
	});

	describe('probeOrderedAlertRead()', () => {
		it('returns null without querying when alert storage is disabled', async () => {
			await expect(AlertStorageService.probeOrderedAlertRead()).resolves.toBeNull();
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('runs the same ordered shape listAlerts uses so a missing index surfaces', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

			await expect(AlertStorageService.probeOrderedAlertRead()).resolves.toBe(true);

			expect(mockOrderBy).toHaveBeenCalledWith('receivedAt', 'desc');
			expect(mockOrderBy).toHaveBeenCalledWith(mockDocumentId(), 'desc');
			expect(mockLimit).toHaveBeenCalledWith(1);
		});

		it('surfaces the storage error when the indexed read is rejected', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const missingIndexError = new Error('9 FAILED_PRECONDITION: The query requires an index.');
			missingIndexError.code = 9;
			mockGet.mockRejectedValueOnce(missingIndexError);

			await expect(AlertStorageService.probeOrderedAlertRead()).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
				missingIndex: true,

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
				signalClass: 'unknown',
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
		it('stores replay attempts using a hashed idempotency key plus a unique attempt suffix', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const idempotencyKey = 'replay/key-1';
			const idempotencyKeyHash = crypto.createHash('sha256').update(idempotencyKey).digest('hex');

			const result = await AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
			});

			expect(result).toMatch(/^alert-123_[a-f0-9]{64}_[0-9]+_[0-9a-f-]{36}$/);
			expect(result.startsWith(`alert-123_${idempotencyKeyHash}_`)).toBe(true);
			expect(mockCollection).toHaveBeenCalledWith('alertReplays');
			const document = mockDocSet.mock.calls[0][0];
			expect(document.alertId).toBe('alert-123');
			expect(document.idempotencyKeyHash).toBe(idempotencyKeyHash);
			expect(document.channels).toEqual(['telegram']);
			expect(document.deliveryResults).toEqual([{ channel: 'telegram', success: true }]);
			expect(document.replayedAt).toBeDefined();
			expect(document.expiresAt).toBeDefined();
			expect(document.source).toBe('alert-replay');
			expect(typeof document.attemptId).toBe('string');
			expect(JSON.stringify(document)).not.toContain(idempotencyKey);
		});

		it('produces a unique document ID for repeated calls with the same idempotency key', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const idempotencyKey = 'replay-key-shared';

			const first = await AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
			});
			const second = await AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey,
				channels: ['whatsapp'],
				deliveryResults: [{ channel: 'whatsapp', success: false }],
			});

			expect(first).not.toEqual(second);
			expect(mockDocSet).toHaveBeenCalledTimes(2);
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

		it('persists reEnriched flag and sanitized enrichmentData when provided', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const idempotencyKey = 'replay/key-enrich';
			const enrichmentData = {
				current_price: 65000,
				setup_type: 'breakout',
				unsupportedUndefined: undefined,
			};

			const result = await AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey,
				channels: ['telegram'],
				deliveryResults: [{ channel: 'telegram', success: true }],
				reEnriched: true,
				enrichmentData,
			});

			expect(result).toBeDefined();
			const document = mockDocSet.mock.calls[0][0];
			expect(document.reEnriched).toBe(true);
			expect(document.enrichmentData).toEqual({
				current_price: 65000,
				setup_type: 'breakout',
			});
			expect(document.enrichmentData).not.toHaveProperty('unsupportedUndefined');
		});

		it('records a failed replay write when Firestore initialization is unavailable', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockInitializeApp.mockImplementationOnce(() => {
				throw new Error('Bad credentials');
			});
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			await expect(AlertStorageService.saveReplayAttempt({
				alertId: 'alert-123',
				idempotencyKey: 'replay-key-init-failure',
				channels: ['telegram'],
				deliveryResults: [],
			})).rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });

			expect(firestoreWriteMetricsService.getSnapshot()).toMatchObject({
				writesAttempted: 1,
				writesSucceeded: 0,
				writesFailed: 1,
				byDomain: { alertReplays: { failure: 1 } },
			});
			warnSpy.mockRestore();
		});
	});


	describe('listReplayAttempts()', () => {
		it('returns null when alert storage is disabled', async () => {
			const result = await AlertStorageService.listReplayAttempts({ limit: 5 });
			expect(result).toBeNull();
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('lists replay attempts with safe fields and pagination metadata', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1_hash_ts_uuid', {
						alertId: 'alert-1',
						idempotencyKeyHash: 'abcdef0123456789',
						attemptId: 'ts_uuid',
						channels: ['telegram'],
						deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
						replayedAt: buildTimestamp('2026-06-06T12:34:56.000Z'),
					}),
					buildQueryDoc('alert-2_hash_ts_uuid', {
						alertId: 'alert-2',
						idempotencyKeyHash: '0123456789abcdef',
						attemptId: 'ts_uuid',
						channels: ['whatsapp'],
						deliveryResults: [{ channel: 'whatsapp', success: false, errorCode: 'TIMEOUT', statusCode: 504 }],
						replayedAt: buildTimestamp('2026-06-06T11:34:56.000Z'),
					}),
				],
			});

			const result = await AlertStorageService.listReplayAttempts({ limit: 1 });

			expect(mockCollection).toHaveBeenCalledWith('alertReplays');
			expect(mockOrderBy).toHaveBeenNthCalledWith(1, 'replayedAt', 'desc');
			expect(mockOrderBy).toHaveBeenNthCalledWith(2, '__name__', 'desc');
			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(result.replays).toEqual([
				{
					id: 'ts_uuid',
					alertId: 'alert-1',
					idempotencyKeyHashPrefix: 'abcdef012345',
					channels: ['telegram'],
					deliverySummary: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
					replayedAt: '2026-06-06T12:34:56.000Z',
					attemptId: 'ts_uuid',
				},
			]);
			expect(result.hasMore).toBe(true);
			expect(parseAlertPaginationCursor(result.nextBefore)).toMatchObject({
				type: 'composite',
				receivedAt: '2026-06-06T12:34:56.000Z',
				documentId: 'alert-1_hash_ts_uuid',
			});
		});

		it('does not expose the internal replay document ID', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [buildQueryDoc('alert-1_full-hash_1700000000000_uuid', {
					alertId: 'alert-1',
					idempotencyKeyHash: 'abcdef0123456789',
					attemptId: '1700000000000_uuid',
					channels: ['telegram'],
					replayedAt: buildTimestamp('2026-06-06T12:34:56.000Z'),
				})],
			});

			const result = await AlertStorageService.listReplayAttempts({ limit: 10 });

			expect(result.replays[0].id).toBe('1700000000000_uuid');
			expect(result.replays[0].id).not.toContain('full-hash');
		});

		it('includes reEnriched and enrichmentData in formatted replay document when present', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1_hash_ts_uuid', {
						alertId: 'alert-1',
						idempotencyKeyHash: 'test-hash-prefix',
						attemptId: 'ts_uuid',
						channels: ['telegram'],
						deliveryResults: [{ channel: 'telegram', success: true, messageId: 'tg-1' }],
						replayedAt: buildTimestamp('2026-06-06T12:34:56.000Z'),
						reEnriched: true,
						enrichmentData: { current_price: 65000 },
					}),
				],
			});

			const result = await AlertStorageService.listReplayAttempts({ limit: 1 });
			expect(result.replays[0].reEnriched).toBe(true);
			expect(result.replays[0].enrichmentData).toEqual({ current_price: 65000 });
		});

		it('applies the composite before cursor to the Firestore query', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const before = require('../../src/services/storage/alertPaginationCursor').encodeAlertPaginationCursor({
				receivedAt: '2026-06-06T12:34:56.000Z',
				id: 'alert-1_hash_ts_uuid',
			});
			mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

			await AlertStorageService.listReplayAttempts({ limit: 10, before });

			expect(mockStartAfter).toHaveBeenCalledWith(expect.anything(), 'alert-1_hash_ts_uuid');
		});

		it('continues scanning after filtering expired replay records', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			const expiredBatch = Array.from({ length: 100 }, (_, index) => buildQueryDoc(`expired-${index}`, {
				replayedAt: buildTimestamp('2026-08-12T12:00:00.000Z'),
				expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
			}));
			mockGet
				.mockResolvedValueOnce({ empty: false, docs: expiredBatch })
				.mockResolvedValueOnce({
					empty: false,
					docs: [buildQueryDoc('active-replay', {
						alertId: 'alert-1',
						attemptId: 'active-replay',
						replayedAt: buildTimestamp('2026-08-12T11:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
					})],
				});

			const result = await AlertStorageService.listReplayAttempts({ limit: 1 });

			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(result.replays.map(replay => replay.id)).toEqual(['active-replay']);
		});

		it('preserves Firestore timestamp precision in replay cursors', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const newerTimestamp = Object.assign(buildTimestamp('2026-06-06T12:34:56.000Z'), {
				seconds: 1780749296,
				nanoseconds: 900000001,
			});
			const olderTimestamp = Object.assign(buildTimestamp('2026-06-06T12:34:56.000Z'), {
				seconds: 1780749296,
				nanoseconds: 900000000,
			});
			mockGet
				.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('newer-replay', { attemptId: 'newer', replayedAt: newerTimestamp }),
						buildQueryDoc('older-replay', { attemptId: 'older', replayedAt: olderTimestamp }),
					],
				})
				.mockResolvedValueOnce({ empty: true, docs: [] });

			const firstPage = await AlertStorageService.listReplayAttempts({ limit: 1 });
			const parsedCursor = parseAlertPaginationCursor(firstPage.nextBefore);
			expect(parsedCursor.timestamp).toEqual({ seconds: 1780749296, nanoseconds: 900000001 });

			mockStartAfter.mockClear();
			await AlertStorageService.listReplayAttempts({ limit: 1, before: firstPage.nextBefore });

			expect(mockStartAfter).toHaveBeenCalledWith(
				expect.objectContaining({ seconds: 1780749296, nanoseconds: 900000001 }),
				'newer-replay',
			);
		});

		it('filters by alertId when provided', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

			await AlertStorageService.listReplayAttempts({ alertId: 'alert-42', limit: 10 });

			expect(mockWhere).toHaveBeenCalledWith('alertId', '==', 'alert-42');
			expect(mockCollection).toHaveBeenCalledWith('alertReplays');
		});

		it('throws STORAGE_UNAVAILABLE when listing replays fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockRejectedValueOnce(new Error('permission denied'));

			await expect(AlertStorageService.listReplayAttempts({ limit: 5 })).rejects.toMatchObject({
				code: 'STORAGE_UNAVAILABLE',
			});
		});

		it('returns empty list when the snapshot is empty', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

			const result = await AlertStorageService.listReplayAttempts({ limit: 5 });

			expect(result).toEqual({ replays: [], hasMore: false, nextBefore: null });
		});
	});

	describe('getLatestReplayForAlert()', () => {
		it('declares the composite Firestore index required by alert-scoped replay reads', () => {
			const fs = require('fs');
			const path = require('path');
			const indexes = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../firestore.indexes.json'), 'utf8'));
			const replayIndex = indexes.indexes.find(index => index.collectionGroup === 'alertReplays'
				&& index.fields.some(field => field.fieldPath === 'alertId' && field.order === 'ASCENDING')
				&& index.fields.some(field => field.fieldPath === 'replayedAt' && field.order === 'DESCENDING')
				&& index.fields.some(field => field.fieldPath === '__name__' && field.order === 'DESCENDING'));

			expect(replayIndex).toBeDefined();
		});
		it('returns null when alert storage is disabled', async () => {
			const result = await AlertStorageService.getLatestReplayForAlert('alert-1');
			expect(result).toBeNull();
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('returns null when alertId is missing or blank', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			expect(await AlertStorageService.getLatestReplayForAlert('')).toBeNull();
			expect(await AlertStorageService.getLatestReplayForAlert('   ')).toBeNull();
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('returns the formatted latest replay for an alert', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1_hash_ts_uuid', {
						alertId: 'alert-1',
						idempotencyKeyHash: 'abcdef0123456789',
						attemptId: 'ts_uuid',
						channels: ['telegram'],
						deliveryResults: [{ channel: 'telegram', success: true }],
						replayedAt: buildTimestamp('2026-06-06T12:34:56.000Z'),
					}),
				],
			});

			const result = await AlertStorageService.getLatestReplayForAlert('alert-1');

			expect(mockWhere).toHaveBeenCalledWith('alertId', '==', 'alert-1');
			expect(mockLimit).toHaveBeenCalledWith(100);
			expect(result).toEqual({
				id: 'ts_uuid',
				alertId: 'alert-1',
				idempotencyKeyHashPrefix: 'abcdef012345',
				channels: ['telegram'],
				deliverySummary: [{ channel: 'telegram', success: true }],
				replayedAt: '2026-06-06T12:34:56.000Z',
				attemptId: 'ts_uuid',
			});
		});

		it('continues scanning after the newest replay expires', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			const expiredBatch = Array.from({ length: 100 }, (_, index) => buildQueryDoc(`expired-${index}`, {
				alertId: 'alert-1',
				attemptId: `expired-${index}`,
				replayedAt: buildTimestamp('2026-08-12T12:00:00.000Z'),
				expiresAt: buildTimestamp('2026-08-12T23:59:59.000Z'),
			}));
			mockGet
				.mockResolvedValueOnce({ empty: false, docs: expiredBatch })
				.mockResolvedValueOnce({
					empty: false,
					docs: [buildQueryDoc('active-replay', {
						alertId: 'alert-1',
						attemptId: 'active-attempt',
						replayedAt: buildTimestamp('2026-08-12T11:00:00.000Z'),
						expiresAt: buildTimestamp('2026-11-11T00:00:00.000Z'),
					})],
				});

			const result = await AlertStorageService.getLatestReplayForAlert('alert-1');

			expect(mockGet).toHaveBeenCalledTimes(2);
			expect(result.id).toBe('active-attempt');
		});

		it('returns null when no replay document exists', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

			const result = await AlertStorageService.getLatestReplayForAlert('alert-1');

			expect(result).toBeNull();
		});

		it('throws STORAGE_UNAVAILABLE when reading latest replay fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockRejectedValueOnce(new Error('permission denied'));

			await expect(AlertStorageService.getLatestReplayForAlert('alert-1')).rejects.toMatchObject({
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
				signalClass: 'unknown',
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
				feature: 'grounding',
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

		it('exports feature tags with sanitized token usage', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('feature-export-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						tokenUsage: {
							inputTokens: 15,
							outputTokens: 27,
							totalTokens: 42,
							totalCost: 0.004,
							byFeature: {
								grounding: { inputTokens: 15, outputTokens: 27, totalTokens: 42, totalCost: 0.004, calls: 2 },
							},
						},
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				includeText: false,
			});

			expect(result.alerts[0]).toMatchObject({
				feature: 'grounding',
				tokenUsage: {
					byFeature: {
						grounding: expect.objectContaining({ calls: 2, totalCost: 0.004 }),
					},
				},
			});
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

		it('projects bounded safe enrichmentData when includeEnrichment is true', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('enriched-alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						enriched: true,
						useTradingViewData: true,
						tradingViewEnrichmentApplied: true,
						tradingViewEnrichmentStatus: 'full',
						enrichmentData: {
							sentiment: 'BULLISH',
							sentiment_score: 0.85,
							setup_type: 'breakout',
							invalidation_level: 64200,
							target_level: 68500,
							risk_reward_ratio: 2.5,
							sources: [
								'https://www.coindesk.com/markets/2026/06/btc-breakout',
								'https://cointelegraph.com/news/bitcoin-surge',
								{ url: 'https://news.bitcoin.com/article-1', title: 'BTC analysis' },
								'invalid-url',
							],
							tradingViewEnrichmentApplied: true,
							tradingViewEnrichmentStatus: 'full',
							promptProvenance: {
								name: 'crypto-sentiment',
								source: 'langfuse',
								label: 'production',
								version: 3,
								schemaDriftDetected: false,
								extraInternalPromptData: 'secret-prompt-content',
							},
							rawProviderResponse: { choices: [{ message: 'full-raw' }] },
							internalSecret: 'sensitive-value',
						},
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				includeEnrichment: true,
			});

			expect(result.alerts[0]).toHaveProperty('enrichmentData');
			expect(result.alerts[0].enrichmentData).toEqual({
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				setup_type: 'breakout',
				invalidation_level: 64200,
				target_level: 68500,
				risk_reward_ratio: 2.5,
				sourceCount: 4,
				sourceDomains: ['www.coindesk.com', 'cointelegraph.com', 'news.bitcoin.com'],
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				promptProvenance: {
					name: 'crypto-sentiment',
					source: 'langfuse',
					label: 'production',
					version: 3,
					schemaDriftDetected: false,
				},
			});
			expect(result.alerts[0].enrichmentData).not.toHaveProperty('rawProviderResponse');
			expect(result.alerts[0].enrichmentData).not.toHaveProperty('internalSecret');
			expect(result.alerts[0].enrichmentData.promptProvenance).not.toHaveProperty('extraInternalPromptData');
		});

		it('returns enrichmentData: null when includeEnrichment is true but alert has no enrichmentData', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('unenriched-alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						enriched: false,
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				includeEnrichment: true,
			});

			expect(result.alerts[0]).toHaveProperty('enrichmentData', null);
		});

		it('omits enrichmentData entirely when includeEnrichment is false or omitted', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('enriched-alert-default', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						enriched: true,
						enrichmentData: { sentiment: 'BULLISH' },
					}),
				],
			});

			const result = await AlertStorageService.exportAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result.alerts[0]).not.toHaveProperty('enrichmentData');
		});
	});

	describe('summarizeAlerts()', () => {
		beforeEach(() => {
			jest.useFakeTimers({ now: new Date('2026-06-06T13:00:00.000Z') });
		});

		afterEach(() => {
			jest.useRealTimers();
		});

		it('aggregates feature-tagged token costs without double-counting totals', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('feature-alert', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						text: 'BINANCE:BTCUSDT',
						tokenUsage: {
							inputTokens: 15,
							outputTokens: 27,
							totalTokens: 42,
							totalCost: 0.004,
							byFeature: {
								grounding: { inputTokens: 10, outputTokens: 20, totalTokens: 30, totalCost: 0.003, calls: 1 },
								enrichment: { inputTokens: 5, outputTokens: 7, totalTokens: 12, totalCost: 0.001, calls: 1 },
							},
						},
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});

			expect(result.enrichment.tokenUsage.totalCost).toBe(0.004);
			expect(result.costByFeature).toEqual({
				grounding: { alerts: 1, batches: 0, symbols: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, totalCost: 0.003 },
				'news-analysis': { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
				'expanded-analysis': { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
				scanner: { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
				enrichment: { alerts: 1, batches: 0, symbols: 1, inputTokens: 5, outputTokens: 7, totalTokens: 12, totalCost: 0.001 },
			});
		});

		it('does not attribute a zero-usage plain webhook alert to grounding', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			// The webhook handler always persists `tokenUsage.toJSON()`; with every
			// enrichment feature disabled that object is truthy but all-zero.
			const zeroUsage = {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
				inputCost: 0,
				outputCost: 0,
				totalCost: 0,
				formattedSummary: 'Token usage:\n- In 0 ($0.00)\n- Out 0 ($0.00)\n- Total 0 ($0.00)',
			};
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('plain-alert', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						text: 'BINANCE:BTCUSDT something happened',
						tokenUsage: zeroUsage,
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});

			expect(result.costByFeature.grounding.alerts).toBe(0);
			expect(result.costByFeature.grounding.totalCost).toBe(0);
			expect(result.costByFeature.grounding.symbols).toBe(0);
		});

		it('still attributes a real-usage plain webhook alert to grounding', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('grounded-alert', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'webhook',
						text: 'BINANCE:BTCUSDT breakout',
						tokenUsage: {
							inputTokens: 100,
							outputTokens: 50,
							totalTokens: 150,
							totalCost: 0.01,
						},
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});

			expect(result.costByFeature.grounding.alerts).toBe(1);
			expect(result.costByFeature.grounding.totalCost).toBe(0.01);
			expect(result.costByFeature.grounding.symbols).toBe(1);
		});

		it('counts one batch and the full symbol set for a multi-symbol news-monitor request', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const requestId = 'req-news-batch';
			// One /api/news-monitor request over 3 symbols writes 3 documents that
			// share requestId and each persist the complete request symbol set.
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'].map((symbol, index) => buildQueryDoc(`news-${index}`, {
					receivedAt: buildTimestamp('2026-06-06T12:00:0' + index + '.000Z'),
					source: 'news-monitor',
					requestId,
					batchId: requestId,
					symbol,
					symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
					tokenUsage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, totalCost: 0.001 },
				})),
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});

			// 3 documents, but only 1 request => 1 batch, 3 distinct symbols.
			expect(result.costByFeature['news-analysis'].batches).toBe(1);
			expect(result.costByFeature['news-analysis'].symbols).toBe(3);
			expect(result.costByFeature['news-analysis'].totalCost).toBe(0.003);
		});

		it('counts every symbol for a single-document multi-symbol expanded-analysis report', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('expanded-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'expanded-analysis',
						requestId: 'req-expanded-1',
						batchId: 'req-expanded-1',
						// Only the first symbol is stored in `symbol`, as before the fix.
						symbol: 'BTCUSDT',
						symbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
						tokenUsage: null,
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});

			expect(result.costByFeature['expanded-analysis'].alerts).toBe(1);
			expect(result.costByFeature['expanded-analysis'].symbols).toBe(3);
		});

		it('counts every symbol for a single-document multi-symbol scanner report', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('scanner-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						source: 'market-scanner',
						requestId: 'req-scanner-1',
						batchId: 'req-scanner-1',
						symbol: 'BTCUSDT',
						symbols: ['BTCUSDT', 'ETHUSDT'],
						tokenUsage: null,
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});

			expect(result.costByFeature.scanner.alerts).toBe(1);
			expect(result.costByFeature.scanner.symbols).toBe(2);
		});

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
				signalClassCounts: {
					breakout: 0,
					mean_reversion: 0,
					trend_continuation: 0,
					reversal: 0,
					volume_spike: 0,
					news_event: 0,
					manual: 0,
					unknown: 2,
				},
				byFeatureFlag: {
					enriched: 1,
					plain: 1,
					tradingViewData: 1,
					tradingViewDataApplied: 1,
					withoutTradingViewData: 1,
				},
				costByFeature: {
					grounding: { alerts: 1, batches: 0, symbols: 1, inputTokens: 10, outputTokens: 20, totalTokens: 30, totalCost: 0.001 },
					'news-analysis': { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
					'expanded-analysis': { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
					scanner: { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
					enrichment: { alerts: 0, batches: 0, symbols: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, totalCost: 0 },
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
					sentimentCalibration: {
						sampleCount: 0,
						evaluated: false,
						saturated: false,
						reason: 'no_samples',
						min: null,
						max: null,
						p10: null,
						p50: null,
						p90: null,
						spread: null,
						distinctValueCount: 0,
						bucketCount: 0,
						buckets: [],
						topBandCount: 0,
						topBandShare: null,
						rawScoreCapCount: 0,
					},
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
				scanner: {
					totalRuns: 0,
					errorCategoryCounts: {
						mcp_unreachable: 0,
						mcp_timeout: 0,
						mcp_rate_limited: 0,
						mcp_tool_error: 0,
						mcp_suspended: 0,
						symbol_invalid: 0,
						symbol_unsupported: 0,
						unknown: 0,
					},
				},
				latency: {
					averageProcessingMs: 250,
					averageDeliveryMs: 150,
					byChannel: {
						telegram: { averageMs: 150, p95Ms: 200, sampleCount: 2 },
						whatsapp: { averageMs: 150, p95Ms: 150, sampleCount: 1 },
					},
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

		it('applies symbol, eventCategory, and exchange filters before aggregating summaries', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const sampleDocs = [
				buildQueryDoc('alert-btc-binance-surge', {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					text: 'BINANCE:BTCUSDT surge',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					eventCategory: 'price_surge',
					source: 'webhook',
				}),
				buildQueryDoc('alert-eth-binance-surge', {
					receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
					text: 'BINANCE:ETHUSDT surge',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					eventCategory: 'price_surge',
					source: 'webhook',
				}),
				buildQueryDoc('alert-btc-coinbase-whale', {
					receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
					text: 'COINBASE:BTCUSDT whale',
					symbol: 'BTCUSDT',
					exchange: 'COINBASE',
					eventCategory: 'whale_movement',
					source: 'webhook',
				}),
			];

			// 1. By symbol (case-insensitive)
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const bySymbol = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
				symbol: 'btcusdt',
			});
			expect(bySymbol.totalAlerts).toBe(2);
			expect(bySymbol.bySymbol).toEqual({ BTCUSDT: 2 });

			// 2. By exchange (case-insensitive)
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byExchange = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
				exchange: 'binance',
			});
			expect(byExchange.totalAlerts).toBe(2);
			expect(byExchange.bySymbol).toEqual({ BTCUSDT: 1, ETHUSDT: 1 });

			// 3. By eventCategory (case-insensitive)
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const byCategory = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
				eventCategory: 'WHALE_MOVEMENT',
			});
			expect(byCategory.totalAlerts).toBe(1);
			expect(byCategory.bySymbol).toEqual({ BTCUSDT: 1 });

			// 4. Combined filters
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const combined = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				eventCategory: 'price_surge',
			});
			expect(combined.totalAlerts).toBe(1);
			expect(combined.bySymbol).toEqual({ BTCUSDT: 1 });
		});

		it('applies signalClass filter before aggregating summaries and computes signalClassCounts accurately', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const sampleDocs = [
				buildQueryDoc('alert-breakout', {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					text: 'BINANCE:BTCUSDT breakout',
					symbol: 'BTCUSDT',
					signalClass: 'breakout',
					source: 'webhook',
				}),
				buildQueryDoc('alert-reversal', {
					receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
					text: 'BINANCE:ETHUSDT reversal',
					symbol: 'ETHUSDT',
					signalClass: 'reversal',
					source: 'webhook',
				}),
				buildQueryDoc('alert-legacy', {
					receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
					text: 'BINANCE:SOLUSDT legacy',
					symbol: 'SOLUSDT',
					source: 'webhook',
				}),
			];

			// Unfiltered summary
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const unfiltered = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
			});
			expect(unfiltered.totalAlerts).toBe(3);
			expect(unfiltered.signalClassCounts).toEqual({
				breakout: 1,
				reversal: 1,
				mean_reversion: 0,
				trend_continuation: 0,
				volume_spike: 0,
				news_event: 0,
				manual: 0,
				unknown: 1,
			});

			// Filtered by signalClass
			mockGet.mockResolvedValueOnce({ empty: false, docs: sampleDocs });
			const filtered = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 10,
				signalClass: 'breakout',
			});
			expect(filtered.totalAlerts).toBe(1);
			expect(filtered.signalClassCounts.breakout).toBe(1);
			expect(filtered.signalClassCounts.reversal).toBe(0);
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

		describe('sentimentCalibration', () => {
			function scoreDoc(id, sentimentScore, extra = {}) {
				return buildQueryDoc(id, {
					receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
					enriched: true,
					source: 'webhook',
					enrichmentData: { symbol: 'BTCUSDT', sentiment_score: sentimentScore, ...extra },
				});
			}

			it('reports no samples and an explicit reason for an empty window', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({ empty: true, docs: [] });

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				expect(result.enrichment.sentimentCalibration.sampleCount).toBe(0);
				expect(result.enrichment.sentimentCalibration.evaluated).toBe(false);
				expect(result.enrichment.sentimentCalibration.saturated).toBe(false);
				expect(result.enrichment.sentimentCalibration.reason).toBe('no_samples');
				expect(result.enrichment.sentimentCalibration.rawScoreCapCount).toBe(0);
			});

			it('flags the issue #1031 production shape as saturated', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				const saturated = [
					...Array(42).fill(0.85),
					...Array(33).fill(0.8),
					...Array(10).fill(0.75),
					...Array(3).fill(0.7),
					...Array(4).fill(0.65),
					...Array(4).fill(0.6),
					...Array(1).fill(0.55),
				];
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: saturated.map((value, index) => scoreDoc(`alert-${index}`, value)),
				});

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				const calibration = result.enrichment.sentimentCalibration;
				expect(calibration.sampleCount).toBe(97);
				expect(calibration.evaluated).toBe(true);
				expect(calibration.saturated).toBe(true);
				expect(calibration.reason).toBe('top_band_concentration');
				expect(calibration.topBandCount).toBe(85);
				expect(calibration.distinctValueCount).toBe(7);
				expect(calibration.bucketCount).toBe(4);
				expect(calibration.p10).toBeCloseTo(0.7, 6);
				expect(calibration.p90).toBeCloseTo(0.85, 6);
			});

			it('reports a healthy window without warning', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				const scores = [];
				for (let i = 0; i < 40; i += 1) {
					scores.push((i % 10) / 10 + 0.05);
				}
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: scores.map((value, index) => scoreDoc(`spread-${index}`, value)),
				});

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				const calibration = result.enrichment.sentimentCalibration;
				expect(calibration.sampleCount).toBe(40);
				expect(calibration.saturated).toBe(false);
				expect(calibration.reason).toBeNull();
				expect(calibration.bucketCount).toBeGreaterThanOrEqual(4);
			});

			it('uses the absolute value of a negative score', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: [
						scoreDoc('bearish', -0.9),
						scoreDoc('bullish', 0.2),
						scoreDoc('neutral', 0),
					],
				});

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				const calibration = result.enrichment.sentimentCalibration;
				expect(calibration.sampleCount).toBe(3);
				expect(calibration.min).toBe(0);
				expect(calibration.max).toBeCloseTo(0.9, 6);
				// Below the sample floor, so saturation is not declared.
				expect(calibration.evaluated).toBe(false);
				expect(calibration.reason).toBe('insufficient_sample');
			});

			it('counts how many alerts the CB-238 zero-source cap rewrote', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: [
						scoreDoc('capped', 0.55, { sentiment_score_raw: 0.9 }),
						scoreDoc('capped-two', -0.55, { sentiment_score_raw: -0.85 }),
						scoreDoc('uncapped', 0.3),
					],
				});

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				expect(result.enrichment.sentimentCalibration.rawScoreCapCount).toBe(2);
			});

			it('ignores plain alerts and malformed stored scores', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: [
						buildQueryDoc('plain-alert', {
							receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
							enriched: false,
							source: 'webhook',
							enrichmentData: { sentiment_score: 0.9 },
						}),
						scoreDoc('nan-score', 'not-a-number'),
						scoreDoc('null-score', null),
						scoreDoc('good-score', 0.3),
					],
				});

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				expect(result.enrichment.sentimentCalibration.sampleCount).toBe(1);
				expect(result.enrichment.sentimentCalibration.max).toBeCloseTo(0.3, 6);
			});

			it('never lets an unreadable score break the summary', async () => {
				process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
				mockGet.mockResolvedValueOnce({
					empty: false,
					docs: [
						scoreDoc('weird', 0.4),
						buildQueryDoc('bad-enrichment', {
							receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
							enriched: true,
							source: 'webhook',
							enrichmentData: 'not-an-object',
						}),
					],
				});

				const result = await AlertStorageService.summarizeAlerts({
					from: '2026-06-06T00:00:00.000Z',
					to: '2026-06-07T00:00:00.000Z',
					limit: 200,
				});

				expect(result.totalAlerts).toBe(2);
				expect(result.enrichment.sentimentCalibration.sampleCount).toBe(1);
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

		// Regression (issue #222): production bySymbol contained a bare integer "53"
		// and the parse artifact "MASTER", polluting the same analytics surface this
		// work is meant to clean up.
		it('does not index numeric-only or single-character symbols in bySymbol', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-numeric', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						text: 'Momentum shifted after 53 candles',
						symbol: '53',
						exchange: 'NASDAQ',
						deliveryResults: [],
						source: 'webhook',
					}),
					buildQueryDoc('alert-single', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						text: 'Signal on B',
						symbol: 'B',
						deliveryResults: [],
						source: 'webhook',
					}),
					buildQueryDoc('alert-valid', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						text: 'BINANCE:ETHUSDT(D) alert triggered',
						symbol: 'ETHUSDT',
						exchange: 'BINANCE',
						deliveryResults: [],
						source: 'webhook',
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result.bySymbol).toEqual({ ETHUSDT: 1, unknown: 2 });
		});

		it('aggregates per-channel delivery latency with average, p95, and sampleCount and omits zero-delivery channels', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						deliveryResults: [
							{ channel: 'telegram', success: true, durationMs: 100 },
							{ channel: 'whatsapp', success: true, durationMs: 300 },
							{ channel: 'discord', success: true, durationMs: 80 },
						],
					}),
					buildQueryDoc('alert-2', {
						receivedAt: buildTimestamp('2026-06-06T11:00:00.000Z'),
						deliveryResults: [
							{ channel: 'telegram', success: true, durationMs: 200 },
							{ channel: 'whatsapp', success: false, durationMs: 400 },
						],
					}),
					buildQueryDoc('alert-3', {
						receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
						deliveryResults: [
							{ channel: 'telegram', success: true, durationMs: 300 },
						],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result.latency.averageDeliveryMs).toBe(Math.round((100 + 300 + 80 + 200 + 400 + 300) / 6));
			expect(result.latency.byChannel).toEqual({
				telegram: {
					averageMs: 200,
					p95Ms: 300,
					sampleCount: 3,
				},
				whatsapp: {
					averageMs: 350,
					p95Ms: 400,
					sampleCount: 2,
				},
				discord: {
					averageMs: 80,
					p95Ms: 80,
					sampleCount: 1,
				},
			});
		});

		it('returns empty object for latency.byChannel when there are no delivery latency samples', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-no-latency', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						deliveryResults: [],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
			});

			expect(result.latency.averageDeliveryMs).toBeNull();
			expect(result.latency.byChannel).toEqual({});
		});

		// ── Time-bucketed series (issue #1287) ─────────────────────────────────
		// The series is built from the same bounded cursor scan as the aggregates,
		// so `sum(bucket.total) === totalAlerts` is guaranteed rather than coincidental.

		it('keeps the controller accepted-interval list identical to the implemented intervals', () => {
			const { VALID_SUMMARY_INTERVALS } = require('../../src/controllers/alerts/alerts');

			// The controller owns request validation and keeps its own list so a
			// partial module mock cannot break route loading. That makes the two
			// lists a drift risk, so it is asserted rather than assumed.
			expect([...VALID_SUMMARY_INTERVALS].sort()).toEqual(
				Object.keys(AlertStorageService.SUMMARY_INTERVALS).sort(),
			);
		});

		it('omits summary.buckets and window.interval entirely when interval is not requested', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T12:00:00.000Z'),
						deliveryResults: [{ channel: 'telegram', success: true }],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
			});

			expect(result).not.toHaveProperty('buckets');
			expect(result.window).toEqual({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-07T00:00:00.000Z',
				limit: 200,
				maxDays: 31,
			});
			// Byte-for-byte regression: the key set and its order must not move.
			expect(Object.keys(result.window)).toEqual(['from', 'to', 'limit', 'maxDays']);
		});

		it('buckets hourly with gapless zero-filled buckets ascending by bucketStart', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-late', {
						receivedAt: buildTimestamp('2026-06-06T02:30:00.000Z'),
						deliveryResults: [
							{ channel: 'telegram', success: true },
							{ channel: 'whatsapp', success: false },
						],
					}),
					buildQueryDoc('alert-early', {
						receivedAt: buildTimestamp('2026-06-06T00:15:00.000Z'),
						deliveryResults: [{ channel: 'telegram', success: true }],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-06T03:00:00.000Z',
				limit: 200,
				interval: 'hour',
			});

			expect(result.window).toEqual({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-06T03:00:00.000Z',
				limit: 200,
				maxDays: 31,
				interval: 'hour',
			});
			// 01:00 has no alerts and must still appear so a chart has no gaps.
			expect(result.buckets).toEqual([
				{
					bucketStart: '2026-06-06T00:00:00.000Z',
					total: 1,
					success: 1,
					failure: 0,
					byChannel: { telegram: { total: 1, success: 1, failure: 0 } },
				},
				{
					bucketStart: '2026-06-06T01:00:00.000Z',
					total: 0,
					success: 0,
					failure: 0,
					byChannel: {},
				},
				{
					bucketStart: '2026-06-06T02:00:00.000Z',
					total: 1,
					success: 1,
					failure: 1,
					byChannel: {
						telegram: { total: 1, success: 1, failure: 0 },
						whatsapp: { total: 1, success: 0, failure: 1 },
					},
				},
				{
					bucketStart: '2026-06-06T03:00:00.000Z',
					total: 0,
					success: 0,
					failure: 0,
					byChannel: {},
				},
			]);
			expect(Object.keys(result.buckets[0])).toEqual([
				'bucketStart',
				'total',
				'success',
				'failure',
				'byChannel',
			]);
		});

		it('buckets daily on UTC midnight boundaries and widens the window cap to 366 days', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-day-1', {
						receivedAt: buildTimestamp('2026-01-15T18:00:00.000Z'),
						deliveryResults: [{ channel: 'discord', success: true }],
					}),
					buildQueryDoc('alert-day-3', {
						receivedAt: buildTimestamp('2026-01-17T06:00:00.000Z'),
						deliveryResults: [{ channel: 'discord', success: false }],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-01-15T00:00:00.000Z',
				to: '2026-01-18T00:00:00.000Z',
				limit: 500,
				interval: 'day',
			});

			expect(result.window.maxDays).toBe(366);
			expect(result.window.interval).toBe('day');
			expect(result.buckets.map(b => b.bucketStart)).toEqual([
				'2026-01-15T00:00:00.000Z',
				'2026-01-16T00:00:00.000Z',
				'2026-01-17T00:00:00.000Z',
				'2026-01-18T00:00:00.000Z',
			]);
			expect(result.buckets[1]).toEqual({
				bucketStart: '2026-01-16T00:00:00.000Z',
				total: 0,
				success: 0,
				failure: 0,
				byChannel: {},
			});
			expect(result.buckets[3].total).toBe(0);
		});

		it('produces an all-zero bucket series for an empty window rather than an empty array', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValue({ empty: true, docs: [] });

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-06T05:00:00.000Z',
				limit: 200,
				interval: 'hour',
			});

			expect(result.totalAlerts).toBe(0);
			expect(result.buckets).toHaveLength(6);
			for (const bucket of result.buckets) {
				expect(bucket).toEqual({
					bucketStart: expect.any(String),
					total: 0,
					success: 0,
					failure: 0,
					byChannel: {},
				});
			}
			expect(result.buckets.map(b => b.bucketStart)).toEqual([
				'2026-06-06T00:00:00.000Z',
				'2026-06-06T01:00:00.000Z',
				'2026-06-06T02:00:00.000Z',
				'2026-06-06T03:00:00.000Z',
				'2026-06-06T04:00:00.000Z',
				'2026-06-06T05:00:00.000Z',
			]);
		});

		it('keeps bucket totals equal to totalAlerts and bucket success/failure equal to the channel sums', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-1', {
						receivedAt: buildTimestamp('2026-06-06T00:10:00.000Z'),
						deliveryResults: [
							{ channel: 'telegram', success: true },
							{ channel: 'whatsapp', success: false },
						],
					}),
					buildQueryDoc('alert-2', {
						receivedAt: buildTimestamp('2026-06-06T00:20:00.000Z'),
						deliveryResults: [{ channel: 'telegram', success: false }],
					}),
					buildQueryDoc('alert-3', {
						receivedAt: buildTimestamp('2026-06-06T01:20:00.000Z'),
						deliveryResults: [],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-06T02:00:00.000Z',
				limit: 200,
				interval: 'hour',
			});

			// `total` counts alerts, not delivery results, so a delivery-less alert counts.
			expect(result.totalAlerts).toBe(3);
			expect(result.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(result.totalAlerts);
			expect(result.buckets.reduce((sum, b) => sum + b.success, 0)).toBe(result.delivery.totalSuccess);
			expect(result.buckets.reduce((sum, b) => sum + b.failure, 0)).toBe(result.delivery.totalFailure);
			for (const bucket of result.buckets) {
				const channels = Object.values(bucket.byChannel);
				expect(bucket.success).toBe(channels.reduce((sum, c) => sum + c.success, 0));
				expect(bucket.failure).toBe(channels.reduce((sum, c) => sum + c.failure, 0));
			}
		});

		it('applies the alert filters to the buckets, not only to the totals', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				empty: false,
				docs: [
					buildQueryDoc('alert-webhook', {
						receivedAt: buildTimestamp('2026-06-06T00:10:00.000Z'),
						source: 'webhook',
						enriched: true,
						deliveryResults: [{ channel: 'telegram', success: true }],
					}),
					buildQueryDoc('alert-news', {
						receivedAt: buildTimestamp('2026-06-06T00:20:00.000Z'),
						source: 'news-monitor',
						enriched: false,
						deliveryResults: [{ channel: 'telegram', success: true }],
					}),
				],
			});

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-06-06T00:00:00.000Z',
				to: '2026-06-06T01:00:00.000Z',
				limit: 200,
				interval: 'hour',
				source: 'webhook',
			});

			expect(result.totalAlerts).toBe(1);
			expect(result.buckets[0].total).toBe(1);
			expect(result.buckets.reduce((sum, b) => sum + b.total, 0)).toBe(1);
		});

		it('rejects an hourly window wider than 31 days instead of silently narrowing it', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			await expect(AlertStorageService.summarizeAlerts({
				from: '2026-01-01T00:00:00.000Z',
				to: '2026-03-01T00:00:00.000Z',
				limit: 200,
				interval: 'hour',
			})).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				message: expect.stringContaining('interval "hour"'),
			});
			// Validated before the scan, so an over-cap request spends no read.
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('rejects a daily window wider than 366 days', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';

			await expect(AlertStorageService.summarizeAlerts({
				from: '2024-01-01T00:00:00.000Z',
				to: '2026-06-01T00:00:00.000Z',
				limit: 200,
				interval: 'day',
			})).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				message: expect.stringContaining('366 days'),
			});
			expect(mockGet).not.toHaveBeenCalled();
		});

		it('keeps the aggregate-only narrowing contract when no interval is requested', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValue({ empty: true, docs: [] });

			const result = await AlertStorageService.summarizeAlerts({
				from: '2026-01-01T00:00:00.000Z',
				to: '2026-03-01T00:00:00.000Z',
				limit: 200,
			});

			// Aggregate-only requests keep the pre-existing silent narrowing.
			expect(result.window.from).toBe('2026-01-29T00:00:00.000Z');
			expect(result.window.maxDays).toBe(31);
			expect(result).not.toHaveProperty('buckets');
		});
	});

	describe('calculatePercentileLatency()', () => {
		it('returns null for empty or non-array input', () => {
			expect(AlertStorageService.calculatePercentileLatency([])).toBeNull();
			expect(AlertStorageService.calculatePercentileLatency(null)).toBeNull();
			expect(AlertStorageService.calculatePercentileLatency(undefined)).toBeNull();
			expect(AlertStorageService.calculatePercentileLatency('not-an-array')).toBeNull();
		});

		it('returns the single sample for a 1-item array', () => {
			expect(AlertStorageService.calculatePercentileLatency([150])).toBe(150);
		});

		it('calculates p95 using sorted-index nearest-rank method', () => {
			expect(AlertStorageService.calculatePercentileLatency([100, 200], 95)).toBe(200);
			const samples = [100, 10, 50, 20, 90, 30, 80, 40, 70, 60];
			expect(AlertStorageService.calculatePercentileLatency(samples, 95)).toBe(100);
			expect(AlertStorageService.calculatePercentileLatency(samples, 50)).toBe(50);
		});

		it('calculates p95 for 20 samples accurately', () => {
			const samples20 = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
			expect(AlertStorageService.calculatePercentileLatency(samples20, 95)).toBe(190);
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

			// Regression (issue #222): the summary metric showed a bare integer "53"
			// indexed as if it were a ticker. Integers and single characters are never
			// valid symbols, even when they are syntactically well formed.
			it('rejects bare integers instead of extracting them as tickers', () => {
				expect(AlertStorageService.parseSymbolFromText('53')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('53(1h)')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('Price moved 53 points on 1h momentum shift')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('RSI crossed 53 on the daily close')).toBeNull();
			});

			// The timeframe is not the symbol: "BTCUSDT(53)" is a legitimate
			// extraction and must keep working.
			it('treats a numeric token inside parentheses as the timeframe, not the symbol', () => {
				expect(AlertStorageService.parseSymbolFromText('BTCUSDT(53)')).toEqual({
					symbol: 'BTCUSDT',
					exchange: null,
				});
			});

			it('rejects single-character symbols', () => {
				expect(AlertStorageService.parseSymbolFromText('B')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('X(1h)')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('A:1')).toBeNull();
			});

			it('rejects numeric-only and single-character exchange-qualified symbols', () => {
				expect(AlertStorageService.parseSymbolFromText('NASDAQ:53')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('NASDAQ:5')).toBeNull();
			});

			it('still accepts two-character real tickers', () => {
				expect(AlertStorageService.parseSymbolFromText('FX_IDC:USDCLP(D)')).toEqual({
					symbol: 'USDCLP',
					exchange: 'FX_IDC',
				});
				expect(AlertStorageService.parseSymbolFromText('ON(1h)')).toEqual({
					symbol: 'ON',
					exchange: null,
				});
			});

			it('reuses hardened asset-context normalization for crypto pairs and suffixes', () => {
				expect(AlertStorageService.parseSymbolFromText('BTC/USDT breakout')).toEqual({
					symbol: 'BTC/USDT',
					exchange: null,
				});
				expect(AlertStorageService.parseSymbolFromText('aerosol prices rose after the announcement')).toBeNull();
				expect(AlertStorageService.parseSymbolFromText('teeth broke resistance')).toBeNull();
			});
		});

		describe('isValidExtractedSymbol()', () => {
			it('rejects non-strings, blank, and unknown sentinels', () => {
				expect(AlertStorageService.isValidExtractedSymbol(null)).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol(undefined)).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol(42)).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('   ')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('unknown')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('UNKNOWN')).toBe(false);
			});

			it('rejects numeric-only and single-character symbols', () => {
				expect(AlertStorageService.isValidExtractedSymbol('53')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('1')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('007')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('A')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('/')).toBe(false);
			});

			it('rejects symbols containing whitespace or path separators', () => {
				expect(AlertStorageService.isValidExtractedSymbol('BTC USDT')).toBe(false);
				expect(AlertStorageService.isValidExtractedSymbol('A/B')).toBe(false);
			});

			it('accepts real tickers and a normalized slash pair', () => {
				expect(AlertStorageService.isValidExtractedSymbol('BTCUSDT')).toBe(true);
				expect(AlertStorageService.isValidExtractedSymbol('ETHUSD')).toBe(true);
				expect(AlertStorageService.isValidExtractedSymbol('AAPL')).toBe(true);
				expect(AlertStorageService.isValidExtractedSymbol('USDCLP')).toBe(true);
				expect(AlertStorageService.isValidExtractedSymbol('BRK.B')).toBe(true);
				expect(AlertStorageService.isValidExtractedSymbol('on')).toBe(true);
				expect(AlertStorageService.isValidExtractedSymbol('BTC/USDT')).toBe(true);
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

			it('rejects numeric-only and single-character values supplied as explicit properties', () => {
				expect(AlertStorageService.extractSymbolAndExchange({ symbol: '53' })).toEqual({
					symbol: 'unknown',
					exchange: null,
				});
				expect(AlertStorageService.extractSymbolAndExchange({ ticker: '53' })).toEqual({
					symbol: 'unknown',
					exchange: null,
				});
				expect(AlertStorageService.extractSymbolAndExchange({ symbol: 'A' })).toEqual({
					symbol: 'unknown',
					exchange: null,
				});
				expect(AlertStorageService.extractSymbolAndExchange({ symbol: 'NASDAQ:53' })).toEqual({
					symbol: 'unknown',
					exchange: null,
				});
				expect(AlertStorageService.extractSymbolAndExchange({ enrichmentData: { symbol: '53' } })).toEqual({
					symbol: 'unknown',
					exchange: null,
				});
			});

			it('falls back to raw text extraction when an explicit property is invalid', () => {
				expect(AlertStorageService.extractSymbolAndExchange({
					symbol: '53',
					text: 'BINANCE:ETHUSDT(D) cambió a señal de VENTA',
				})).toEqual({
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
				});
			});
		});

		describe('extractSourceDomains()', () => {
			it('extracts unique lowercase hostnames from string and object source entries', () => {
				const sources = [
					'https://Bloomberg.com/news/1',
					{ url: 'https://COINDESK.COM/article/2' },
					'https://bloomberg.com/news/other', // duplicate
					'not-a-url',
					null,
					123,
				];
				expect(AlertStorageService.extractSourceDomains(sources)).toEqual([
					'bloomberg.com',
					'coindesk.com',
				]);
			});

			it('caps source domains at 10 items', () => {
				const sources = Array.from({ length: 15 }, (_, i) => `https://domain${i}.com/page`);
				const result = AlertStorageService.extractSourceDomains(sources);
				expect(result).toHaveLength(10);
				expect(result[0]).toBe('domain0.com');
			});

			it('returns empty array when sources is not an array', () => {
				expect(AlertStorageService.extractSourceDomains(null)).toEqual([]);
				expect(AlertStorageService.extractSourceDomains(undefined)).toEqual([]);
				expect(AlertStorageService.extractSourceDomains('not-array')).toEqual([]);
			});
		});

		describe('formatEnrichmentSummary()', () => {
			it('returns null for non-object, null, or array inputs', () => {
				expect(AlertStorageService.formatEnrichmentSummary(null)).toBeNull();
				expect(AlertStorageService.formatEnrichmentSummary(undefined)).toBeNull();
				expect(AlertStorageService.formatEnrichmentSummary([])).toBeNull();
				expect(AlertStorageService.formatEnrichmentSummary('invalid')).toBeNull();
			});

			it('clips sentiment to 32 chars and setup_type to 64 chars', () => {
				const result = AlertStorageService.formatEnrichmentSummary({
					sentiment: 'A'.repeat(50),
					setup_type: 'B'.repeat(100),
				});
				expect(result.sentiment).toBe('A'.repeat(32));
				expect(result.setup_type).toBe('B'.repeat(64));
			});

			it('handles alternate camelCase field names for sentimentScore and setupType', () => {
				const result = AlertStorageService.formatEnrichmentSummary({
					sentimentScore: 0.75,
					setupType: 'continuation',
					invalidationLevel: 100,
					targetLevel: 200,
					riskRewardRatio: 2.0,
				});
				expect(result.sentiment_score).toBe(0.75);
				expect(result.setup_type).toBe('continuation');
				expect(result.invalidation_level).toBe(100);
				expect(result.target_level).toBe(200);
				expect(result.risk_reward_ratio).toBe(2.0);
			});

			it('falls back to docData for tradingViewEnrichment fields if missing from enrichmentData', () => {
				const result = AlertStorageService.formatEnrichmentSummary(
					{ sentiment: 'NEUTRAL' },
					{
						tradingViewEnrichmentApplied: true,
						tradingViewEnrichmentStatus: 'partial',
					},
				);
				expect(result.tradingViewEnrichmentApplied).toBe(true);
				expect(result.tradingViewEnrichmentStatus).toBe('partial');
			});
		});
	});

	describe('deleteAlerts()', () => {
		it('returns null when alert storage is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const result = await AlertStorageService.deleteAlerts(['alert-1']);
			expect(result).toBeNull();
		});

		it('returns { deleted: 0 } when alertIds is empty or invalid', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			expect(await AlertStorageService.deleteAlerts([])).toEqual({ deleted: 0 });
			expect(await AlertStorageService.deleteAlerts(null)).toEqual({ deleted: 0 });
		});

		it('batch deletes documents that exist using Firestore batch', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet
				.mockImplementationOnce(async () => ({ exists: true, id: 'alert-1' }))
				.mockImplementationOnce(async () => ({ exists: true, id: 'alert-2' }));
			const result = await AlertStorageService.deleteAlerts(['alert-1', 'alert-2', 'alert-1']);
			expect(result).toEqual({ deleted: 2 });
			expect(mockBatchDelete).toHaveBeenCalledTimes(2);
		});

		it('reports only alerts that actually existed as deleted', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet
				.mockImplementationOnce(async () => ({ exists: true, id: 'alert-1' }))
				.mockImplementationOnce(async () => ({ exists: false, id: 'nonexistent-2' }));
			const result = await AlertStorageService.deleteAlerts(['alert-1', 'nonexistent-2']);
			expect(result).toEqual({ deleted: 1 });
			expect(mockBatchDelete).toHaveBeenCalledTimes(1);
		});

		it('returns { deleted: 0 } and skips batch delete when no requested documents exist', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockImplementationOnce(async () => ({ exists: false, id: 'missing' }));
			const result = await AlertStorageService.deleteAlerts(['missing']);
			expect(result).toEqual({ deleted: 0 });
			expect(mockBatchDelete).not.toHaveBeenCalled();
		});

		it('throws STORAGE_UNAVAILABLE when reading documents before batch delete fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockRejectedValueOnce(new Error('Firestore read timeout'));
			await expect(AlertStorageService.deleteAlerts(['alert-1'])).rejects.toMatchObject({
				code: AlertStorageService.STORAGE_UNAVAILABLE_CODE,
			});
		});

		it('throws STORAGE_UNAVAILABLE when batch commit fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockImplementationOnce(async () => ({ exists: true, id: 'alert-1' }));
			mockBatchCommit.mockImplementationOnce(() => {
				throw new Error('Firestore commit failed');
			});
			await expect(AlertStorageService.deleteAlerts(['alert-1'])).rejects.toMatchObject({
				code: AlertStorageService.STORAGE_UNAVAILABLE_CODE,
			});
		});
	});

	describe('exportAlertsByIds()', () => {
		it('returns null when alert storage is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const result = await AlertStorageService.exportAlertsByIds({ alertIds: ['alert-1'] });
			expect(result).toBeNull();
		});

		it('exports matching active alerts by ID', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockImplementationOnce(async () => ({
				exists: true,
				id: 'alert-1',
				data: () => ({
					text: 'BINANCE:BTCUSDT(1h) alert',
					receivedAt: buildTimestamp('2026-06-06T10:00:00.000Z'),
					expiresAt: buildTimestamp('2026-12-31T00:00:00.000Z'),
				}),
			}));

			const result = await AlertStorageService.exportAlertsByIds({ alertIds: ['alert-1'] });
			expect(result.alerts).toHaveLength(1);
			expect(result.alerts[0].id).toBe('alert-1');
		});

		it('filters out non-existent or expired alerts', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			jest.useFakeTimers().setSystemTime(new Date('2026-08-13T00:00:00.000Z'));
			mockDocGet
				.mockImplementationOnce(async () => ({
					exists: false,
					id: 'missing',
					data: () => null,
				}))
				.mockImplementationOnce(async () => ({
					exists: true,
					id: 'expired',
					data: () => ({
						receivedAt: buildTimestamp('2026-05-01T00:00:00.000Z'),
						expiresAt: buildTimestamp('2026-05-02T00:00:00.000Z'),
					}),
				}));

			const result = await AlertStorageService.exportAlertsByIds({ alertIds: ['missing', 'expired'] });
			expect(result.alerts).toHaveLength(0);
		});
		it('throws storage unavailable error when Firestore read rejects', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockRejectedValueOnce(new Error('Firestore quota exceeded'));

			await expect(AlertStorageService.exportAlertsByIds({ alertIds: ['alert-1'] }))
				.rejects.toMatchObject({ code: AlertStorageService.STORAGE_UNAVAILABLE_CODE });
		});
	});

	describe('getAlertsByIds()', () => {
		it('returns null when alert storage is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const result = await AlertStorageService.getAlertsByIds(['alert-1']);
			expect(result).toBeNull();
		});

		it('throws storage unavailable error when Firestore read rejects', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockDocGet.mockRejectedValueOnce(new Error('Firestore connection timeout'));

			await expect(AlertStorageService.getAlertsByIds(['alert-1']))
				.rejects.toMatchObject({ code: AlertStorageService.STORAGE_UNAVAILABLE_CODE });
		});
	});

	describe('getReplayAttemptByIdempotencyKey()', () => {
		it('returns null when alert storage is disabled or params invalid', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			expect(await AlertStorageService.getReplayAttemptByIdempotencyKey('alert-1', 'key-1')).toBeNull();

			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			expect(await AlertStorageService.getReplayAttemptByIdempotencyKey('', 'key-1')).toBeNull();
			expect(await AlertStorageService.getReplayAttemptByIdempotencyKey('alert-1', '')).toBeNull();
		});

		it('queries replay document by alertId and idempotencyKeyHash', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({
				docs: [{
					id: 'replay-doc-1',
					exists: true,
					data: () => ({
						alertId: 'alert-1',
						idempotencyKeyHash: 'somehash',
						deliveryResults: [{ channel: 'telegram', success: true }],
					}),
				}],
			});

			const replay = await AlertStorageService.getReplayAttemptByIdempotencyKey('alert-1', 'key-1');
			expect(replay).toBeDefined();
			expect(replay.id).toBe('replay-doc-1');
			expect(replay.alertId).toBe('alert-1');
		});

		it('returns null when no replay matches', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockResolvedValueOnce({ docs: [] });
			expect(await AlertStorageService.getReplayAttemptByIdempotencyKey('alert-1', 'key-1')).toBeNull();
		});

		it('throws storage unavailable error when Firestore query fails', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			mockGet.mockRejectedValueOnce(new Error('Firestore unavailable'));
			await expect(AlertStorageService.getReplayAttemptByIdempotencyKey('alert-1', 'key-1')).rejects.toMatchObject({
				code: AlertStorageService.STORAGE_UNAVAILABLE_CODE,
			});
		});
	});

	describe('batchReplayAlerts()', () => {
		it('returns null when alert storage is disabled', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'false';
			const result = await AlertStorageService.batchReplayAlerts([{ alertId: 'alert-1', idempotencyKey: 'k', channels: ['telegram'], deliveryResults: [] }]);
			expect(result).toBeNull();
		});

		it('saves batch replay attempts using Firestore batch', async () => {
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			const result = await AlertStorageService.batchReplayAlerts([
				{ alertId: 'alert-1', idempotencyKey: 'k1', channels: ['telegram'], deliveryResults: [{ channel: 'telegram', success: true }] },
				{ alertId: 'alert-2', idempotencyKey: 'k2', channels: ['discord'], deliveryResults: [{ channel: 'discord', success: true }] },
			]);
			expect(result).toHaveLength(2);
			expect(mockBatchSet).toHaveBeenCalledTimes(2);
		});
	});

	// GH-599: `risk_reward_ratio_source` is added by `saveAlertInternal()` via
	// `applyDeterministicRiskReward()`, so it exists ONLY on the persisted document. The
	// dry-run branch returns `enrichedData` before persistence and never gains the field,
	// so documenting it solely under the dry-run `DeliveryResult` payload published a
	// provenance tag on a response that cannot contain it, while the stored-alert contract
	// that CAN contain it stayed undocumented. Anchor the GH-599 fields on `StoredAlert`.
	describe('GH-599 persisted entry-price contract', () => {
		const openapi = require('../../src/openapi/openapi.json');
		const storedAlertEnrichment = openapi.components.schemas.StoredAlert.properties.enrichmentData;

		it('documents current_price and price_currency on stored alert enrichment data', () => {
			expect(storedAlertEnrichment.properties).toHaveProperty('current_price');
			expect(storedAlertEnrichment.properties).toHaveProperty('price_currency');
			// The price is the model's reading of grounded context, not a snippet-level
			// extraction, so the contract must not imply field-level citation.
			expect(storedAlertEnrichment.properties.current_price.description).toMatch(/no field-level citation/i);
		});

		it('documents risk_reward_ratio_source provenance on stored alert enrichment data', () => {
			expect(storedAlertEnrichment.properties).toHaveProperty('risk_reward_ratio_source');
			expect(storedAlertEnrichment.properties.risk_reward_ratio_source.description).toMatch(/computed/i);
			expect(storedAlertEnrichment.properties.risk_reward_ratio_source.description).toMatch(/persist|stored|Firestore/i);
		});

		it('enumerates every levelsSource and priceSource value the merge path can emit', () => {
			// `selectRiskMetadata()` falls back to `mcp.levelsSource || 'tradingview-mcp'`,
			// so `tradingview-mcp` is the value most MCP-sourced alerts actually persist.
			// An enum missing it marks the commonest production shape invalid.
			expect(storedAlertEnrichment.properties.levelsSource.enum).toEqual([
				'tradingview-mcp',
				'gemini-grounding',
				'fallback-trade-plan',
				'derived-quote',
			]);
			expect(storedAlertEnrichment.properties.priceSource.enum).toEqual([
				'tradingview-mcp',
				'gemini-grounding',
				'derived-quote',
			]);
		});

		it('does not advertise risk_reward_ratio_source as a dry-run response field', () => {
			const dryRunEnrichment = openapi.components.schemas.DeliveryResult
				.properties.payload.properties.enrichedData.properties;
			expect(dryRunEnrichment).not.toHaveProperty('risk_reward_ratio_source');
		});
	});
});
