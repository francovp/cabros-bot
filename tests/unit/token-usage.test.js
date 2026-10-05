'use strict';

const { TokenUsageTracker } = require('../../src/lib/tokenUsage');

describe('TokenUsageTracker feature attribution', () => {
	it('keeps per-feature totals without changing aggregate usage', () => {
		const tracker = new TokenUsageTracker('grounding');

		tracker.addUsage({ inputTokens: 10, outputTokens: 20 }, 'unknown-model');
		tracker.addUsage({ inputTokens: 5, outputTokens: 7 }, 'unknown-model', 'enrichment');

		expect(tracker.toJSON()).toMatchObject({
			inputTokens: 15,
			outputTokens: 27,
			totalTokens: 42,
			byFeature: {
				grounding: {
					calls: 1,
					inputTokens: 10,
					outputTokens: 20,
					totalTokens: 30,
				},
				enrichment: {
					calls: 1,
					inputTokens: 5,
					outputTokens: 7,
					totalTokens: 12,
				},
			},
		});
	});
});

describe('TokenUsageTracker enrichment cost attribution', () => {
	// Regression: enrichment model names such as `gpt-4o` or `openai/gpt-5-mini`
	// must not silently fall back to a zero-cost rate, otherwise
	// `byFeature.enrichment.totalCost` reports a confident 0 for a paid feature.
	it('prices documented Azure/OpenAI enrichment models instead of reporting zero cost', () => {
		const tracker = new TokenUsageTracker('grounding');

		tracker.addUsage(
			{ prompt_tokens: 1000000, completion_tokens: 1000000 },
			'gpt-4o',
			'enrichment',
		);

		const bucket = tracker.toJSON().byFeature.enrichment;
		expect(bucket.totalCost).toBeGreaterThan(0);
		expect(bucket.totalCost).toBeCloseTo(12.5, 6);
	});

	it('strips provider prefixes before resolving enrichment pricing', () => {
		const prefixed = new TokenUsageTracker();
		prefixed.addUsage({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'openai/gpt-4o', 'enrichment');

		const plain = new TokenUsageTracker();
		plain.addUsage({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'gpt-4o', 'enrichment');

		expect(prefixed.toJSON().byFeature.enrichment.totalCost)
			.toBeCloseTo(plain.toJSON().byFeature.enrichment.totalCost, 6);
	});

	it('reports the default rate for an unrecognized enrichment model rather than zero', () => {
		const tracker = new TokenUsageTracker();
		tracker.addUsage({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'totally-unknown-model', 'enrichment');

		const bucket = tracker.toJSON().byFeature.enrichment;
		expect(bucket.totalCost).toBeGreaterThan(0);
	});

	it('treats explicitly free enrichment models as zero cost', () => {
		const tracker = new TokenUsageTracker();
		tracker.addUsage({ prompt_tokens: 1000000, completion_tokens: 1000000 }, 'openrouter/some-model:free', 'enrichment');

		expect(tracker.toJSON().byFeature.enrichment.totalCost).toBe(0);
	});
});
