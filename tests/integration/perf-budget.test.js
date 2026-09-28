'use strict';

/**
 * tests/integration/perf-budget.test.js
 *
 * Boots the Express app in API-only mode and hits each budgeted route a
 * bounded number of times, asserting that the median duration is within
 * `tests/performance/budgets.json`. The soft envelope (1.5x) emits a
 * `console.warn`; the hard envelope (2x) fails unless
 * `PERF_BUDGET_RELAXED=true` is set.
 */

const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { assertWithinBudget, loadBudgets } = require('../helpers/perfBudget');

const ROUTES_TO_HIT = [
	{ route: '/ready', method: 'get', expectStatus: [200, 503] },
	{ route: '/api/status', method: 'get', expectStatus: [200, 401] },
	{ route: '/api/capabilities', method: 'get', expectStatus: [200, 401] },
	{ route: '/api/jobs', method: 'get', expectStatus: [200, 401] },
	{ route: '/api/alerts', method: 'get', expectStatus: [200, 401, 403, 503] },
	{ route: '/api/alerts/summary', method: 'get', expectStatus: [200, 401, 403, 503] },
	{ route: '/api/outcomes', method: 'get', expectStatus: [200, 401, 403] },
	{ route: '/api/outcomes/summary', method: 'get', expectStatus: [200, 401, 403] },
	// /api/scanner-presets accepts 404 too because in API-only mode the
	// admin router may not mount the collection; we still want a perf sample
	// to prove the budget guard is wired.
	{ route: '/api/scanner-presets', method: 'get', expectStatus: [200, 401, 403, 404, 503] },
];

describe('Performance budget guard (GH-795)', () => {
	let savedEnv;
	let mockBot;
	let mounted = false;

	beforeAll(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'perf-budget-test-key',
			ENABLE_API_ONLY_MODE: 'true',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
		});
		jest.clearAllMocks();
		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'perf-test-msg' }),
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'PerfTestBot' }),
			},
		};
		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
		mounted = true;
	});

	afterAll(() => {
		restoreEnv(savedEnv);
		// Pop the router we mounted in beforeAll so other suites that share
		// this app instance (with maxWorkers: 1) don't see duplicate handlers.
		if (mounted && app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
			mounted = false;
		}
	});

	it('declares budgets for the routes we exercise', () => {
		const budgets = loadBudgets();
		for (const entry of ROUTES_TO_HIT) {
			expect(budgets[entry.route]).toBeDefined();
			expect(budgets[entry.route].p95Ms).toBeGreaterThan(0);
		}
	});

	ROUTES_TO_HIT.forEach(({ route, method, expectStatus }) => {
		it(`keeps p95 latency for ${route} within budget (20 iterations)`, async () => {
			const samples = [];
			const ITERATIONS = 20;
			for (let i = 0; i < ITERATIONS; i++) {
				const start = process.hrtime.bigint();
				let response;
				if (method === 'get') {
					response = await request(app).get(route);
				} else if (method === 'post') {
					response = await request(app).post(route).send({});
				} else {
					throw new Error('Unsupported method: ' + method);
				}
				const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
				samples.push(durationMs);
				expect(expectStatus).toContain(response.status);
			}
			samples.sort((a, b) => a - b);
			// True p95 (ceil-style; clamped to the last sample).
			const p95Index = Math.min(samples.length - 1, Math.floor(samples.length * 0.95));
			const p95 = samples[p95Index];
			assertWithinBudget(route, p95);
		});
	});
});