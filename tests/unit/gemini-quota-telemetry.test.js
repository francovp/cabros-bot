// Regression coverage for issue #718: Gemini quota fallback telemetry accounting.
//
// Two accounting defects are covered:
//   1. A single provider rejection incremented `triggersTotal` twice, because
//      `genaiClient.search()` triggered the cooldown before rethrowing and the
//      analyzer retry loop then triggered it again for the same rejection.
//   2. The *first* quota-triggered Brave fallback was not counted: when
//      `search()` hit a quota error, it activated the cooldown and fell through
//      to Brave without recording the fallback, so only the already-active-
//      cooldown branch incremented `braveFallbacksDuringCooldown`.

jest.mock('../../src/services/grounding/config', () => ({
	GEMINI_API_KEY: 'test-key',
	GROUNDING_MODEL_NAME: 'test-model',
	ENABLE_NEWS_MONITOR_TEST_MODE: false,
	GEMINI_MODEL_NAME: 'test-gemini-model',
	MODEL_PROVIDER: 'gemini',
	BRAVE_SEARCH_API_KEY: 'test-brave-key',
	BRAVE_SEARCH_ENDPOINT: 'https://api.search.brave.com/res/v1/web/search',
	FORCE_BRAVE_SEARCH: false,
	AZURE_LLM_MODEL: null,
	OPENROUTER_MODEL: null,
	GEMINI_MODEL_NAME_FALLBACK: 'gemini-2.5-flash-lite',
}));

const genaiClient = require('../../src/services/grounding/genaiClient');
const geminiQuotaManager = require('../../src/services/grounding/geminiQuotaManager');

global.fetch = jest.fn();

function makeQuotaError(retryDelay = '30s') {
	return Object.assign(
		new Error(`429 RESOURCE_EXHAUSTED: {"error":{"details":[{"retryDelay":"${retryDelay}"}]}}`),
		{ status: 429 },
	);
}

function mockBraveSuccess() {
	global.fetch.mockResolvedValue({
		ok: true,
		json: async () => ({
			web: {
				results: [
					{ title: 'Brave 1', url: 'https://example.com/1', description: 'd1' },
				],
			},
		}),
	});
}

describe('Gemini quota telemetry accounting (#718)', () => {
	beforeEach(() => {
		geminiQuotaManager.resetForTesting();
		genaiClient.genAI = { models: { generateContent: jest.fn() } };
		jest.clearAllMocks();
	});

	describe('AC1: one provider rejection produces one triggersTotal increment', () => {
		it('search() rethrow path triggers the cooldown exactly once', async () => {
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(makeQuotaError());

			await expect(
				genaiClient.search({ query: 'test', rethrowQuotaErrors: true }),
			).rejects.toThrow('RESOURCE_EXHAUSTED');

			expect(geminiQuotaManager.getSnapshot().triggersTotal).toBe(1);
		});

		it('analyzer retry loop does not double-count a rejection already counted by search()', () => {
			jest.resetModules();
			let isolatedQuotaManager;
			let NewsAnalyzer;
			jest.isolateModules(() => {
				isolatedQuotaManager = require('../../src/services/grounding/geminiQuotaManager');
				({ NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer'));
			});
			isolatedQuotaManager.resetForTesting();

			// Reproduce the reported flow: `search()` (or the price service)
			// already triggered the cooldown for this rejection, then the
			// analyzer's retry loop observes the same error.
			isolatedQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 1 });
			expect(isolatedQuotaManager.getSnapshot().triggersTotal).toBe(1);

			const analyzer = new NewsAnalyzer();
			analyzer.analyzeSymbolInternal = jest.fn()
				.mockRejectedValueOnce(makeQuotaError('1ms'))
				.mockResolvedValueOnce({ status: 'analyzed', alert: null, cached: false });
			analyzer.geminiQuotaMaxRetries = 2;
			analyzer.geminiQuotaRetryBaseMs = 1;
			analyzer.timeout = 5000;

			return analyzer.analyzeSymbol('BTCUSDT', 'req-telemetry-single-trigger').then((result) => {
				expect(result.status).toBe('analyzed');
				expect(analyzer.analyzeSymbolInternal).toHaveBeenCalledTimes(2);
				// The pre-existing rejection was already counted; the retry loop
				// must not add a second increment for the same provider rejection.
				expect(isolatedQuotaManager.getSnapshot().triggersTotal).toBe(1);
				isolatedQuotaManager.resetForTesting();
			});
		});
	});

	describe('AC2: every quota-caused Brave fallback is counted, including the first', () => {
		it('counts the first Brave fallback when Google returns 429 (rethrowQuotaErrors=false)', async () => {
			genaiClient.genAI.models.generateContent.mockRejectedValueOnce(makeQuotaError());
			mockBraveSuccess();

			const result = await genaiClient.search({ query: 'test' });

			// Brave was actually selected because of quota exhaustion.
			expect(result.results).toHaveLength(1);
			expect(global.fetch).toHaveBeenCalledTimes(1);

			const snapshot = geminiQuotaManager.getSnapshot();
			expect(snapshot.triggersTotal).toBe(1);
			expect(snapshot.braveFallbacksDuringCooldown).toBe(1);
			expect(snapshot.lastBraveFallbackAt).not.toBeNull();
		});

		it('does not count a Brave fallback that is not caused by quota exhaustion', async () => {
			genaiClient.genAI.models.generateContent.mockResolvedValueOnce({ response: { text: 'ok', candidates: [] } });
			mockBraveSuccess();

			await genaiClient.search({ query: 'test' });

			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(geminiQuotaManager.getSnapshot().braveFallbacksDuringCooldown).toBe(0);
		});

		it('still counts exactly one fallback when the cooldown is already active', async () => {
			geminiQuotaManager.triggerQuotaCooldown({ status: 429, retryDelay: 10000 });
			mockBraveSuccess();

			await genaiClient.search({ query: 'test' });

			const snapshot = geminiQuotaManager.getSnapshot();
			// The pre-existing trigger is one incident; this call adds one fallback.
			expect(snapshot.triggersTotal).toBe(1);
			expect(snapshot.braveFallbacksDuringCooldown).toBe(1);
		});

		it('records a separate fallback for each quota-caused Brave call', async () => {
			// '0ms' keeps the cooldown immediately expired so the second call
			// reaches Google again and produces a genuinely separate rejection.
			genaiClient.genAI.models.generateContent
				.mockRejectedValueOnce(makeQuotaError('0ms'))
				.mockRejectedValueOnce(makeQuotaError('0ms'));
			mockBraveSuccess();
			mockBraveSuccess();

			await genaiClient.search({ query: 'first' });
			await genaiClient.search({ query: 'second' });

			const snapshot = geminiQuotaManager.getSnapshot();
			expect(snapshot.triggersTotal).toBe(2);
			expect(snapshot.braveFallbacksDuringCooldown).toBe(2);
		});
	});
});
