/**
 * News Alert Formatting Tests
 * Verifies that news alert sources are formatted as markdown links with titles
 * instead of raw URLs
 */

const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

describe('News Alert Source Formatting', () => {
	let analyzer;

	beforeEach(() => {
		analyzer = new NewsAnalyzer();
	});

	describe('formatAlertMessage with SearchResult objects', () => {
		it('should format sources as markdown links with titles', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Meta stock surges on strong earnings',
				sentiment_score: 0.8,
				confidence: 0.85,
				sources: [
					{
						title: 'Bloomberg - Meta Stock Soars',
						url: 'https://bloomberg.com/meta-stock',
					},
					{
						title: 'Reuters Markets',
						url: 'https://reuters.com/markets/meta',
					},
					{
						title: 'CNBC Tech News',
						url: 'https://cnbc.com/tech/meta',
					},
				],
			};

			const message = analyzer.formatAlertMessage('META', analysis, {
				price: 350.5,
				change24h: 5.2,
			});

			// Verify markdown link format (with escaped special characters for MarkdownV2)
			expect(message).toContain('[Bloomberg \\- Meta Stock Soars](https://bloomberg.com/meta-stock)');
			expect(message).toContain('[Reuters Markets](https://reuters.com/markets/meta)');
			expect(message).toContain('[CNBC Tech News](https://cnbc.com/tech/meta)');

			// Verify no raw URLs are shown without markdown link format
			expect(message).not.toContain('https://bloomberg.com/meta-stock |');
			expect(message).not.toContain('| https://reuters.com/markets/meta');

			// Verify proper formatting
			expect(message).toContain('Sources:');
			expect(message).toContain(' | ');

			console.log('Formatted message:\n', message);
		});

		it('should handle backward compatibility with plain URLs', () => {
			const analysis = {
				event_category: 'regulatory',
				headline: 'Regulatory announcement',
				sentiment_score: 0.0,
				confidence: 0.6,
				sources: [
					'https://example.com/source1',
					'https://example.com/source2',
				],
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Should handle plain URLs gracefully
			expect(message).toContain('https://example.com/source1');
			expect(message).toContain('https://example.com/source2');
		});

		it('should limit displayed sources to 3', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Big move',
				sentiment_score: 0.5,
				confidence: 0.7,
				sources: [
					{ title: 'Source 1', url: 'https://example.com/1' },
					{ title: 'Source 2', url: 'https://example.com/2' },
					{ title: 'Source 3', url: 'https://example.com/3' },
					{ title: 'Source 4', url: 'https://example.com/4' },
					{ title: 'Source 5', url: 'https://example.com/5' },
				],
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Verify only first 3 sources are shown (note: numbers are escaped for MarkdownV2)
			expect(message).toContain('[Source \\1]');
			expect(message).toContain('[Source \\2]');
			expect(message).toContain('[Source \\3]');
			expect(message).not.toContain('[Source \\4]');
			expect(message).not.toContain('[Source \\5]');
		});

		it('should format complete alert message with all components', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Major bullish news drives market surge',
				sentiment_score: 0.85,
				confidence: 0.9,
				sources: [
					{
						title: 'Financial Times',
						url: 'https://ft.com/markets/article',
					},
				],
			};

			const marketContext = {
				price: 150.75,
				change24h: 8.5,
			};

			const message = analyzer.formatAlertMessage('AAPL', analysis, marketContext);

			// Verify all components are present
			expect(message).toContain('*AAPL Alert*');
			expect(message).toContain('Event: Major bullish news drives market surge');
			expect(message).toContain('Sentiment: Bullish 🚀 (0.85)');
			expect(message).toContain('Confidence: 90%');
			expect(message).toContain('Price: $150.75 (+8.5%)');
			expect(message).toContain('[Financial Times](https://ft.com/markets/article)');
		});

		it('should handle missing sources gracefully', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Price move detected',
				sentiment_score: 0.6,
				confidence: 0.7,
				sources: [], // Empty array
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Should not have Sources line if empty
			expect(message).not.toContain('Sources:');
		});

		it('should handle undefined sources gracefully', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Price move detected',
				sentiment_score: 0.6,
				confidence: 0.7,
				// No sources property
			};

			const message = analyzer.formatAlertMessage('SYMBOL', analysis, null);

			// Should not error and should not have Sources line
			expect(message).toBeTruthy();
			expect(message).not.toContain('Sources:');
		});

		it('should escape special characters in source titles for MarkdownV2', () => {
			const analysis = {
				event_category: 'price_surge',
				headline: 'Important news',
				sentiment_score: 0.5,
				confidence: 0.7,
				sources: [
					{
						title: 'Market News (Updated)',
						url: 'https://example.com/news',
					},
				],
			};

			const message = analyzer.formatAlertMessage('TEST', analysis, null);

			// Title should have special characters escaped for MarkdownV2
			expect(message).toContain('Market News \\(Updated\\)');
			expect(message).toContain('https://example.com/news');
		});
	});
});
