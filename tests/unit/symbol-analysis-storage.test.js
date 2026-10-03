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

		it('prefers RemoteConfig value when available', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.ENABLE_SYMBOL_ANALYSIS_STORAGE = 'false';
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_SYMBOL_ANALYSIS_STORAGE: true });
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

		it('uses RemoteConfig override when available', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.SYMBOL_ANALYSIS_RETENTION_DAYS = '14';
			remoteConfigService._setRemoteOverridesForTesting({ SYMBOL_ANALYSIS_RETENTION_DAYS: 30 });
			expect(SymbolAnalysisStorageService.getRetentionDays()).toBe(30);
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
});
