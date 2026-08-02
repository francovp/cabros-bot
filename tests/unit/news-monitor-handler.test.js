const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const sentryService = require('../../src/services/monitoring/SentryService');

describe('NewsMonitorHandler', () => {
	it('runs symbol analysis inside the Sentry analysis span', async () => {
		const previousFlag = process.env.ENABLE_NEWS_MONITOR;
		process.env.ENABLE_NEWS_MONITOR = 'true';

		const analysisSpan = {
			setAttribute: jest.fn(),
			end: jest.fn(),
		};
		const analyzer = {
			analyzeSymbols: jest.fn().mockResolvedValue([
				{ status: 'analyzed', alert: null, deliveryResults: [] },
			]),
		};
		const handler = new NewsMonitorHandler();
		handler.analyzer = analyzer;
		const req = {
			method: 'POST',
			query: {},
			body: { crypto: ['BTCUSDT'], stocks: [] },
		};
		const res = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
		jest.spyOn(sentryService, 'getActiveSpan').mockReturnValue(null);
		jest.spyOn(sentryService, 'startInactiveSpan').mockReturnValue(analysisSpan);
		const withActiveSpan = jest.spyOn(sentryService, 'withActiveSpan')
			.mockImplementation((_span, callback) => callback());

		try {
			await handler.handleRequest(req, res);

			expect(withActiveSpan).toHaveBeenCalledWith(analysisSpan, expect.any(Function));
			expect(analyzer.analyzeSymbols).toHaveBeenCalledTimes(1);
		} finally {
			jest.restoreAllMocks();
			if (previousFlag === undefined) delete process.env.ENABLE_NEWS_MONITOR;
			else process.env.ENABLE_NEWS_MONITOR = previousFlag;
		}
	});

	it('should count Gemini quota exhaustion separately in summary', () => {
		const handler = new NewsMonitorHandler();

		const summary = handler.generateSummary([
			{
				status: 'error',
				error: {
					code: 'GEMINI_QUOTA_EXHAUSTED',
					message: '429 RESOURCE_EXHAUSTED',
				},
			},
			{
				status: 'analyzed',
				alert: null,
			},
		]);

		expect(summary).toEqual(expect.objectContaining({
			total: 2,
			analyzed: 1,
			error: 1,
			quota_exhausted: 1,
		}));
	});
});
