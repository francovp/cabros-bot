const gemini = require('../../src/services/grounding/gemini');

jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient', () => ({
	search: jest.fn().mockResolvedValue({
		results: [{ url: 'https://example.com/1', title: 'Source 1' }],
		searchResultText: 'Market context',
		totalResults: 1,
	}),
	llmCall: jest.fn(),
}));

const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const { ALLOWED_EVENT_CATEGORIES } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');

describe('News Monitor - Categories Parameter Unit Tests', () => {
	let handler;

	beforeEach(() => {
		handler = new NewsMonitorHandler();
	});

	describe('ALLOWED_EVENT_CATEGORIES', () => {
		it('contains the four alertable event categories', () => {
			expect(ALLOWED_EVENT_CATEGORIES).toEqual(
				expect.arrayContaining(['price_surge', 'price_decline', 'public_figure', 'regulatory'])
			);
			expect(ALLOWED_EVENT_CATEGORIES).not.toContain('none');
		});
	});

	describe('parseRequest with categories', () => {
		it('parses categories from POST body', () => {
			const req = {
				method: 'POST',
				body: {
					crypto: ['BTCUSDT'],
					categories: ['regulatory', 'price_surge'],
				},
			};
			const parsed = handler.parseRequest(req);
			expect(parsed.categories).toEqual(['regulatory', 'price_surge']);
		});

		it('parses categories from GET query comma-separated string', () => {
			const req = {
				method: 'GET',
				query: {
					crypto: 'BTCUSDT',
					categories: 'regulatory, public_figure',
				},
			};
			const parsed = handler.parseRequest(req);
			expect(parsed.categories).toEqual(['regulatory', 'public_figure']);
		});

		it('handles omitted categories as undefined', () => {
			const reqPost = { method: 'POST', body: { crypto: ['BTCUSDT'] } };
			expect(handler.parseRequest(reqPost).categories).toBeUndefined();

			const reqGet = { method: 'GET', query: { crypto: 'BTCUSDT' } };
			expect(handler.parseRequest(reqGet).categories).toBeUndefined();
		});
	});

	describe('validateCategories', () => {
		it('accepts undefined (omitted parameter)', () => {
			expect(handler.validateCategories(undefined)).toBeNull();
		});

		it('accepts valid category arrays', () => {
			expect(handler.validateCategories(['price_surge'])).toBeNull();
			expect(handler.validateCategories(['regulatory', 'public_figure'])).toBeNull();
			expect(handler.validateCategories(['PRICE_DECLINE', 'REGULATORY'])).toBeNull();
		});

		it('rejects empty arrays', () => {
			expect(handler.validateCategories([])).toBe('Categories must not be empty');
		});

		it('rejects non-array values', () => {
			expect(handler.validateCategories('regulatory')).toBe('Categories must be an array');
			expect(handler.validateCategories(123)).toBe('Categories must be an array');
			expect(handler.validateCategories({})).toBe('Categories must be an array');
		});

		it('rejects arrays with non-string elements', () => {
			expect(handler.validateCategories([123])).toBe('Categories must contain non-empty strings');
			expect(handler.validateCategories([''])).toBe('Categories must contain non-empty strings');
		});

		it('rejects "none" or unknown categories', () => {
			expect(handler.validateCategories(['none'])).toContain('Invalid category: "none"');
			expect(handler.validateCategories(['unknown_category'])).toContain('Invalid category: "unknown_category"');
			expect(handler.validateCategories(['regulatory', 'fake_cat'])).toContain('Invalid category: "fake_cat"');
		});
	});

	describe('handleRequest categories validation error', () => {
		it('returns 400 INVALID_REQUEST when categories parameter is invalid', async () => {
			const previousFlag = process.env.ENABLE_NEWS_MONITOR;
			process.env.ENABLE_NEWS_MONITOR = 'true';

			const req = {
				method: 'POST',
				headers: { 'x-request-id': 'req-test-1' },
				body: {
					crypto: ['BTCUSDT'],
					categories: ['invalid_category'],
				},
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			try {
				await handler.handleRequest(req, res);
				expect(res.status).toHaveBeenCalledWith(400);
				expect(res.json).toHaveBeenCalledWith(
					expect.objectContaining({
						code: 'INVALID_REQUEST',
						error: expect.stringContaining('Invalid category: "invalid_category"'),
					})
				);
			} finally {
				if (previousFlag === undefined) delete process.env.ENABLE_NEWS_MONITOR;
				else process.env.ENABLE_NEWS_MONITOR = previousFlag;
			}
		});

		it('passes normalized categories to analyzer.analyzeSymbols', async () => {
			const previousFlag = process.env.ENABLE_NEWS_MONITOR;
			process.env.ENABLE_NEWS_MONITOR = 'true';

			const analyzer = {
				analyzeSymbols: jest.fn().mockResolvedValue([
					{ status: 'analyzed', alert: null, deliveryResults: [] },
				]),
			};
			handler.analyzer = analyzer;

			const req = {
				method: 'POST',
				headers: { 'x-request-id': 'req-test-2' },
				body: {
					crypto: ['BTCUSDT'],
					categories: ['REGULATORY', 'regulatory', 'price_surge'],
				},
			};
			const res = {
				status: jest.fn().mockReturnThis(),
				json: jest.fn().mockReturnThis(),
			};

			try {
				await handler.handleRequest(req, res);
				expect(res.status).toHaveBeenCalledWith(200);
				expect(analyzer.analyzeSymbols).toHaveBeenCalledTimes(1);
				expect(analyzer.analyzeSymbols.mock.calls[0][4]).toEqual(
					expect.objectContaining({
						categories: ['regulatory', 'price_surge'],
					})
				);
			} finally {
				if (previousFlag === undefined) delete process.env.ENABLE_NEWS_MONITOR;
				else process.env.ENABLE_NEWS_MONITOR = previousFlag;
			}
		});
	});

	describe('NewsAnalyzer category filtering', () => {
		const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
		const { getCacheInstance } = require('../../src/controllers/webhooks/handlers/newsMonitor/cache');

		let analyzer;
		let cache;

		beforeEach(() => {
			analyzer = new NewsAnalyzer();
			cache = getCacheInstance();
			cache.clear();
			jest.spyOn(analyzer, 'getMarketContext').mockResolvedValue({
				price: 60000,
				change24h: 2.5,
				source: 'binance',
			});
		});

		afterEach(() => {
			jest.restoreAllMocks();
			cache.clear();
		});

		it('suppresses alert delivery and caches event when event category is excluded by filter', async () => {
			gemini.analyzeNewsForSymbol.mockResolvedValue({
				event_category: 'price_surge',
				headline: 'BTC price skyrockets',
				confidence: 0.85,
				sentiment_score: 0.8,
			});

			const result = await analyzer.analyzeSymbolInternal(
				'BTCUSDT',
				'req-1',
				null,
				{},
				{ categories: ['regulatory'] }
			);

			expect(result.status).toBe('analyzed');
			expect(result.alert).toBeNull();
			expect(result.cached).toBe(false);
			expect(result.analysisRecord.alertSent).toBe(false);
			expect(result.analysisRecord.eventCategory).toBe('price_surge');

			// Verify event was cached for deduplication
			const cached = await cache.get('BTCUSDT', 'price_surge');
			expect(cached).not.toBeNull();
			expect(cached.alert).not.toBeNull();
			expect(cached.alert.eventCategory).toBe('price_surge');
		});

		it('suppresses cached alert when cached category is excluded by filter', async () => {
			// Pre-populate cache with price_surge
			await cache.set('BTCUSDT', 'price_surge', {
				alert: {
					symbol: 'BTCUSDT',
					eventCategory: 'price_surge',
					headline: 'BTC price skyrockets',
					confidence: 0.85,
					sentimentScore: 0.8,
				},
				analysisResult: { symbol: 'BTCUSDT', status: 'analyzed' },
				deliveryResults: [],
			});

			gemini.analyzeNewsForSymbol.mockClear();

			const result = await analyzer.analyzeSymbolInternal(
				'BTCUSDT',
				'req-2',
				null,
				{},
				{ categories: ['regulatory'] }
			);

			expect(result.status).toBe('cached');
			expect(result.alert).toBeNull();
			expect(result.cached).toBe(true);
			expect(gemini.analyzeNewsForSymbol).not.toHaveBeenCalled();
		});

		it('delivers alert when event category matches the filter', async () => {
			gemini.analyzeNewsForSymbol.mockResolvedValue({
				event_category: 'regulatory',
				headline: 'SEC approves crypto rule',
				confidence: 0.85,
				sentiment_score: 0.5,
			});

			const result = await analyzer.analyzeSymbolInternal(
				'BTCUSDT',
				'req-3',
				null,
				{},
				{ categories: ['regulatory', 'price_surge'], deferDelivery: true }
			);

			expect(result.status).toBe('analyzed');
			expect(result.alert).not.toBeNull();
			expect(result.alert.eventCategory).toBe('regulatory');
		});

		it('delivers all categories when categories filter is omitted', async () => {
			gemini.analyzeNewsForSymbol.mockResolvedValue({
				event_category: 'price_surge',
				headline: 'BTC price surges',
				confidence: 0.85,
				sentiment_score: 0.8,
			});

			const result = await analyzer.analyzeSymbolInternal(
				'BTCUSDT',
				'req-4',
				null,
				{},
				{ deferDelivery: true }
			);

			expect(result.status).toBe('analyzed');
			expect(result.alert).not.toBeNull();
			expect(result.alert.eventCategory).toBe('price_surge');
		});
	});
});
