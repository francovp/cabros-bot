'use strict';

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const newsAnalysisStorageService = require('../../src/services/storage/NewsAnalysisStorageService');
const { __resetCollectionState: resetCollectionState } = require('firebase-admin');

// The console reads the payload the controller actually returns, so these tests assert the
// wire shape through the real route rather than through the storage service alone. The
// cursor case in particular cannot be proven from the view: a console that sends the wrong
// query key still renders a page, because the server ignores the parameter it never reads.
describe('GET /api/news-monitor/analyses and /summary (admin read contract)', () => {
	let savedEnv;

	const headers = { 'x-api-key': 'test-key' };

	beforeEach(() => {
		savedEnv = process.env;
		process.env = { ...savedEnv };
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_FIRESTORE_NEWS_ANALYSIS: 'true',
			NODE_ENV: 'test',
			BOT_TOKEN: 'test-token',
			ENABLE_TELEGRAM_BOT: 'false',
			TELEGRAM_CHAT_ID: '',
			ENABLE_WHATSAPP_ALERTS: 'false',
			ENABLE_DISCORD_ALERTS: 'false',
		});
		jest.clearAllMocks();
		resetCollectionState();
		newsAnalysisStorageService.__resetFirestoreClient();
		app.use('/api', getRoutes({}));
	});

	afterEach(() => {
		process.env = savedEnv;
		newsAnalysisStorageService.__resetFirestoreClient();
	});

	const seed = async (symbols) => {
		for (let index = 0; index < symbols.length; index += 1) {
			await newsAnalysisStorageService.recordAnalysis({
				symbol: symbols[index],
				eventCategory: 'price_surge',
				sentiment: 0.5,
				confidence: 0.84,
				headline: `Headline ${index}`,
				alertSent: index % 2 === 0,
			});
		}
	};

	const FOUR_RECORDS = ['BTCUSDT', 'BTCUSDT', 'ETHUSDT', 'ETHUSDT'];

	it('returns records with createdAt (not analyzedAt) and the documented envelope', async () => {
		await seed(['BTCUSDT']);

		const res = await request(app)
			.get('/api/news-monitor/analyses?limit=10')
			.set(headers);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(Array.isArray(res.body.analyses)).toBe(true);
		expect(res.body.analyses).toHaveLength(1);
		const record = res.body.analyses[0];
		expect(record.symbol).toBe('BTCUSDT');
		expect(record).toHaveProperty('createdAt');
		// The console column reads createdAt; an analyzedAt field would render an em dash
		// forever, so it must not be the documented field name.
		expect(record.analyzedAt).toBeUndefined();
		expect(res.body.nextCursor).toBeNull();
	});

	it('applies the documented `before` cursor so page 2 differs from page 1', async () => {
		await seed(FOUR_RECORDS);

		const first = await request(app)
			.get('/api/news-monitor/analyses?limit=2')
			.set(headers);

		expect(first.status).toBe(200);
		const page1 = first.body.analyses.map((row) => row.id);
		expect(page1).toHaveLength(2);
		expect(first.body.nextCursor).toBeTruthy();

		const second = await request(app)
			.get(`/api/news-monitor/analyses?limit=2&before=${encodeURIComponent(first.body.nextCursor)}`)
			.set(headers);

		expect(second.status).toBe(200);
		const page2 = second.body.analyses.map((row) => row.id);
		expect(page2).toHaveLength(2);
		// The regression this guards: `before` was never read, so page 2 came back identical
		// to page 1 and the console's Next page button looped forever.
		expect(page2).not.toEqual(page1);
		expect(page2.some((id) => page1.includes(id))).toBe(false);
	});

	it('still honours the legacy beforeCursor alias so no existing caller breaks', async () => {
		await seed(FOUR_RECORDS);

		const first = await request(app).get('/api/news-monitor/analyses?limit=2').set(headers);
		const page1 = first.body.analyses.map((row) => row.id);

		const second = await request(app)
			.get(`/api/news-monitor/analyses?limit=2&beforeCursor=${encodeURIComponent(first.body.nextCursor)}`)
			.set(headers);

		const page2 = second.body.analyses.map((row) => row.id);
		expect(page2).not.toEqual(page1);
	});

	it('summarizes with the count keys and averageConfidence the console reads', async () => {
		await seed(FOUR_RECORDS);

		const res = await request(app)
			.get('/api/news-monitor/summary')
			.set(headers);

		expect(res.status).toBe(200);
		expect(res.body.success).toBe(true);
		expect(res.body.totalAnalyses).toBe(4);
		expect(res.body.totalAlertsSent).toBe(2);
		const symbol = res.body.bySymbol.BTCUSDT;
		expect(symbol.totalAnalyses).toBe(2);
		expect(symbol.alertsSent).toBe(1);
		expect(symbol.averageConfidence).toBe(0.84);
		const category = res.body.byEventCategory.price_surge;
		expect(category.total).toBe(4);
		expect(category.averageConfidence).toBe(0.84);
		// The service never emitted this field, so the contract must not promise it: the
		// console computed a fabricated 0% beside contradictory counts because of it.
		expect(res.body.alertRatePercent).toBeUndefined();
		expect(res.body.falsePositiveProxy.threshold).toBe(0.7);
	});
});