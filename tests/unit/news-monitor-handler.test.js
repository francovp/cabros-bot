const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');

describe('NewsMonitorHandler', () => {
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
