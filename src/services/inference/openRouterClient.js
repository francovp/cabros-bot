/**
 * OpenRouter Client Wrapper
 * Wraps OpenRouter API for optional LLM enrichment
 */

const { OPENROUTER_API_KEY, OPENROUTER_MODEL } = require('../grounding/config');

class OpenRouterClient {
	constructor() {
		this.apiKey = OPENROUTER_API_KEY;
		this.model = OPENROUTER_MODEL;
		this.endpoint = 'https://openrouter.ai/api/v1/chat/completions';
		// 10s timeout not directly applicable to fetch unless we use AbortController,
		// but we will trust the caller or fetch default/environment.
		console.debug('[OpenRouterClient] Initialized with model:', this.model);
	}

	/**
   * Validate configuration at startup
   * @returns {boolean} True if all required env vars are set
   */
	validate() {
		if (!this.apiKey || !this.model) {
			console.warn('[OpenRouterClient] Configuration incomplete. Missing:', {
				apiKey: !this.apiKey,
				model: !this.model,
			});
			return false;
		}
		console.debug('[OpenRouterClient] Configuration validated');
		return true;
	}

	/**
   * Send chat completion request to OpenRouter
   * @param {string} systemPrompt - System prompt
   * @param {string} userMessage - User message
   * @returns {Promise<string>} Model response
   */
	async chatCompletion(systemPrompt, userMessage) {
		if (!this.validate()) {
			throw new Error('OpenRouterClient configuration incomplete');
		}

		const payload = {
			model: this.model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userMessage },
			],
			temperature: 0.7,
			top_p: 1.0,
		};

		try {
			const response = await fetch(this.endpoint, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
					'Content-Type': 'application/json',
					'HTTP-Referer': 'https://github.com/carlos-bastidas/ai-news-monitor', // Optional, using a placeholder or repo URL
					'X-Title': 'AI News Monitor', // Optional
				},
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`OpenRouter API error: ${response.status} ${response.statusText} - ${errorText}`);
			}

			const data = await response.json();

			// Handle standard OpenAI response format
			if (data.choices && data.choices[0] && data.choices[0].message) {
				return data.choices[0].message.content;
			}

			throw new Error('Unexpected response format');
		} catch (error) {
			console.error('[OpenRouterClient] Chat completion failed:', error.message);
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
			console.error('[OpenRouterClient] Failed to parse JSON response:', error.message);
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
			// Try a simple models generation call with max_tokens 1 to check connectivity
			// Or just assume if config is valid, we are good until first call.
			// OpenRouter doesn't seem to have a dedicated health endpoint without auth that gives meaningful info easily via this client structure,
			// but we can try a minimal completion.

			// Actually, let's try to list models or just return true if validate passes,
			// but to be consistent with AzureClient which calls /models, let's try to call completion with minimal tokens.
			// Or better, let's just return true if validation passes for now to avoid consuming credits on health checks
			// unless we really need it. Azure client calls /models which is free usually.
			// OpenRouter has /api/v1/models.

			const response = await fetch('https://openrouter.ai/api/v1/models', {
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
				},
			});

			return response.ok;
		} catch (error) {
			console.error('[OpenRouterClient] Health check failed:', error.message);
			return false;
		}
	}
}

// Singleton instance
let instance = null;

function getOpenRouterClient() {
	if (!instance) {
		instance = new OpenRouterClient();
	}
	return instance;
}

module.exports = {
	getOpenRouterClient,
	OpenRouterClient,
};
