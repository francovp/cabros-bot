const { GoogleGenAI } = require('@google/genai');
const { GEMINI_API_KEY, GROUNDING_MODEL_NAME, ENABLE_NEWS_MONITOR_TEST_MODE } = require('./config');
const { normalizeUsageMetadata } = require('../../lib/tokenUsage');

class GenaiClient {
        constructor() {
                this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        }

        async search({ query, model = GROUNDING_MODEL_NAME, maxResults = 3, textWithCitations = false }) {
                try {

                        if (ENABLE_NEWS_MONITOR_TEST_MODE) {
                                console.debug('[genaiClient] News Monitor Test Mode enabled - returning mock search results');
                                return {
                                        results: [
                                                {
                                                        title: 'Test Article 1',
                                                        snippet: 'This is a snippet from test article 1.',
                                                        url: 'https://example.com/test-article-1',
                                                        sourceDomain: 'example.com',
                                                },
                                                {
                                                        title: 'Test Article 2',
                                                        snippet: 'This is a snippet from test article 2.',
                                                        url: 'https://example.com/test-article-2',
                                                        sourceDomain: 'example.com',
                                                },
                                        ],
                                        totalResults: 2,
                                        searchResultText: 'Mock search results for testing purposes.',
                                };
                        }

                        console.debug(`[genaiClient] Performing search with query: "${query}" using model: "${model}"`);
                        // Use the model's Google Search tool to collect search results
                        const groundingTool = {
                                googleSearch: {},
                        };

                        const config = {
                                tools: [groundingTool],
                                temperature: 0.2,
                        };

                        const result = await this.genAI.models.generateContent({
                                model: model,
                                contents: query,
                                config,
                        });

                        // Handle response structure - could be direct or wrapped in response property
                        const response = result?.response || result || {};
                        const usage = normalizeUsageMetadata(response.usageMetadata);

                        console.debug('[genaiClient] search full response usageMetadata: ', response.usageMetadata);

                        let searchResultText = response.text || '';

                        // Safely access first candidate (result may be unexpected shape)
                        const candidate = response?.candidates?.[0];
                        console.debug('[genaiClient] search result candidate[0]: ', candidate);

                        // Extract search results from grounding chunks safely (default empty arrays)
                        const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
                        console.debug('[genaiClient] search groundingChunks: ', groundingChunks);

                        const groundingSupports = candidate?.groundingMetadata?.groundingSupports || [];
                        console.debug('[genaiClient] search groundingSupports: ', groundingSupports);

                        if (textWithCitations) {
                                searchResultText = this._addCitations(searchResultText, groundingSupports, groundingChunks);
                        }

                        // Map to normalized SearchResult objects
                        const results = groundingChunks
                                .filter(chunk => chunk && chunk.web)
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
                                usage,
                        };
                } catch (error) {
                        // Normalize to expected error message prefix
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
                        const result = response?.response || response || {};
                        const usage = normalizeUsageMetadata(result.usageMetadata);

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
                                usage,
                        };
                } catch (error) {
                        throw new Error(`LLM call failed: ${error.message}`);
                }
        }

        _addCitations(text, supports, chunks) {
                // Sort supports by end_index in descending order to avoid shifting issues when inserting.
                const sortedSupports = [...supports].sort(
                        (a, b) => (b.segment?.endIndex ?? 0) - (a.segment?.endIndex ?? 0),
                );

                for (const support of sortedSupports) {
                        const endIndex = support.segment?.endIndex;
                        if (endIndex === undefined || !support.groundingChunkIndices?.length) {
                                continue;
                        }

                        const citationLinks = support.groundingChunkIndices
                        .map(i => {
                                const uri = chunks[i]?.web?.uri;
                                if (uri) {
                                return `[${i + 1}](${uri})`;
                                }
                                return null;
                        })
                        .filter(Boolean);

                        if (citationLinks.length > 0) {
                                const citationString = citationLinks.join(", ");
                                text = text.slice(0, endIndex) + citationString + text.slice(endIndex);
                        }
                }

                return text;
        }
}

module.exports = new GenaiClient();
