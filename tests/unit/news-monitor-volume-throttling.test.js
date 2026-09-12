'use strict';

const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');
const { AnalysisStatus } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');
const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const {
	getVolumeTracker,
	resetVolumeTrackerForTesting,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/volumeTracker');

describe('News Monitor Volume Throttling & Adaptive Caps', () => {
	let originalEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		process.env.ENABLE_NEWS_MONITOR = 'true';
		process.env.NEWS_ALERT_THRESHOLD = '0.5';
		resetVolumeTrackerForTesting();
	});

	afterEach(() => {
		Object.keys(process.env).forEach((k) => delete process.env[k]);
		Object.assign(process.env, originalEnv);
		resetVolumeTrackerForTesting();
	});

	describe('batch throttling and confidence prioritization', () => {
		it('caps delivered alerts per request and prioritizes higher confidence scores', async () => {
			process.env.NEWS_MAX_ALERTS_PER_BATCH = '2';

			const analyzer = new NewsAnalyzer();
			const deliveredSymbols = [];

			// Mock analyzeSymbol to return candidate alerts with differing confidence
			const symbolConfidenceMap = {
				BTCUSDT: 0.70,
				ETHUSDT: 0.95,
				SOLUSDT: 0.85,
				ADAUSDT: 0.60,
			};

			analyzer.analyzeSymbol = jest.fn(async (symbol, requestId, tokenUsage, routing, startedAt, options) => {
				const conf = symbolConfidenceMap[symbol];
				const candidate = {
					symbol,
					status: AnalysisStatus.ANALYZED,
					cached: false,
					alert: {
						symbol,
						eventCategory: 'price_surge',
						headline: `${symbol} surges`,
						confidence: conf,
					},
					deliveryResults: [],
					_pendingDelivery: {
						notificationMgr: {},
						alert: { symbol, confidence: conf },
						routing,
						geminiAnalysis: { event_category: 'price_surge' },
						options,
					},
				};
				return candidate;
			});

			analyzer.executePendingDelivery = jest.fn(async (candidate) => {
				deliveredSymbols.push(candidate.symbol);
				candidate.deliveryResults = [{ channel: 'telegram', success: true }];
			});

			const results = await analyzer.analyzeSymbols(
				['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ADAUSDT'],
				'req-batch-throttle',
				null,
				{},
				{},
			);

			// ETHUSDT (0.95) and SOLUSDT (0.85) should be delivered (top 2)
			expect(deliveredSymbols).toEqual(expect.arrayContaining(['ETHUSDT', 'SOLUSDT']));
			expect(deliveredSymbols).toHaveLength(2);

			const ethResult = results.find((r) => r.symbol === 'ETHUSDT');
			const solResult = results.find((r) => r.symbol === 'SOLUSDT');
			const btcResult = results.find((r) => r.symbol === 'BTCUSDT');
			const adaResult = results.find((r) => r.symbol === 'ADAUSDT');

			expect(ethResult.status).toBe(AnalysisStatus.ANALYZED);
			expect(ethResult.deliveryResults).toEqual([{ channel: 'telegram', success: true }]);

			expect(solResult.status).toBe(AnalysisStatus.ANALYZED);
			expect(solResult.deliveryResults).toEqual([{ channel: 'telegram', success: true }]);

			// BTCUSDT (0.70) and ADAUSDT (0.60) should be throttled
			expect(btcResult.status).toBe(AnalysisStatus.THROTTLED);
			expect(btcResult.reason).toBe('alert_volume_cap');
			expect(btcResult.deliveryResults).toEqual([]);

			expect(adaResult.status).toBe(AnalysisStatus.THROTTLED);
			expect(adaResult.reason).toBe('alert_volume_cap');
			expect(adaResult.deliveryResults).toEqual([]);

			// Volume tracker should record 2 delivered, 2 throttled
			const usage = getVolumeTracker().getWindowUsage();
			expect(usage.alertsDelivered).toBe(2);
			expect(usage.alertsThrottled).toBe(2);
		});

		it('summary counts throttled alerts accurately', () => {
			const handler = new NewsMonitorHandler();
			const results = [
				{ symbol: 'ETHUSDT', status: AnalysisStatus.ANALYZED, alert: { confidence: 0.9 } },
				{ symbol: 'SOLUSDT', status: AnalysisStatus.ANALYZED, alert: { confidence: 0.8 } },
				{ symbol: 'BTCUSDT', status: AnalysisStatus.THROTTLED, reason: 'alert_volume_cap' },
				{ symbol: 'ADAUSDT', status: AnalysisStatus.THROTTLED, reason: 'alert_volume_cap' },
			];

			const summary = handler.generateSummary(results);
			expect(summary).toEqual(expect.objectContaining({
				total: 4,
				analyzed: 2,
				throttled: 2,
				alerts_sent: 2,
				cached: 0,
				error: 0,
				timeout: 0,
			}));
		});
	});

	describe('cross-request window exhaustion', () => {
		it('throttles alerts when cumulative deliveries reach the window cap', async () => {
			process.env.NEWS_MAX_ALERTS_PER_BATCH = '5';
			process.env.NEWS_MAX_ALERTS_PER_WINDOW = '3';
			process.env.NEWS_MAX_ALERTS_PER_WINDOW_MS = '300000';

			const analyzer = new NewsAnalyzer();
			const deliveredSymbols = [];

			analyzer.executePendingDelivery = jest.fn(async (candidate) => {
				deliveredSymbols.push(candidate.symbol);
				candidate.deliveryResults = [{ channel: 'telegram', success: true }];
			});

			// Batch 1: 2 symbols (both should be delivered; window remaining = 1)
			analyzer.analyzeSymbol = jest.fn(async (symbol) => ({
				symbol,
				status: AnalysisStatus.ANALYZED,
				alert: { symbol, confidence: 0.9 },
				deliveryResults: [],
				_pendingDelivery: { notificationMgr: {}, alert: { symbol, confidence: 0.9 }, routing: {}, geminiAnalysis: {} },
			}));

			const batch1 = await analyzer.analyzeSymbols(['BTCUSDT', 'ETHUSDT'], 'req-1', null, {}, {});
			expect(batch1.filter((r) => r.status === AnalysisStatus.ANALYZED)).toHaveLength(2);
			expect(batch1.filter((r) => r.status === AnalysisStatus.THROTTLED)).toHaveLength(0);

			let usage = getVolumeTracker().getWindowUsage();
			expect(usage.alertsDelivered).toBe(2);
			expect(usage.alertsThrottled).toBe(0);

			// Batch 2: 2 symbols with confidence 0.95 and 0.80 (only top 1 delivered because window cap = 3; 1 throttled)
			analyzer.analyzeSymbol = jest.fn(async (symbol) => {
				const conf = symbol === 'SOLUSDT' ? 0.95 : 0.80;
				return {
					symbol,
					status: AnalysisStatus.ANALYZED,
					alert: { symbol, confidence: conf },
					deliveryResults: [],
					_pendingDelivery: { notificationMgr: {}, alert: { symbol, confidence: conf }, routing: {}, geminiAnalysis: {} },
				};
			});

			const batch2 = await analyzer.analyzeSymbols(['AVAXUSDT', 'SOLUSDT'], 'req-2', null, {}, {});
			const solResult = batch2.find((r) => r.symbol === 'SOLUSDT');
			const avaxResult = batch2.find((r) => r.symbol === 'AVAXUSDT');

			expect(solResult.status).toBe(AnalysisStatus.ANALYZED);
			expect(avaxResult.status).toBe(AnalysisStatus.THROTTLED);
			expect(avaxResult.reason).toBe('alert_volume_cap');

			usage = getVolumeTracker().getWindowUsage();
			expect(usage.alertsDelivered).toBe(3);
			expect(usage.alertsThrottled).toBe(1);

			// Batch 3: 1 symbol (window fully exhausted; throttled immediately)
			analyzer.analyzeSymbol = jest.fn(async (symbol) => ({
				symbol,
				status: AnalysisStatus.ANALYZED,
				alert: { symbol, confidence: 0.99 },
				deliveryResults: [],
				_pendingDelivery: { notificationMgr: {}, alert: { symbol, confidence: 0.99 }, routing: {}, geminiAnalysis: {} },
			}));

			const batch3 = await analyzer.analyzeSymbols(['DOTUSDT'], 'req-3', null, {}, {});
			expect(batch3[0].status).toBe(AnalysisStatus.THROTTLED);
			expect(batch3[0].reason).toBe('alert_volume_cap');

			usage = getVolumeTracker().getWindowUsage();
			expect(usage.alertsDelivered).toBe(3);
			expect(usage.alertsThrottled).toBe(2);
		});
	});

	describe('dry-run mode', () => {
		it('respects caps and marks intended vs throttled alerts without consuming window quota', async () => {
			process.env.NEWS_MAX_ALERTS_PER_BATCH = '1';
			process.env.NEWS_MAX_ALERTS_PER_WINDOW = '5';

			const analyzer = new NewsAnalyzer();

			analyzer.analyzeSymbol = jest.fn(async (symbol) => {
				const conf = symbol === 'BTCUSDT' ? 0.9 : 0.6;
				return {
					symbol,
					status: AnalysisStatus.ANALYZED,
					alert: { symbol, confidence: conf },
					deliveryResults: [],
				};
			});

			const results = await analyzer.analyzeSymbols(
				['ETHUSDT', 'BTCUSDT'],
				'req-dry-run',
				null,
				{},
				{ dryRun: true },
			);

			const btc = results.find((r) => r.symbol === 'BTCUSDT');
			const eth = results.find((r) => r.symbol === 'ETHUSDT');

			// BTC has higher confidence (0.9 vs 0.6) -> intended alert
			expect(btc.status).toBe(AnalysisStatus.ANALYZED);
			expect(btc.deliveryResults).toEqual([]);
			expect(btc.alert).toBeDefined();

			// ETH exceeded batch cap of 1 -> throttled
			expect(eth.status).toBe(AnalysisStatus.THROTTLED);
			expect(eth.reason).toBe('alert_volume_cap');
			expect(eth.alert).toBeDefined(); // alert details preserved for operator visibility

			// Dry run must NOT consume quota in volume tracker
			const usage = getVolumeTracker().getWindowUsage();
			expect(usage.alertsDelivered).toBe(0);
			expect(usage.alertsThrottled).toBe(0);
		});
	});

	describe('deduplication cache preservation', () => {
		it('leaves cached results unaffected and does not count them against fresh delivery caps', async () => {
			process.env.NEWS_MAX_ALERTS_PER_BATCH = '1';

			const analyzer = new NewsAnalyzer();

			analyzer.analyzeSymbol = jest.fn(async (symbol) => {
				if (symbol === 'CACHED_SYM') {
					return {
						symbol,
						status: AnalysisStatus.CACHED,
						cached: true,
						alert: { symbol, confidence: 0.99 },
						deliveryResults: [{ channel: 'telegram', success: true }],
					};
				}
				return {
					symbol,
					status: AnalysisStatus.ANALYZED,
					alert: { symbol, confidence: 0.85 },
					deliveryResults: [],
					_pendingDelivery: { notificationMgr: {}, alert: { symbol, confidence: 0.85 }, routing: {}, geminiAnalysis: {} },
				};
			});

			analyzer.executePendingDelivery = jest.fn(async (candidate) => {
				candidate.deliveryResults = [{ channel: 'telegram', success: true }];
			});

			const results = await analyzer.analyzeSymbols(
				['CACHED_SYM', 'FRESH_SYM'],
				'req-dedup-check',
				null,
				{},
				{},
			);

			const cachedResult = results.find((r) => r.symbol === 'CACHED_SYM');
			const freshResult = results.find((r) => r.symbol === 'FRESH_SYM');

			expect(cachedResult.status).toBe(AnalysisStatus.CACHED);
			expect(cachedResult.cached).toBe(true);

			// Fresh symbol can still be delivered because cached results do not count against fresh alert cap
			expect(freshResult.status).toBe(AnalysisStatus.ANALYZED);
			expect(freshResult.deliveryResults).toEqual([{ channel: 'telegram', success: true }]);
		});
	});
});
