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
	}

	/**
	 * Add a usage record (raw metadata or normalized object)
	 * @param {Object|null|undefined} usage
	 */
	addUsage(usage) {
		const normalized = normalizeUsageMetadata(usage);
		if (!normalized) return;

		this.inputTokens += normalized.inputTokens || 0;
		this.outputTokens += normalized.outputTokens || 0;

		// If only totalTokens is available, spread remainder into outputTokens
		const remainder = (normalized.totalTokens || 0) - (normalized.inputTokens || 0) - (normalized.outputTokens || 0);
		if (remainder > 0) {
			this.outputTokens += remainder;
		}
	}

	merge(otherTracker) {
		if (!otherTracker) return;
		const { inputTokens, outputTokens } = otherTracker.toJSON();
		this.inputTokens += inputTokens;
		this.outputTokens += outputTokens;
	}

	toJSON() {
		const totalTokens = this.inputTokens + this.outputTokens;
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens,
		};
	}
}

module.exports = {
	normalizeUsageMetadata,
	TokenUsageTracker,
};
