'use strict';

const request = require('supertest');
const http = require('node:http');
const { buildLocalAppEnvironment, getPerformanceRequests } = require('./run');
const { startMockTradingViewMcp } = require('./support/mock-tradingview-mcp');

const directAgent = new http.Agent();

function valueAtPath(value, path) {
	return path.split('.').reduce((current, key) => current === undefined || current === null ? undefined : current[key], value);
}

describe('performance load request contracts', () => {
	let savedEnv;
	let app;
	let mockMcp;
	let jobService;
	let nativeFetch;
	let fetchTargets;

	beforeAll(async () => {
		savedEnv = { ...process.env };
		mockMcp = await startMockTradingViewMcp();
		process.env = buildLocalAppEnvironment(savedEnv, 18080, mockMcp.url);
		nativeFetch = global.fetch;
		fetchTargets = [];
		global.fetch = (input, options) => {
			let target = 'relative-or-invalid';
			try {
				const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
				target = `${url.host}${url.pathname}`;
			} catch (_) {
				// Keep malformed targets visible without including credentials or query strings.
			}
			fetchTargets.push(target);
			return nativeFetch(input, options);
		};
		jest.resetModules();
		jest.doMock('dotenv', () => ({ config: jest.fn() }));
		jest.doMock('../../src/services/grounding/gemini', () => ({
			analyzeNewsForSymbol: jest.fn().mockResolvedValue({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Mock Bitcoin market event',
				confidence: 0.95,
				sources: ['https://example.com/news'],
			}),
			generateGroundedSummary: jest.fn().mockResolvedValue({
				summary: 'Mock market summary',
				citations: [],
				confidence: 0.9,
			}),
		}));
		jest.doMock('../../src/services/grounding/genaiClient', () => ({
			search: jest.fn().mockResolvedValue({ results: [], searchResultText: '', totalResults: 0 }),
		}));
		app = require('../../app');
		app.use('/api', require('../../src/routes').getRoutes());
		({ jobService } = require('../../src/services/jobs/JobService'));
	});

	afterAll(async () => {
		try {
			if (jobService) await jobService.waitForActiveJobs();
		} finally {
			require('../../src/lib/performanceDiagnostics').closePerformanceDiagnostics();
			await mockMcp?.close();
			global.fetch = nativeFetch;
			process.env = savedEnv;
			jest.dontMock('dotenv');
			jest.resetModules();
		}
	});

	it('returns each declared success contract against the local MCP stub', async () => {
		for (const contract of getPerformanceRequests()) {
			const response = await request(app)
				.post(contract.path)
				.agent(directAgent)
				.set('Content-Type', 'application/json')
				.set('x-api-key', 'performance-test-key')
				.send(contract.body);

			expect({ name: contract.name, status: response.status, body: response.body, text: response.text, contentType: response.headers['content-type'], fetchTargets }).toEqual(expect.objectContaining({
				name: contract.name,
				status: contract.expectedStatus,
			}));
			for (const [key, expected] of Object.entries(contract.expectedBody || {})) {
				expect(response.body[key]).toBe(expected);
			}
			for (const [path, expected] of Object.entries(contract.expectedBodyPaths || {})) {
				expect(valueAtPath(response.body, path)).toBe(expected);
			}
			for (const path of contract.expectedStringPaths || []) {
				expect(valueAtPath(response.body, path)).toEqual(expect.any(String));
				expect(valueAtPath(response.body, path).length).toBeGreaterThan(0);
			}
		}
		expect(fetchTargets.length).toBeGreaterThan(0);
		expect(new Set(fetchTargets)).toEqual(new Set([`${new URL(mockMcp.url).host}/mcp`]));
	});
});
