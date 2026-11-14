'use strict';

const costEstimationService = require('../../src/services/cost/CostEstimationService');
const { resolveDryRunCost, isDryRunCostValue } = require('../../src/lib/dryRunRequest');

describe('CostEstimationService (Issue #745)', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
		delete process.env.LLM_COST_RATES_JSON;
		delete process.env.ENABLE_DRY_RUN_COST;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('dryRun=cost detection', () => {
		it('recognises ?dryRun=cost and ?estimate=true', () => {
			expect(isDryRunCostValue('cost')).toBe(true);
			expect(resolveDryRunCost({ query: { dryRun: 'cost' }, body: {} })).toBe(true);
			expect(resolveDryRunCost({ query: { estimate: 'true' }, body: {} })).toBe(true);
			expect(resolveDryRunCost({ query: {}, body: { dryRun: 'cost' } })).toBe(true);
			expect(resolveDryRunCost({ query: {}, body: { estimate: true } })).toBe(true);
			expect(resolveDryRunCost({ query: { estimate: 'cost' }, body: {} })).toBe(true);
			expect(resolveDryRunCost({ query: { estimate: 'estimate' }, body: {} })).toBe(true);
			expect(resolveDryRunCost({ query: { dryRun: 'true' }, body: {} })).toBe(false);
		});
	});

	describe('zero-call guarantee', () => {
		it('makes no billable calls: pure function with no fetch/MCP/Firestore dependency', () => {
			const serviceSource = require('fs').readFileSync(
				require.resolve('../../src/services/cost/CostEstimationService'),
				'utf8',
			);
			expect(serviceSource).not.toMatch(/fetch\s*\(/);
			expect(serviceSource).not.toMatch(/require\(.*(TradingViewMcpService|genaiClient|BraveSearch|Langfuse|firestoreConfig)/);
			// Estimate must be deterministic and synchronous
			const first = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			const second = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			expect(first).toEqual(second);
			expect(first.noBillableCalls).toBe(true);
			expect(first.dryRun).toBe('cost');
		});

		it('expanded-analysis and market-scanner report MCP cost as unknown, never $0', () => {
			const expanded = costEstimationService.estimate({
				operation: 'expanded-analysis-alert',
				symbols: ['BINANCE:BTCUSDT'],
				body: {},
			});
			expect(expanded.tokensIn).toBe(0);
			expect(expanded.estimatedCostUsd).toBe(0);
			expect(expanded.externalCosts[0]).toMatchObject({ kind: 'tradingview-mcp', status: 'unknown', estimatedCostUsd: null });
			expect(expanded.warnings.join(' ')).toMatch(/MCP/);

			const scanner = costEstimationService.estimate({
				operation: 'market-scanner-alert',
				symbols: ['top_gainers'],
				body: { scans: ['top_gainers', 'top_losers'] },
			});
			expect(scanner.externalCosts[0].status).toBe('unknown');
			expect(scanner.externalCosts[0].estimatedCostUsd).toBeNull();
		});
	});

	describe('per-symbol math', () => {
		it('scales tokens and cost per symbol', () => {
			const one = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			const two = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT', 'ETHUSDT'] });
			expect(two.tokensIn).toBe(one.tokensIn * 2);
			expect(two.tokensOut).toBe(one.tokensOut * 2);
			expect(two.estimatedTotalTokens).toBe(two.tokensIn + two.tokensOut);
			expect(two.estimatedCostUsd).toBeCloseTo(one.estimatedCostUsd * 2, 5);
			expect(two.perSymbol).toHaveLength(2);
			expect(two.perSymbol[0].symbol).toBe('BTCUSDT');
		});

		it('uses chars/4 rough upper bound plus output budget', () => {
			// NEWS_PROMPT_CHARS + QUERY_CHARS = 4125 -> ceil(4125/4)=1032 per symbol
			expect(costEstimationService.estimateInputTokensForChars(4125)).toBe(1032);
			expect(costEstimationService.estimateInputTokensForChars(0)).toBe(1);
			const estimate = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			expect(estimate.tokensIn).toBe(1032);
			expect(estimate.tokensOut).toBe(400);
		});

		it('accounts for explicit grounded context or configured context allowance in news input tokens', () => {
			const baseline = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			expect(baseline.tokensIn).toBe(1032);

			// Explicit text context in body
			const withContext = costEstimationService.estimate({
				operation: 'news-monitor',
				symbols: ['BTCUSDT'],
				body: { groundedContext: 'Short market summary text about Bitcoin.' },
			});
			expect(withContext.tokensIn).toBeGreaterThan(baseline.tokensIn);
			expect(withContext.assumptions.contextAllowanceTokens).toBeGreaterThan(0);

			// Configured context allowance via options
			const withAllowance = costEstimationService.estimate({
				operation: 'news-monitor',
				symbols: ['BTCUSDT'],
				contextAllowanceTokens: 500,
			});
			expect(withAllowance.tokensIn).toBe(1032 + 500);
			expect(withAllowance.assumptions.contextAllowanceTokens).toBe(500);
		});
	});

	describe('per-model cost lookup and Remote Config fallback', () => {
		it('prices with bundled PRICING_PER_1M and reports ratesSource default', () => {
			const estimate = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			const { rates, source } = costEstimationService.resolveRates();
			expect(source).toBe('default');
			expect(rates).toBeDefined();
			// gemini-2.5-flash default: $0.30 / $2.50 per 1M
			expect(estimate.estimatedCostUsd).toBeCloseTo(
				(1032 * 0.30 + 400 * 2.50) / 1000000,
				5,
			);
			expect(estimate.providerBreakdown).toHaveLength(1);
			expect(estimate.providerBreakdown[0]).toMatchObject({
				provider: 'gemini',
				calls: 2,
			});
		});

		it('overrides rates from LLM_COST_RATES_JSON', () => {
			process.env.LLM_COST_RATES_JSON = JSON.stringify({
				'gemini-2.5-flash': { input: 1, output: 1 },
			});
			const estimate = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			expect(estimate.assumptions.ratesSource).toBe('environment');
			expect(estimate.estimatedCostUsd).toBeCloseTo((1032 + 400) / 1000000, 6);
		});

		it('ignores malformed rate JSON and falls back to defaults', () => {
			process.env.LLM_COST_RATES_JSON = 'not-json{{{';
			const estimate = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			// Malformed JSON yields no overrides, so pricing falls back to the bundled table.
			expect(estimate.estimatedCostUsd).toBeCloseTo((1032 * 0.30 + 400 * 2.50) / 1000000, 5);
		});
	});

	describe('quotaImpact', () => {
		it('computes percent against configured daily quota', () => {
			process.env.COST_ESTIMATION_DAILY_QUOTA_TOKENS = '1000000';
			const estimate = costEstimationService.estimate({ operation: 'news-monitor', symbols: ['BTCUSDT'] });
			expect(estimate.quotaImpact.dailyQuotaTokens).toBe(1000000);
			expect(estimate.quotaImpact.percent).toBeCloseTo((1432 / 1000000) * 100, 6);
			expect(estimate.quotaImpact.summary).toMatch(/configured daily quota/);
		});
	});

	describe('operations/estimate selector', () => {
		it('normalizes aliases and rejects unknown operations', () => {
			expect(costEstimationService.normalizeOperation('jobs')).toBe('tradingview-analysis');
			expect(costEstimationService.normalizeOperation('NEWS-MONITOR')).toBe('news-monitor');
			expect(costEstimationService.isValidOperation('expanded-analysis')).toBe(true);
			expect(costEstimationService.estimate({ operation: 'nope' })).toBeNull();
		});

		it('tradingview-analysis delegates to expanded or market-scanner by type', () => {
			const expanded = costEstimationService.estimate({
				operation: 'tradingview-analysis',
				symbols: ['BINANCE:BTCUSDT'],
				body: { type: 'expanded-analysis' },
			});
			expect(expanded.operation).toBe('expanded-analysis-alert');

			const scanner = costEstimationService.estimate({
				operation: 'tradingview-analysis',
				symbols: ['top_gainers'],
				body: { type: 'market-scanner', scans: ['top_gainers'] },
			});
			expect(scanner.operation).toBe('market-scanner-alert');
		});
	});

	describe('getStatus', () => {
		it('exposes enabled/configured/ready/source without secrets', () => {
			const status = costEstimationService.getStatus();
			expect(status).toMatchObject({
				enabled: true,
				configured: true,
				ready: true,
				status: 'ready',
			});
			expect(status.source).toEqual(expect.any(String));
			expect(status.operations).toEqual(
				expect.arrayContaining(['news-monitor', 'expanded-analysis-alert', 'market-scanner-alert', 'tradingview-analysis']),
			);
			expect(JSON.stringify(status)).not.toMatch(/api[_-]?key|secret|token/i);
		});
	});
});
