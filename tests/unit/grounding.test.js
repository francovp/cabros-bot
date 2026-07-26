/* global describe, it, expect, jest */

const { groundAlert } = require('../../src/services/grounding/grounding');
const { generateEnrichedAlert } = require('../../src/services/grounding/gemini');
const genaiClient = require('../../src/services/grounding/genaiClient');

jest.mock('../../src/services/grounding/metrics');
jest.mock('../../src/services/grounding/gemini');
jest.mock('../../src/services/grounding/genaiClient');

describe('Grounding Service', () => {
	describe('groundAlert', () => {
		it('should enrich alert with search results and summary', async () => {
			// Mock search results
			const searchResults = [
				{
					title: 'Test Article',
					snippet: 'Sample snippet',
					url: 'https://test.com',
					sourceDomain: 'test.com',
				},
			];

			// Mock search response
			genaiClient.search.mockResolvedValueOnce({
				results: searchResults,
				totalResults: 1,
			});

			// Mock summary generation
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				insights: ['Test summary'],
				sources: searchResults,
			});

			const result = await groundAlert({
				text: 'Test alert',
			});

			expect(result.insights[0]).toBe('Test summary');
			expect(result.sources).toHaveLength(1);
			expect(result.sentiment_score).toBe(0.85);
			expect(result.truncated).toBe(false);

			// Verify search and LLM were called
			expect(genaiClient.search).toHaveBeenCalled();
			expect(generateEnrichedAlert).toHaveBeenCalled();
		});

		it('should handle long text by truncating', async () => {
			const longText = 'x'.repeat(5000);

			// Mock successful grounding
			genaiClient.search.mockResolvedValueOnce({
				results: [],
				totalResults: 0,
			});

			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: ['Summary of truncated text'],
				sources: [],
			});

			const result = await groundAlert({
				text: longText,
			});

			expect(result.truncated).toBe(true);
		});

		it('should handle timeouts', async () => {
			// Mock slow responses for both search and LLM
			genaiClient.llmCall.mockImplementationOnce(() => new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Grounding timeout')), 2000);
			}));

			genaiClient.search.mockImplementationOnce(() => new Promise((_, reject) => {
				setTimeout(() => reject(new Error('Grounding timeout')), 2000);
			}));

			await expect(groundAlert({
				text: 'Test',
				options: { timeoutMs: 100 },
			})).rejects.toThrow('Grounding timeout');
		});

		it('should handle API errors gracefully', async () => {
			genaiClient.search.mockRejectedValueOnce(new Error('API error'));

			await expect(groundAlert({
				text: 'Test',
			})).rejects.toThrow('Grounding failed: API error');
		});

		it('should use centralized alert prompt defaults by default', async () => {
			genaiClient.search.mockResolvedValueOnce({ results: [], totalResults: 0 });
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: [],
				sources: [],
			});

			await groundAlert({ text: 'Test alert text' });

			const call = generateEnrichedAlert.mock.calls[0][0];
			expect(call.options.systemPrompt).toBeUndefined();
		});

		it('should use NEWS_ANALYSIS prompt when requested', async () => {
			genaiClient.search.mockResolvedValueOnce({ results: [], totalResults: 0 });
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: [],
				sources: [],
			});

			await groundAlert({
				text: 'Test alert text',
				options: { promptType: 'NEWS_ANALYSIS' },
			});

			expect(generateEnrichedAlert).toHaveBeenCalledWith(expect.objectContaining({
				options: expect.objectContaining({
					systemPrompt: expect.stringContaining('sentiment analyst specializing in crypto and stock news'),
				}),
			}));
		});

		it('should normalize BATS: exchange prefix in search queries to prevent BAT crypto and British American Tobacco hallucinations', async () => {
			genaiClient.search.mockResolvedValueOnce({ results: [], totalResults: 0 });
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'BEARISH',
				sentiment_score: 0.8,
				insights: ['TSM stock signal'],
				sources: [],
			});

			const result = await groundAlert({
				text: 'BATS:TSM(D) cambió a señal de VENTA',
			});

			expect(genaiClient.search).toHaveBeenCalledWith(expect.objectContaining({
				query: expect.stringContaining('TSM stock'),
			}));
			const searchQuery = genaiClient.search.mock.calls[0][0].query;
			expect(searchQuery).not.toContain('BATS:');
			expect(result.symbol).toBe('TSM');
			expect(result.exchange).toBe('BATS');
			expect(result.assetClass).toBe('stock');
		});

		it('should normalize BINANCE: exchange prefix in search queries', async () => {
			genaiClient.search.mockResolvedValueOnce({ results: [], totalResults: 0 });
			generateEnrichedAlert.mockResolvedValueOnce({
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				insights: ['BTCUSDT crypto signal'],
				sources: [],
			});

			const result = await groundAlert({
				text: 'BINANCE:BTCUSDT(1H) cambió a señal de COMPRA',
			});

			expect(genaiClient.search).toHaveBeenCalledWith(expect.objectContaining({
				query: expect.stringContaining('BTCUSDT crypto'),
			}));
			const searchQuery = genaiClient.search.mock.calls[0][0].query;
			expect(searchQuery).not.toContain('BINANCE:');
			expect(result.symbol).toBe('BTCUSDT');
			expect(result.exchange).toBe('BINANCE');
			expect(result.assetClass).toBe('crypto');
		});
	});
});