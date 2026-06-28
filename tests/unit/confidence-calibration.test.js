/**
 * Unit Tests for Confidence Calibration (Issue #127)
 * Tests: source_count, source_freshness, source_quality, event_age, uncertainty penalties
 */

const {
	analyzeNewsForSymbol,
	parseNewsAnalysisResponse,
	calculateCalibratedConfidence,
	buildConfidenceReason,
} = require('../../src/services/grounding/gemini');
const { EventCategory } = require('../../src/controllers/webhooks/handlers/newsMonitor/constants');

jest.mock('../../src/services/grounding/genaiClient');

describe('Confidence Calibration (Issue #127)', () => {
	const genaiClient = require('../../src/services/grounding/genaiClient');

	beforeEach(() => {
		jest.clearAllMocks();
		// Mock search() to return grounding results
		genaiClient.search.mockResolvedValue({
			results: [
				{ url: 'https://example.com/1', title: 'Source 1' },
				{ url: 'https://example.com/2', title: 'Source 2' },
			],
			searchResultText: 'Market context from search',
			totalResults: 2,
		});
	});

	describe('parseNewsAnalysisResponse with calibration fields', () => {
		it('should parse all new calibration fields when provided', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges',
				description: 'Test event',
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
				invalidation_hint: 'price drops below $40k',
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.source_count).toBe(3);
			expect(result.source_freshness).toBe('recent');
			expect(result.source_quality).toBe('high');
			expect(result.event_age).toBe('1h');
			expect(result.time_horizon).toBe('intraday');
			expect(result.uncertainty_reason).toBe('');
			expect(result.invalidation_hint).toBe('price drops below $40k');
			expect(result._hasCalibrationFields).toBe(true);
		});

		it('should detect missing calibration fields and use legacy formula', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges',
				description: 'Test event',
				sources: ['https://example.com'],
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result._hasCalibrationFields).toBe(false);
		});

		it('should use defaults for missing calibration fields', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges',
				source_count: 1,
				// missing source_freshness, source_quality, etc.
			});

			const result = parseNewsAnalysisResponse(response);

			expect(result.source_count).toBe(1);
			expect(result.source_freshness).toBe('old');
			expect(result.source_quality).toBe('low');
			expect(result.event_age).toBe('0h');
			expect(result.time_horizon).toBe('intraday');
			expect(result.uncertainty_reason).toBe('');
			expect(result.invalidation_hint).toBe('');
			expect(result._hasCalibrationFields).toBe(false);
		});

		it('should clamp source_count to max 10', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges',
				source_count: 15,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const result = parseNewsAnalysisResponse(response);
			expect(result.source_count).toBe(10);
		});

		it('should validate source_freshness enum', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges',
				source_count: 2,
				source_freshness: 'invalid_value',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const result = parseNewsAnalysisResponse(response);
			expect(result.source_freshness).toBe('old'); // defaults to old
		});

		it('should validate source_quality enum', () => {
			const response = JSON.stringify({
				event_category: 'price_surge',
				event_significance: 0.8,
				sentiment_score: 0.9,
				headline: 'Bitcoin surges',
				source_count: 2,
				source_freshness: 'recent',
				source_quality: 'invalid_quality',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
				invalidation_hint: '',
			});

			const result = parseNewsAnalysisResponse(response);
			expect(result.source_quality).toBe('low'); // defaults to low
		});
	});

	describe('calculateCalibratedConfidence', () => {
		it('should apply base formula when all calibration fields are optimal', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.6*0.8 + 0.4*0.9 = 0.48 + 0.36 = 0.84
			// No penalties applied
			expect(confidence).toBeCloseTo(0.84, 5);
		});

		it('should penalize single source heavily', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 1,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.6 (single source penalty) = 0.504
			expect(confidence).toBeCloseTo(0.504, 3);
		});

		it('should penalize no sources very heavily', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 0,
				source_freshness: 'old', // forced when source_count = 0
				source_quality: 'low', // forced when source_count = 0
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.3 (no source penalty) * 0.3 (old freshness) * 0.5 (low quality) = 0.0378
			expect(confidence).toBeCloseTo(0.0378, 4);
		});

		it('should penalize stale sources', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'stale',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.6 (stale penalty) = 0.504
			expect(confidence).toBeCloseTo(0.504, 3);
		});

		it('should penalize old sources heavily', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'old',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.3 (old penalty) = 0.252
			expect(confidence).toBeCloseTo(0.252, 3);
		});

		it('should penalize low quality sources', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'low',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.5 (low quality) = 0.42
			expect(confidence).toBeCloseTo(0.42, 3);
		});

		it('should penalize medium quality sources', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'medium',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.8 (medium quality) = 0.672
			expect(confidence).toBeCloseTo(0.672, 3);
		});

		it('should penalize uncertainty', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: 'conflicting narratives',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.7 (uncertainty penalty) = 0.588
			expect(confidence).toBeCloseTo(0.588, 3);
		});

		it('should penalize event age > 24h heavily', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '48h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.4 (age > 24h) = 0.336
			expect(confidence).toBeCloseTo(0.336, 3);
		});

		it('should penalize event age > 6h', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '12h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.6 (age > 6h) = 0.504
			expect(confidence).toBeCloseTo(0.504, 3);
		});

		it('should slightly penalize event age > 1h', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '3h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.85 (age > 1h) = 0.714
			expect(confidence).toBeCloseTo(0.714, 3);
		});

		it('should apply multiple penalties cumulatively', () => {
			const analysis = {
				event_significance: 0.8,
				sentiment_score: 0.9,
				source_count: 1,
				source_freshness: 'stale',
				source_quality: 'low',
				event_age: '12h',
				time_horizon: 'intraday',
				uncertainty_reason: 'single-source report',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.84 * 0.6 (single source) * 0.6 (stale) * 0.5 (low quality) * 0.6 (age > 6h) * 0.7 (uncertainty)
			// = 0.84 * 0.6 * 0.6 * 0.5 * 0.6 * 0.7 = 0.84 * 0.0756 = 0.0635
			expect(confidence).toBeCloseTo(0.0635, 4);
		});

		it('should clamp confidence to [0, 1]', () => {
			const analysis = {
				event_significance: 1.0,
				sentiment_score: 1.0,
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				event_age: '1h',
				time_horizon: 'intraday',
				uncertainty_reason: '',
			};

			const confidence = calculateCalibratedConfidence(analysis);
			// Base: 0.6*1.0 + 0.4*1.0 = 1.0, no penalties = 1.0
			expect(confidence).toBe(1.0);
		});
	});

	describe('buildConfidenceReason', () => {
		it('should return high confidence message when all optimal', () => {
			const analysis = {
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				uncertainty_reason: '',
			};

			const reason = buildConfidenceReason(analysis);
			expect(reason).toBe('high confidence: multi-source, fresh, quality sources');
		});

		it('should include single source in reason', () => {
			const analysis = {
				source_count: 1,
				source_freshness: 'recent',
				source_quality: 'high',
				uncertainty_reason: '',
			};

			const reason = buildConfidenceReason(analysis);
			expect(reason).toContain('single source');
		});

		it('should include stale sources in reason', () => {
			const analysis = {
				source_count: 3,
				source_freshness: 'stale',
				source_quality: 'high',
				uncertainty_reason: '',
			};

			const reason = buildConfidenceReason(analysis);
			expect(reason).toContain('stale sources');
		});

		it('should include low quality in reason', () => {
			const analysis = {
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'low',
				uncertainty_reason: '',
			};

			const reason = buildConfidenceReason(analysis);
			expect(reason).toContain('low-quality sources');
		});

		it('should include uncertainty reason', () => {
			const analysis = {
				source_count: 3,
				source_freshness: 'recent',
				source_quality: 'high',
				uncertainty_reason: 'conflicting narratives',
			};

			const reason = buildConfidenceReason(analysis);
			expect(reason).toContain('conflicting narratives');
		});
	});

	describe('analyzeNewsForSymbol with calibration', () => {
		it('should use legacy formula when LLM does not provide calibration fields', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_surge',
					event_significance: 0.8,
					sentiment_score: 0.9,
					headline: 'Test',
					sources: [],
				}),
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Market context');

			// Legacy formula: 0.6 * 0.8 + 0.4 * 0.9 = 0.84
			expect(result.confidence).toBeCloseTo(0.84, 5);
			expect(result.confidence_reason).toBe('legacy formula');
			expect(result._hasCalibrationFields).toBe(false);
		});

		it('should use calibrated confidence when LLM provides all calibration fields', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_surge',
					event_significance: 0.8,
					sentiment_score: 0.9,
					headline: 'Bitcoin surges',
					source_count: 3,
					source_freshness: 'recent',
					source_quality: 'high',
					event_age: '1h',
					time_horizon: 'intraday',
					uncertainty_reason: '',
					invalidation_hint: '',
				}),
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Market context');

			// Calibrated: 0.84 (no penalties)
			expect(result.confidence).toBeCloseTo(0.84, 5);
			expect(result.confidence_reason).toBe('high confidence: multi-source, fresh, quality sources');
			expect(result._hasCalibrationFields).toBe(true);
		});

		it('should apply penalties when LLM provides poor calibration fields', async () => {
			genaiClient.llmCallv2.mockResolvedValue({
				text: JSON.stringify({
					event_category: 'price_surge',
					event_significance: 0.8,
					sentiment_score: 0.9,
					headline: 'Bitcoin surges',
					source_count: 1,
					source_freshness: 'stale',
					source_quality: 'low',
					event_age: '12h',
					time_horizon: 'intraday',
					uncertainty_reason: 'single-source report',
					invalidation_hint: '',
				}),
			});

			const result = await analyzeNewsForSymbol('BTCUSDT', 'Market context');

			// Calibrated with penalties: 0.84 * 0.6 * 0.6 * 0.5 * 0.6 * 0.7 = ~0.0635
			expect(result.confidence).toBeCloseTo(0.0635, 4);
			expect(result.confidence_reason).toContain('single source');
			expect(result.confidence_reason).toContain('stale sources');
			expect(result.confidence_reason).toContain('low-quality sources');
			expect(result.confidence_reason).toContain('single-source report');
		});
	});
});
