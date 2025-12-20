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
	'gemma-3': { input: 0, output: 0 },
	'gemma-3n': { input: 0, output: 0 },
	'gemma-3-27b-it': { input: 0, output: 0 },
	'gemma-3-1b-it': { input: 0, output: 0 },
	'gemma-3-4b-it': { input: 0, output: 0 },
	'gemma-3-8b-it': { input: 0, output: 0 },
	// Legacy/Other models defaults (using Flash 2.0 pricing as baseline)
	'default': { input: 0.10, output: 0.40 }
};

/**
 * Normalize usage metadata from various providers into a common shape.
 * Supports Gemini usageMetadata ({ promptTokenCount, candidatesTokenCount, totalTokenCount })
 * and generic { inputTokens, outputTokens, totalTokens } objects.
 * @param {Object} usageMetadata
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number }|null}
 */
function normalizeUsageMetadata(usageMetadata) {
	if (!usageMetadata) return null;

	const meta = usageMetadata.usageMetadata || usageMetadata;
	const inputTokens = toNumber(firstDefined(meta.promptTokenCount, meta.inputTokens, meta.promptTokens)) || 0;
	const outputTokens = toNumber(firstDefined(meta.candidatesTokenCount, meta.outputTokens, meta.completionTokens)) || 0;

	const explicitTotal = toNumber(firstDefined(meta.totalTokenCount, meta.totalTokens));
	const totalTokens = explicitTotal != null ? explicitTotal : inputTokens + outputTokens;

	return {
		inputTokens,
		outputTokens,
		totalTokens: totalTokens != null ? totalTokens : inputTokens + outputTokens,
	};
}

class TokenUsageTracker {
	constructor() {
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.inputCost = 0;
		this.outputCost = 0;
	}

	/**
	 * Calculate cost for token usage
	 * @param {number} inputTokens
	 * @param {number} outputTokens
	 * @param {string} model
	 */
	calculateCost(inputTokens, outputTokens, model) {
		let pricing = PRICING_PER_1M[model];

		// Handle unknown gemma models as free (fallback)
		if (!pricing && model && model.toLowerCase().includes('gemma')) {
			pricing = { input: 0, output: 0 };
		}

		// Fallback to default
		if (!pricing) {
			pricing = PRICING_PER_1M['default'];
		}

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
		}
	}

	merge(otherTracker) {
		if (!otherTracker) return;
		const { inputTokens, outputTokens, inputCost, outputCost } = otherTracker.toJSON();
		this.inputTokens += inputTokens;
		this.outputTokens += outputTokens;
		this.inputCost += (inputCost || 0);
		this.outputCost += (outputCost || 0);
	}

	toJSON() {
		const totalTokens = this.inputTokens + this.outputTokens;
		const totalCost = this.inputCost + this.outputCost;
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens,
			inputCost: this.inputCost,
			outputCost: this.outputCost,
			totalCost
		};
	}

	/**
	 * Format usage and price as a string
	 * @returns {string}
	 */
	formatSummary() {
		const { inputTokens, outputTokens, totalTokens, inputCost, outputCost, totalCost } = this.toJSON();

		// Helper to format currency (up to 6 decimal places for small amounts)
		const fmt = (val) => {
			if (val === 0) return '0.00';
			return val < 0.01 ? val.toPrecision(3) : val.toFixed(4);
		};

		return `Token usage:
- In ${inputTokens} ($${fmt(inputCost)})
- Out ${outputTokens} ($${fmt(outputCost)})
- Total ${totalTokens} ($${fmt(totalCost)})`;
	}
}

module.exports = {
	normalizeUsageMetadata,
	TokenUsageTracker,
};
