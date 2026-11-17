const {
	isEnrichmentRenderable,
	hasRenderableInsights,
	hasRenderableSources,
	hasRenderableTechnicalLevels,
	hasRenderableRiskMetadata,
} = require('../../src/services/grounding/renderableEnrichment');

describe('isEnrichmentRenderable (CB-583 / Issue #583)', () => {
	describe('empty/null inputs', () => {
		it('returns false for null', () => {
			expect(isEnrichmentRenderable(null)).toBe(false);
		});

		it('returns false for undefined', () => {
			expect(isEnrichmentRenderable(undefined)).toBe(false);
		});

		it('returns false for non-object primitives', () => {
			expect(isEnrichmentRenderable('string')).toBe(false);
			expect(isEnrichmentRenderable(42)).toBe(false);
			expect(isEnrichmentRenderable(true)).toBe(false);
		});

		it('returns false for empty object', () => {
			expect(isEnrichmentRenderable({})).toBe(false);
		});
	});

	describe('hasRenderableInsights', () => {
		it('returns false for missing insights', () => {
			expect(hasRenderableInsights({})).toBe(false);
		});

		it('returns false for empty array', () => {
			expect(hasRenderableInsights({ insights: [] })).toBe(false);
		});

		it('returns false for array of empty strings', () => {
			expect(hasRenderableInsights({ insights: ['', '  '] })).toBe(false);
		});

		it('returns true for non-empty string insight', () => {
			expect(hasRenderableInsights({ insights: ['price target raised'] })).toBe(true);
		});

		it('returns true when at least one insight is non-empty', () => {
			expect(hasRenderableInsights({ insights: ['', 'real news', '  '] })).toBe(true);
		});

		it('returns false for non-array insights', () => {
			expect(hasRenderableInsights({ insights: 'not an array' })).toBe(false);
			expect(hasRenderableInsights({ insights: null })).toBe(false);
		});
	});

	describe('hasRenderableSources', () => {
		it('returns false for missing sources', () => {
			expect(hasRenderableSources({})).toBe(false);
		});

		it('returns false for empty array', () => {
			expect(hasRenderableSources({ sources: [] })).toBe(false);
		});

		it('returns false for source with title but no url', () => {
			expect(hasRenderableSources({
				sources: [{ title: 'Reuters', snippet: 'snippet' }],
			})).toBe(false);
		});

		it('returns false for source with url but no title/snippet', () => {
			expect(hasRenderableSources({
				sources: [{ url: 'https://example.com' }],
			})).toBe(false);
		});

		it('returns true for source with both title and url', () => {
			expect(hasRenderableSources({
				sources: [{ title: 'Reuters', url: 'https://example.com' }],
			})).toBe(true);
		});

		it('returns true when at least one source has title+url', () => {
			expect(hasRenderableSources({
				sources: [
					{ title: 'no url here' },
					{ title: 'Reuters', url: 'https://example.com' },
				],
			})).toBe(true);
		});

		it('accepts snippet as title fallback when url is present', () => {
			expect(hasRenderableSources({
				sources: [{ snippet: 'Article preview', url: 'https://example.com' }],
			})).toBe(true);
		});
	});

	describe('hasRenderableTechnicalLevels', () => {
		it('returns false for missing technical_levels', () => {
			expect(hasRenderableTechnicalLevels({})).toBe(false);
		});

		it('returns false for empty supports and resistances', () => {
			expect(hasRenderableTechnicalLevels({
				technical_levels: { supports: [], resistances: [] },
			})).toBe(false);
		});

		it('returns true when at least one support is non-empty', () => {
			expect(hasRenderableTechnicalLevels({
				technical_levels: { supports: ['65000'], resistances: [] },
			})).toBe(true);
		});

		it('returns true when at least one resistance is non-empty', () => {
			expect(hasRenderableTechnicalLevels({
				technical_levels: { supports: [], resistances: ['70000'] },
			})).toBe(true);
		});

		it('returns false when all entries are empty strings', () => {
			expect(hasRenderableTechnicalLevels({
				technical_levels: { supports: ['', '  '], resistances: [''] },
			})).toBe(false);
		});
	});

	describe('hasRenderableRiskMetadata', () => {
		it('returns false for missing fields', () => {
			expect(hasRenderableRiskMetadata({})).toBe(false);
		});

		it('returns true for non-empty invalidation_level', () => {
			expect(hasRenderableRiskMetadata({ invalidation_level: '$65000' })).toBe(true);
		});

		it('returns true for non-empty target_level', () => {
			expect(hasRenderableRiskMetadata({ target_level: '$72000' })).toBe(true);
		});

		it('returns true for finite numeric risk_reward_ratio', () => {
			expect(hasRenderableRiskMetadata({ risk_reward_ratio: 2.5 })).toBe(true);
		});

		it('returns true for non-empty string risk_reward_ratio', () => {
			expect(hasRenderableRiskMetadata({ risk_reward_ratio: '2.5:1' })).toBe(true);
		});

		it('returns false for empty strings or NaN', () => {
			expect(hasRenderableRiskMetadata({ invalidation_level: '' })).toBe(false);
			expect(hasRenderableRiskMetadata({ risk_reward_ratio: NaN })).toBe(false);
			expect(hasRenderableRiskMetadata({ risk_reward_ratio: Infinity })).toBe(false);
		});
	});

	describe('isEnrichmentRenderable end-to-end', () => {
		it('returns true when insights present but sources/levels empty', () => {
			expect(isEnrichmentRenderable({
				insights: ['price target raised'],
				sources: [],
				technical_levels: { supports: [], resistances: [] },
			})).toBe(true);
		});

		it('returns true when sources present but insights empty', () => {
			expect(isEnrichmentRenderable({
				insights: [],
				sources: [{ title: 'Reuters', url: 'https://example.com' }],
			})).toBe(true);
		});

		it('returns true when technical levels present but insights/sources empty', () => {
			expect(isEnrichmentRenderable({
				insights: [],
				sources: [],
				technical_levels: { supports: ['65000'], resistances: [] },
			})).toBe(true);
		});

		it('returns true when risk metadata present but everything else empty', () => {
			expect(isEnrichmentRenderable({
				insights: [],
				sources: [],
				technical_levels: { supports: [], resistances: [] },
				invalidation_level: '$65000',
				target_level: '$72000',
				risk_reward_ratio: 2.5,
			})).toBe(true);
		});

		it('returns false when only sentiment/score present (the invisible-enrichment case)', () => {
			expect(isEnrichmentRenderable({
				sentiment: 'BULLISH',
				sentiment_score: 0.4,
				insights: [],
				sources: [],
				technical_levels: { supports: [], resistances: [] },
			})).toBe(false);
		});

		it('returns false for completely empty alert', () => {
			expect(isEnrichmentRenderable({
				sentiment: 'NEUTRAL',
				sentiment_score: 0,
				insights: [],
				sources: [],
				truncated: false,
			})).toBe(false);
		});
	});
});
