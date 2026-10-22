const {
	buildK6Thresholds,
	buildLoadScenarios,
	buildLocalAppEnvironment,
	buildLoadEnvironment,
	getPerformanceEndpoints,
	getPerformanceRequests,
	waitForHealth,
} = require('./run');
const { createPerformanceDiagnostics } = require('../../src/lib/performanceDiagnostics');
const { closePerformanceDiagnostics } = require('../../src/lib/performanceDiagnostics');
const jestConfig = require('../../jest.config');
const performanceJestConfig = require('./chaos/jest.config');
const budgets = require('./budgets.json');

describe('performance harness configuration', () => {
	afterAll(() => closePerformanceDiagnostics());

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

	it('uses valid request and success contracts for every load endpoint', () => {
		const requests = getPerformanceRequests();
		expect(requests).toHaveLength(5);
		for (const request of requests) {
			expect(budgets[request.budgetPath]).toBeDefined();
			expect(request.expectedStatus).toBeGreaterThanOrEqual(200);
			expect(request.expectedStatus).toBeLessThan(300);
			expect(request.expectedBody).toEqual(expect.objectContaining({ success: true }));
			expect(request.body).toEqual(expect.any(Object));
		}
		expect(requests.find(({ name }) => name === 'jobs').body).toEqual(expect.objectContaining({
			type: 'expanded-analysis',
			symbols: ['BINANCE:BTCUSDT'],
		}));
	});

	it('builds load and soak thresholds from the checked-in budgets', () => {
		const loadThresholds = buildK6Thresholds(budgets, 'load');
		const soakThresholds = buildK6Thresholds(budgets, 'soak');
		expect(loadThresholds['http_req_duration{endpoint:alert}']).toContain(`p(95)<${budgets['/api/webhook/alert'].p95Ms}`);
		expect(soakThresholds['http_req_duration{endpoint:alert}']).toContain(`p(99)<${budgets['/api/webhook/alert'].p99Ms}`);
		expect(loadThresholds.checks).toEqual(['rate==1']);
		expect(loadThresholds.dropped_iterations).toEqual(['count<1']);
		expect(soakThresholds.checks).toEqual(['rate==1']);
		expect(soakThresholds.dropped_iterations).toEqual(['count<1']);
	});

	it('isolates local load runs from inherited credentials and background integrations', () => {
		const local = buildLocalAppEnvironment({
			WEBHOOK_API_KEY: 'inherited-key',
			TRADINGVIEW_MCP_URL: 'https://production.example/mcp',
			ENABLE_NOTIFICATION_REDRIVE: 'true',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'true',
			ENABLE_WHATSAPP_ALERTS: 'true',
			GEMINI_API_KEY: 'inherited-secret',
		}, 18080, 'http://127.0.0.1:19090/mcp');
		expect(local.WEBHOOK_API_KEY).toBe('performance-test-key');
		expect(local.TRADINGVIEW_MCP_URL).toBe('http://127.0.0.1:19090/mcp');
		expect(local.ENABLE_NOTIFICATION_REDRIVE).toBe('false');
		expect(local.ENABLE_SIGNAL_OUTCOME_TRACKING).toBe('false');
		expect(local.ENABLE_WHATSAPP_ALERTS).toBe('false');
		expect(local.ENABLE_API_ONLY_MODE).toBe('true');
		expect(local.GEMINI_API_KEY).toBeUndefined();
	});

	it('uses the synthetic API key for a local child and requires credentials for an external target', () => {
		expect(buildLoadEnvironment({}, 'http://127.0.0.1:18080', true).WEBHOOK_API_KEY).toBe('performance-test-key');
		expect(buildLoadEnvironment({ WEBHOOK_API_KEY: 'external-key' }, 'https://preview.example', false).WEBHOOK_API_KEY).toBe('external-key');
		expect(() => buildLoadEnvironment({}, 'https://preview.example', false)).toThrow(/WEBHOOK_API_KEY/);
	});

	it('excludes only the dependency-outage drill from default Jest discovery', () => {
		expect(jestConfig.testPathIgnorePatterns).toContain('/tests/performance/chaos/');
		expect(performanceJestConfig.testMatch).toContain('<rootDir>/tests/performance/chaos/**/*.test.js');
		expect(performanceJestConfig.testPathIgnorePatterns).not.toContain('/tests/performance/chaos/');
	});

	it('aborts a health probe when fetch stalls past its deadline', async () => {
		let receivedSignal;
		const fetchImpl = jest.fn((_, options) => {
			receivedSignal = options.signal;
			return new Promise((_, reject) => {
				receivedSignal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
			});
		});

		await expect(waitForHealth('http://127.0.0.1:18080', {
			timeoutMs: 30,
			probeTimeoutMs: 5,
			pollIntervalMs: 0,
			fetchImpl,
		})).rejects.toThrow(/did not become healthy/);
		expect(receivedSignal.aborted).toBe(true);
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
