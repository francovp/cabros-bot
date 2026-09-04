const { TokenUsageTracker, normalizeUsageMetadata } = require('../../src/lib/tokenUsage');

describe('TokenUsageTracker', () => {
	describe('normalizeUsageMetadata', () => {
		it('normalizes Gemini usageMetadata', () => {
			const raw = {
				promptTokenCount: 100,
				candidatesTokenCount: 50,
				totalTokenCount: 150,
			};
			expect(normalizeUsageMetadata(raw)).toEqual({
				inputTokens: 100,
				outputTokens: 50,
				totalTokens: 150,
			});
		});

		it('normalizes OpenAI-style usage', () => {
			const raw = {
				prompt_tokens: 200,
				completion_tokens: 80,
				total_tokens: 280,
			};
			expect(normalizeUsageMetadata(raw)).toEqual({
				inputTokens: 200,
				outputTokens: 80,
				totalTokens: 280,
			});
		});

		it('returns null for empty or invalid input', () => {
			expect(normalizeUsageMetadata(null)).toBeNull();
			expect(normalizeUsageMetadata(undefined)).toBeNull();
		});
	});

	describe('addUsage', () => {
		it('aggregates input and output tokens', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 });
			tracker.addUsage({ inputTokens: 200, outputTokens: 100 });

			const json = tracker.toJSON();
			expect(json.inputTokens).toBe(300);
			expect(json.outputTokens).toBe(150);
			expect(json.totalTokens).toBe(450);
		});

		it('calculates cost when model is specified', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 1000000, outputTokens: 1000000 }, 'gemini-2.5-flash');

			const json = tracker.toJSON();
			expect(json.inputCost).toBeCloseTo(0.30, 4);
			expect(json.outputCost).toBeCloseTo(2.50, 4);
			expect(json.totalCost).toBeCloseTo(2.80, 4);
		});
	});

	describe('addSource', () => {
		it('records usage attributed to a source name', () => {
			const tracker = new TokenUsageTracker();
			tracker.addSource('geminiGrounding', { inputTokens: 800, outputTokens: 400 });

			const json = tracker.toJSON();
			expect(json.bySource).toBeDefined();
			expect(json.bySource.geminiGrounding).toEqual({
				inputTokens: 800,
				outputTokens: 400,
				totalTokens: 1200,
			});
			// Backward compatibility
			expect(json.inputTokens).toBe(800);
			expect(json.outputTokens).toBe(400);
			expect(json.totalTokens).toBe(1200);
		});

		it('accumulates multiple sources and calculates totals correctly', () => {
			const tracker = new TokenUsageTracker();
			tracker.addSource('geminiGrounding', { inputTokens: 800, outputTokens: 400 });
			tracker.addSource('tradingviewMcp', { inputTokens: 1000, outputTokens: 200 });
			tracker.addSource('volumeConfirmation', { inputTokens: 150, outputTokens: 50 });

			const json = tracker.toJSON();
			expect(json.totalTokens).toBe(2600);
			expect(json.inputTokens).toBe(1950);
			expect(json.outputTokens).toBe(650);
			expect(json.bySource).toEqual({
				geminiGrounding: { inputTokens: 800, outputTokens: 400, totalTokens: 1200 },
				tradingviewMcp: { inputTokens: 1000, outputTokens: 200, totalTokens: 1200 },
				volumeConfirmation: { inputTokens: 150, outputTokens: 50, totalTokens: 200 },
			});
		});

		it('accumulates multiple calls to the same source', () => {
			const tracker = new TokenUsageTracker();
			tracker.addSource('geminiGrounding', { inputTokens: 300, outputTokens: 100 });
			tracker.addSource('geminiGrounding', { inputTokens: 500, outputTokens: 300 });

			const json = tracker.toJSON();
			expect(json.bySource.geminiGrounding).toEqual({
				inputTokens: 800,
				outputTokens: 400,
				totalTokens: 1200,
			});
			expect(json.totalTokens).toBe(1200);
		});

		it('handles model pricing with addSource', () => {
			const tracker = new TokenUsageTracker();
			tracker.addSource('geminiGrounding', { inputTokens: 1000000, outputTokens: 1000000 }, 'gemini-2.5-flash');

			const json = tracker.toJSON();
			expect(json.totalCost).toBeCloseTo(2.80, 4);
			expect(json.bySource.geminiGrounding).toEqual({
				inputTokens: 1000000,
				outputTokens: 1000000,
				totalTokens: 2000000,
			});
		});

		it('handles invalid or empty inputs gracefully', () => {
			const tracker = new TokenUsageTracker();
			tracker.addSource(null, { inputTokens: 100, outputTokens: 50 });
			tracker.addSource('', { inputTokens: 100, outputTokens: 50 });
			tracker.addSource('geminiGrounding', null);
			tracker.addSource('geminiGrounding', undefined);

			const json = tracker.toJSON();
			expect(json.bySource).toBeUndefined();
			expect(json.totalTokens).toBe(0);
		});

		it('merges trackers preserving bySource', () => {
			const trackerA = new TokenUsageTracker();
			trackerA.addSource('geminiGrounding', { inputTokens: 500, outputTokens: 200 });

			const trackerB = new TokenUsageTracker();
			trackerB.addSource('tradingviewMcp', { inputTokens: 300, outputTokens: 100 });
			trackerB.addSource('geminiGrounding', { inputTokens: 100, outputTokens: 50 });

			trackerA.merge(trackerB);

			const json = trackerA.toJSON();
			expect(json.totalTokens).toBe(1250);
			expect(json.bySource).toEqual({
				geminiGrounding: { inputTokens: 600, outputTokens: 250, totalTokens: 850 },
				tradingviewMcp: { inputTokens: 300, outputTokens: 100, totalTokens: 400 },
			});
		});
	});

	describe('formatSummary', () => {
		it('formats summary with bySource breakdown when sources are present', () => {
			const tracker = new TokenUsageTracker();
			tracker.addSource('geminiGrounding', { inputTokens: 800, outputTokens: 400 });
			tracker.addSource('tradingviewMcp', { inputTokens: 1000, outputTokens: 200 });

			const summary = tracker.formatSummary();
			expect(summary).toContain('Token usage:');
			expect(summary).toContain('Total 2400');
		});
	});
});
