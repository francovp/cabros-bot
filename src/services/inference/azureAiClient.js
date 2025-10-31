/**
 * Azure AI Inference Client Wrapper
 * Wraps @azure-rest/ai-inference for optional LLM enrichment
 * 003-news-monitor: User Story 6 (optional enrichment)
 */

const https = require('https');

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
   * Make HTTP request to Azure AI Inference endpoint
   * @param {string} method - HTTP method
   * @param {string} path - Request path
   * @param {Object} body - Request body (will be JSON stringified)
   * @returns {Promise<Object>} Response body as JSON
   */
	async makeRequest(method, path, body = null) {
		return new Promise((resolve, reject) => {
			const url = new URL(this.endpoint);
			const hostname = url.hostname;
			const fullPath = path.startsWith('/') ? path : '/' + path;

			const options = {
				hostname,
				path: fullPath,
				method,
				headers: {
					'api-key': this.apiKey,
					'Content-Type': 'application/json',
					'User-Agent': 'cabros-bot/news-monitor',
				},
				timeout: this.timeout,
			};

			if (method !== 'GET' && body) {
				const bodyStr = JSON.stringify(body);
				options.headers['Content-Length'] = Buffer.byteLength(bodyStr);
			}

			const req = https.request(options, (res) => {
				let data = '';

				res.on('data', (chunk) => {
					data += chunk;
				});

				res.on('end', () => {
					try {
						const json = JSON.parse(data);
						if (res.statusCode >= 400) {
							reject(new Error(`HTTP ${res.statusCode}: ${json.error || data}`));
						} else {
							resolve(json);
						}
					} catch (e) {
						reject(new Error(`Failed to parse response: ${e.message}`));
					}
				});
			});

			req.on('timeout', () => {
				req.destroy();
				reject(new Error('Request timeout'));
			});

			req.on('error', (err) => {
				reject(err);
			});

			if (method !== 'GET' && body) {
				req.write(JSON.stringify(body));
			}

			req.end();
		});
	}

	/**
   * Send chat completion request to Azure AI
   * @param {string} systemPrompt - System prompt
   * @param {string} userMessage - User message
   * @returns {Promise<string>} Model response
   */
	async chatCompletion(systemPrompt, userMessage) {
		const payload = {
			model: this.model,
			messages: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userMessage },
			],
			temperature: 0.7,
			max_tokens: 500,
			top_p: 0.95,
		};

		try {
			const response = await this.makeRequest('POST', '/chat/completions', payload);

			// Handle standard OpenAI response format
			if (response.choices && response.choices[0] && response.choices[0].message) {
				return response.choices[0].message.content;
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
		try {
			// Try a simple models endpoint call if available
			const response = await this.makeRequest('GET', '/models', null);
			return !!response;
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
