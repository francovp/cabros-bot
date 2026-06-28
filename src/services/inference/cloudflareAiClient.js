/**
 * Cloudflare AI Gateway Client Wrapper
 * Uses OpenAI SDK with a custom baseURL for Cloudflare AI Gateway
 * Enables standardized LLM calls via CF AIG for compatible models (Gemini, etc.)
 */

const OpenAI = require('openai');
const { CF_AIG_TOKEN, CF_AIG_BASE_URL, CF_AIG_MODEL } = require('../grounding/config');

class CloudflareAiClient {
	constructor() {
		this.apiKey = CF_AIG_TOKEN;
		this.baseURL = CF_AIG_BASE_URL;
		this.model = CF_AIG_MODEL;
		this.timeout = 10000;
		console.debug('[CloudflareAiClient] Initialized with baseURL:', this.baseURL, 'model:', this.model);
	}

	/**
	 * Validate configuration at startup
	 * @returns {boolean} True if all required env vars are set
	 */
	validate() {
		if (!this.apiKey || !this.baseURL || !this.model) {
			console.warn('[CloudflareAiClient] Configuration incomplete. Missing:', {
				apiKey: !this.apiKey,
				baseURL: !this.baseURL,
				model: !this.model,
			});
			return false;
		}
		console.debug('[CloudflareAiClient] Configuration validated');
		return true;
	}

	/**
	 * Send chat completion request via Cloudflare AI Gateway
	 * @param {string} systemPrompt - System prompt
	 * @param {string} userMessage - User message
	 * @returns {Promise<{text: string, usage: object}>} Model response
	 */
	async chatCompletion(systemPrompt, userMessage) {
		if (!this.validate()) {
			throw new Error('CloudflareAiClient configuration incomplete');
		}

		const client = new OpenAI({
			apiKey: this.apiKey,
			baseURL: this.baseURL,
			timeout: this.timeout,
			maxRetries: 0,
		});

		try {
			const response = await client.chat.completions.create({
				model: this.model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage },
				],
				temperature: 0.7,
				top_p: 1.0,
			});

			return {
				text: response.choices[0]?.message?.content || '',
				usage: response.usage || {},
			};
		} catch (error) {
			console.error('[CloudflareAiClient] Chat completion failed:', error.message);
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
			const jsonMatch = response.match(/\{[\s\S]*\}/);
			if (jsonMatch) {
				return JSON.parse(jsonMatch[0]);
			}
			throw new Error('No JSON found in response');
		} catch (error) {
			console.error('[CloudflareAiClient] Failed to parse JSON response:', error.message);
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
			const client = new OpenAI({
				apiKey: this.apiKey,
				baseURL: this.baseURL,
				timeout: 5000,
				maxRetries: 0,
			});

			// Send a minimal completion to verify connectivity
			await client.chat.completions.create({
				model: this.model,
				messages: [{ role: 'user', content: 'ping' }],
				max_tokens: 1,
			});

			return true;
		} catch (error) {
			console.error('[CloudflareAiClient] Health check failed:', error.message);
			return false;
		}
	}
}

// Singleton instance
let instance = null;

function getCloudflareAiClient() {
	if (!instance) {
		instance = new CloudflareAiClient();
	}
	return instance;
}

module.exports = {
	getCloudflareAiClient,
	CloudflareAiClient,
};
