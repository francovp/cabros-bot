/**
 * Token usage utilities
 * Provides normalization helpers and a tracker for aggregating
 * input/output tokens across multiple LLM calls.
 */

function toNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function firstDefined(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null) {
			return value;
		}
	}
	return null;
}

// Pricing per 1M tokens (USD)
// Based on: https://ai.google.dev/gemini-api/docs/pricing
const PRICING_PER_1M = {
	'gemini-3-pro-preview': { input: 2.00, output: 12.00 },
	'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
	'gemini-2.5-pro': { input: 1.25, output: 10.00 },
	'gemini-2.5-flash': { input: 0.30, output: 2.50 },
	'gemini-2.0-flash': { input: 0.10, output: 0.40 },
	'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
	// Other models
	'default': { input: 0.00, output: 0.00 },
};

/**
 * Normalize usage metadata from various providers into a common shape.
 * Supports Gemini usageMetadata ({ promptTokenCount, candidatesTokenCount, totalTokenCount }),
 * OpenAI-compatible usage ({ prompt_tokens, completion_tokens, total_tokens }),
 * and generic { inputTokens, outputTokens, totalTokens } objects.
 * @param {Object} usageMetadata
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number }|null}
 */
function normalizeUsageMetadata(usageMetadata) {
	if (!usageMetadata) return null;

	const meta = usageMetadata.usageMetadata || usageMetadata;
	const inputTokens = toNumber(firstDefined(meta.promptTokenCount, meta.inputTokens, meta.promptTokens, meta.prompt_tokens)) || 0;
	const outputTokens = toNumber(firstDefined(meta.candidatesTokenCount, meta.outputTokens, meta.completionTokens, meta.completion_tokens)) || 0;

	const explicitTotal = toNumber(firstDefined(meta.totalTokenCount, meta.totalTokens, meta.total_tokens));
	const totalTokens = explicitTotal != null ? explicitTotal : inputTokens + outputTokens;

	return {
		inputTokens,
		outputTokens,
		totalTokens: totalTokens != null ? totalTokens : inputTokens + outputTokens,
	};
}

/**
 * Normalize a model identifier so prefixed/versioned variants map onto
 * a known pricing key. Currently strips the `google-ai-studio/` gateway
 * prefix used by Cloudflare AI Gateway and trims whitespace.
 * @param {string} model
 * @returns {string}
 */
function normalizeModelName(model) {
	if (typeof model !== 'string') return model;
	const trimmed = model.trim();
	if (!trimmed) return trimmed;
	const slashIndex = trimmed.indexOf('/');
	if (slashIndex > 0 && slashIndex < trimmed.length - 1) {
		return trimmed.slice(slashIndex + 1);
	}
	return trimmed;
}

/**
 * Look up pricing for a model, recognizing both raw and prefixed/aliased
 * identifiers. Returns `{ pricing, matchedKey }` so the caller can detect
 * when an unknown model silently fell back to the `$0` default.
 * @param {string} model
 * @returns {{ pricing: {input: number, output: number}, matchedKey: string|null, unknown: boolean }}
 */
function resolvePricing(model) {
	if (typeof model !== 'string' || model.trim() === '') {
		return { pricing: PRICING_PER_1M['default'], matchedKey: null, unknown: false };
	}

	const normalized = normalizeModelName(model);

	// Direct match against the pricing map.
	let pricing = PRICING_PER_1M[normalized];
	let matchedKey = normalized;

	// Gemma variants are intentionally free (legacy free-tier behavior).
	if (!pricing && normalized.toLowerCase().includes('gemma')) {
		pricing = { input: 0, output: 0 };
	}

	// Fall back to default ($0) for everything else.
	if (!pricing) {
		pricing = PRICING_PER_1M['default'];
	}

	const unknown = pricing === PRICING_PER_1M['default'] && matchedKey !== 'default';
	return { pricing, matchedKey: normalized, unknown };
}

class TokenUsageTracker {
	constructor() {
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.inputCost = 0;
		this.outputCost = 0;
		this._unknownModels = new Set();
		this._warnedModels = new Set();
	}

	/**
	 * Calculate cost for token usage
	 * @param {number} inputTokens
	 * @param {number} outputTokens
	 * @param {string} model
	 */
	calculateCost(inputTokens, outputTokens, model) {
		const { pricing } = resolvePricing(model);
		const iCost = (inputTokens / 1000000) * pricing.input;
		const oCost = (outputTokens / 1000000) * pricing.output;
		return { inputCost: iCost, outputCost: oCost };
	}

	/**
	 * Add a usage record (raw metadata or normalized object)
	 * @param {Object|null|undefined} usage
	 * @param {string} [model] - Model name for pricing calculation
	 */
	addUsage(usage, model) {
		const normalized = normalizeUsageMetadata(usage);
		if (!normalized) return;

		const currentInput = normalized.inputTokens || 0;
		let currentOutput = normalized.outputTokens || 0;

		// If only totalTokens is available, spread remainder into outputTokens
		const remainder = (normalized.totalTokens || 0) - currentInput - currentOutput;
		if (remainder > 0) {
			currentOutput += remainder;
		}

		this.inputTokens += currentInput;
		this.outputTokens += currentOutput;

		if (model) {
			const { inputCost, outputCost } = this.calculateCost(currentInput, currentOutput, model);
			this.inputCost += inputCost;
			this.outputCost += outputCost;

			// Track unknown models so toJSON can surface them.
			const { unknown, matchedKey } = resolvePricing(model);
			if (unknown && matchedKey) {
				if (!this._unknownModels.has(matchedKey)) {
					this._unknownModels.add(matchedKey);
				}
				if (!this._warnedModels.has(matchedKey)) {
					this._warnedModels.add(matchedKey);
					console.warn(
						`[TokenUsageTracker] unknown model "${matchedKey}" priced at $0; add an entry to PRICING_PER_1M in src/lib/tokenUsage.js to enable real cost accounting`,
					);
				}
			}
		}
	}

	merge(otherTracker) {
		if (!otherTracker) return;
		const { inputTokens, outputTokens, inputCost, outputCost, pricing } = otherTracker.toJSON();
		this.inputTokens += inputTokens;
		this.outputTokens += outputTokens;
		this.inputCost += (inputCost || 0);
		this.outputCost += (outputCost || 0);
		if (pricing && Array.isArray(pricing.unknownModels)) {
			for (const model of pricing.unknownModels) {
				this._unknownModels.add(model);
			}
		}
	}

	toJSON() {
		const totalTokens = this.inputTokens + this.outputTokens;
		const totalCost = this.inputCost + this.outputCost;
		const unknownModels = Array.from(this._unknownModels);
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens,
			inputCost: this.inputCost,
			outputCost: this.outputCost,
			totalCost,
			pricing: {
				unknownModelPricing: unknownModels.length > 0,
				unknownModels,
			},
		};
	}

	/**
	 * Format usage and price as a string
	 * @returns {string}
	 */
	formatSummary() {
		const { inputTokens, outputTokens, totalTokens, inputCost, outputCost, totalCost, pricing } = this.toJSON();

		// Helper to format currency (up to 6 decimal places for small amounts)
		const fmt = (val) => {
			if (val === 0) return '0.00';
			return val < 0.01 ? val.toPrecision(3) : val.toFixed(4);
		};

		const summary = `Token usage:
- In ${inputTokens} ($${fmt(inputCost)})
- Out ${outputTokens} ($${fmt(outputCost)})
- Total ${totalTokens} ($${fmt(totalCost)})`;

		if (pricing && pricing.unknownModelPricing && pricing.unknownModels.length > 0) {
			return `${summary}\n- Note: cost is $0 (unknown model pricing for: ${pricing.unknownModels.join(', ')})`;
		}
		return summary;
	}
}

module.exports = {
	normalizeUsageMetadata,
	TokenUsageTracker,
	normalizeModelName,
	resolvePricing,
};
