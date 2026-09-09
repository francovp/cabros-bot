const {
	TokenUsageTracker,
	normalizeUsageMetadata,
} = require('../../src/lib/tokenUsage');

describe('TokenUsageTracker cost accounting (CB-583 / Issue #583)', () => {
	describe('addUsage cost calculation', () => {
		it('computes non-zero cost for a known Gemini model', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			}, 'gemini-2.5-flash');

			const json = tracker.toJSON();
			// 1000/1M * 0.30 + 200/1M * 2.50 = 0.0003 + 0.0005 = 0.0008
			expect(json.inputCost).toBeCloseTo(0.0003, 6);
			expect(json.outputCost).toBeCloseTo(0.0005, 6);
			expect(json.totalCost).toBeCloseTo(0.0008, 6);
		});

		it('uses default pricing when model is missing (CB-583 fix)', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			}, null);

			const json = tracker.toJSON();
			// Default pricing now matches gemini-2.5-flash so cost telemetry
			// is no longer silently zeroed out.
			expect(json.totalCost).toBeCloseTo(0.0008, 6);
			expect(json.totalCost).not.toBe(0);
		});

		it('uses default pricing when model is undefined (CB-583 fix)', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			});

			const json = tracker.toJSON();
			expect(json.totalCost).toBeCloseTo(0.0008, 6);
		});

		it('uses default pricing for unknown model names (CB-583 fix)', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			}, 'unknown-future-model-9000');

			const json = tracker.toJSON();
			expect(json.totalCost).toBeCloseTo(0.0008, 6);
		});

		it('treats brave-search as free (billed per request, not per token)', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			}, 'brave-search');

			const json = tracker.toJSON();
			expect(json.inputCost).toBe(0);
			expect(json.outputCost).toBe(0);
			expect(json.totalCost).toBe(0);
			// Tokens are still tracked.
			expect(json.inputTokens).toBe(1000);
			expect(json.outputTokens).toBe(200);
		});

		it('accumulates cost across multiple addUsage calls', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 500,
				candidatesTokenCount: 100,
				totalTokenCount: 600,
			}, 'gemini-2.5-flash');
			tracker.addUsage({
				promptTokenCount: 500,
				candidatesTokenCount: 100,
				totalTokenCount: 600,
			}, 'gemini-2.5-flash');

			const json = tracker.toJSON();
			expect(json.totalCost).toBeCloseTo(0.0008, 6);
			expect(json.inputTokens).toBe(1000);
			expect(json.outputTokens).toBe(200);
		});
	});

	describe('reset() (CB-583 render-or-skip gate)', () => {
		it('zeros all token and cost counters', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			}, 'gemini-2.5-flash');
			expect(tracker.toJSON().totalCost).toBeGreaterThan(0);

			tracker.reset();

			const json = tracker.toJSON();
			expect(json.inputTokens).toBe(0);
			expect(json.outputTokens).toBe(0);
			expect(json.totalTokens).toBe(0);
			expect(json.inputCost).toBe(0);
			expect(json.outputCost).toBe(0);
			expect(json.totalCost).toBe(0);
		});

		it('allows re-accumulation after reset', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({
				promptTokenCount: 1000,
				candidatesTokenCount: 200,
				totalTokenCount: 1200,
			}, 'gemini-2.5-flash');
			tracker.reset();
			tracker.addUsage({
				promptTokenCount: 500,
				candidatesTokenCount: 50,
				totalTokenCount: 550,
			}, 'gemini-2.5-flash');

			const json = tracker.toJSON();
			expect(json.inputTokens).toBe(500);
			expect(json.outputTokens).toBe(50);
		});
	});

	describe('merge() preserves cost semantics', () => {
		it('sums token and cost counts from both trackers', () => {
			const a = new TokenUsageTracker();
			a.addUsage({
				promptTokenCount: 100,
				candidatesTokenCount: 20,
				totalTokenCount: 120,
			}, 'gemini-2.5-flash');

			const b = new TokenUsageTracker();
			b.addUsage({
				promptTokenCount: 200,
				candidatesTokenCount: 40,
				totalTokenCount: 240,
			}, 'gemini-2.5-flash');

			a.merge(b);

			const json = a.toJSON();
			expect(json.inputTokens).toBe(300);
			expect(json.outputTokens).toBe(60);
		});
	});

	describe('normalizeUsageMetadata back-compat', () => {
		it('handles Gemini usageMetadata wrapper', () => {
			const result = normalizeUsageMetadata({
				usageMetadata: {
					promptTokenCount: 10,
					candidatesTokenCount: 20,
					totalTokenCount: 30,
				},
			});
			expect(result).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
		});

		it('handles flat OpenAI-style usage', () => {
			const result = normalizeUsageMetadata({
				prompt_tokens: 10,
				completion_tokens: 20,
				total_tokens: 30,
			});
			expect(result).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
		});

		it('returns null for missing usage', () => {
			expect(normalizeUsageMetadata(null)).toBeNull();
			expect(normalizeUsageMetadata(undefined)).toBeNull();
		});
	});
});
