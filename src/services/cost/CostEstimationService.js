'use strict';

/**
 * Pre-flight cost estimation for LLM-driven endpoints (Issue #745).
 *
 * Owner decision (option 1): approximate LLM token costs with a documented
 * rough upper bound and report non-LLM external costs as unknown/null, never
 * $0. This module never calls Gemini, TradingView MCP, Brave Search, Langfuse
 * (remote), Firestore, or any billable provider — it only reads runtime
 * configuration and local prompt-size constants.
 *
 * Token approximation answers the tokenizer-variance question (virgin-trainee-dev):
 * this is intentionally a rough upper bound (`chars / 4` for input, configured
 * output budgets), not a precise tokenization. Actual usage will vary with
 * tokenizer version and generation length; consumers must treat the USD figure
 * as an estimate-only planning ceiling, never as an exact bill.
 */

const { PRICING_PER_1M, resolveModelPricing } = require('../../lib/tokenUsage');

// Local prompt defaults (src/services/prompts/defaults/*.txt) — input-token
// baseline per LLM call, derived from file sizes at time of writing.
const NEWS_PROMPT_CHARS = 3615; // news-analysis.user 3456 + system 159
const NEWS_QUERY_CHARS = 510; // search-query-derivation system 465 + query 45

const DEFAULTS = Object.freeze({
	newsOutputTokens: 400,
	analysisOutputTokens: 800,
	scannerOutputTokens: 600,
	dailyQuotaTokens: 1000000,
});

// Canonical operations from the issue + owner decision. Aliases map to canonical.
const OPERATION_ALIASES = Object.freeze({
	'news-monitor': 'news-monitor',
	news: 'news-monitor',
	'news-monitor-alert': 'news-monitor',
	'expanded-analysis-alert': 'expanded-analysis-alert',
	'expanded-analysis': 'expanded-analysis-alert',
	expanded_analysis: 'expanded-analysis-alert',
	'market-scanner-alert': 'market-scanner-alert',
	'market-scanner': 'market-scanner-alert',
	market_scanner: 'market-scanner-alert',
	'tradingview-analysis': 'tradingview-analysis',
	'jobs-tradingview-analysis': 'tradingview-analysis',
	jobs: 'tradingview-analysis',
	tradingview_analysis: 'tradingview-analysis',
});

const CANONICAL_OPERATIONS = Object.freeze([
	'news-monitor',
	'expanded-analysis-alert',
	'market-scanner-alert',
	'tradingview-analysis',
]);

function normalizeOperation(operation) {
	if (typeof operation !== 'string') {
		return null;
	}
	const key = operation.trim().toLowerCase();
	return OPERATION_ALIASES[key] || null;
}

function isValidOperation(operation) {
	return normalizeOperation(operation) !== null;
}

function estimateInputTokensForChars(chars) {
	if (!Number.isFinite(chars) || chars <= 0) {
		return 1;
	}
	return Math.max(1, Math.ceil(chars / 4));
}

function estimateTokensForText(text) {
	return estimateInputTokensForChars(String(text || '').length);
}

function getRemoteConfigService() {
	// Lazy require to avoid a require cycle at module load (status.js).
	// eslint-disable-next-line global-require
	return require('../remoteConfig/RemoteConfigService');
}

function resolveRuntimeConfig() {
	try {
		return getRemoteConfigService().getRuntimeConfig();
	} catch (error) {
		return {};
	}
}

function resolveRemoteOverrideSafely(key) {
	try {
		return getRemoteConfigService().getRemoteOverride(key);
	} catch (error) {
		return undefined;
	}
}

function isEnabled() {
	const config = resolveRuntimeConfig();
	if (config.ENABLE_DRY_RUN_COST !== undefined) {
		return Boolean(config.ENABLE_DRY_RUN_COST);
	}
	const env = process.env.ENABLE_DRY_RUN_COST;
	if (env !== undefined) {
		return env === 'true';
	}
	return true;
}

function resolveProvider() {
	const provider = typeof process.env.MODEL_PROVIDER === 'string' && process.env.MODEL_PROVIDER.trim() !== ''
		? process.env.MODEL_PROVIDER.trim().toLowerCase()
		: 'gemini';
	return ['gemini', 'azure', 'openrouter', 'cloudflare'].includes(provider) ? provider : 'gemini';
}

function resolveModel(runtimeConfig = resolveRuntimeConfig()) {
	const provider = resolveProvider();
	if (provider === 'azure' && process.env.AZURE_LLM_MODEL) {
		return process.env.AZURE_LLM_MODEL.trim();
	}
	if (provider === 'openrouter' && process.env.OPENROUTER_MODEL) {
		return process.env.OPENROUTER_MODEL.trim();
	}
	if (provider === 'cloudflare' && process.env.CF_AIG_MODEL) {
		return process.env.CF_AIG_MODEL.trim();
	}
	const candidates = [
		runtimeConfig && runtimeConfig.GEMINI_MODEL_NAME,
		process.env.GEMINI_MODEL_NAME,
		runtimeConfig && runtimeConfig.GROUNDING_MODEL_NAME,
		process.env.GROUNDING_MODEL_NAME,
		runtimeConfig && runtimeConfig.GEMINI_MODEL_NAME_FALLBACK,
		process.env.GEMINI_MODEL_NAME_FALLBACK,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim() !== '') {
			return candidate.trim();
		}
	}
	return 'gemini-2.5-flash';
}

function resolveProviderName() {
	return resolveProvider();
}

function parseRatesJson(raw) {
	if (typeof raw !== 'string' || raw.trim() === '') {
		return {};
	}
	try {
		const parsed = JSON.parse(raw.trim());
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const out = {};
		for (const [model, rate] of Object.entries(parsed)) {
			if (typeof model !== 'string') {
				continue;
			}
			if (!rate || typeof rate !== 'object') {
				continue;
			}
			const input = Number(rate.input);
			const output = Number(rate.output);
			if (!Number.isFinite(input) || !Number.isFinite(output) || input < 0 || output < 0 || input > 1000 || output > 1000) {
				continue;
			}
			out[model.trim()] = { input, output };
		}
		return out;
	} catch (error) {
		return {};
	}
}

function resolveRates() {
	const remote = resolveRemoteOverrideSafely('LLM_COST_RATES_JSON');
	const runtimeConfig = resolveRuntimeConfig();
	const envRaw = process.env.LLM_COST_RATES_JSON;
	const remoteRaw = typeof remote === 'string' ? remote : undefined;
	const configRaw = runtimeConfig && typeof runtimeConfig.LLM_COST_RATES_JSON === 'string'
		? runtimeConfig.LLM_COST_RATES_JSON
		: undefined;
	const raw = remoteRaw !== undefined
		? remoteRaw
		: (configRaw !== undefined && configRaw.trim() !== '' ? configRaw : envRaw);
	const source = remoteRaw !== undefined && remoteRaw.trim() !== ''
		? 'remote'
		: (typeof raw === 'string' && raw.trim() !== '' ? 'environment' : 'default');
	const overrides = parseRatesJson(raw);
	const rates = { ...PRICING_PER_1M, ...overrides };
	return { rates, overrides, source };
}

function pricingForModel(model, rates) {
	const override = parseRatesJson(process.env.LLM_COST_RATES_JSON);
	void override;
	const direct = rates && typeof rates[model] === 'object' ? rates[model] : null;
	if (direct && Number.isFinite(direct.input) && Number.isFinite(direct.output)) {
		return direct;
	}
	try {
		return resolveModelPricing(model);
	} catch (error) {
		return PRICING_PER_1M.default;
	}
}

function costForTokens(inputTokens, outputTokens, pricing) {
	const inputCost = (Number(inputTokens) || 0) / 1000000 * (pricing.input || 0);
	const outputCost = (Number(outputTokens) || 0) / 1000000 * (pricing.output || 0);
	return { inputCostUsd: inputCost, outputCostUsd: outputCost, costUsd: inputCost + outputCost };
}

function round6(value) {
	return Math.round((Number(value) || 0) * 1000000) / 1000000;
}

function resolveNumbers(runtimeConfig = resolveRuntimeConfig()) {
	const pick = (key, fallback, min, max) => {
		const rawRemote = resolveRemoteOverrideSafely(key);
		if (rawRemote !== undefined && Number.isFinite(Number(rawRemote))) {
			const value = Number(rawRemote);
			if (value >= min && value <= max) {
				return value;
			}
		}
		const configValue = runtimeConfig && runtimeConfig[key];
		if (configValue !== undefined && Number.isFinite(Number(configValue))) {
			const value = Number(configValue);
			if (value >= min && value <= max) {
				return value;
			}
		}
		const envValue = process.env[key];
		if (envValue !== undefined && envValue !== '') {
			const value = Number(envValue);
			if (Number.isFinite(value) && value >= min && value <= max) {
				return value;
			}
		}
		return fallback;
	};
	return {
		newsOutputTokens: pick('COST_ESTIMATION_OUTPUT_TOKENS_NEWS', DEFAULTS.newsOutputTokens, 10, 8000),
		analysisOutputTokens: pick('COST_ESTIMATION_OUTPUT_TOKENS_ANALYSIS', DEFAULTS.analysisOutputTokens, 10, 8000),
		scannerOutputTokens: pick('COST_ESTIMATION_OUTPUT_TOKENS_SCANNER', DEFAULTS.scannerOutputTokens, 10, 8000),
		dailyQuotaTokens: pick('COST_ESTIMATION_DAILY_QUOTA_TOKENS', DEFAULTS.dailyQuotaTokens, 1000, 100000000),
	};
}

function normalizeSymbols(rawSymbols, maxSymbols = 50) {
	if (!Array.isArray(rawSymbols)) {
		return [];
	}
	return rawSymbols
		.filter((entry) => typeof entry === 'string' && entry.trim() !== '')
		.map((entry) => entry.trim())
		.slice(0, maxSymbols);
}

function buildPerSymbol(items, inputTokensPerItem, outputTokensPerItem, pricing) {
	return items.map((item) => {
		const cost = costForTokens(inputTokensPerItem, outputTokensPerItem, pricing);
		return {
			symbol: item.symbol,
			tokensIn: inputTokensPerItem,
			tokensOut: outputTokensPerItem,
			estimatedTotalTokens: inputTokensPerItem + outputTokensPerItem,
			costUsd: round6(cost.costUsd),
		};
	});
}

function buildModelBreakdown(model, calls, tokensIn, tokensOut, pricing) {
	const cost = costForTokens(tokensIn, tokensOut, pricing);
	return [{
		provider: resolveProviderName(),
		model,
		calls,
		tokensIn,
		tokensOut,
		estimatedTotalTokens: tokensIn + tokensOut,
		costUsd: round6(cost.costUsd),
		inputCostUsd: round6(cost.inputCostUsd),
		outputCostUsd: round6(cost.outputCostUsd),
		ratePer1m: { input: pricing.input, output: pricing.output },
	}];
}

function unknownExternal(kind, calls, reason) {
	return [{
		kind,
		calls: Number(calls) || 0,
		status: 'unknown',
		estimatedCostUsd: null,
		reason,
	}];
}

function estimate(options = {}) {
	const operation = normalizeOperation(options.operation);
	if (!operation) {
		return null;
	}
	const runtimeConfig = resolveRuntimeConfig();
	const numbers = resolveNumbers(runtimeConfig);
	const model = resolveModel(runtimeConfig);
	const { rates, source: ratesSource } = resolveRates();
	const pricing = pricingForModel(model, rates);
	const warnings = [];

	if (!model) {
		warnings.push('model_unknown');
	}

	const symbols = normalizeSymbols(options.symbols || []);
	const body = options.body && typeof options.body === 'object' ? options.body : {};

	// Per-operation symbol/call derivation (no billable calls; caller validates).
	let perSymbol = [];
	let calls = 0;
	let tokensIn = 0;
	let tokensOut = 0;
	let externalCosts = [];
	let outputBudgetKind = null;

	if (operation === 'news-monitor') {
		// News handler validates up to 100 symbols; estimate the full accepted batch.
		const crypto = normalizeSymbols(body.crypto || options.crypto, 100);
		const stocks = normalizeSymbols(body.stocks || options.stocks, 100);
		const merged = symbols.length > 0 ? symbols.slice(0, 100) : [...crypto, ...stocks].slice(0, 100);
		const inputPerSymbol = estimateInputTokensForChars(NEWS_PROMPT_CHARS + NEWS_QUERY_CHARS);
		const outputPerSymbol = numbers.newsOutputTokens;
		calls = merged.length * 2;
		outputBudgetKind = 'COST_ESTIMATION_OUTPUT_TOKENS_NEWS';
		perSymbol = buildPerSymbol(merged.map((symbol) => ({ symbol })), inputPerSymbol, outputPerSymbol, pricing);
		tokensIn = inputPerSymbol * merged.length;
		tokensOut = outputPerSymbol * merged.length;
		externalCosts = unknownExternal('brave-search', merged.length, 'Brave Search is billed per request; no public price table is bundled, so cost is unknown rather than zero.');
	} else if (operation === 'expanded-analysis-alert') {
		const inputPerSymbol = 0;
		const outputPerSymbol = 0;
		// Expanded analysis is an MCP analysis per symbol, not an LLM call.
		perSymbol = symbols.map((symbol) => {
			const mtf = (body.includeMultiTimeframe === true || body.includeMultiTimeframe === 'true' || body.include_multi_timeframe === true || body.include_multi_timeframe === 'true') ? 1 : 0;
			const combined = body.analysisMode === 'combined' ? 1 : 0;
			return {
				symbol,
				tokensIn: inputPerSymbol,
				tokensOut: outputPerSymbol,
				estimatedTotalTokens: inputPerSymbol + outputPerSymbol,
				costUsd: 0,
				mcpCalls: 1 + mtf + combined,
			};
		});
		calls = perSymbol.reduce((sum, entry) => sum + (entry.mcpCalls || 0), 0);
		tokensIn = 0;
		tokensOut = 0;
		outputBudgetKind = 'COST_ESTIMATION_OUTPUT_TOKENS_ANALYSIS';
		externalCosts = unknownExternal('tradingview-mcp', calls, 'TradingView MCP has no bundled public price table, so external cost is unknown rather than zero.');
	} else if (operation === 'market-scanner-alert') {
		const rawScans = Array.isArray(body.scans) ? body.scans.filter((entry) => typeof entry === 'string') : null;
		const scans = rawScans && rawScans.length > 0 ? rawScans : ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
		const limit = Number.isInteger(Number(body.limit)) && Number(body.limit) > 0 ? Math.min(20, Math.max(1, Number(body.limit))) : 5;
		const isTruthyFlag = (value) => value === true || value === 'true';
		const mtf = isTruthyFlag(body.includeMultiTimeframe) || isTruthyFlag(body.include_multi_timeframe) ? 1 : 0;
		const baseCalls = scans.length;
		const candidateMtfCalls = mtf * scans.length * limit;
		calls = baseCalls + candidateMtfCalls;
		perSymbol = scans.map((scan) => ({
			symbol: scan,
			tokensIn: 0,
			tokensOut: 0,
			estimatedTotalTokens: 0,
			costUsd: 0,
			mcpCalls: 1 + (mtf ? limit : 0),
		}));
		tokensIn = 0;
		tokensOut = 0;
		outputBudgetKind = 'COST_ESTIMATION_OUTPUT_TOKENS_SCANNER';
		externalCosts = unknownExternal('tradingview-mcp', calls, 'TradingView MCP scanner calls have no bundled public price table, so external cost is unknown rather than zero.');
	} else if (operation === 'tradingview-analysis') {
		const type = typeof body.type === 'string' ? body.type : 'expanded-analysis';
		const subOperation = type === 'market-scanner' ? 'market-scanner-alert' : 'expanded-analysis-alert';
		return estimate({ ...options, operation: subOperation, body });
	}

	if (operation === 'expanded-analysis-alert' || operation === 'market-scanner-alert') {
		warnings.push('llm_cost_zero: this operation calls TradingView MCP, not an LLM; LLM token cost is $0 and MCP cost is unknown (not zero).');
	}

	const estimatedTotalTokens = tokensIn + tokensOut;
	const llmCost = tokensIn === 0 && tokensOut === 0
		? 0
		: costForTokens(tokensIn, tokensOut, pricing).costUsd;
	const estimatedCostUsd = round6(llmCost);
	const quotaImpactPercent = numbers.dailyQuotaTokens > 0
		? round6((estimatedTotalTokens / numbers.dailyQuotaTokens) * 100)
		: null;

	return {
		operation,
		dryRun: 'cost',
		estimate: true,
		noBillableCalls: true,
		model,
		tokensIn,
		tokensOut,
		estimatedTotalTokens,
		estimatedCostUsd,
		providerBreakdown: tokensIn === 0 && tokensOut === 0
			? []
			: buildModelBreakdown(model, Math.max(1, calls), tokensIn, tokensOut, pricing),
		externalCosts,
		quotaImpact: {
			dailyQuotaTokens: numbers.dailyQuotaTokens,
			percent: quotaImpactPercent,
			summary: `~${quotaImpactPercent}% of configured daily quota (${numbers.dailyQuotaTokens} tokens)`,
		},
		perSymbol,
		callCount: calls,
		warnings,
		assumptions: {
			tokenApprox: 'rough upper bound: ceil(chars / 4) for input; output uses a configured budget ceiling',
			outputBudgetKind,
			outputTokensPerCall: tokensOut > 0 ? Math.round(tokensOut / Math.max(1, calls)) : 0,
			ratesSource,
			estimateOnly: 'Estimate only — actual rate may differ; MCP/search costs are unknown, not $0.',
		},
	};
}

function getStatus() {
	const enabled = isEnabled();
	const { source } = resolveRates();
	const model = resolveModel();
	let rcSource = 'default';
	try {
		rcSource = getRemoteConfigService().getSource();
	} catch (error) {
		rcSource = 'unknown';
	}
	const status = enabled ? 'ready' : 'disabled';
	return {
		enabled,
		configured: true,
		ready: enabled,
		status,
		source: rcSource,
		ratesSource: source,
		model,
		operations: [...CANONICAL_OPERATIONS],
	};
}

module.exports = {
	OPERATION_ALIASES,
	CANONICAL_OPERATIONS,
	normalizeOperation,
	isValidOperation,
	estimateInputTokensForChars,
	estimateTokensForText,
	isEnabled,
	resolveModel,
	resolveProvider,
	resolveProviderName,
	resolveRates,
	estimate,
	getStatus,
	DEFAULTS,
	NEWS_PROMPT_CHARS,
	NEWS_QUERY_CHARS,
};
