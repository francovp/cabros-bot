/**
 * LLM Alert Enrichment Service
 * Optional secondary enrichment using Azure AI Inference
 * 003-news-monitor: User Story 6 (optional enrichment)
 * Conservative confidence selection: min(Gemini, LLM)
 */

const { getAzureAIClient } = require('./azureAiClient');
const { sendWithRetry } = require('../../lib/retryHelper');

const ENRICHMENT_SYSTEM_PROMPT = `You are a financial market analyst specializing in risk assessment. 
Given an analysis result from Gemini, assess the confidence level of the detected event.
Respond with JSON: {"confidence": 0.0-1.0, "reasoning": "brief explanation"}
Use conservative scoring: 0.7+ only for highly credible, well-sourced events.
Penalize vague events, single sources, or uncorroborated claims.`;

class EnrichmentService {
	constructor() {
		this.azureClient = getAzureAIClient();
		this.enabled = process.env.ENABLE_LLM_ALERT_ENRICHMENT === 'true';
		// 10s timeout
		this.timeout = 10000;
	}

	/**
   * Check if enrichment is enabled and configured
   * @returns {boolean} True if enrichment can be used
   */
	isEnabled() {
		if (!this.enabled) {
			return false;
		}
		return this.azureClient.validate();
	}

	/**
   * Build enrichment prompt from analysis result
   * @param {Object} analysisData - Gemini analysis with confidence
   * @returns {string} User message for LLM
   */
	buildEnrichmentPrompt(analysisData) {
		const {
			headline,
			sentiment_score,
			event_significance,
			sources,
			gemini_confidence,
		} = analysisData;

		return `Assess the confidence of this financial event:
Event: ${headline}
Sentiment Score: ${sentiment_score}
Event Significance: ${event_significance}
Sources: ${sources.length} (${sources.join(', ')})
Initial Confidence (Gemini): ${gemini_confidence}

Respond with JSON: {"confidence": <0.0-1.0>, "reasoning": "<brief assessment>"}`;
	}

	/**
   * Enrich alert with secondary LLM analysis
   * Applies conservative confidence selection
   * @param {Object} geminiAnalysis - Gemini analysis result
   * @returns {Promise<Object|null>} Enrichment metadata or null on failure
   */
	async enrichAlert(geminiAnalysis) {
		if (!this.isEnabled()) {
			console.debug('[EnrichmentService] Enrichment disabled');
			return null;
		}

		const { confidence: geminiConfidence } = geminiAnalysis;

		try {
		// Call LLM enrichment with retry logic
			const enrichmentResponse = await sendWithRetry(
				async () => {
					const userPrompt = this.buildEnrichmentPrompt(geminiAnalysis);
					return await this.azureClient.chatCompletion(ENRICHMENT_SYSTEM_PROMPT, userPrompt);
				},
				3,
				console,
			);

			// Parse LLM response
			const llmResult = this.azureClient.parseJsonResponse(enrichmentResponse);

			// Apply conservative confidence selection
			const finalConfidence = Math.min(geminiConfidence, llmResult.confidence);

			const enrichmentMetadata = {
				original_confidence: geminiConfidence,
				enriched_confidence: finalConfidence,
				enrichment_applied: true,
				reasoning_excerpt: llmResult.reasoning.substring(0, 500),
				model_name: process.env.AZURE_LLM_MODEL || 'unknown',
				processing_time_ms: 0,
			};

			console.debug('[EnrichmentService] Enrichment successful', {
				original: geminiConfidence,
				enriched: finalConfidence,
				selected: 'min',
			});

			return enrichmentMetadata;
		} catch (error) {
			console.warn('[EnrichmentService] Enrichment failed, using Gemini confidence:', error.message);
			return null;
		}
	}

	/**
   * Get enrichment metadata indicating service is disabled
   * @returns {Object} Metadata with enrichment_applied=false
   */
	getDisabledMetadata(geminiConfidence) {
		return {
			original_confidence: geminiConfidence,
			enriched_confidence: geminiConfidence,
			enrichment_applied: false,
			reasoning_excerpt: 'Enrichment service is disabled',
			model_name: process.env.AZURE_LLM_MODEL || 'none',
			processing_time_ms: 0,
		};
	}

	/**
	 * Validate enrichment configuration
	 * @returns {boolean} True if all required env vars are set
	 */
	validate() {
		if (!this.enabled) {
			console.debug('[EnrichmentService] Enrichment disabled via env var');
			return true;
		}
		return this.azureClient.validate();
	}
}

// Singleton instance
let instance = null;

function getEnrichmentService() {
	if (!instance) {
		instance = new EnrichmentService();
	}
	return instance;
}

module.exports = {
	getEnrichmentService,
	EnrichmentService,
};
