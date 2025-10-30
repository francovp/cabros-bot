const { GoogleGenAI } = require('@google/genai');
const { GEMINI_API_KEY, GROUNDING_MODEL_NAME } = require('./config');

class GenaiClient {
	constructor() {
		this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
	}

	async search({ query, model = GROUNDING_MODEL_NAME, maxResults = 3 }) {
		try {
			// Use the model's Google Search tool to collect search results
			const groundingTool = {
				googleSearch: {},
			};

			const config = {
				tools: [groundingTool],
				//maxOutputTokens: 2048,
				temperature: 0.2,
			};

			const result = await this.genAI.models.generateContent({
				model: model,
				contents: query,
				config,
			});

			// Handle response structure - could be direct or wrapped in response property
			const response = result.response || result;

			console.debug('[genaiClient] search result candidates: ', response.candidates);
			console.debug('[genaiClient] search full response usageMetadata: ', response.usageMetadata);

			const searchResultText = response.text || '';

			// Extract search results from grounding chunks safely
			const groundingChunks = (
				response &&
				response.candidates &&
				response.candidates[0] &&
				response.candidates[0].groundingMetadata &&
				response.candidates[0].groundingMetadata.groundingChunks
			) || [];

			// Map to normalized SearchResult objects
			const results = groundingChunks
				.filter(chunk => chunk.web)
				.map(chunk => {
					const uri = chunk.web.uri || '';
					let sourceDomain = chunk.web.domain;
					if (!sourceDomain && uri) {
						try {
							sourceDomain = new URL(uri).hostname;
						} catch (e) {
							sourceDomain = '';
						}
					}

					return {
						title: chunk.web.title || 'Unknown Source',
						snippet: chunk.web.snippet || '',
						url: uri,
						sourceDomain: sourceDomain || '',
					};
				})
				.slice(0, maxResults);

			return {
				results,
				totalResults: groundingChunks.length,
				searchResultText: searchResultText,
			};
		} catch (error) {
			throw new Error(`Search failed: ${error.message}`);
		}
	}

	async llmCall({ prompt, context = {}, opts = {} }) {
		const { model = GROUNDING_MODEL_NAME, temperature = 0.2 } = opts;

		try {
			const response = await this.genAI.models.generateContent({
				model,
				contents: prompt,
				config: {
					maxOutputTokens: opts.maxTokens !== undefined ? opts.maxTokens : null,
					temperature,
				},
				context,
			});

			// Handle response structure - could be direct or wrapped in response property
			const result = response.response || response;

			// Prefer the text() helper if available (can be a function or property)
			let text = '';
			console.debug('[genaiClient] llmCall result candidates: ', result.candidates);
			console.debug('[genaiClient] llmCall full response usageMetadata: ', result.usageMetadata);
			
			if (result) {
				// Try text() as a function first
				if (typeof result.text === 'function') {
					text = result.text();
				} else if (typeof result.text === 'string') {
					text = result.text;
				} else if (result.candidates && result.candidates[0]) {
					// attempt to find text in candidate structure
					const cand = result.candidates[0];
					if (cand.content && Array.isArray(cand.content.parts) && cand.content.parts[0] && cand.content.parts[0].text) {
						text = cand.content.parts[0].text;
						console.debug('[genaiClient] extracted text via candidate.content.parts: ', text);
					} else if (cand.content && Array.isArray(cand.content) && cand.content[0] && cand.content[0].text) {
						text = cand.content[0].text;
						console.debug('[genaiClient] extracted text via candidate.content[0].text: ', text);
					} else if (cand.output && Array.isArray(cand.output) && cand.output[0] && cand.output[0].text) {
						text = cand.output[0].text;
						console.debug('[genaiClient] extracted text via candidate.output: ', text);
					}
				}
			}

			console.debug('[genaiClient] llmCall success');

			return {
				text,
				citations: context.citations || [],
			};
		} catch (error) {
			throw new Error(`LLM call failed: ${error.message}`);
		}
	}
}

module.exports = new GenaiClient();