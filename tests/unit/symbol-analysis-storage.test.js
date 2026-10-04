'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const SymbolAnalysisStorageService = require('../../src/services/storage/SymbolAnalysisStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

const {
	__mockDocSet: mockDocSet,
	__mockInitializeApp: mockInitializeApp,
	__resetCollectionState: mockResetCollectionState,
} = admin;

describe('SymbolAnalysisStorageService', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		jest.useFakeTimers().setSystemTime(new Date('2026-06-06T12:00:00.000Z'));
		admin.__resetApps();
		if (typeof mockResetCollectionState === 'function') {
			mockResetCollectionState();
		}
		if (global.__firebaseAdminMockState?.collections) {
			global.__firebaseAdminMockState.collections.clear();
		}
		SymbolAnalysisStorageService.__resetFirestoreClient();
		remoteConfigService._resetForTesting();
		delete process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE;
		delete process.env.SYMBOL_ANALYSIS_RETENTION_DAYS;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	});

	afterEach(() => {
		jest.useRealTimers();
		delete process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE;
		delete process.env.SYMBOL_ANALYSIS_RETENTION_DAYS;
		delete process.env.FIREBASE_PROJECT_ID;
		delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
	});

	describe('isEnabled()', () => {
		it('returns false by default when not configured', () => {
			expect(SymbolAnalysisStorageService.isEnabled()).toBe(false);
		});

		it('returns true when process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE is "true"', () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			expect(SymbolAnalysisStorageService.isEnabled()).toBe(true);
		});

		it('returns false when process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE is "false"', () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			expect(SymbolAnalysisStorageService.isEnabled()).toBe(false);
		});

		// The gate is environment-only. A published server template outranks
		// render.yaml, so allowing the key here would let the template silently
		// override the blueprint's `true` and keep the enablement inert.
		it('ignores a Remote Config override because the gate is environment-only', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_SYMBOL_ANALYSIS_STORAGE: true });
			expect(SymbolAnalysisStorageService.isEnabled()).toBe(false);

			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			expect(SymbolAnalysisStorageService.isEnabled()).toBe(true);
		});
	});

	describe('getRetentionDays()', () => {
		it('returns default 7 days when unset', () => {
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(7);
		});

		it('returns valid integer from environment', () => {
			process.env.SYMBOL_ANALYSIS_RETENTION_DAYS = '14';
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(14);
		});

		it('falls back to default 7 days if environment value is out of bounds', () => {
			process.env.SYMBOL_ANALYSIS_RETENTION_DAYS = '0';
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(7);

			process.env.SYMBOL_ANALYSIS_RETENTION_DAYS = '500';
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(7);

			process.env.SYMBOL_ANALYSIS_RETENTION_DAYS = 'invalid';
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(7);
		});

		it('ignores a Remote Config override because the retention horizon is environment-only', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.SYMBOL_ANALYSIS_RETENTION_DAYS = '14';
			remoteConfigService._setRemoteOverridesForTesting({ SYMBOL_ANALYSIS_RETENTION_DAYS: 30 });
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(14);
		});
	});

	describe('buildRetentionExpiryTimestamp()', () => {
		it('calculates expiresAt timestamp based on retention days', () => {
			const nowMs = new Date('2026-06-06T12:00:00.000Z').getTime();
			const expiry = SymbolAnalysisStorageService.buildRetentionExpiryTimestamp(nowMs);
			const expectedDate = new Date(nowMs + 7 * 24 * 60 * 60 * 1000);
			expect(expiry.toDate()).toEqual(expectedDate);
		});
	});

	describe('stripUndefinedFieldsDeep()', () => {
		it('removes undefined fields recursively while keeping null and defined values', () => {
			const input = {
				a: 1,
				b: undefined,
				c: null,
				nested: {
					d: undefined,
					e: 'valid',
					f: [1, undefined, 2],
				},
			};

			const cleaned = SymbolAnalysisStorageService.stripUndefinedFieldsDeep(input);
			expect(cleaned).toEqual({
				a: 1,
				c: null,
				nested: {
					e: 'valid',
					f: [1, 2],
				},
			});
		});
	});

	describe('recordAnalysis()', () => {
		it('returns null when feature is disabled', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			const result = await SymbolAnalysisStorageService.recordAnalysis({ symbol: 'BINANCE:BTCUSDT' });
			expect(result).toBeNull();
			expect(mockDocSet).not.toHaveBeenCalled();
		});

		it('persists a complete symbol analysis record and returns document ID', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			const record = {
				requestId: 'test-req-123',
				symbol: 'BINANCE:BTCUSDT',
				asset: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				analysisMode: 'standard',
				decision: {
					action: 'BUY',
					confidence: 0.85,
					dataSufficient: true,
				},
				price: 65432.1,
				rsi: 45.6,
				indicators: {
					bbUpper: 67000,
					bbLower: 63000,
					sma20: 65000,
					macd: 120.5,
					macdSignal: 110.2,
					atr: 500,
					adx: 25.4,
					volumeRatio: 1.35,
				},
				risk: {
					riskRewardRatio: 2.5,
					invalidationLevel: 64000,
					targetLevel: 69000,
					valid: true,
				},
				multiTimeframe: true,
				analysisStatus: 'complete',
				processingTimeMs: 1450,
			};

			const savedId = await SymbolAnalysisStorageService.recordAnalysis(record);
			expect(savedId).toBe('test-req-123');
			expect(mockDocSet).toHaveBeenCalledTimes(1);

			const savedData = mockDocSet.mock.calls[0][0];
			expect(savedData.requestId).toBe('test-req-123');
			expect(savedData.symbol).toBe('BINANCE:BTCUSDT');
			expect(savedData.asset).toBe('BTCUSDT');
			expect(savedData.exchange).toBe('BINANCE');
			expect(savedData.timeframe).toBe('1h');
			expect(savedData.decision.action).toBe('BUY');
			expect(savedData.decision.confidence).toBe(0.85);
			expect(savedData.price).toBe(65432.1);
			expect(savedData.rsi).toBe(45.6);
			expect(savedData.multiTimeframe).toBe(true);
			expect(savedData.analysisStatus).toBe('complete');
			expect(savedData.processingTimeMs).toBe(1450);
			expect(savedData.expiresAt).toBeDefined();
			expect(savedData.createdAt).toBeDefined();
		});

		it('strips undefined properties before saving to Firestore', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			const record = {
				requestId: 'test-req-undef',
				symbol: 'BINANCE:ETHUSDT',
				asset: 'ETHUSDT',
				exchange: 'BINANCE',
				timeframe: '4h',
				decision: {
					action: 'NO_TRADE',
					confidence: undefined,
				},
				price: 3500,
				rsi: undefined,
				indicators: {
					sma20: undefined,
					volumeRatio: 0.9,
				},
			};

			const savedId = await SymbolAnalysisStorageService.recordAnalysis(record);
			expect(savedId).toBe('test-req-undef');

			const savedData = mockDocSet.mock.calls[0][0];
			expect(savedData.decision.confidence).toBeUndefined();
			expect(savedData.rsi).toBeUndefined();
			expect(savedData.indicators.sma20).toBeUndefined();
			expect(savedData.indicators.volumeRatio).toBe(0.9);
		});

		it('fails open when Firestore throws', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			mockDocSet.mockRejectedValueOnce(new Error('Firestore write quota exceeded'));
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			const result = await SymbolAnalysisStorageService.recordAnalysis({
				requestId: 'test-fail',
				symbol: 'BINANCE:SOLUSDT',
			});

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[SymbolAnalysisStorageService] Failed to record symbol analysis:'),
				expect.stringContaining('quota exceeded'),
			);
			warnSpy.mockRestore();
		});
	});

	describe('summarizeAnalyses()', () => {
		it('throws FEATURE_DISABLED when disabled', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			await expect(SymbolAnalysisStorageService.summarizeAnalyses()).rejects.toThrow(
				expect.objectContaining({ code: 'FEATURE_DISABLED' }),
			);
		});

		it('aggregates counts by action, symbol, timeframe, and exchange', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			const collectionState = global.__firebaseAdminMockState.collections.get('symbolAnalyses') || new Map();
			global.__firebaseAdminMockState.collections.set('symbolAnalyses', collectionState);

			collectionState.set('doc-1', {
				id: 'doc-1',
				symbol: 'BINANCE:BTCUSDT',
				asset: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				decision: { action: 'BUY', confidence: 0.8 },
				price: 60000,
				rsi: 40,
				createdAt: { toDate: () => new Date('2026-06-06T10:00:00.000Z') },
			});
			collectionState.set('doc-2', {
				id: 'doc-2',
				symbol: 'BINANCE:BTCUSDT',
				asset: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				decision: { action: 'BUY', confidence: 0.9 },
				price: 61000,
				rsi: 50,
				createdAt: { toDate: () => new Date('2026-06-06T11:00:00.000Z') },
			});
			collectionState.set('doc-3', {
				id: 'doc-3',
				symbol: 'BINANCE:ETHUSDT',
				asset: 'ETHUSDT',
				exchange: 'BINANCE',
				timeframe: '4h',
				decision: { action: 'NO_TRADE', confidence: 0.5 },
				price: 3000,
				rsi: 55,
				createdAt: { toDate: () => new Date('2026-06-06T11:30:00.000Z') },
			});

			const summary = await SymbolAnalysisStorageService.summarizeAnalyses();
			expect(summary.success).toBe(true);
			expect(summary.totalAnalyses).toBe(3);
			expect(summary.byAction).toEqual({
				BUY: 2,
				SELL: 0,
				NO_TRADE: 1,
			});
			expect(summary.bySymbol['BINANCE:BTCUSDT']).toEqual({
				count: 2,
				actions: { BUY: 2, SELL: 0, NO_TRADE: 0 },
				avgConfidence: 0.85,
				avgPrice: 60500,
			});
			expect(summary.byTimeframe['1h']).toEqual({
				count: 2,
				actions: { BUY: 2, SELL: 0, NO_TRADE: 0 },
			});
			expect(summary.byTimeframe['4h']).toEqual({
				count: 1,
				actions: { BUY: 0, SELL: 0, NO_TRADE: 1 },
			});
		});
	});

	// Issue #1179 turns symbol-analysis persistence on in production. Until this
	// change, `getStatus()` derived `status: 'ready'` from credential shape alone
	// (`enabled && configured`), so flipping the flag immediately painted a green
	// checkmark on a deployment that had never persisted a single analysis — and
	// because every Firestore error here is swallowed into a `null` return, the
	// operator had no signal that the enablement was not taking effect. This is the
	// repo's "shape is not readiness" rule, previously applied to
	// `firebaseRemoteConfig.ready` (#598), `equityMarketData.ready` (#1116), durable
	// idempotency (#1111) and Firestore `readHealth` (#1285).
	describe('durable readiness is proven, not inferred from credential shape (issue #1179)', () => {
		const originalEnv = { ...process.env };

		// `isFirestoreConfigured()` parses the private key with `createPrivateKey`, so a
		// placeholder string never reaches `configured: true`. A real throwaway key keeps
		// these tests on the credential-shape path without checking one into the repo.
		const TEST_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
			modulusLength: 2048,
			privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
			publicKeyEncoding: { type: 'spki', format: 'pem' },
		}).privateKey;

		const VALID_SERVICE_ACCOUNT = JSON.stringify({
			type: 'service_account',
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: TEST_PRIVATE_KEY,
		});

		// Passes `isFirestoreConfigured()` (project id, client email, parseable key) but is
		// refused by the credential loader as an inline ADC document — the documented case
		// from issue #1127, which issue #1128 made a non-`ok` initialization instead of an
		// `initializeApp({})` default-auth call.
		const INLINE_AUTHORIZED_USER = JSON.stringify({
			type: 'authorized_user',
			project_id: 'test-project',
			client_email: 'test@example.com',
			private_key: TEST_PRIVATE_KEY,
			client_id: 'client-id',
			client_secret: 'client-secret',
			refresh_token: 'refresh-token',
		});

		function enableWithValidCredentials() {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
			admin.__resetApps();
			SymbolAnalysisStorageService.__resetForTesting();
		}

		beforeEach(() => {
			Object.keys(process.env).forEach((key) => {
				if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
					delete process.env[key];
				}
			});
			Object.assign(process.env, originalEnv);
			SymbolAnalysisStorageService.__resetForTesting();
			admin.__resetApps();
			mockDocSet.mockReset();
			mockDocSet.mockResolvedValue(undefined);
			if (typeof mockResetCollectionState === 'function') {
				mockResetCollectionState();
			}
			remoteConfigService._resetForTesting();
		});

		afterEach(() => {
			SymbolAnalysisStorageService.__resetForTesting();
			admin.__resetApps();
			mockDocSet.mockReset();
			Object.keys(process.env).forEach((key) => {
				if (!Object.prototype.hasOwnProperty.call(originalEnv, key)) {
					delete process.env[key];
				}
			});
			Object.assign(process.env, originalEnv);
		});

		it('reports disabled and not ready when the flag is off, with no counters touched', () => {
			delete process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE;

			const status = SymbolAnalysisStorageService.getStatus();

			expect(status.enabled).toBe(false);
			expect(status.ready).toBe(false);
			expect(status.status).toBe('disabled');
			expect(status.readiness).toBe('unverified');
			expect(status.writesAttempted).toBe(0);
			expect(status.collection).toBe('symbolAnalyses');
			expect(status.retentionDays).toBe(7);
		});

		it('reports unverified, not ready, when enabled and configured but nothing has persisted yet', () => {
			enableWithValidCredentials();

			const status = SymbolAnalysisStorageService.getStatus();

			expect(status.enabled).toBe(true);
			expect(status.configured).toBe(true);
			// The proof question is deliberately separate from the intent question: a fresh
			// deployment that has never written an analysis is NOT evidence of health.
			expect(status.ready).toBe(false);
			expect(status.readiness).toBe('unverified');
			expect(status.status).toBe('unverified');
			expect(status.writesAttempted).toBe(0);
			expect(status.writesSucceeded).toBe(0);
			expect(status.failOpen).toBe(true);
		});

		it('reports ready only after an observed successful write', async () => {
			enableWithValidCredentials();

			await SymbolAnalysisStorageService.recordAnalysis({
				requestId: 'req-ready',
				symbol: 'BINANCE:BTCUSDT',
				decision: { action: 'BUY', confidence: 0.8 },
			});

			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.ready).toBe(true);
			expect(status.readiness).toBe('verified');
			expect(status.status).toBe('ready');
			expect(status.writesAttempted).toBe(1);
			expect(status.writesSucceeded).toBe(1);
			expect(status.lastWriteAt).toEqual(expect.any(String));
			expect(status.lastErrorReason).toBeNull();
		});

		it('reports degraded when a write fails, and self-heals on the next success', async () => {
			enableWithValidCredentials();
			mockDocSet.mockRejectedValueOnce(new Error('firestore unavailable'));

			const failedId = await SymbolAnalysisStorageService.recordAnalysis({
				requestId: 'req-degraded',
				symbol: 'BINANCE:BTCUSDT',
			});

			// Fail-open: the caller still gets the analysis response, so the record is dropped.
			expect(failedId).toBeNull();

			const degraded = SymbolAnalysisStorageService.getStatus();
			expect(degraded.ready).toBe(false);
			expect(degraded.readiness).toBe('degraded');
			expect(degraded.status).toBe('degraded');
			expect(degraded.writesFailed).toBe(1);
			expect(degraded.consecutiveFailures).toBe(1);

			await SymbolAnalysisStorageService.recordAnalysis({ requestId: 'req-recovered' });

			const recovered = SymbolAnalysisStorageService.getStatus();
			expect(recovered.ready).toBe(true);
			expect(recovered.status).toBe('ready');
			expect(recovered.consecutiveFailures).toBe(0);
		});

		it('counts a durable-use attempt even when Firebase initialization is rejected', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = INLINE_AUTHORIZED_USER;
			admin.__resetApps();
			SymbolAnalysisStorageService.__resetForTesting();
			const initializeSpy = jest.spyOn(admin, 'initializeApp');

			// `configured` is still true (credential *shape* is valid), so without a recorded
			// rejection the status would read as an unproven `ready`.
			expect(SymbolAnalysisStorageService.getStatus().configured).toBe(true);
			expect(await SymbolAnalysisStorageService.recordAnalysis({ requestId: 'req-bad-creds' })).toBeNull();

			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.status).toBe('degraded');
			expect(status.writesAttempted).toBe(1);
			expect(status.lastErrorReason).toBe('firestore_not_initialized');
			// Issue #1128: a rejected initialization must never fall through to default auth.
			expect(initializeSpy).not.toHaveBeenCalled();
			initializeSpy.mockRestore();
		});

		it('constrains lastErrorReason to a closed enum so a provider message can never leak', async () => {
			enableWithValidCredentials();
			mockDocSet.mockRejectedValueOnce(
				new Error('Firestore write failed at projects/test-project/databases/(default)/documents/symbolAnalyses/req'),
			);

			await SymbolAnalysisStorageService.recordAnalysis({ requestId: 'req-leak' });

			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.lastErrorReason).toBe('firestore_unavailable');
			expect(JSON.stringify(status)).not.toContain('projects/test-project');
		});

		it('never registers a durable attempt from a status read alone', () => {
			enableWithValidCredentials();

			SymbolAnalysisStorageService.getStatus();
			SymbolAnalysisStorageService.getStatus();
			const status = SymbolAnalysisStorageService.getStatus();

			// A status poll is not evidence of Firestore health; recording it would let an
			// operator manufacture `ready` by watching /api/status.
			expect(status.writesAttempted).toBe(0);
			expect(status.readsAttempted).toBe(0);
			expect(status.ready).toBe(false);
		});

		it('reports misconfigured when enabled without usable credentials', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
			delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
			process.env.HOME = '/nonexistent-home-for-tests';
			process.env.GCE_METADATA_HOST = '';
			process.env.K_SERVICE = '';
			process.env.FUNCTION_TARGET = '';
			admin.__resetApps();
			SymbolAnalysisStorageService.__resetForTesting();

			await SymbolAnalysisStorageService.recordAnalysis({ requestId: 'req-unconfigured' });

			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.enabled).toBe(true);
			expect(status.configured).toBe(false);
			expect(status.status).toBe('misconfigured');
			expect(status.ready).toBe(false);
		});

		it('lets gate state win over observed readiness', async () => {
			enableWithValidCredentials();
			await SymbolAnalysisStorageService.recordAnalysis({ requestId: 'req-verified' });
			expect(SymbolAnalysisStorageService.getStatus().status).toBe('ready');

			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			const afterDisable = SymbolAnalysisStorageService.getStatus();
			expect(afterDisable.status).toBe('disabled');
			expect(afterDisable.ready).toBe(false);
			// The observed window survives so an operator can still see what happened.
			expect(afterDisable.writesSucceeded).toBe(1);
		});

		it('tracks reads separately from writes so a read cannot imply a write succeeded', async () => {
			enableWithValidCredentials();

			await SymbolAnalysisStorageService.listAnalyses({ limit: 5 });

			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.readsAttempted).toBe(1);
			expect(status.readsSucceeded).toBe(1);
			expect(status.writesSucceeded).toBe(0);
			// Persistence is the feature; a successful read proves reachability, not that
			// analyses are being stored, so it does not flip the verdict to `ready`.
			expect(status.ready).toBe(false);
			expect(status.status).toBe('unverified');
		});
	});

	describe('listAnalyses()', () => {
		it('throws FEATURE_DISABLED when disabled', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			await expect(SymbolAnalysisStorageService.listAnalyses()).rejects.toThrow(
				expect.objectContaining({ code: 'FEATURE_DISABLED' }),
			);
		});

		it('returns formatted documents with pagination', async () => {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			const collectionState = global.__firebaseAdminMockState.collections.get('symbolAnalyses') || new Map();
			global.__firebaseAdminMockState.collections.set('symbolAnalyses', collectionState);

			collectionState.set('doc-1', {
				id: 'doc-1',
				symbol: 'BINANCE:BTCUSDT',
				asset: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				decision: { action: 'BUY', confidence: 0.8 },
				price: 60000,
				createdAt: { toDate: () => new Date('2026-06-06T10:00:00.000Z') },
			});

			const result = await SymbolAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(result.success).toBe(true);
			expect(result.count).toBe(1);
			expect(result.limit).toBe(10);
			expect(result.analyses).toHaveLength(1);
			expect(result.analyses[0].id).toBe('doc-1');
			expect(result.analyses[0].symbol).toBe('BINANCE:BTCUSDT');
		});
	});

	// A rejected `query.get()` was rethrown as-is and carries no `code`, so the
	// controller fell through to its 500 branch instead of the contractual 503.
	describe('read failure mapping (503 STORAGE_UNAVAILABLE)', () => {
		const VALID_SERVICE_ACCOUNT = JSON.stringify({
			type: 'service_account',
			project_id: 'demo-cabros',
			client_email: 'firebase-adminsdk@demo-cabros.iam.gserviceaccount.com',
			private_key: crypto.generateKeyPairSync('rsa', {
				modulusLength: 2048,
				privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
				publicKeyEncoding: { type: 'spki', format: 'pem' },
			}).privateKey,
		});

		// The fully-qualified project/database path is what makes a raw Firestore
		// message unsafe to return: it is echoed by the 503 body, which the
		// controller sends as `error.message`.
		const providerError = () => {
			const error = new Error(
				'5 NOT_FOUND: no matching index found. The query is rejected for projects/test-project/databases/(default).',
			);
			error.code = 5;
			return error;
		};

		function enableWithReachableCredentials() {
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'true';
			process.env.FIREBASE_SERVICE_ACCOUNT_JSON = VALID_SERVICE_ACCOUNT;
			admin.__resetApps();
			SymbolAnalysisStorageService.__resetForTesting();
		}

		beforeEach(() => {
			enableWithReachableCredentials();
		});

		afterEach(() => {
			admin.__mockGet.mockReset();
		});

		it('maps a listAnalyses read rejection to STORAGE_UNAVAILABLE without leaking provider text', async () => {
			admin.__mockGet.mockReturnValue(Promise.reject(providerError()));

			const error = await SymbolAnalysisStorageService.listAnalyses({ limit: 5 }).catch((thrown) => thrown);

			expect(error).toBeInstanceOf(Error);
			expect(error.code).toBe('STORAGE_UNAVAILABLE');
			expect(error.message).not.toContain('projects/test-project/databases/(default)');
			expect(error.message).not.toContain('NOT_FOUND');

			// The observed window still records the failed read so status degrades.
			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.readsAttempted).toBe(1);
			expect(status.readsFailed).toBe(1);
			expect(status.readsSucceeded).toBe(0);
			expect(status.status).toBe('degraded');
			expect(status.lastErrorReason).toBe('firestore_unavailable');
		});

		it('maps a summarizeAnalyses read rejection to STORAGE_UNAVAILABLE without leaking provider text', async () => {
			admin.__mockGet.mockReturnValue(Promise.reject(providerError()));

			const error = await SymbolAnalysisStorageService.summarizeAnalyses({ limit: 5 }).catch((thrown) => thrown);

			expect(error).toBeInstanceOf(Error);
			expect(error.code).toBe('STORAGE_UNAVAILABLE');
			expect(error.message).not.toContain('projects/test-project/databases/(default)');
			expect(error.message).not.toContain('NOT_FOUND');

			const status = SymbolAnalysisStorageService.getStatus();
			expect(status.readsFailed).toBe(1);
			expect(status.status).toBe('degraded');
		});

		it('keeps an already-classified code rather than overwriting it', async () => {
			const original = providerError();
			original.code = 'INVALID_REQUEST';
			admin.__mockGet.mockReturnValue(Promise.reject(original));

			const error = await SymbolAnalysisStorageService.listAnalyses({ limit: 5 }).catch((thrown) => thrown);

			expect(error).toBe(original);
			expect(error.code).toBe('INVALID_REQUEST');
		});
	});
});
