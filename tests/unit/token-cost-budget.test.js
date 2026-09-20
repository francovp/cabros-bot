'use strict';

const {
	TokenUsageTracker,
	GlobalTokenCostBudgetTracker,
	globalTokenTracker,
	tokenCostBudgetService,
	registerGlobalUsage,
	MODEL_PRICING,
} = require('../../src/lib/tokenUsage');

describe('Token Cost Budget Tracking', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.ENABLE_TOKEN_COST_BUDGET;
		delete process.env.TOKEN_COST_DAILY_BUDGET_USD;
		delete process.env.TOKEN_COST_WARN_THRESHOLD_PCT;
		delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		delete process.env.BOT_TOKEN;
		globalTokenTracker.reset();
	});

	afterEach(() => {
		process.env = originalEnv;
		globalTokenTracker.reset();
		jest.restoreAllMocks();
	});

	describe('TokenUsageTracker & Spend Calculation', () => {
		it('calculates estimated spend for known models accurately', () => {
			const tracker = new TokenUsageTracker();
			// gemini-2.0-flash: $0.10/1M input, $0.40/1M output
			tracker.addUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');

			const total = tracker.getTotalUsage();
			expect(total.inputTokens).toBe(1_000_000);
			expect(total.outputTokens).toBe(1_000_000);
			expect(total.totalTokens).toBe(2_000_000);
			expect(total.estimatedSpendUsd).toBeCloseTo(0.50, 4);
		});

		it('calculates spend for gemini-2.5-flash correctly', () => {
			const tracker = new TokenUsageTracker();
			// gemini-2.5-flash: $0.30/1M input, $2.50/1M output
			tracker.addUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.5-flash');

			const total = tracker.getTotalUsage();
			expect(total.estimatedSpendUsd).toBeCloseTo(2.80, 4);
		});

		it('calculates spend for fallback/unknown models using default pricing', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100_000, outputTokens: 50_000 }, 'custom-model-xyz');

			const total = tracker.getTotalUsage();
			expect(total.inputTokens).toBe(100_000);
			expect(total.outputTokens).toBe(50_000);
			// Default pricing: $0.15/$0.60 per 1M -> 100k*0.15 + 50k*0.60 = $0.045
			expect(total.estimatedSpendUsd).toBe(0.045);
		});

		it('handles undefined or null usage objects gracefully', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage(null, 'gemini-2.0-flash');
			tracker.addUsage(undefined, 'gemini-2.0-flash');
			tracker.addUsage({}, 'gemini-2.0-flash');

			expect(tracker.getTotalUsage().totalTokens).toBe(0);
			expect(tracker.getTotalUsage().estimatedSpendUsd).toBe(0);
		});
	});

	describe('GlobalTokenCostBudgetTracker', () => {
		it('defaults to disabled when ENABLE_TOKEN_COST_BUDGET is not set', () => {
			const tracker = new GlobalTokenCostBudgetTracker();
			expect(tracker.isEnabled()).toBe(false);
			expect(tracker.isBudgetExceeded()).toBe(false);
			expect(tracker.isWarningThresholdReached()).toBe(false);

			const status = tracker.getBudgetStatus();
			expect(status.enabled).toBe(false);
			expect(status.status).toBe('disabled');
			expect(status.dailySpendUsd).toBe(0);
		});

		it('parses budget configuration correctly when enabled', () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '10.50';
			process.env.TOKEN_COST_WARN_THRESHOLD_PCT = '75';

			const tracker = new GlobalTokenCostBudgetTracker();
			expect(tracker.isEnabled()).toBe(true);

			const config = tracker.getBudgetConfig();
			expect(config.enabled).toBe(true);
			expect(config.dailyBudgetUsd).toBe(10.50);
			expect(config.budgetUsd).toBe(10.50);
			expect(config.warnThresholdPct).toBe(75);

			const status = tracker.getBudgetStatus();
			expect(status.enabled).toBe(true);
			expect(status.status).toBe('ready');
			expect(status.budgetUsd).toBe(10.50);
		});

		it('falls back to safe defaults on invalid budget environment values', () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '-5';
			process.env.TOKEN_COST_WARN_THRESHOLD_PCT = '150';

			const tracker = new GlobalTokenCostBudgetTracker();
			const config = tracker.getBudgetConfig();
			expect(config.dailyBudgetUsd).toBe(5.0); // default fallback
			expect(config.warnThresholdPct).toBe(80); // default fallback
		});

		it('tracks spend accumulation and updates utilizationPct', () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '1.00';
			process.env.TOKEN_COST_WARN_THRESHOLD_PCT = '80';

			const tracker = new GlobalTokenCostBudgetTracker();
			// 1M input ($0.10) + 1M output ($0.40) for gemini-2.0-flash = $0.50 (50% of $1.00)
			tracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');

			const status = tracker.getBudgetStatus();
			expect(status.dailySpendUsd).toBeCloseTo(0.50, 4);
			expect(status.utilizationPct).toBe(50);
			expect(tracker.isBudgetExceeded()).toBe(false);
			expect(tracker.isWarningThresholdReached()).toBe(false);
		});

		it('triggers warning threshold notification and flag when threshold is crossed', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '1.00';
			process.env.TOKEN_COST_WARN_THRESHOLD_PCT = '80';

			const tracker = new GlobalTokenCostBudgetTracker();
			const notifySpy = jest.spyOn(tracker, '_sendAdminNotification').mockResolvedValue();

			// For gemini-2.0-flash: 1.7M output tokens ($0.68) + 1.7M input tokens ($0.17) = $0.85
			// $0.85 / $1.00 = 85% >= 80% warning threshold
			tracker.recordUsage({ inputTokens: 1_700_000, outputTokens: 1_700_000 }, 'gemini-2.0-flash');

			expect(tracker.isWarningThresholdReached()).toBe(true);
			expect(tracker.isBudgetExceeded()).toBe(false);
			expect(notifySpy).toHaveBeenCalledTimes(1);
			expect(notifySpy).toHaveBeenCalledWith(
				'warning',
				expect.objectContaining({ utilizationPct: 85, warnThresholdPct: 80 }),
			);

			// Subsequent usage below 100% does not re-trigger warning notification
			tracker.recordUsage({ inputTokens: 10_000, outputTokens: 10_000 }, 'gemini-2.0-flash');
			expect(notifySpy).toHaveBeenCalledTimes(1);
		});

		it('triggers budget ceiling notification and marks budget exceeded when 100% reached', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '1.00';
			process.env.TOKEN_COST_WARN_THRESHOLD_PCT = '80';

			const tracker = new GlobalTokenCostBudgetTracker();
			const notifySpy = jest.spyOn(tracker, '_sendAdminNotification').mockResolvedValue();

			// Add $1.00 spend (2M in = $0.20 + 2M out = $0.80 -> $1.00)
			tracker.recordUsage({ inputTokens: 2_000_000, outputTokens: 2_000_000 }, 'gemini-2.0-flash');

			expect(tracker.isBudgetExceeded()).toBe(true);
			// Both warning and ceiling triggered
			expect(notifySpy).toHaveBeenCalledTimes(2);
			expect(notifySpy).toHaveBeenLastCalledWith(
				'limit',
				expect.objectContaining({ utilizationPct: 100 }),
			);

			// Additional usage does not spam notifications
			tracker.recordUsage({ inputTokens: 100_000, outputTokens: 100_000 }, 'gemini-2.0-flash');
			expect(notifySpy).toHaveBeenCalledTimes(2);
		});

		it('resets spend and notification flags on UTC day rollover', () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '1.00';

			// Day 1
			const day1 = new Date('2026-03-29T12:00:00.000Z').getTime();
			jest.spyOn(Date, 'now').mockReturnValue(day1);

			const tracker = new GlobalTokenCostBudgetTracker();
			jest.spyOn(tracker, '_sendAdminNotification').mockResolvedValue();

			tracker.recordUsage({ inputTokens: 2_000_000, outputTokens: 2_000_000 }, 'gemini-2.0-flash');
			expect(tracker.isBudgetExceeded()).toBe(true);
			expect(tracker.getBudgetStatus().alertsSent).toBe(2);

			// Day 2 (rollover)
			const day2 = new Date('2026-03-30T01:00:00.000Z').getTime();
			jest.spyOn(Date, 'now').mockReturnValue(day2);

			expect(tracker.isBudgetExceeded()).toBe(false);
			expect(tracker.isWarningThresholdReached()).toBe(false);
			const status = tracker.getBudgetStatus();
			expect(status.dailySpendUsd).toBe(0);
			expect(status.alertsSent).toBe(0);
		});

		it('fails open if admin notification throws', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '1.00';
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '12345';
			process.env.BOT_TOKEN = 'test-token';

			const tracker = new GlobalTokenCostBudgetTracker();
			jest.spyOn(global, 'fetch').mockRejectedValue(new Error('Telegram API connection timeout'));
			const consoleErrorSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			// Should not throw even if notification delivery fails
			expect(() => {
				tracker.recordUsage({ inputTokens: 2_000_000, outputTokens: 2_000_000 }, 'gemini-2.0-flash');
			}).not.toThrow();

			// Wait a tick for async dispatch to resolve
			await new Promise(resolve => setTimeout(resolve, 50));
			expect(consoleErrorSpy).toHaveBeenCalled();
		});

		it('does not double count when request-scoped addUsage is called without recordGlobal', () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '5.00';

			const requestTracker = new TokenUsageTracker();
			const usage = { inputTokens: 500, outputTokens: 500 };

			// Request-scoped adds to request tracker only
			requestTracker.addUsage(usage, 'gemini-2.0-flash');
			expect(requestTracker.getTotalUsage().totalTokens).toBe(1000);
			expect(globalTokenTracker.getTotalUsage().totalTokens).toBe(0);

			// Calling registerGlobalUsage records into global tracker
			registerGlobalUsage(usage, 'gemini-2.0-flash');
			expect(globalTokenTracker.getTotalUsage().totalTokens).toBe(1000);
		});
	});

	describe('Call-Site Fail-Open Budget Guard Behavior', () => {
		it('gemini.generateGroundedSummary falls back to raw text slice when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			// Exceed budget
			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const gemini = require('../../src/services/grounding/gemini');
			const result = await gemini.generateGroundedSummary({
				text: 'BTC is breaking resistance at $90k with huge volume',
				searchResults: [],
			});
			expect(result).toBeDefined();
			expect(result.summary).toContain('BTC is breaking resistance');
			expect(result.budgetExceeded).toBe(true);
		});

		it('gemini.analyzeNewsForSymbol returns fallback event when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const gemini = require('../../src/services/grounding/gemini');
			const result = await gemini.analyzeNewsForSymbol('BTC', 'Breaking market headlines');
			expect(result).toBeDefined();
			expect(result.event_category).toBe('none');
			expect(result.budgetExceeded).toBe(true);
		});

		it('gemini.generateEnrichedAlert returns neutral fallback when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const gemini = require('../../src/services/grounding/gemini');
			const result = await gemini.generateEnrichedAlert({
				text: 'BINANCE:BTCUSDT long signal triggered at key support',
			});
			expect(result).toBeDefined();
			expect(result.sentiment).toBe('NEUTRAL');
			expect(result.budgetExceeded).toBe(true);
		});

		it('grounding.deriveSearchQuery returns alertText directly when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const { deriveSearchQuery } = require('../../src/services/grounding/grounding');
			const query = await deriveSearchQuery('ETHUSDT breakout trade');
			expect(query).toBe('ETHUSDT breakout trade');
		});

		it('grounding.groundAlert returns ungrounded alert fallback when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const { groundAlert } = require('../../src/services/grounding/grounding');
			const result = await groundAlert({ text: 'SOLUSDT massive momentum' });
			expect(result.sentiment).toBe('NEUTRAL');
			expect(result.budgetExceeded).toBe(true);
			expect(result.sources).toEqual([]);
		});

		it('geminiPriceService.fetchGeminiPrice returns null when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const geminiPriceService = require('../../src/services/grounding/geminiPriceService');
			const result = await geminiPriceService.fetchGeminiPrice('BTC');
			expect(result).toBeNull();
		});

		it('genaiClient.llmCallv2 throws TOKEN_BUDGET_EXCEEDED when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const genaiClient = require('../../src/services/grounding/genaiClient');
			await expect(genaiClient.llmCallv2({ systemPrompt: 'test', userPrompt: 'test' }))
				.rejects
				.toThrow('Daily token cost budget exceeded');
		});

		it('resolves model pricing across provider prefixes, suffixes, and fallback', () => {
			const tracker = new GlobalTokenCostBudgetTracker();

			// Strip google/ and -001
			const geminiFlash = tracker.calculateCost(1_000_000, 1_000_000, 'google/gemini-2.0-flash-001');
			expect(geminiFlash.inputCost).toBeCloseTo(0.10, 4);
			expect(geminiFlash.outputCost).toBeCloseTo(0.40, 4);

			// Strip google-ai-studio/
			const gemini25 = tracker.calculateCost(1_000_000, 1_000_000, 'google-ai-studio/gemini-2.5-flash');
			expect(gemini25.inputCost).toBeCloseTo(0.30, 4);
			expect(gemini25.outputCost).toBeCloseTo(2.50, 4);

			// Strip azure/
			const gpt4oMini = tracker.calculateCost(1_000_000, 1_000_000, 'azure/gpt-4o-mini');
			expect(gpt4oMini.inputCost).toBeCloseTo(0.15, 4);
			expect(gpt4oMini.outputCost).toBeCloseTo(0.60, 4);

			// Unrecognized model falls back to default nonzero price to preserve budget limits
			const unknownModel = tracker.calculateCost(1_000_000, 1_000_000, 'custom-vendor/new-llm');
			expect(unknownModel.inputCost).toBeGreaterThan(0);
			expect(unknownModel.outputCost).toBeGreaterThan(0);

			// Gemma is free
			const gemma = tracker.calculateCost(1_000_000, 1_000_000, 'gemma-2-9b');
			expect(gemma.inputCost).toBe(0);
			expect(gemma.outputCost).toBe(0);
		});

		it('does not increment alertsSent or latch flags if admin notification delivery fails', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '1.00';
			process.env.TOKEN_COST_WARN_THRESHOLD_PCT = '80';

			const tracker = new GlobalTokenCostBudgetTracker();
			// Simulate delivery failure (e.g. no admin chat or network error)
			const notifySpy = jest.spyOn(tracker, '_sendAdminNotification').mockResolvedValue(false);

			// 85% spend crossed
			tracker.recordUsage({ inputTokens: 1_700_000, outputTokens: 1_700_000 }, 'gemini-2.0-flash');
			await Promise.resolve();

			expect(notifySpy).toHaveBeenCalledTimes(1);
			expect(tracker.warningAlertSent).toBe(false);
			expect(tracker.alertsSent).toBe(0);

			// Now simulate successful delivery when retried
			notifySpy.mockResolvedValue(true);
			tracker.recordUsage({ inputTokens: 10_000, outputTokens: 10_000 }, 'gemini-2.0-flash');
			await Promise.resolve();

			expect(tracker.warningAlertSent).toBe(true);
			expect(tracker.alertsSent).toBe(1);
		});

		it('persists spend increments and synchronizes shared spend with Firestore', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '5.00';

			const mockDocRef = {
				set: jest.fn().mockResolvedValue({}),
				get: jest.fn().mockResolvedValue({
					exists: true,
					data: () => ({
						dailySpendUsd: 3.50,
						dailyInputTokens: 2_000_000,
						dailyOutputTokens: 2_000_000,
					}),
				}),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue({
					doc: jest.fn().mockReturnValue(mockDocRef),
				}),
			};

			const tracker = new GlobalTokenCostBudgetTracker();
			tracker.firestore = mockFirestore;

			// Record spend locally
			tracker.recordUsage({ inputTokens: 100_000, outputTokens: 100_000 }, 'gemini-2.0-flash');
			expect(mockFirestore.collection).toHaveBeenCalledWith('tokenBudgets');
			expect(mockDocRef.set).toHaveBeenCalled();

			// Sync spend from shared Firestore replica
			await tracker.syncSharedSpend();
			expect(tracker.dailySpendUsd).toBe(3.50);
		});

		it('enrichmentService guards against exceeded budget and registers global usage', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const { getEnrichmentService } = require('../../src/services/inference/enrichmentService');
			const service = getEnrichmentService();
			jest.spyOn(service, 'isEnabled').mockReturnValue(true);

			const result = await service.enrichAlert({ confidence: 0.8 });
			expect(result).toBeNull();
		});

		it('azureAiClient throws 429 when budget is exceeded', async () => {
			process.env.ENABLE_TOKEN_COST_BUDGET = 'true';
			process.env.TOKEN_COST_DAILY_BUDGET_USD = '0.01';

			globalTokenTracker.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gemini-2.0-flash');
			expect(tokenCostBudgetService.isBudgetExceeded()).toBe(true);

			const { AzureAIClient } = require('../../src/services/inference/azureAiClient');
			const client = new AzureAIClient();
			jest.spyOn(client, 'validate').mockReturnValue(true);

			await expect(client.chatCompletion('system', 'user'))
				.rejects
				.toThrow('Daily LLM token cost budget exceeded');
		});
	});
});
