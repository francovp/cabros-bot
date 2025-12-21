const { GoogleGenAI } = require('@google/genai');
const {
        GEMINI_API_KEY,
        GROUNDING_MODEL_NAME,
        ENABLE_NEWS_MONITOR_TEST_MODE,
        BRAVE_SEARCH_API_KEY,
        BRAVE_SEARCH_ENDPOINT
} = require('./config');

class GenaiClient {
        constructor() {
                this.genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
        }

        async _searchBrave(query, count = 3) {
                if (!BRAVE_SEARCH_API_KEY) {
                        console.warn('[genaiClient] BRAVE_SEARCH_API_KEY is not set. Returning empty results.');
                        return [];
                }

                try {
                        const url = new URL(BRAVE_SEARCH_ENDPOINT);
                        url.searchParams.append('q', query);
                        url.searchParams.append('count', count);

                        const response = await fetch(url.toString(), {
                                method: 'GET',
                                headers: {
                                        'Accept': 'application/json',
                                        'Accept-Encoding': 'gzip',
                                        'X-Subscription-Token': BRAVE_SEARCH_API_KEY
                                }
                        });

                        if (!response.ok) {
                                throw new Error(`Brave Search API failed with status ${response.status}: ${response.statusText}`);
                        }

                        const data = await response.json();

                        // Parse Brave results
                        // Brave structure: { web: { results: [ { title, url, description, profile: { name } } ] } }
                        const results = data.web?.results?.map(result => {
                                let sourceDomain = '';
                                if (result.profile && result.profile.name) {
                                        sourceDomain = result.profile.name;
                                } else if (result.url) {
                                        try {
                                                sourceDomain = new URL(result.url).hostname;
                                        } catch (e) {
                                                sourceDomain = '';
                                        }
                                }

                                return {
                                        title: result.title || 'Unknown Source',
                                        snippet: result.description || '',
                                        url: result.url || '',
                                        sourceDomain: sourceDomain
                                };
                        }) || [];

                        return results;
                } catch (error) {
                        console.error('[genaiClient] Brave Search error:', error);
                        return [];
                }
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

                        console.debug(`[genaiClient] Performing search with query: "${query}" using Brave Search API`);

                        // 1. Get search results from Brave
                        const results = await this._searchBrave(query, maxResults);

                        // 2. Generate text grounded in these results using LLM
                        let searchResultText = '';

                        if (results.length > 0) {
                                const contextPrompt = results.map((r, i) => `[${i+1}] Title: ${r.title}\nSource: ${r.sourceDomain}\nURL: ${r.url}\nSnippet: ${r.snippet}`).join('\n\n');

                                const prompt = `Query: ${query}\n\nSearch Results:\n${contextPrompt}\n\nInstructions: Answer the query based *only* on the provided search results. If the search results are insufficient, state that. ${textWithCitations ? 'Cite your sources using [1], [2], etc.' : ''}`;

                                const llmResponse = await this.llmCall({ prompt, opts: { model } });
                                searchResultText = llmResponse.text;
                        } else {
                                searchResultText = "No search results found.";
                        }

                        return {
                                results,
                                totalResults: results.length,
                                searchResultText: searchResultText,
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
