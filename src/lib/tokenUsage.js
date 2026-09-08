/**
 * Token usage utilities
 * Provides normalization helpers and a tracker for aggregating
 * input/output tokens across multiple LLM calls.
 */

function toNumber(value) {
	if (value === null || value === undefined || value === '') return null;
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
	const totalTokens = (explicitTotal != null && explicitTotal > 0) ? explicitTotal : inputTokens + outputTokens;

	return {
		inputTokens,
		outputTokens,
		totalTokens,
	};
}

class TokenUsageTracker {
	constructor() {
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.inputCost = 0;
		this.outputCost = 0;
		this.bySource = {};
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

	/**
	 * Add a usage record attributed to a named source
	 * @param {string} name - Name of the enrichment source (e.g. 'geminiGrounding', 'tradingviewMcp')
	 * @param {Object|null|undefined} usage - Raw metadata, normalized object, or TokenUsageTracker
	 * @param {string} [model] - Model name for pricing calculation
	 */
	addSource(name, usage, model) {
		if (!name || typeof name !== 'string') return;
		const rawUsage = (usage && typeof usage.toJSON === 'function') ? usage.toJSON() : usage;
		const normalized = normalizeUsageMetadata(rawUsage);
		if (!normalized) return;

		const currentInput = normalized.inputTokens || 0;
		let currentOutput = normalized.outputTokens || 0;

		// If only totalTokens is available, spread remainder into outputTokens
		const remainder = (normalized.totalTokens || 0) - currentInput - currentOutput;
		if (remainder > 0) {
			currentOutput += remainder;
		}

		if (!this.bySource[name]) {
			this.bySource[name] = {
				inputTokens: 0,
				outputTokens: 0,
				totalTokens: 0,
			};
		}

		this.bySource[name].inputTokens += currentInput;
		this.bySource[name].outputTokens += currentOutput;
		this.bySource[name].totalTokens = this.bySource[name].inputTokens + this.bySource[name].outputTokens;

		this.inputTokens += currentInput;
		this.outputTokens += currentOutput;

		if (rawUsage && typeof rawUsage.inputCost === 'number' && typeof rawUsage.outputCost === 'number') {
			this.inputCost += rawUsage.inputCost;
			this.outputCost += rawUsage.outputCost;
		} else if (model) {
			const { inputCost, outputCost } = this.calculateCost(currentInput, currentOutput, model);
			this.inputCost += inputCost;
			this.outputCost += outputCost;
		}
	}

	merge(otherTracker) {
		if (!otherTracker) return;
		const otherData = typeof otherTracker.toJSON === 'function' ? otherTracker.toJSON() : otherTracker;
		const { inputTokens, outputTokens, inputCost, outputCost, bySource } = otherData;
		this.inputTokens += (inputTokens || 0);
		this.outputTokens += (outputTokens || 0);
		this.inputCost += (inputCost || 0);
		this.outputCost += (outputCost || 0);

		if (bySource && typeof bySource === 'object') {
			for (const [sourceName, sourceUsage] of Object.entries(bySource)) {
				if (!sourceUsage) continue;
				if (!this.bySource[sourceName]) {
					this.bySource[sourceName] = {
						inputTokens: 0,
						outputTokens: 0,
						totalTokens: 0,
					};
				}
				const sIn = sourceUsage.inputTokens || 0;
				const sOut = sourceUsage.outputTokens || 0;
				this.bySource[sourceName].inputTokens += sIn;
				this.bySource[sourceName].outputTokens += sOut;
				this.bySource[sourceName].totalTokens = this.bySource[sourceName].inputTokens + this.bySource[sourceName].outputTokens;
			}
		}
	}

	toJSON() {
		const totalTokens = this.inputTokens + this.outputTokens;
		const totalCost = this.inputCost + this.outputCost;
		const result = {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens,
			inputCost: this.inputCost,
			outputCost: this.outputCost,
			totalCost,
		};
		const sourceKeys = Object.keys(this.bySource || {});
		if (sourceKeys.length > 0) {
			result.bySource = {};
			for (const key of sourceKeys) {
				result.bySource[key] = {
					inputTokens: this.bySource[key].inputTokens,
					outputTokens: this.bySource[key].outputTokens,
					totalTokens: this.bySource[key].totalTokens,
				};
			}
		}
		return result;
	}

	/**
	 * Format usage and price as a string
	 * @returns {string}
	 */
	formatSummary() {
		const { inputTokens, outputTokens, totalTokens, inputCost, outputCost, totalCost, bySource } = this.toJSON();

		// Helper to format currency (up to 6 decimal places for small amounts)
		const fmt = (val) => {
			if (val === 0) return '0.00';
			return val < 0.01 ? val.toPrecision(3) : val.toFixed(4);
		};

		let summary = `Token usage:
- In ${inputTokens} ($${fmt(inputCost)})
- Out ${outputTokens} ($${fmt(outputCost)})
- Total ${totalTokens} ($${fmt(totalCost)})`;

		if (bySource && Object.keys(bySource).length > 1) {
			const sourceBreakdowns = Object.entries(bySource)
				.map(([name, s]) => `  • ${name}: ${s.totalTokens || (s.inputTokens + s.outputTokens)} (${s.inputTokens} in / ${s.outputTokens} out)`)
				.join('\n');
			summary += `\nBy source:\n${sourceBreakdowns}`;
		}

		return summary;
	}
}

module.exports = {
	normalizeUsageMetadata,
	TokenUsageTracker,
};
