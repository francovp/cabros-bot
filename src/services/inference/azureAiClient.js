/**
 * Azure AI Inference Client Wrapper
 * Wraps @azure-rest/ai-inference for optional LLM enrichment
 * 003-news-monitor: User Story 6 (optional enrichment)
 */

const ModelClient = require("@azure-rest/ai-inference").default;
const { isUnexpected } = require("@azure-rest/ai-inference");
const { AzureKeyCredential } = require("@azure/core-auth");

class AzureAIClient {
	constructor() {
		this.endpoint = process.env.AZURE_LLM_ENDPOINT;
		this.apiKey = process.env.AZURE_LLM_KEY;
		this.model = process.env.AZURE_LLM_MODEL;
		// 10s timeout
		this.timeout = 10000;
	}

	/**
   * Validate configuration at startup
   * @returns {boolean} True if all required env vars are set
   */
	validate() {
		if (!this.endpoint || !this.apiKey || !this.model) {
			console.warn('[AzureAIClient] Configuration incomplete. Missing:', {
				endpoint: !this.endpoint,
				apiKey: !this.apiKey,
				model: !this.model,
			});
			return false;
		}
		console.debug('[AzureAIClient] Configuration validated');
		return true;
	}

	/**
   * Send chat completion request to Azure AI
   * @param {string} systemPrompt - System prompt
   * @param {string} userMessage - User message
   * @returns {Promise<string>} Model response
   */
	async chatCompletion(systemPrompt, userMessage) {
		if (!this.validate()) {
			throw new Error('AzureAIClient configuration incomplete');
		}

		const client = ModelClient(
			this.endpoint,
			new AzureKeyCredential(this.apiKey)
		);

		const payload = {
			body: {
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage },
				],
				model: this.model,
				temperature: 0.7,
				max_tokens: 500,
				top_p: 0.95,
			},
			timeout: this.timeout
		};

		try {
			const response = await client.path('/chat/completions').post(payload);

			if (isUnexpected(response)) {
				throw new Error(JSON.stringify(response.body.error));
			}

			// Handle standard OpenAI response format
			if (response.body.choices && response.body.choices[0] && response.body.choices[0].message) {
				return response.body.choices[0].message.content;
			}

			throw new Error('Unexpected response format');
		} catch (error) {
			console.error('[AzureAIClient] Chat completion failed:', error.message);
			throw error;
		}
	}

	/**
   * Parse JSON response from model
   * @param {string} response - Model response text
   * @returns {Object} Parsed JSON
   */
	parseJsonResponse(response) {
		try {
			// Try to extract JSON from response
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
			throw new Error('No JSON found in response');
		} catch (error) {
			console.error('[AzureAIClient] Failed to parse JSON response:', error.message);
			throw error;
		}
	}

	/**
   * Health check to verify endpoint is reachable
   * @returns {Promise<boolean>} True if healthy
   */
	async healthCheck() {
		if (!this.validate()) return false;

		try {
			const client = ModelClient(
				this.endpoint,
				new AzureKeyCredential(this.apiKey)
			);

			// Try a simple models endpoint call if available
			const response = await client.path('/models').get({
				timeout: this.timeout
			});

			return !isUnexpected(response);
		} catch (error) {
			console.error('[AzureAIClient] Health check failed:', error.message);
			return false;
		}
	}
}

// Singleton instance
let instance = null;

function getAzureAIClient() {
	if (!instance) {
		instance = new AzureAIClient();
	}
	return instance;
}

module.exports = {
	getAzureAIClient,
	AzureAIClient,
};
