/**
 * Unit Tests for Enrichment Service (Phase 8 - US6)
 * Tests: Conservative confidence selection, error handling, fallback logic
 */

const { getEnrichmentService, EnrichmentService } = require('../../src/services/inference/enrichmentService');

jest.mock('../../src/services/inference/azureAiClient');
jest.mock('../../src/lib/retryHelper');

describe('EnrichmentService (Phase 8 - US6)', () => {
	const azureAiClient = require('../../src/services/inference/azureAiClient');
	const retryHelper = require('../../src/lib/retryHelper');
	const originalEnv = process.env;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env = {
			...originalEnv,
			ENABLE_LLM_ALERT_ENRICHMENT: 'false', // Disabled by default
			AZURE_LLM_MODEL: 'gpt-4',
		};
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	describe('isEnabled', () => {
		it('should return false when ENABLE_LLM_ALERT_ENRICHMENT is false', () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'false';
			const service = new EnrichmentService();

			expect(service.isEnabled()).toBe(false);
		});

		it('should return true when enabled and Azure client is validated', () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const service = new EnrichmentService();
			expect(service.isEnabled()).toBe(true);
		});

		it('should return false when enabled but Azure client validation fails', () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(false),
			});

			const service = new EnrichmentService();
			expect(service.isEnabled()).toBe(false);
		});
	});

	describe('buildEnrichmentPrompt', () => {
		it('should build prompt from analysis data', () => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const service = new EnrichmentService();
			const analysisData = {
				headline: 'Bitcoin surges on positive news',
				sentiment_score: 0.9,
				event_significance: 0.8,
				sources: ['https://example.com/1', 'https://example.com/2'],
				gemini_confidence: 0.84,
			};

			const prompt = service.buildEnrichmentPrompt(analysisData);

			expect(prompt).toContain('Bitcoin surges on positive news');
			expect(prompt).toContain('0.9'); // sentiment_score
			expect(prompt).toContain('0.8'); // event_significance
			expect(prompt).toContain('2'); // sources count
			expect(prompt).toContain('0.84'); // gemini_confidence
		});

		it('should include all required fields in prompt', () => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const service = new EnrichmentService();
			const analysisData = {
				headline: 'Market event',
				sentiment_score: 0.5,
				event_significance: 0.6,
				sources: ['https://source1.com'],
				gemini_confidence: 0.75,
			};

			const prompt = service.buildEnrichmentPrompt(analysisData);

			expect(prompt).toContain('Assess the confidence');
			expect(prompt).toContain('Event:');
			expect(prompt).toContain('Sentiment Score:');
			expect(prompt).toContain('Event Significance:');
			expect(prompt).toContain('Sources:');
			expect(prompt).toContain('Initial Confidence (Gemini):');
		});
	});

	describe('enrichAlert', () => {
		beforeEach(() => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
				chatCompletion: jest.fn(),
				parseJsonResponse: jest.fn(),
			});
		});

		it('should apply conservative confidence selection (min of Gemini and LLM)', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			const mockAzureClient = azureAiClient.getAzureAIClient();
			mockAzureClient.chatCompletion.mockResolvedValue('{"confidence": 0.7, "reasoning": "Well sourced"}');
			mockAzureClient.parseJsonResponse.mockReturnValue({ confidence: 0.7, reasoning: 'Well sourced' });

			retryHelper.sendWithRetry.mockResolvedValue('{"confidence": 0.7, "reasoning": "Well sourced"}');

			const geminiAnalysis = {
				confidence: 0.9,
				headline: 'Test event',
				sentiment_score: 0.8,
				event_significance: 0.8,
				sources: ['https://example.com'],
			};

			const result = await service.enrichAlert(geminiAnalysis);

			// Conservative: min(0.9, 0.7) = 0.7
			expect(result.enriched_confidence).toBe(0.7);
			expect(result.original_confidence).toBe(0.9);
		});

		it('should use Gemini confidence when LLM is lower (conservative selection)', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			const mockAzureClient = azureAiClient.getAzureAIClient();
			mockAzureClient.chatCompletion.mockResolvedValue('{"confidence": 0.5, "reasoning": "Less credible"}');
			mockAzureClient.parseJsonResponse.mockReturnValue({ confidence: 0.5, reasoning: 'Less credible' });

			retryHelper.sendWithRetry.mockResolvedValue('{"confidence": 0.5, "reasoning": "Less credible"}');

			const geminiAnalysis = {
				confidence: 0.85,
				headline: 'Event',
				sentiment_score: 0.8,
				event_significance: 0.7,
				sources: ['https://example.com'],
			};

			const result = await service.enrichAlert(geminiAnalysis);

			// Conservative: min(0.85, 0.5) = 0.5
			expect(result.enriched_confidence).toBe(0.5);
		});

		it('should return null when enrichment is disabled', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'false';
			const service = new EnrichmentService();

			const geminiAnalysis = {
				confidence: 0.9,
				headline: 'Test',
				sentiment_score: 0.8,
				event_significance: 0.8,
				sources: [],
			};

			const result = await service.enrichAlert(geminiAnalysis);

			expect(result).toBeNull();
		});

		it('should include enrichment metadata in response', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			const mockAzureClient = azureAiClient.getAzureAIClient();
			mockAzureClient.chatCompletion.mockResolvedValue('{"confidence": 0.8, "reasoning": "Event is credible and well-sourced from multiple outlets"}');
			mockAzureClient.parseJsonResponse.mockReturnValue({
				confidence: 0.8,
				reasoning: 'Event is credible and well-sourced from multiple outlets',
			});

			retryHelper.sendWithRetry.mockResolvedValue('{"confidence": 0.8, "reasoning": "Event is credible"}');

			const geminiAnalysis = {
				confidence: 0.85,
				headline: 'Market event',
				sentiment_score: 0.8,
				event_significance: 0.7,
				sources: ['https://example.com'],
			};

			const result = await service.enrichAlert(geminiAnalysis);

			expect(result).toHaveProperty('original_confidence');
			expect(result).toHaveProperty('enriched_confidence');
			expect(result).toHaveProperty('enrichment_applied');
			expect(result).toHaveProperty('reasoning_excerpt');
			expect(result).toHaveProperty('model_name');
			expect(result).toHaveProperty('processing_time_ms');
			expect(result.enrichment_applied).toBe(true);
			expect(result.model_name).toBe('gpt-4');
		});

		it('should truncate reasoning to 500 chars', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			const longReasoning = 'A'.repeat(1000);
			const mockAzureClient = azureAiClient.getAzureAIClient();
			mockAzureClient.chatCompletion.mockResolvedValue(`{"confidence": 0.7, "reasoning": "${longReasoning}"}`);
			mockAzureClient.parseJsonResponse.mockReturnValue({
				confidence: 0.7,
				reasoning: longReasoning,
			});

			retryHelper.sendWithRetry.mockResolvedValue(`{"confidence": 0.7, "reasoning": "${longReasoning}"}`);

			const geminiAnalysis = {
				confidence: 0.8,
				headline: 'Test',
				sentiment_score: 0.5,
				event_significance: 0.6,
				sources: [],
			};

			const result = await service.enrichAlert(geminiAnalysis);

			expect(result.reasoning_excerpt.length).toBe(500);
		});

		it('should return null on enrichment failure', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			retryHelper.sendWithRetry.mockRejectedValue(new Error('API error'));

			const geminiAnalysis = {
				confidence: 0.9,
				headline: 'Test',
				sentiment_score: 0.8,
				event_significance: 0.7,
				sources: [],
			};

			const result = await service.enrichAlert(geminiAnalysis);

			expect(result).toBeNull();
		});

		it('should log warning on enrichment failure', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();
			retryHelper.sendWithRetry.mockRejectedValue(new Error('API timeout'));

			const geminiAnalysis = {
				confidence: 0.9,
				headline: 'Test',
				sentiment_score: 0.8,
				event_significance: 0.7,
				sources: [],
			};

			await service.enrichAlert(geminiAnalysis);

			expect(consoleWarnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[EnrichmentService] Enrichment failed'),
				expect.any(String),
			);

			consoleWarnSpy.mockRestore();
		});
	});

	describe('getDisabledMetadata', () => {
		it('should return metadata with enrichment_applied=false', () => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const service = new EnrichmentService();
			const metadata = service.getDisabledMetadata(0.8);

			expect(metadata.enrichment_applied).toBe(false);
			expect(metadata.original_confidence).toBe(0.8);
			expect(metadata.enriched_confidence).toBe(0.8);
		});

		it('should include disabled reason in metadata', () => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const service = new EnrichmentService();
			const metadata = service.getDisabledMetadata(0.75);

			expect(metadata.reasoning_excerpt).toBe('Enrichment service is disabled');
			expect(metadata.model_name).toBe('gpt-4');
		});
	});

	describe('validate', () => {
		it('should return true when enrichment is disabled', () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'false';
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(false),
			});

			const service = new EnrichmentService();
			expect(service.validate()).toBe(true);
		});

		it('should delegate to Azure client when enrichment is enabled', () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const mockValidate = jest.fn().mockReturnValue(true);
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: mockValidate,
			});

			const service = new EnrichmentService();
			const result = service.validate();

			expect(result).toBe(true);
			expect(mockValidate).toHaveBeenCalled();
		});
	});

	describe('Singleton Pattern', () => {
		it('should return same instance from getEnrichmentService', () => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const instance1 = getEnrichmentService();
			const instance2 = getEnrichmentService();

			expect(instance1).toBe(instance2);
		});
	});

	describe('Conservative Confidence Selection Formula', () => {
		beforeEach(() => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
				chatCompletion: jest.fn(),
				parseJsonResponse: jest.fn(),
			});
		});

		it('should always select the minimum of Gemini and LLM confidence', async () => {
			process.env.ENABLE_LLM_ALERT_ENRICHMENT = 'true';
			const service = new EnrichmentService();

			const testCases = [
				{ gemini: 0.9, llm: 0.8, expected: 0.8 },
				{ gemini: 0.7, llm: 0.9, expected: 0.7 },
				{ gemini: 1.0, llm: 0.5, expected: 0.5 },
				{ gemini: 0.5, llm: 1.0, expected: 0.5 },
				{ gemini: 0.5, llm: 0.5, expected: 0.5 },
			];

			for (const testCase of testCases) {
				jest.clearAllMocks();

				const mockAzureClient = azureAiClient.getAzureAIClient();
				mockAzureClient.parseJsonResponse.mockReturnValue({
					confidence: testCase.llm,
					reasoning: 'test',
				});

				retryHelper.sendWithRetry.mockResolvedValue(`{"confidence": ${testCase.llm}}`);

				const result = await service.enrichAlert({
					confidence: testCase.gemini,
					headline: 'Test',
					sentiment_score: 0.5,
					event_significance: 0.5,
					sources: [],
				});

				expect(result.enriched_confidence).toBe(testCase.expected);
			}
		});
	});

	describe('Timeout Handling', () => {
		it('should have 10 second timeout for enrichment', () => {
			azureAiClient.getAzureAIClient.mockReturnValue({
				validate: jest.fn().mockReturnValue(true),
			});

			const service = new EnrichmentService();
			expect(service.timeout).toBe(10000);
		});
	});
});
