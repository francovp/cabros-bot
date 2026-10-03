const { buildLoadScenarios, getPerformanceEndpoints } = require('./run');
const { createPerformanceDiagnostics } = require('../../src/lib/performanceDiagnostics');

describe('performance harness configuration', () => {
	it('covers the requested 10, 50, and 200 RPS profiles', () => {
		expect(buildLoadScenarios().map((scenario) => scenario.rate)).toEqual([10, 50, 200]);
	});

	it('keeps every hot endpoint in the checked-in budget contract', () => {
		expect(getPerformanceEndpoints()).toEqual(expect.arrayContaining([
			'/api/webhook/alert',
			'/api/webhook/expanded-analysis-alert',
			'/api/webhook/market-scanner-alert',
			'/api/jobs/tradingview-analysis',
			'/api/news-monitor',
		]));
	});

	it('exposes bounded memory and event-loop diagnostics for soak runs', () => {
		const diagnostics = createPerformanceDiagnostics({ resolution: 20 });
		const snapshot = diagnostics.snapshot();
		diagnostics.close();

		expect(snapshot).toEqual(expect.objectContaining({
			eventLoopLagMs: expect.any(Number),
		heapUsedBytes: expect.any(Number),
		rssBytes: expect.any(Number),
	}));
	});
});
