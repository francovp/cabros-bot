/* global jest, describe, it, expect, beforeEach, afterEach */
'use strict';

const {
	normalizeUsageMetadata,
	TokenUsageTracker,
} = require('../../src/lib/tokenUsage');

describe('tokenUsage', () => {
	let warnSpy;

	beforeEach(() => {
		warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
	});

	afterEach(() => {
		warnSpy.mockRestore();
	});

	describe('normalizeUsageMetadata', () => {
		it('parses Gemini usageMetadata', () => {
			expect(normalizeUsageMetadata({
				promptTokenCount: 11,
				candidatesTokenCount: 7,
				totalTokenCount: 18,
			})).toEqual({ inputTokens: 11, outputTokens: 7, totalTokens: 18 });
		});

		it('parses OpenAI-compatible usage', () => {
			expect(normalizeUsageMetadata({
				prompt_tokens: 12,
				completion_tokens: 8,
				total_tokens: 20,
			})).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
		});

		it('returns null for null input', () => {
			expect(normalizeUsageMetadata(null)).toBeNull();
		});
	});

	describe('TokenUsageTracker - known model pricing', () => {
		it('prices gemini-2.5-flash at known rate', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 1000000, outputTokens: 1000000 }, 'gemini-2.5-flash');
			const json = tracker.toJSON();
			expect(json.inputCost).toBeCloseTo(0.30);
			expect(json.outputCost).toBeCloseTo(2.50);
			expect(json.totalCost).toBeCloseTo(2.80);
			expect(json.pricing).toEqual({ unknownModelPricing: false, unknownModels: [] });
		});

		it('strips google-ai-studio/ prefix to match Gemini rates', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 1000000, outputTokens: 1000000 }, 'google-ai-studio/gemini-2.5-flash');
			const json = tracker.toJSON();
			expect(json.inputCost).toBeCloseTo(0.30);
			expect(json.outputCost).toBeCloseTo(2.50);
			expect(json.pricing.unknownModelPricing).toBe(false);
			expect(json.pricing.unknownModels).toEqual([]);
		});

		it('strips trailing/leading whitespace from model name', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 1000000, outputTokens: 1000000 }, '  gemini-2.5-flash  ');
			const json = tracker.toJSON();
			expect(json.totalCost).toBeCloseTo(2.80);
			expect(json.pricing.unknownModelPricing).toBe(false);
		});
	});

	describe('TokenUsageTracker - unknown model handling (issue #759)', () => {
		it('flags unknown models and records unknownModelPricing: true', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 1000000, outputTokens: 1000000 }, 'azure-llm');
			const json = tracker.toJSON();
			expect(json.inputCost).toBe(0);
			expect(json.outputCost).toBe(0);
			expect(json.totalCost).toBe(0);
			expect(json.pricing.unknownModelPricing).toBe(true);
			expect(json.pricing.unknownModels).toContain('azure-llm');
		});

		it('warns once per unique unknown model', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'openrouter-model');
			tracker.addUsage({ inputTokens: 200, outputTokens: 100 }, 'openrouter-model');
			tracker.addUsage({ inputTokens: 300, outputTokens: 150 }, 'azure-llm');

			const warnings = warnSpy.mock.calls.map((call) => call[0]);
			const unknownWarnings = warnings.filter((msg) => typeof msg === 'string' && msg.includes('unknown model'));
			expect(unknownWarnings.length).toBe(2);
		});

		it('does NOT warn for gemma variants (legitimate free tier)', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'gemma-2-9b');
			const json = tracker.toJSON();
			expect(json.pricing.unknownModelPricing).toBe(false);
			expect(json.pricing.unknownModels).toEqual([]);
		});

		it('does NOT flag empty/undefined model as unknown (silent pass-through)', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 });
			const json = tracker.toJSON();
			expect(json.pricing).toEqual({ unknownModelPricing: false, unknownModels: [] });
		});

		it('accumulates multiple unknown models in the list', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'azure-llm');
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'openrouter-model');
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'cloudflare-aig');
			const json = tracker.toJSON();
			expect(json.pricing.unknownModels).toEqual(
				expect.arrayContaining(['azure-llm', 'openrouter-model', 'cloudflare-aig']),
			);
			expect(json.pricing.unknownModelPricing).toBe(true);
		});

		it('still records token counts even for unknown models', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 500, outputTokens: 250 }, 'azure-llm');
			const json = tracker.toJSON();
			expect(json.inputTokens).toBe(500);
			expect(json.outputTokens).toBe(250);
			expect(json.totalTokens).toBe(750);
		});
	});

	describe('TokenUsageTracker - formatSummary', () => {
		it('includes pricing warning in summary when unknown model was used', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'azure-llm');
			const summary = tracker.formatSummary();
			expect(summary).toMatch(/Token usage:/);
			expect(summary).toMatch(/unknown/i);
		});

		it('omits pricing warning when all models are known', () => {
			const tracker = new TokenUsageTracker();
			tracker.addUsage({ inputTokens: 100, outputTokens: 50 }, 'gemini-2.5-flash');
			const summary = tracker.formatSummary();
			expect(summary).not.toMatch(/unknown/i);
		});
	});

	describe('TokenUsageTracker - merge preserves pricing metadata', () => {
		it('merges unknownModelPricing flag from one tracker with unknown model', () => {
			const a = new TokenUsageTracker();
			a.addUsage({ inputTokens: 100, outputTokens: 50 }, 'azure-llm');
			const b = new TokenUsageTracker();
			b.addUsage({ inputTokens: 100, outputTokens: 50 }, 'gemini-2.5-flash');

			b.merge(a);
			const json = b.toJSON();
			expect(json.pricing.unknownModelPricing).toBe(true);
			expect(json.pricing.unknownModels).toContain('azure-llm');
		});
	});
});
