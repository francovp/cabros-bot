const { GoogleGenAI } = require('@google/genai');
const { getAzureAIClient } = require('../inference/azureAiClient');
const { getOpenRouterClient } = require('../inference/openRouterClient');
const { GEMINI_API_KEY, GROUNDING_MODEL_NAME, ENABLE_NEWS_MONITOR_TEST_MODE, GEMINI_MODEL_NAME, MODEL_PROVIDER } = require('./config');
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
                const { model = GEMINI_MODEL_NAME, temperature = 0.2 } = opts;

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

        /**
         * Helper to switch between Gemini, Azure LLM, and OpenRouter based on configuration and availability.
         * Priority: Gemini -> Azure -> OpenRouter
         * @param {object} params
         * @param {string} params.systemPrompt - System prompt
         * @param {string} params.userPrompt - User prompt
         * @param {object} params.context - Context (citations) for Gemini
         * @param {object} params.opts - Options (model, temperature) for Gemini
         * @returns {Promise<{text: string, citations: Array}>} Response text and citations
         */
        async llmCallv2({ systemPrompt, userPrompt, context = {}, opts = {} }) {
                let lastError;

                // 1. Try Gemini
                if (MODEL_PROVIDER === 'gemini' && GEMINI_MODEL_NAME) {
                        try {
                                // Previous calls were like: prompt = `${systemPrompt}\n\n${userPrompt}`.
                                const combinedPrompt = `${systemPrompt}\n\n${userPrompt}`;
                                console.debug('[GenaiClient] Attempting Gemini LLM call');
                                return await this.llmCall({
                                        prompt: combinedPrompt,
                                        context,
                                        opts
                                });
                        } catch (error) {
                                console.warn('[GenaiClient] Gemini call failed, attempting failover:', error.message);
                                lastError = error;
                        }
                } else {
                        console.debug('[GenaiClient] GEMINI_MODEL_NAME not defined, skipping Gemini');
                }

                // 2. Try Azure
                if (MODEL_PROVIDER === 'azure') {
                        try {
                                const azureClient = getAzureAIClient();
                                if (azureClient.validate()) {
                                        console.debug('[GenaiClient] Attempting Azure AI Client');
                                        const text = await azureClient.chatCompletion(systemPrompt, userPrompt);
                                        return {
                                                text,
                                                citations: context.citations || [],
                                        };
                                } else {
                                console.debug('[GenaiClient] Azure AI Client not configured, skipping');
                                }
                        } catch (error) {
                                console.warn('[GenaiClient] Azure call failed, attempting failover:', error.message);
                                lastError = error;
                        }
                }

                if (MODEL_PROVIDER === 'openrouter') {

                        // 3. Try OpenRouter
                        try {
                                const openRouterClient = getOpenRouterClient();
                                if (openRouterClient.validate()) {
                                        console.debug('[GenaiClient] Attempting OpenRouter Client');
                                        const text = await openRouterClient.chatCompletion(systemPrompt, userPrompt);
                                        return {
                                                text,
                                                citations: context.citations || [],
                                        };
                                } else {
                                        console.debug('[GenaiClient] OpenRouter Client not configured, skipping');
                                }
                        } catch (error) {
                                console.warn('[GenaiClient] OpenRouter call failed:', error.message);
                                lastError = error;
                        }
                }

                // If we reach here, all configured providers failed
                throw new Error(`All LLM providers failed. Last error: ${lastError ? lastError.message : 'No providers configured'}`);
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
