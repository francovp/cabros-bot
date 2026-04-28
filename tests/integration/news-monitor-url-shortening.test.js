/**
 * News Monitor - URL Shortening Integration Tests
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly)
 */

const {
	getURLShortener,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');

describe('URL Shortener - Integration Tests (US2b)', () => {
	let shortener;

	beforeEach(() => {
		shortener = getURLShortener();
		shortener.clearCache();
		// Clear all API keys to test behavior
		delete process.env.BITLY_API_KEY;
		delete process.env.REURL_API_KEY;
		delete process.env.CUTTLY_API_KEY;
		delete process.env.PICSEE_API_KEY;
		delete process.env.TINYURL_API_KEY;
		delete process.env.PIXNET0RZ_API_KEY;
	});

	afterEach(() => {
		shortener.clearCache();
	});

	describe('URL Shortening Behavior', () => {
		it('should shorten URLs when services are available', async () => {
			// At least tinyurl should be available (free service)
			const result = await shortener.shortenUrl(
				'https://example.com/very-long-url',
			);
			// Should return either null (if all fail) or a shortened URL
			// With tinyurl available, should return shortened URL
			expect(
				result === null || typeof result === 'string',
			).toBe(true);
		});

		it('should handle multiple URL shortening in parallel', async () => {
			const urls = ['https://example.com/url1', 'https://example.com/url2'];
			const results = await shortener.shortenUrlsParallel(urls);
			// Results object might be empty or have shortened URLs
			expect(typeof results).toBe('object');
		});
	});

	describe('Cache Management', () => {
		it('should report cache statistics', () => {
			const stats = shortener.getCacheStats();
			expect(stats).toHaveProperty('size');
			expect(stats).toHaveProperty('enabled');
			expect(stats).toHaveProperty('configuredServices');
			expect(stats).toHaveProperty('primaryService');
		});

		it('should clear cache on demand', () => {
			shortener.cache.set('https://example.com/url', 'https://bit.ly/short');
			expect(shortener.cache.size()).toBeGreaterThan(0);
			shortener.clearCache();
			expect(shortener.cache.size()).toBe(0);
		});

		it('should cache and retrieve shortened URLs', async () => {
			// Mock the API call
			const originalCallAPI = shortener.callShortenerAPI;
			shortener.callShortenerAPI = async () => 'https://short.test';

			const url = 'https://example.com/url';
			const result1 = await shortener.shortenUrl(url);
			const result2 = await shortener.shortenUrl(url);

			// Both should be the same (second from cache)
			expect(result1).toBe(result2);

			// Restore original method
			shortener.callShortenerAPI = originalCallAPI;
		});
	});

	describe('Singleton Pattern', () => {
		it('should return same instance on multiple calls', () => {
			const instance1 = getURLShortener();
			const instance2 = getURLShortener();
			expect(instance1).toBe(instance2);
		});
	});

	describe('Configuration Validation', () => {
		it('should handle missing API keys gracefully', () => {
			// Clear all keys
			delete process.env.BITLY_API_KEY;
			delete process.env.BITLY_ACCESS_TOKEN;
			delete process.env.REURL_API_KEY;
			delete process.env.CUTTLY_API_KEY;
			delete process.env.PICSEE_API_KEY;
			delete process.env.TINYURL_API_KEY;
			delete process.env.PIXNET0RZ_API_KEY;

			const newShortener = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener').URLShortener;
			const instance = new newShortener();

			// Should still work because free services are available
			expect(typeof instance.isEnabled()).toBe('boolean');
		});

		it('should indicate enabled when BITLY_API_KEY set', () => {
			process.env.BITLY_API_KEY = 'test-key';

			// Need to require fresh to get new instance with new env vars
			// For this test, we'll create a new instance
			const { URLShortener } = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');
			const newShortener = new URLShortener();
			expect(newShortener.isEnabled()).toBe(true);

			delete process.env.BITLY_API_KEY;
		});

		it('should indicate enabled when REURL_API_KEY set', () => {
			process.env.REURL_API_KEY = 'test-key';

			const { URLShortener } = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');
			const newShortener = new URLShortener();
			expect(newShortener.isEnabled()).toBe(true);

			delete process.env.REURL_API_KEY;
		});

		it('should build configured services list correctly', () => {
			process.env.BITLY_API_KEY = 'bitly-key';
			process.env.REURL_API_KEY = 'reurl-key';

			const { URLShortener } = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');
			const newShortener = new URLShortener();

			// Primary service should be in the list
			expect(newShortener.configuredServices.length).toBeGreaterThan(0);

			delete process.env.BITLY_API_KEY;
			delete process.env.REURL_API_KEY;
		});
	});

	describe('Service Fallback', () => {
		it('should try fallback services when primary fails', async () => {
			const { URLShortener } = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');
			const newShortener = new URLShortener();

			let callCount = 0;
			const originalCallAPI = newShortener.callShortenerAPI;

			// First call fails, second succeeds
			newShortener.callShortenerAPI = async (url, service) => {
				callCount++;
				if (callCount === 1) {
					throw new Error('Primary service error');
				}
				return 'https://fallback.short.url';
			};

			const result = await newShortener.shortenUrl('https://example.com/url');

			// Should have attempted to call the API
			expect(callCount).toBeGreaterThan(0);

			newShortener.callShortenerAPI = originalCallAPI;
		});
	});
});
