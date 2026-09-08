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
