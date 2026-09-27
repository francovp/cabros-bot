'use strict';

const admin = require('firebase-admin');
const NewsAnalysisStorageService = require('../../src/services/storage/NewsAnalysisStorageService');

const {
	__mockCollection: mockCollection,
	__mockDocSet: mockDocSet,
	__mockWhere: mockWhere,
	__mockOrderBy: mockOrderBy,
	__mockLimit: mockLimit,
	__resetCollectionState: resetCollectionState,
} = admin;

describe('NewsAnalysisStorageService', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		resetCollectionState();
		NewsAnalysisStorageService.__resetFirestoreClient();
		process.env = { ...originalEnv };
		process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'true';
	});

	afterAll(() => {
		process.env = originalEnv;
	});

	describe('configuration & gating', () => {
		it('reports isEnabled() === true when ENABLE_FIRESTORE_NEWS_ANALYSIS=true', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'true';
			expect(NewsAnalysisStorageService.isEnabled()).toBe(true);
		});

		it('reports isEnabled() === false when ENABLE_FIRESTORE_NEWS_ANALYSIS is false or unset', () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			expect(NewsAnalysisStorageService.isEnabled()).toBe(false);
			delete process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS;
			expect(NewsAnalysisStorageService.isEnabled()).toBe(false);
		});

		it('uses default retention days 30 when unset or invalid', () => {
			delete process.env.NEWS_ANALYSIS_RETENTION_DAYS;
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);

			process.env.NEWS_ANALYSIS_RETENTION_DAYS = 'invalid';
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);

			process.env.NEWS_ANALYSIS_RETENTION_DAYS = '500'; // above 365
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);

			process.env.NEWS_ANALYSIS_RETENTION_DAYS = '0'; // below 1
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(30);
		});

		it('uses valid configured retention days', () => {
			process.env.NEWS_ANALYSIS_RETENTION_DAYS = '60';
			expect(NewsAnalysisStorageService.getRetentionDays()).toBe(60);
		});
	});

	describe('stripUndefinedFieldsDeep', () => {
		it('recursively removes undefined fields while keeping null and other values', () => {
			const input = {
				a: 1,
				b: undefined,
				c: null,
				d: {
					e: undefined,
					f: 'hello',
					g: [1, undefined, 2, { h: undefined, i: true }],
				},
			};
			const sanitized = NewsAnalysisStorageService.stripUndefinedFieldsDeep(input);
			expect(sanitized).toEqual({
				a: 1,
				c: null,
				d: {
					f: 'hello',
					g: [1, 2, { i: true }],
				},
			});
		});
	});

	describe('recordAnalysis', () => {
		it('returns null and does not write if isEnabled() is false', async () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			const result = await NewsAnalysisStorageService.recordAnalysis({ symbol: 'BTCUSDT' });
			expect(result).toBeNull();
		});

		it('persists a complete analysis document with sanitized fields', async () => {
			const record = {
				symbol: 'btcusdt',
				eventCategory: 'price_surge',
				sentiment: 0.85,
				confidence: 0.9,
				headline: 'Bitcoin crosses key level',
				alertSent: true,
				promptVersion: 'v2.1',
				tokens: 1540.6,
			};

			const savedId = await NewsAnalysisStorageService.recordAnalysis(record);
			expect(savedId).toBeTruthy();

			// Read back from mock collection state
			const { analyses } = await NewsAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(analyses).toHaveLength(1);
			const saved = analyses[0];
			expect(saved.id).toBe(savedId);
			expect(saved.symbol).toBe('BTCUSDT');
			expect(saved.eventCategory).toBe('price_surge');
			expect(saved.sentiment).toBe(0.85);
			expect(saved.confidence).toBe(0.9);
			expect(saved.headline).toBe('Bitcoin crosses key level');
			expect(saved.alertSent).toBe(true);
			expect(saved.promptVersion).toBe('v2.1');
			expect(saved.tokens).toBe(1541);
		});

		it('strips undefined promptVersion and defaults missing values gracefully', async () => {
			const record = {
				symbol: 'ETHUSDT',
				eventCategory: undefined,
				sentiment: undefined,
				confidence: undefined,
				headline: undefined,
				alertSent: false,
				promptVersion: undefined,
				tokens: undefined,
			};

			const savedId = await NewsAnalysisStorageService.recordAnalysis(record);
			expect(savedId).toBeTruthy();

			const { analyses } = await NewsAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(analyses).toHaveLength(1);
			const saved = analyses[0];
			expect(saved.symbol).toBe('ETHUSDT');
			expect(saved.eventCategory).toBe('none');
			expect(saved.sentiment).toBe(0);
			expect(saved.confidence).toBe(0);
			expect(saved.headline).toBe('');
			expect(saved.alertSent).toBe(false);
			expect(saved.promptVersion).toBeNull();
			expect(saved.tokens).toBeNull();
		});

		it('fails open when Firestore write rejects', async () => {
			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
			mockDocSet.mockImplementationOnce(() => Promise.reject(new Error('Firestore write quota exceeded')));

			const savedId = await NewsAnalysisStorageService.recordAnalysis({ symbol: 'SOLUSDT' });
			expect(savedId).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[NewsAnalysisStorageService] Failed to record news analysis:'),
				'Firestore write quota exceeded',
			);
			warnSpy.mockRestore();
		});
	});

	describe('recordAnalyses', () => {
		it('records multiple analyses concurrently and returns array of ids', async () => {
			const records = [
				{ symbol: 'BTCUSDT', confidence: 0.8, alertSent: true },
				{ symbol: 'ETHUSDT', confidence: 0.6, alertSent: false },
			];
			const ids = await NewsAnalysisStorageService.recordAnalyses(records);
			expect(ids).toHaveLength(2);

			const { analyses } = await NewsAnalysisStorageService.listAnalyses({ limit: 10 });
			expect(analyses).toHaveLength(2);
		});

		it('returns empty array when records is empty or invalid', async () => {
			expect(await NewsAnalysisStorageService.recordAnalyses([])).toEqual([]);
			expect(await NewsAnalysisStorageService.recordAnalyses(null)).toEqual([]);
		});
	});

	describe('summarizeAnalyses', () => {
		it('throws FEATURE_DISABLED error when disabled', async () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';
			await expect(NewsAnalysisStorageService.summarizeAnalyses()).rejects.toMatchObject({
				code: 'FEATURE_DISABLED',
			});
		});

		it('aggregates per-symbol and per-eventCategory metrics', async () => {
			// Record test data
			await NewsAnalysisStorageService.recordAnalyses([
				{ symbol: 'BTCUSDT', eventCategory: 'price_surge', confidence: 0.8, alertSent: true },
				{ symbol: 'BTCUSDT', eventCategory: 'regulatory', confidence: 0.6, alertSent: false },
				{ symbol: 'ETHUSDT', eventCategory: 'price_surge', confidence: 0.9, alertSent: true },
			]);

			const summary = await NewsAnalysisStorageService.summarizeAnalyses();
			expect(summary.totalAnalyses).toBe(3);
			expect(summary.totalAlertsSent).toBe(2);

			// bySymbol
			expect(summary.bySymbol.BTCUSDT).toEqual({
				totalAnalyses: 2,
				alertsSent: 1,
				averageConfidence: 0.7,
			});
			expect(summary.bySymbol.ETHUSDT).toEqual({
				totalAnalyses: 1,
				alertsSent: 1,
				averageConfidence: 0.9,
			});

			// byEventCategory
			expect(summary.byEventCategory.price_surge).toEqual({
				total: 2,
				alertsSent: 2,
				averageConfidence: 0.85,
			});
			expect(summary.byEventCategory.regulatory).toEqual({
				total: 1,
				alertsSent: 0,
				averageConfidence: 0.6,
			});
		});

		it('computes false-positive proxy metric accurately', async () => {
			const now = Date.now();
			// Mock records directly with simulated createdAt timestamps
			const collectionState = global.__firebaseAdminMockState.collections.get('news_analysis') || new Map();
			global.__firebaseAdminMockState.collections.set('news_analysis', collectionState);

			// Alert 1: BTC alert at t=0 (confidence 0.85)
			collectionState.set('doc-1', {
				id: 'doc-1',
				symbol: 'BTCUSDT',
				eventCategory: 'price_surge',
				confidence: 0.85,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 100000) },
			});
			// Alert 2: BTC alert at t=1 hour later (confidence 0.8) -> Follows up Alert 1!
			collectionState.set('doc-2', {
				id: 'doc-2',
				symbol: 'BTCUSDT',
				eventCategory: 'price_surge',
				confidence: 0.8,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 100000 + 3600000) },
			});
			// Alert 3: ETH alert with high confidence but NO follow up within 24h
			collectionState.set('doc-3', {
				id: 'doc-3',
				symbol: 'ETHUSDT',
				eventCategory: 'regulatory',
				confidence: 0.9,
				alertSent: true,
				createdAt: { toDate: () => new Date(now - 200000) },
			});

			const summary = await NewsAnalysisStorageService.summarizeAnalyses({ threshold: 0.75 });
			// Total evaluated alerts: 3 (Alert 1, Alert 2, Alert 3 all have confidence >= 0.75 and alertSent=true)
			// Alert 1 had follow-up (Alert 2).
			// Alert 2 had NO follow-up.
			// Alert 3 had NO follow-up.
			// No followup count = 2 / 3 = 66.67%
			expect(summary.falsePositiveProxy.totalEvaluated).toBe(3);
			expect(summary.falsePositiveProxy.noFollowupCount).toBe(2);
			expect(summary.falsePositiveProxy.ratePercent).toBe(66.67);
		});
	});

	describe('listAnalyses', () => {
		it('returns paginated analyses with nextCursor', async () => {
			await NewsAnalysisStorageService.recordAnalyses([
				{ symbol: 'BTCUSDT', confidence: 0.8 },
				{ symbol: 'ETHUSDT', confidence: 0.7 },
				{ symbol: 'SOLUSDT', confidence: 0.9 },
			]);

			const result = await NewsAnalysisStorageService.listAnalyses({ limit: 2 });
			expect(result.analyses).toHaveLength(2);
			expect(result.nextCursor).toBeTruthy();
		});
	});
});
