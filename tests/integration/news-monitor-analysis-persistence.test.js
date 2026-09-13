'use strict';

const request = require('supertest');
const express = require('express');
const admin = require('firebase-admin');
const { getRoutes } = require('../../src/routes');
const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');
const NewsAnalysisStorageService = require('../../src/services/storage/NewsAnalysisStorageService');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('News Monitor Analysis Persistence & Endpoints Integration', () => {
	let savedEnv;
	let app;

	beforeEach(() => {
		savedEnv = saveEnv();
		process.env = {
			...process.env,
			NODE_ENV: 'test',
			WEBHOOK_API_KEY: 'test-api-key',
			ENABLE_NEWS_MONITOR: 'true',
			ENABLE_FIRESTORE_NEWS_ANALYSIS: 'true',
			FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({
				type: 'service_account',
				project_id: 'cabros-bot-test',
			}),
		};

		jest.clearAllMocks();
		admin.__resetCollectionState();
		NewsAnalysisStorageService.__resetFirestoreClient();
		getCacheInstance().clear();

		// Mock Gemini analyzeNewsForSymbol
		const gemini = require('../../src/services/grounding/gemini');
		if (typeof gemini.analyzeNewsForSymbol?.mockResolvedValue === 'function') {
			gemini.analyzeNewsForSymbol.mockReset().mockResolvedValue({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.75,
				headline: 'Bitcoin surges past resistance',
				confidence: 0.82,
				promptVersion: 'v1.0.0',
				sources: [{ title: 'News 1', url: 'https://example.com/1' }],
			});
		} else {
			gemini.analyzeNewsForSymbol = jest.fn().mockResolvedValue({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.75,
				headline: 'Bitcoin surges past resistance',
				confidence: 0.82,
				promptVersion: 'v1.0.0',
				sources: [{ title: 'News 1', url: 'https://example.com/1' }],
			});
		}

		app = express();
		app.use(express.json());
		app.use('/api', getRoutes(() => null));
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	describe('Feature flag gating & authentication', () => {
		it('rejects /api/news-monitor/summary with 401 when API key is missing', async () => {
			const res = await request(app).get('/api/news-monitor/summary');
			expect(res.status).toBe(401);
		});

		it('rejects /api/news-monitor/analyses with 401 when API key is missing', async () => {
			const res = await request(app).get('/api/news-monitor/analyses');
			expect(res.status).toBe(401);
		});

		it('returns 403 FEATURE_DISABLED when ENABLE_FIRESTORE_NEWS_ANALYSIS is disabled', async () => {
			process.env.ENABLE_FIRESTORE_NEWS_ANALYSIS = 'false';

			const summaryRes = await request(app)
				.get('/api/news-monitor/summary')
				.set('x-api-key', 'test-api-key');
			expect(summaryRes.status).toBe(403);
			expect(summaryRes.body.code).toBe('FEATURE_DISABLED');

			const listRes = await request(app)
				.get('/api/news-monitor/analyses')
				.set('x-api-key', 'test-api-key');
			expect(listRes.status).toBe(403);
			expect(listRes.body.code).toBe('FEATURE_DISABLED');
		});
	});

	describe('Persistence behavior during /api/news-monitor POST', () => {
		it('persists analysis records and maintains public response contract without analysisRecord leak', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-api-key')
				.send({
					crypto: ['BTCUSDT'],
					stocks: [],
					dryRun: false,
				});

			expect(res.status).toBe(200);
			expect(res.body.success).toBe(true);
			expect(res.body.results).toHaveLength(1);
			// Verify analysisRecord is stripped from response
			expect(res.body.results[0].analysisRecord).toBeUndefined();

			// Give fire-and-forget promise time to resolve
			await new Promise((resolve) => setTimeout(resolve, 50));

			// Verify record was persisted to Firestore collection
			const listRes = await request(app)
				.get('/api/news-monitor/analyses')
				.set('x-api-key', 'test-api-key');
			expect(listRes.status).toBe(200);
			expect(listRes.body.analyses).toHaveLength(1);
			const saved = listRes.body.analyses[0];
			expect(saved.symbol).toBe('BTCUSDT');
			expect(saved.eventCategory).toBe('price_surge');
			expect(saved.sentiment).toBe(0.75);
			expect(saved.confidence).toBe(0.82);
			expect(saved.headline).toBe('Bitcoin surges past resistance');
			expect(saved.promptVersion).toBe('v1.0.0');
		});

		it('does NOT persist analysis records when dryRun is true', async () => {
			const res = await request(app)
				.post('/api/news-monitor')
				.set('x-api-key', 'test-api-key')
				.send({
					crypto: ['BTCUSDT'],
					stocks: [],
					dryRun: true,
				});

			expect(res.status).toBe(200);
			expect(res.body.dryRun).toBe(true);

			await new Promise((resolve) => setTimeout(resolve, 50));

			const listRes = await request(app)
				.get('/api/news-monitor/analyses')
				.set('x-api-key', 'test-api-key');
			expect(listRes.status).toBe(200);
			expect(listRes.body.analyses).toHaveLength(0);
		});
	});

	describe('GET /api/news-monitor/summary validation and execution', () => {
		it('validates invalid query parameters', async () => {
			const invalidLimit = await request(app)
				.get('/api/news-monitor/summary?limit=invalid')
				.set('x-api-key', 'test-api-key');
			expect(invalidLimit.status).toBe(400);
			expect(invalidLimit.body.code).toBe('INVALID_REQUEST');

			const invalidThreshold = await request(app)
				.get('/api/news-monitor/summary?threshold=2.5')
				.set('x-api-key', 'test-api-key');
			expect(invalidThreshold.status).toBe(400);
			expect(invalidThreshold.body.code).toBe('INVALID_REQUEST');

			const invalidFrom = await request(app)
				.get('/api/news-monitor/summary?from=not-a-date')
				.set('x-api-key', 'test-api-key');
			expect(invalidFrom.status).toBe(400);
			expect(invalidFrom.body.code).toBe('INVALID_REQUEST');
		});

		it('returns aggregated summary and false-positive proxy metrics', async () => {
			// Record test analyses
			await NewsAnalysisStorageService.recordAnalyses([
				{ symbol: 'BTCUSDT', eventCategory: 'price_surge', confidence: 0.85, alertSent: true },
				{ symbol: 'ETHUSDT', eventCategory: 'regulatory', confidence: 0.65, alertSent: false },
			]);

			const res = await request(app)
				.get('/api/news-monitor/summary')
				.set('x-api-key', 'test-api-key');

			expect(res.status).toBe(200);
			expect(res.body.totalAnalyses).toBe(2);
			expect(res.body.totalAlertsSent).toBe(1);
			expect(res.body.bySymbol.BTCUSDT).toBeDefined();
			expect(res.body.bySymbol.ETHUSDT).toBeDefined();
			expect(res.body.byEventCategory.price_surge).toBeDefined();
			expect(res.body.falsePositiveProxy).toBeDefined();
		});
	});
});
