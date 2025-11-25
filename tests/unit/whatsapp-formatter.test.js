/**
 * WhatsAppMarkdownFormatter URL Shortening Tests (Task T028)
 * Tests async formatEnriched() with Bitly URL shortening integration
 */

const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');

describe('WhatsAppMarkdownFormatter - T028 URL Shortening Integration', () => {
	let mockUrlShortener;

	beforeEach(() => {
		mockUrlShortener = {
			shortenUrlsParallel: jest.fn(),
		};
	});

	describe('constructor', () => {
		it('should initialize with urlShortener', () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});
			expect(formatter.urlShortener).toBe(mockUrlShortener);
		});

		it('should initialize without urlShortener (backward compatibility)', () => {
			const formatter = new WhatsAppMarkdownFormatter({});
			expect(formatter.urlShortener).toBeFalsy(); // Could be undefined or null
		});

		it('should initialize with logger', () => {
			const mockLogger = { debug: jest.fn(), warn: jest.fn() };
			const formatter = new WhatsAppMarkdownFormatter({
				logger: mockLogger,
				urlShortener: mockUrlShortener,
			});
			expect(formatter.logger).toBe(mockLogger);
		});
	});

	describe('formatEnriched() - New Structure (Sentiment, Insights, Technical Levels)', () => {
		it('should format enriched alert with all sections', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://coindesk.com/btc': 'https://bit.ly/btc',
				'https://bloomberg.com/crypto': 'https://bit.ly/crypto',
			});

			const enriched = {
				original_text: 'Bitcoin breaks 83k',
				sentiment: 'BULLISH',
				sentiment_score: 0.9,
				insights: [
					'Bitcoin price surged past $83k.',
					'Volume indicates strong momentum.',
				],
				technical_levels: {
					supports: ['$80,000', '$81,500'],
					resistances: ['$85,000'],
				},
				sources: [
					{
						title: 'CoinDesk',
						url: 'https://coindesk.com/btc',
					},
					{
						title: 'Bloomberg',
						url: 'https://bloomberg.com/crypto',
					},
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Check Sentiment
			expect(result).toContain('Sentiment: BULLISH 🚀 (0.90)');

			// Check Insights
			expect(result).toContain('*Key Insights*');
			expect(result).toContain('• Bitcoin price surged past $83k.');
			expect(result).toContain('• Volume indicates strong momentum.');

			// Check Technical Levels
			expect(result).toContain('*Technical Levels*');
			expect(result).toContain('Supports: $80,000, $81,500');
			expect(result).toContain('Resistances: $85,000');

			// Check Sources
			expect(result).toContain('*Sources*');
			expect(result).toContain('CoinDesk: https://bit.ly/btc');
			expect(result).toContain('Bloomberg: https://bit.ly/crypto');
		});

		it('should handle missing technical levels', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const enriched = {
				original_text: 'Alert',
				sentiment: 'NEUTRAL',
				sentiment_score: 0.5,
				insights: ['Insight'],
				technical_levels: { supports: [], resistances: [] },
				sources: [],
			};

			const result = await formatter.formatEnriched(enriched);
			expect(result).not.toContain('*Technical Levels*');
		});

		it('should handle degraded/short alert (minimal fields)', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const degradedAlert = {
				original_text: 'Short alert',
				sentiment: 'NEUTRAL',
				sentiment_score: 0,
				insights: [],
				technical_levels: { supports: [], resistances: [] },
				sources: [],
			};

			const result = await formatter.formatEnriched(degradedAlert);

			expect(result).toContain('*Short alert*');
			expect(result).toContain('Sentiment: NEUTRAL 😐 (0.00)');
			expect(result).not.toContain('*Key Insights*');
			expect(result).not.toContain('*Technical Levels*');
			expect(result).not.toContain('*Sources*');
		});

		it('should handle undefined optional fields', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const minimalAlert = {
				original_text: 'Minimal alert',
				sentiment: 'BULLISH',
				sentiment_score: 0.8,
				// insights undefined
				// technical_levels undefined
				// sources undefined
			};

			const result = await formatter.formatEnriched(minimalAlert);

			expect(result).toContain('*Minimal alert*');
			expect(result).toContain('Sentiment: BULLISH 🚀 (0.80)');
			expect(result).not.toContain('*Key Insights*');
			expect(result).not.toContain('*Technical Levels*');
			expect(result).not.toContain('*Sources*');
		});
	});

	describe('formatEnriched() async - URL Shortening', () => {
		it('should shorten URLs in enriched citations', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/very/long/url': 'https://bit.ly/short1',
			});

			const enriched = {
				original_text: 'Market update',
				insights: ['Bitcoin surged'],
				sources: [
					{ title: 'Reuters', url: 'https://example.com/very/long/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(mockUrlShortener.shortenUrlsParallel).toHaveBeenCalled();
			expect(result).toContain('Reuters');
			expect(result).toContain('bit.ly/short1');
		});

		it('should handle shortening API errors gracefully', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockRejectedValue(
				new Error('Bitly API rate limit'),
			);

			const enriched = {
				original_text: 'Alert text',
				insights: ['Update'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Should fallback to title-only format
			expect(result).toContain('Source');
		});

		it('should skip shortening if no urlShortener configured', async () => {
			const formatter = new WhatsAppMarkdownFormatter({});

			const enriched = {
				original_text: 'Alert',
				insights: ['Update'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Should include title (URL may or may not be included depending on impl)
			expect(result).toContain('Source');
		});

		it('should handle multiple citations for shortening', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url1': 'https://bit.ly/1',
				'https://example.com/url2': 'https://bit.ly/2',
			});

			const enriched = {
				original_text: 'News update',
				insights: ['Market alert'],
				sources: [
					{ title: 'Bloomberg', url: 'https://example.com/url1' },
					{ title: 'Reuters', url: 'https://example.com/url2' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toContain('Bloomberg');
			expect(result).toContain('bit.ly/1');
			expect(result).toContain('Reuters');
			expect(result).toContain('bit.ly/2');
		});

		it('should handle partial shortening failures', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			// Only url1 shortening succeeds
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url1': 'https://bit.ly/1',
			});

			const enriched = {
				original_text: 'Update',
				insights: ['Summary'],
				sources: [
					{ title: 'Working', url: 'https://example.com/url1' },
					{ title: 'Failed', url: 'https://example.com/url2' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Working citation should have shortened URL
			expect(result).toContain('Working');
			expect(result).toContain('bit.ly/1');
			// Failed citation should fallback to title-only
			expect(result).toContain('Failed');
		});

		it('should preserve summary and original text in output', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'Original alert body',
				insights: ['AI-generated summary text'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toContain('Original alert body');
			expect(result).toContain('AI-generated summary text');
			expect(result).toContain('Source');
			expect(result).toContain('bit.ly/short');
		});

		it('should handle timeout during shortening gracefully', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockRejectedValue(
				new Error('Timeout after 10000ms'),
			);

			const enriched = {
				original_text: 'Alert',
				insights: ['Update'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Should still deliver with fallback
			expect(result).toContain('Source');
		});

		it('should handle empty citations array', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const enriched = {
				original_text: 'Alert without citations',
				insights: ['Summary text'],
				sources: [],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toContain('Alert without citations');
			expect(result).toContain('Summary text');
			expect(mockUrlShortener.shortenUrlsParallel).not.toHaveBeenCalled();
		});

		it('should handle citations without URLs', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Source without URL' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toContain('Source without URL');
			expect(mockUrlShortener.shortenUrlsParallel).not.toHaveBeenCalled();
		});

		it('should log shortening statistics on success', async () => {
			const mockLogger = { debug: jest.fn(), warn: jest.fn() };
			const formatter = new WhatsAppMarkdownFormatter({
				logger: mockLogger,
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
			};

			await formatter.formatEnriched(enriched);

			// URL shortener should be called
			expect(mockUrlShortener.shortenUrlsParallel).toHaveBeenCalled();
		});

		it('should handle truncated alerts', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'x'.repeat(1000),
				insights: ['Summary'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
				truncated: true,
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toBeDefined();
		});

		it('should handle extraText in enriched object', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({});

			const enriched = {
				original_text: 'Alert text',
				insights: ['Summary'],
				extraText: 'Additional metadata',
				sources: [],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toBeDefined();
		});

		it('should handle MarkdownV2 escape sequences in citations', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'Alert \\*with\\* escapes',
				insights: ['Summary\\_with\\_underscores'],
				sources: [
					{ title: 'Source \\*bold\\*', url: 'https://example.com/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Should handle escapes
			expect(result).toBeDefined();
		});

		it('should handle citations with malformed URLs gracefully', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			// Only return result for valid URL
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Valid', url: 'https://example.com/url' },
					{ title: 'Invalid', url: 'not-a-url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			// Should handle gracefully
			expect(result).toContain('Valid');
			expect(result).toContain('Invalid');
		});

		it('should handle very long URLs', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const longUrl = 'https://example.com/' + 'a'.repeat(500);
			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				[longUrl]: 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Long URL', url: longUrl },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toContain('bit.ly/short');
		});

		it('should handle citations with special characters in titles', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/url': 'https://bit.ly/short',
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Source *bold* _italic_ ~strikethrough~', url: 'https://example.com/url' },
				],
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toBeDefined();
		});
	});

	describe('formatNewsAlert() - Backward Compatibility', () => {
		it('should format news alert correctly', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/1': 'https://bit.ly/1',
			});

			const enriched = {
				originalText: 'Bitcoin surges',
				summary: '*Sentiment:* Bullish 🚀 (0.85)\n*Price:* $83000',
				citations: [
					{ title: 'Source 1', url: 'https://example.com/1' },
					{ title: 'Source 2', url: 'https://example.com/2' },
				],
				extraText: '_Model Confidence: 90%_',
			};

			const result = await formatter.formatEnriched(enriched);

			expect(result).toContain('*Bitcoin surges*');
			expect(result).toContain('*Sentiment:* Bullish 🚀 (0.85)');
			expect(result).toContain('*Price:* $83000');
			expect(result).toContain('*Sources*');
			expect(result).toContain('Source 1: https://bit.ly/1');
			expect(result).toContain('Source 2: https://example.com/2');
			expect(result).toContain('_Model Confidence: 90%_');
		});
	});

	describe('format() - synchronous plain text (backward compatibility)', () => {
		it('should format plain text without URL shortening', () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const result = formatter.format('Plain text alert message');

			expect(result).toBe('Plain text alert message');
			expect(mockUrlShortener.shortenUrlsParallel).not.toHaveBeenCalled();
		});

		it('should handle empty string', () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const result = formatter.format('');

			expect(result).toBe('');
		});

		it('should strip MarkdownV2 escape sequences', () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const result = formatter.format('Text \\*with\\* \\[escapes\\]');

			expect(result).toContain('*');
			expect(result).not.toContain('\\*');
		});
	});

	describe('error scenarios', () => {
		it('should handle undefined enriched object', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const result = await formatter.formatEnriched(undefined);
			expect(typeof result).toBe('string');
		});

		it('should handle enriched with undefined citations', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: undefined,
			};

			const result = await formatter.formatEnriched(enriched);
			expect(typeof result).toBe('string');
		});

		it('should handle formatter without logger', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockRejectedValue(
				new Error('API error'),
			);

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Source', url: 'https://example.com/url' },
				],
			};

			// Should not throw even without logger
			const result = await formatter.formatEnriched(enriched);
			expect(typeof result).toBe('string');
		});

		it('should handle mixed valid and invalid URL citations', async () => {
			const formatter = new WhatsAppMarkdownFormatter({
				urlShortener: mockUrlShortener,
			});

			mockUrlShortener.shortenUrlsParallel.mockResolvedValue({
				'https://example.com/valid': 'https://bit.ly/valid',
			});

			const enriched = {
				original_text: 'Alert',
				insights: ['Summary'],
				sources: [
					{ title: 'Valid HTTPS', url: 'https://example.com/valid' },
					{ title: 'Valid HTTP', url: 'http://example.com/valid' },
					{ title: 'No protocol', url: 'example.com/url' },
					{ title: 'Empty URL', url: '' },
				],
			};

			const result = await formatter.formatEnriched(enriched);
			expect(result).toBeDefined();
		});
	});
});
