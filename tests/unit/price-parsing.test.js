/**
 * Unit tests for price parsing from Gemini search results
 * Tests the parsePriceFromSearchResult method in analyzer.js
 */

const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

describe('Price Parsing from Search Results', () => {
	let analyzer;

	beforeEach(() => {
		analyzer = new NewsAnalyzer();
	});

	describe('parsePriceFromSearchResult', () => {
		it('should parse price in format $123.45', () => {
			const searchText = 'Bitcoin price today is $67,450.50 USD';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.price).toBe(67450.5);
		});

		it('should parse price in format 123.45 USD', () => {
			const searchText = 'Ethereum current price: 3,456.78 USD';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'ETHUSD');
			expect(result.price).toBe(3456.78);
		});

		it('should parse 24h change in format +5.2%', () => {
			const searchText = 'Bitcoin up +5.2% in the last 24 hours';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.change24h).toBe(5.2);
		});

		it('should parse 24h change in format -2.1%', () => {
			const searchText = 'Stock NVDA down -2.1% today';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'NVDA');
			expect(result.change24h).toBe(-2.1);
		});

		it('should parse both price and 24h change together', () => {
			const searchText = 'Bitcoin at $68,000 USD is up +3.5% in 24h trading';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.price).toBe(68000);
			expect(result.change24h).toBe(3.5);
		});

		it('should handle multiple prices and return first one', () => {
			const searchText = '$1,000 offer and Bitcoin is $67,500 right now';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			// Returns first match
			expect(result.price).toBe(1000);
		});

		it('should return null for empty search text', () => {
			const result = analyzer.parsePriceFromSearchResult('', 'BTCUSDT');
			expect(result.price).toBeNull();
			expect(result.change24h).toBeNull();
		});

		it('should return null for non-string input', () => {
			const result = analyzer.parsePriceFromSearchResult(null, 'BTCUSDT');
			expect(result.price).toBeNull();
			expect(result.change24h).toBeNull();
		});

		it('should reject unrealistic prices (>1M)', () => {
			const searchText = 'Bitcoin price error: $1,234,567.89';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.price).toBeNull(); // Out of range
		});

		it('should reject zero or negative prices', () => {
			const searchText = 'Bitcoin lost all value: $0.00';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.price).toBeNull();
		});

		it('should reject 24h changes >100%', () => {
			const searchText = 'Meme coin up 250% today';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'MEME');
			expect(result.change24h).toBeNull(); // Out of range
		});

		it('should parse decimal changes like 0.5%', () => {
			const searchText = 'Stock gained 0.5% today';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'AAPL');
			expect(result.change24h).toBe(0.5);
		});

		it('should handle complex real-world snippet', () => {
			const searchText = `
				Bitcoin Price Today
				Bitcoin is currently trading at $67,890.23 USD
				24h Change: +2.5%
				Market Cap: $1.3T
				Volume: $45.2B
			`;
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.price).toBe(67890.23);
			expect(result.change24h).toBe(2.5);
		});

		it('should parse prices with commas', () => {
			const searchText = 'Stock NVDA trading at $1,234.56';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'NVDA');
			expect(result.price).toBe(1234.56);
		});

		it('should handle no matches gracefully', () => {
			const searchText = 'Some random text with no financial data';
			const result = analyzer.parsePriceFromSearchResult(searchText, 'BTCUSDT');
			expect(result.price).toBeNull();
			expect(result.change24h).toBeNull();
		});
	});
});
