/**
 * Unit Tests for Event Detection (Phase 7 - US5)
 * Tests: Event category detection, confidence scoring, fallback parsing
 */

const {
	analyzeNewsForSymbol,
	parseNewsAnalysisResponse,
	calibrateNewsConfidence,
} = require('../../src/services/grounding/gemini');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');

jest.mock('../../src/services/grounding/genaiClient');

describe('Event Detection (Phase 7 - US5)', () => {
	const genaiClient = require('../../src/services/grounding/genaiClient');

	describe('parseNewsAnalysisResponse', () => {
		it('should parse valid JSON response with price_surge', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges on positive news',
				sources: ['https://example.com/news1', 'https://example.com/news2'],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe('price_surge');
			expect(result.event_significance).toBe(0.8);
			expect(result.sentiment_score).toBe(0.9);
			expect(result.headline).toBe('Bitcoin surges on positive news');
		});

		it('should parse valid JSON response with price_decline', () => {
			const response = JSON.stringify({
				event_category: 'price_decline',
				event_significance: 0.7,
				sentiment_score: -0.8,
				headline: 'Market downturn on regulatory concerns',
				sources: ['https://example.com'],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe('price_decline');
			expect(result.sentiment_score).toBe(-0.8);
		});

		it('should parse valid JSON response with regulatory category', () => {
			const response = JSON.stringify({
				event_category: 'regulatory',
				event_significance: 0.9,
				sentiment_score: -0.5,
				headline: 'SEC announces new crypto regulations',
				sources: ['https://sec.gov'],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe('regulatory');
		});

		it('should parse valid JSON response with public_figure category', () => {
			const response = JSON.stringify({
				event_category: 'public_figure',
				event_significance: 0.6,
				sentiment_score: 0.4,
				headline: 'Elon Musk comments on Bitcoin',
				sources: ['https://twitter.com'],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe('public_figure');
		});

		it('should handle JSON embedded in response text', () => {
			const response = `Some text before...
{
  "event_category": "price_surge",
  "event_significance": 0.75,
  "sentiment_score": 0.85,
  "headline": "Bullish market movement",
  "sources": []
}
Some text after...`;

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe('price_surge');
			expect(result.event_significance).toBe(0.75);
		});

		it('should clamp values to valid ranges', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 1.5, // Should clamp to 1.0
				sentiment_score: -1.5, // Should clamp to -1.0
				headline: 'Test',
				sources: [],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_significance).toBe(1);
			expect(result.sentiment_score).toBe(-1);
		});

		it('should handle invalid event_category with fallback to NONE', () => {
			const response = JSON.stringify({
				event_category: 'unknown_category',
				event_significance: 0.5,
				sentiment_score: 0.0,
				headline: 'Invalid category',
				sources: [],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe(EventCategory.NONE);
			expect(result.event_significance).toBe(0);
		});

		it('should handle malformed JSON with fallback', () => {
			const response = 'This is not valid JSON at all';

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe(EventCategory.NONE);
			expect(result.event_significance).toBe(0);
			expect(result.sentiment_score).toBe(0);
			expect(result.headline).toBe('Could not detect market event');
		});

		it('should handle missing fields with defaults', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				// Missing significance, sentiment, headline, sources
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.event_category).toBe('price_surge');
			expect(result.event_significance).toBe(0);
			expect(result.sentiment_score).toBe(0);
			expect(result.headline).toBe('Market event detected');
		});

		it('should truncate long headlines to 250 chars', () => {
			const longHeadline = 'A'.repeat(300);
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0.0,
				headline: longHeadline,
				sources: [],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.headline).toHaveLength(250);
		});

		it('should limit sources to 10 URLs', () => {
			const sources = Array.from({ length: 15 }, (_, i) => `https://example.com/${i}`);
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0.0,
				headline: 'Test',
				sources: sources,
			});

			const result = parseNewsAnalysisResponse(response);

		});
	});

	describe('analyzeNewsForSymbol', () => {
		beforeEach(() => {
			jest.clearAllMocks();
			// Mock search() to return grounding results
			genaiClient.search.mockResolvedValue({
				results: [
					{ url: 'https://reuters.com/1', title: 'Source 1', sourceDomain: 'reuters.com', publishedAt: '2026-06-28T11:00:00Z' },
					{ url: 'https://bloomberg.com/2', title: 'Source 2', sourceDomain: 'bloomberg.com', publishedAt: '2026-06-28T10:00:00Z' },
				],
				searchResultText: 'Market context from search',
				totalResults: 2,
			});
			// Mock llmCallv2() (used by analyzeNewsForSymbol) to return analysis
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_surge',
					event_significance: 0.8,
					sentiment_score: 0.9,
					headline: 'Test',
					source_count: 3,
					source_freshness: 0.9,
					source_quality: 0.9,
					event_age_hours: 1,
					time_horizon: 'short_term',
					uncertainty_reason: '',
					invalidation_hint: '',
				}),
			});
		});

		it('should calculate confidence using formula: 0.6*significance + 0.4*|sentiment|', async () => {
			const result = await analyzeNewsForSymbol('BTCUSDT', 'Market context');

			// base = 0.6 * 0.8 + 0.4 * |0.9| = 0.84; good source data => no penalties
			expect(result.confidence).toBeCloseTo(0.84, 5);
		});

		it('should calculate confidence with negative sentiment', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_decline',
					event_significance: 0.7,
					sentiment_score: -0.8,
					headline: 'Test',
					source_count: 3,
					source_freshness: 0.9,
					source_quality: 0.9,
					event_age_hours: 1,
					time_horizon: 'short_term',
					uncertainty_reason: '',
					invalidation_hint: '',
				}),
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Bearish news');

			// base = 0.6 * 0.7 + 0.4 * |-0.8| = 0.74; good source data => no penalties
			expect(result.confidence).toBeCloseTo(0.74, 5);
		});

		it('should clamp confidence to [0, 1] range', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_surge',
					event_significance: 1.0,
					sentiment_score: 1.0,
					headline: 'Test',
					source_count: 5,
					source_freshness: 1.0,
					source_quality: 1.0,
					event_age_hours: 0,
					time_horizon: 'short_term',
					uncertainty_reason: '',
					invalidation_hint: '',
				}),
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Context');

			// base = 0.6 * 1.0 + 0.4 * 1.0 = 1.0; perfect source data => no penalties
			expect(result.confidence).toBe(1.0);
			expect(result.confidence).toBeGreaterThanOrEqual(0);
			expect(result.confidence).toBeLessThanOrEqual(1);
		});

		it('should return full analysis result with all required fields', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'regulatory',
					event_significance: 0.85,
					sentiment_score: -0.6,
					headline: 'SEC announcement',
					source_count: 2,
					source_freshness: 0.8,
					source_quality: 0.9,
					event_age_hours: 2,
					time_horizon: 'short_term',
					uncertainty_reason: '',
					invalidation_hint: '',
				}),
			});

			const result = await analyzeNewsForSymbol('AAPL', 'Regulatory context');

			expect(result).toHaveProperty('event_category');
			expect(result).toHaveProperty('event_significance');
			expect(result).toHaveProperty('sentiment_score');
			expect(result).toHaveProperty('headline');
			expect(result).toHaveProperty('sources');
			expect(result).toHaveProperty('confidence');
			expect(result).toHaveProperty('confidence_reason');
		});

		it('should throw error when Gemini call fails', async () => {
			genaiClient.llmCallv2.mockRejectedValue(new Error('API error'));

			await expect(analyzeNewsForSymbol('BTCUSDT', 'Context')).rejects.toThrow('API error');
		});

		it('should handle fallback when Gemini response cannot be parsed', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: 'Invalid response format',
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Context');

			expect(result.event_category).toBe(EventCategory.NONE);
			expect(result.confidence).toBe(0);
		});

		it('should detect price_surge events correctly', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_surge',
					event_significance: 0.9,
					sentiment_score: 0.95,
					headline: 'Bitcoin hits record high',
					sources: ['https://coinbase.com', 'https://kraken.com'],
				}),
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Bullish market data');

			expect(result.event_category).toBe('price_surge');
			expect(result.event_significance).toBeGreaterThan(0.8);
		});

		it('should detect price_decline events correctly', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_decline',
					event_significance: 0.85,
					sentiment_score: -0.9,
					headline: 'Market crash after announcement',
					sources: ['https://bloomberg.com'],
				}),
			});

			const result = await analyzeNewsForSymbol('AAPL', 'Bearish market news');

			expect(result.event_category).toBe('price_decline');
			expect(result.sentiment_score).toBeLessThan(0);
		});

		it('should detect public_figure mentions', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'public_figure',
					event_significance: 0.6,
					sentiment_score: 0.3,
					headline: 'Elon Musk tweets about Tesla',
					sources: ['https://twitter.com'],
				}),
			});

			const result = await analyzeNewsForSymbol('TSLA', 'Social media context');

			expect(result.event_category).toBe('public_figure');
		});

		it('should detect regulatory events', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'regulatory',
					event_significance: 0.95,
					sentiment_score: -0.7,
					headline: 'Federal Reserve raises interest rates',
					sources: ['https://federalreserve.gov'],
				}),
			});

			const result = await analyzeNewsForSymbol('SPY', 'Market regulation context');

			expect(result.event_category).toBe('regulatory');
		});

		it('should return NONE when no significant event detected', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'none',
					event_significance: 0.2,
					sentiment_score: 0.1,
					headline: 'Regular market activity',
					sources: [],
				}),
			});

			const result = await analyzeNewsForSymbol('XYZ', 'Normal market context');

			expect(result.event_category).toBe('none');
		});
	});

	describe('parseNewsAnalysisResponse - new source metadata fields', () => {
		it('should parse source_count, source_freshness, source_quality from valid response', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.7,
				headline: 'Test',
				description: 'Test description',
				source_count: 5,
				source_freshness: 0.9,
				source_quality: 0.85,
				event_age_hours: 3,
				time_horizon: 'short_term',
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.source_count).toBe(5);
			expect(result.source_freshness).toBe(0.9);
			expect(result.source_quality).toBe(0.85);
			expect(result.event_age_hours).toBe(3);
			expect(result.time_horizon).toBe('short_term');
			expect(result.uncertainty_reason).toBe('');
			expect(result.invalidation_hint).toBe('');
		});

		it('should clamp source_count to [0, 10]', () => {
			const over = parseNewsAnalysisResponse(JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0,
				headline: 'Test',
				source_count: 25,
			}));
			expect(over.source_count).toBe(10);

			const under = parseNewsAnalysisResponse(JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0,
				headline: 'Test',
				source_count: -5,
			}));
			expect(under.source_count).toBe(0);
		});

		it('should clamp source_freshness and source_quality to [0, 1]', () => {
			const over = parseNewsAnalysisResponse(JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0,
				headline: 'Test',
				source_freshness: 2.5,
				source_quality: -0.5,
			}));
			expect(over.source_freshness).toBe(1);
			expect(over.source_quality).toBe(0);
		});

		it('should apply defaults for missing new fields (backward compat)', () => {
			const legacyResponse = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0.3,
				headline: 'Test',
			});

			const result = parseNewsAnalysisResponse(legacyResponse);

			expect(result.source_count).toBe(0);
			expect(result.source_freshness).toBe(0.5);
			expect(result.source_quality).toBe(0.5);
			expect(result.event_age_hours).toBeNull();
			expect(result.time_horizon).toBe('short_term');
			expect(result.uncertainty_reason).toBe('');
			expect(result.invalidation_hint).toBe('');
		});

		it('should round source_count to an integer', () => {
			const result = parseNewsAnalysisResponse(JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0,
				headline: 'Test',
				source_count: 3.7,
			}));
			expect(result.source_count).toBe(4);
		});

		it('should set time_horizon default for invalid values', () => {
			const result = parseNewsAnalysisResponse(JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0,
				headline: 'Test',
				time_horizon: 'invalid_value',
			}));
			expect(result.time_horizon).toBe('short_term');
		});

		it('should trim uncertainty_reason and invalidation_hint', () => {
			const result = parseNewsAnalysisResponse(JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.5,
				sentiment_score: 0,
				headline: 'Test',
				uncertainty_reason: '  conflicting signals  ',
				invalidation_hint: '  price reversal possible  ',
			}));
			expect(result.uncertainty_reason).toBe('conflicting signals');
			expect(result.invalidation_hint).toBe('price reversal possible');
		});

		it('should include new fields in fallback response on parse error', () => {
			const result = parseNewsAnalysisResponse('not valid json');
			expect(result.event_category).toBe(EventCategory.NONE);
			expect(result.source_count).toBe(0);
			expect(result.source_freshness).toBe(0);
			expect(result.source_quality).toBe(0);
			expect(result.event_age_hours).toBeNull();
			expect(result.time_horizon).toBe('short_term');
			expect(result.uncertainty_reason).toBe('parse error');
			expect(result.invalidation_hint).toBe('');
		});
	});

	describe('calibrateNewsConfidence', () => {
		it('should return high confidence for high-quality multi-source news', () => {
			const result = calibrateNewsConfidence({
				event_significance: 0.9,
				sentiment_score: 0.8,
				source_count: 3,
				source_freshness: 0.95,
				source_quality: 0.9,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			expect(result.confidence).toBeGreaterThan(0.7);
			expect(result.confidence_reason).toContain('sufficient corroboration');
			expect(result.confidence).toBeLessThanOrEqual(1);
		});

		it('should penalize single-source news', () => {
			const multiSource = calibrateNewsConfidence({
				event_significance: 0.9,
				sentiment_score: 0.8,
				source_count: 3,
				source_freshness: 0.9,
				source_quality: 0.9,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const singleSource = calibrateNewsConfidence({
				event_significance: 0.9,
				sentiment_score: 0.8,
				source_count: 1,
				source_freshness: 0.9,
				source_quality: 0.9,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			expect(singleSource.confidence).toBeLessThan(multiSource.confidence);
			expect(singleSource.confidence_reason).toContain('single source');
		});

		it('should penalize stale sources (low freshness)', () => {
			const fresh = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.95,
				source_quality: 0.8,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const stale = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.2,
				source_quality: 0.8,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			expect(stale.confidence).toBeLessThan(fresh.confidence);
			expect(stale.confidence_reason).toContain('stale');
		});

		it('should penalize low-quality/unreliable sources', () => {
			const highQuality = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.9,
				source_quality: 0.9,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const lowQuality = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.9,
				source_quality: 0.2,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			expect(lowQuality.confidence).toBeLessThan(highQuality.confidence);
			expect(lowQuality.confidence_reason).toContain('low source authority');
		});

		it('should penalize uncertainty and invalidation hints', () => {
			const clean = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.9,
				source_quality: 0.8,
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const uncertain = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.9,
				source_quality: 0.8,
				uncertainty_reason: 'conflicting signals',
				invalidation_hint: '',
			});

			const invalidatable = calibrateNewsConfidence({
				event_significance: 0.8,
				sentiment_score: 0.7,
				source_count: 3,
				source_freshness: 0.9,
				source_quality: 0.8,
				uncertainty_reason: '',
				invalidation_hint: 'if price reverses below support',
			});

			expect(uncertain.confidence).toBeLessThan(clean.confidence);
			expect(uncertain.confidence_reason).toContain('conflicting signals');
			expect(invalidatable.confidence).toBeLessThan(clean.confidence);
			expect(invalidatable.confidence_reason).toContain('may invalidate');
		});

		it('should return 0 confidence when penalties exceed base', () => {
			const result = calibrateNewsConfidence({
				event_significance: 0,
				sentiment_score: 0,
				source_count: 0,
				source_freshness: 0,
				source_quality: 0,
				uncertainty_reason: 'no reliable data',
				invalidation_hint: 'everything is uncertain',
			});

			expect(result.confidence).toBe(0);
			expect(result.confidence_reason).toBeTruthy();
		});

		it('should clamp confidence to [0, 1]', () => {
			const over = calibrateNewsConfidence({
				event_significance: 2,
				sentiment_score: 2,
				source_count: 10,
				source_freshness: 1,
				source_quality: 1,
				uncertainty_reason: '',
				invalidation_hint: '',
			});
			expect(over.confidence).toBeLessThanOrEqual(1);

			const under = calibrateNewsConfidence({
				event_significance: -0.5,
				sentiment_score: -0.5,
				source_count: 0,
				source_freshness: 0,
				source_quality: 0,
				uncertainty_reason: 'all bad',
				invalidation_hint: 'everything is uncertain',
			});
			expect(under.confidence).toBeGreaterThanOrEqual(0);
		});
	});

	describe('calibrateNewsConfidence with actual grounding sources', () => {
		const baseAnalysis = () => ({
			event_significance: 0.8,
			sentiment_score: 0.7,
			source_count: 3,
			source_freshness: 0.9,
			source_quality: 0.9,
			uncertainty_reason: '',
			invalidation_hint: '',
		});

		const makeSource = (overrides) => ({
			title: overrides.title || 'Source',
			snippet: overrides.snippet || '',
			url: overrides.url || 'https://example.com/article',
			sourceDomain: overrides.sourceDomain || overrides.domain || 'example.com',
			publishedAt: overrides.publishedAt,
		});

		it('should suppress alert when zero actual grounding sources are returned', () => {
			const result = calibrateNewsConfidence(baseAnalysis(), []);

			expect(result.confidence).toBeLessThan(0.5);
			expect(result.confidence_reason).toContain('no corroborating sources');
			expect(result.calibration.grounding_used).toBe(true);
			expect(result.calibration.actual_source_count).toBe(0);
			expect(result.calibration.effective_source_count).toBe(0);
		});

		it('should penalize a single actual grounding source', () => {
			const sources = [
				makeSource({ sourceDomain: 'reuters.com' }),
			];
			const result = calibrateNewsConfidence(baseAnalysis(), sources);

			expect(result.confidence_reason).toContain('single source');
			expect(result.calibration.actual_source_count).toBe(1);
		});

		it('should not penalize multiple high-quality grounding sources', () => {
			const sources = [
				makeSource({ sourceDomain: 'reuters.com', publishedAt: '2026-06-28T11:00:00Z' }),
				makeSource({ sourceDomain: 'bloomberg.com', publishedAt: '2026-06-28T11:00:00Z' }),
				makeSource({ sourceDomain: 'coindesk.com', publishedAt: '2026-06-28T11:00:00Z' }),
			];
			const result = calibrateNewsConfidence(baseAnalysis(), sources);

			expect(result.confidence).toBeGreaterThan(0.7);
			expect(result.calibration.actual_quality_tiers.high).toBe(3);
			expect(result.calibration.actual_source_quality).toBeGreaterThan(0.8);
		});

		it('should apply unknown-freshness penalty when no dates are provided', () => {
			const sources = [
				makeSource({ sourceDomain: 'reuters.com' }),
				makeSource({ sourceDomain: 'cnbc.com' }),
			];
			const result = calibrateNewsConfidence(baseAnalysis(), sources);

			expect(result.confidence_reason).toContain('unknown freshness');
			expect(result.calibration.has_explicit_dates).toBe(false);
			expect(result.calibration.freshness_unknown).toBe(true);
		});

		it('should penalize stale grounding sources when dates are older than the freshness window', () => {
			const now = new Date('2026-06-28T12:00:00Z');
			const tenDaysAgo = new Date(now.getTime() - (10 * 24 * 60 * 60 * 1000)).toISOString();
			const sources = [
				makeSource({ sourceDomain: 'reuters.com', publishedAt: tenDaysAgo }),
				makeSource({ sourceDomain: 'bloomberg.com', publishedAt: tenDaysAgo }),
			];
			const result = calibrateNewsConfidence(baseAnalysis(), sources, { now });

			expect(result.confidence_reason).toMatch(/stale|freshness/);
			expect(result.calibration.actual_stale_sources).toBe(2);
			expect(result.calibration.actual_source_freshness).toBeLessThan(0.3);
		});

		it('should penalize low-quality domains', () => {
			const sources = [
				makeSource({ sourceDomain: 'rumors.blog' }),
				makeSource({ sourceDomain: 'unknown-source.xyz' }),
			];
			const result = calibrateNewsConfidence(baseAnalysis(), sources);

			expect(result.confidence_reason).toMatch(/low source authority|moderate source authority/);
			expect(result.calibration.actual_quality_tiers.low).toBeGreaterThanOrEqual(1);
			expect(result.calibration.actual_source_quality).toBeLessThan(0.6);
		});

		it('should let actual grounding count override an optimistic model source_count', () => {
			const sources = [
				makeSource({ sourceDomain: 'reuters.com' }),
			];
			const analysis = baseAnalysis();
			analysis.source_count = 10; // model claims 10 sources, but grounding returned 1
			const result = calibrateNewsConfidence(analysis, sources);

			expect(result.calibration.model_source_count).toBe(10);
			expect(result.calibration.actual_source_count).toBe(1);
			expect(result.calibration.effective_source_count).toBe(1);
			expect(result.confidence_reason).toContain('single source');
		});

		it('should fall back to model metadata when grounding sources are missing', () => {
			const analysis = baseAnalysis();
			const result = calibrateNewsConfidence(analysis, null);

			expect(result.calibration.grounding_used).toBe(false);
			expect(result.confidence_reason).toContain('sufficient corroboration');
		});

		it('should never throw and must fall back when grounding sources are malformed', () => {
			const analysis = baseAnalysis();
			const malformed = [{}, { url: null, sourceDomain: null }, { title: 'x' }];

			expect(() => calibrateNewsConfidence(analysis, malformed)).not.toThrow();
			const result = calibrateNewsConfidence(analysis, malformed);
			expect(result.calibration.grounding_used).toBe(true);
		});

		it('should return a structured calibration block for downstream debug/dry-run surfaces', () => {
			const sources = [
				makeSource({ sourceDomain: 'reuters.com' }),
				makeSource({ sourceDomain: 'bloomberg.com' }),
			];
			const result = calibrateNewsConfidence(baseAnalysis(), sources);

			expect(result.calibration).toMatchObject({
				grounding_used: true,
				has_explicit_dates: false,
				freshness_unknown: true,
				actual_source_count: 2,
				effective_source_count: 2,
			});
			expect(Array.isArray(result.calibration.actual_source_domains)).toBe(true);
		});
	});
});
