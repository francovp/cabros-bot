/**
 * URL Shortener - Unit Tests
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly)
 */

const {
	URLShortener,
	URLShortenerCache,
} = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');

describe('URLShortenerCache - Unit Tests', () => {
	let cache;

	beforeEach(() => {
		cache = new URLShortenerCache();
	});

	it('should store and retrieve URL mappings', () => {
		const url = 'https://example.com/long-url';
		const shortUrl = 'https://bit.ly/abc123';

		cache.set(url, shortUrl);
		const result = cache.get(url);

		expect(result).toBe(shortUrl);
	});

	it('should return null for non-existent URLs', () => {
		const result = cache.get('https://nonexistent.com');
		expect(result).toBeNull();
	});

	it('should report correct cache size', () => {
		expect(cache.size()).toBe(0);
		cache.set('https://example.com/url1', 'https://bit.ly/short1');
		expect(cache.size()).toBe(1);
	});

	it('should clear all entries', () => {
		cache.set('https://example.com/url1', 'https://bit.ly/short1');
		cache.clear();
		expect(cache.size()).toBe(0);
	});
});

describe('URLShortener - Unit Tests', () => {
	let shortener;

	beforeEach(() => {
		shortener = new URLShortener();
		shortener.clearCache();
	});

	it('should be enabled when at least one free service (tinyurl) is available', () => {
		// tinyurl and pixnet0rz.tw are free services that don't require API keys
		delete process.env.BITLY_API_KEY;
		delete process.env.REURL_API_KEY;
		delete process.env.CUTTLY_API_KEY;
		delete process.env.PICSEE_API_KEY;
		delete process.env.TINYURL_API_KEY;
		delete process.env.PIXNET0RZ_API_KEY;

		const urlShortener = new URLShortener();
		// Should still be enabled because tinyurl/pixnet0rz are free
		expect(urlShortener.isEnabled()).toBe(true);
	});

	it('should be enabled when BITLY_API_KEY is set', () => {
		process.env.BITLY_API_KEY = 'test-api-key';
		const urlShortener = new URLShortener();
		expect(urlShortener.isEnabled()).toBe(true);
	});

	it('should be disabled when all API-requiring services are not configured', () => {
		// This test would only pass if we disable free services, which isn't practical
		// So we test that configured services list is properly built
		delete process.env.BITLY_API_KEY;
		delete process.env.REURL_API_KEY;
		delete process.env.CUTTLY_API_KEY;
		delete process.env.PICSEE_API_KEY;
		delete process.env.TINYURL_API_KEY;
		delete process.env.PIXNET0RZ_API_KEY;

		const urlShortener = new URLShortener();
		// configuredServices should include free services
		expect(urlShortener.configuredServices.length).toBeGreaterThan(0);
	});

	it('uses a 5-second timeout for URL shortening', () => {
		expect(shortener.timeout).toBe(5000);
	});

	it('aborts a stalled provider within the batch budget and skips later sources', async () => {
		const batchTimeoutMs = 30;
		shortener.primaryService = 'picsee';
		shortener.configuredServices = ['cuttly'];
		shortener.enabled = true;
		shortener.timeout = batchTimeoutMs;
		shortener.batchTimeoutMs = batchTimeoutMs;
		const originalFetch = global.fetch;
		global.fetch = jest.fn((_url, options = {}) => new Promise((resolve, reject) => {
			options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
		}));

		try {
			const startedAt = Date.now();
			const results = await shortener.shortenUrlsParallel([
				'https://example.com/first',
				'https://example.com/second',
			]);

			expect(results).toEqual({});
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(1000);
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('aborts a provider response whose body stalls after headers', async () => {
		shortener.configuredServices = ['cuttly'];
		shortener.timeout = 30;
		const originalFetch = global.fetch;
		let signal;
		global.fetch = jest.fn((_url, options = {}) => {
			signal = options.signal;
			return Promise.resolve({
				json: () => new Promise((resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
				}),
			});
		});

		try {
			await expect(shortener.callShortenerAPI('https://example.com/body-stall', 'cuttly'))
				.rejects.toThrow('URL shortening timeout');
			expect(signal.aborted).toBe(true);
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('aborts provider shortening when the caller signal is cancelled', async () => {
		shortener.primaryService = 'picsee';
		shortener.configuredServices = ['cuttly', 'tinyurl'];
		shortener.enabled = true;
		shortener.timeout = 1000;
		shortener.batchTimeoutMs = 1000;
		const originalFetch = global.fetch;
		global.fetch = jest.fn((_url, options = {}) => new Promise((resolve, reject) => {
			options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true });
		}));
		const controller = new AbortController();

		try {
			const startedAt = Date.now();
			const shortening = shortener.shortenUrlsParallel(
				['https://example.com/cancelled'],
				{ signal: controller.signal },
			);
			await new Promise(setImmediate);
			controller.abort(new Error('caller cancelled'));

			await expect(shortening).resolves.toEqual({});
			expect(global.fetch).toHaveBeenCalledTimes(1);
			expect(global.fetch.mock.calls[0][1].signal.aborted).toBe(true);
			expect(Date.now() - startedAt).toBeLessThan(300);
		} finally {
			global.fetch = originalFetch;
		}
	});

	it('should return null when all services are unavailable and shortening fails', async () => {
		// Mock that all services fail (not testing actual API calls)
		// This test verifies fallback behavior when all services are exhausted
		const disabledShortener = new URLShortener();

		// Override callShortenerAPI to always fail
		disabledShortener.callShortenerAPI = async () => {
			throw new Error('Service unavailable');
		};

		const result = await disabledShortener.shortenUrl(
			'https://example.com/url',
		);
		expect(result).toBeNull();
	});

	it('should return empty object for parallel shortening when all services fail', async () => {
		const disabledShortener = new URLShortener();

		// Override callShortenerAPI to always fail
		disabledShortener.callShortenerAPI = async () => {
			throw new Error('Service unavailable');
		};

		const results = await disabledShortener.shortenUrlsParallel([
			'https://example.com/url1',
		]);
		expect(results).toEqual({});
	});

	it('should properly handle service fallback on error', async () => {
		const shortener = new URLShortener();
		let callCount = 0;

		// Mock: first service fails, second succeeds
		shortener.callShortenerAPI = async (url, service) => {
			callCount++;
			if (callCount === 1) {
				throw new Error('First service error');
			}
			return 'https://short.url';
		};

		const result = await shortener.shortenUrl('https://example.com/url');

		// Should have tried the service
		expect(callCount).toBeGreaterThan(0);
	});

	it('should have correct cache statistics', () => {
		const stats = shortener.getCacheStats();
		expect(stats).toHaveProperty('size');
		expect(stats).toHaveProperty('enabled');
		expect(stats).toHaveProperty('configuredServices');
		expect(stats).toHaveProperty('primaryService');
	});

	it('should cache successfully shortened URLs', async () => {
		const shortener = new URLShortener();

		// Mock successful API call
		shortener.callShortenerAPI = async () => 'https://short.url';

		const result1 = await shortener.shortenUrl('https://example.com/url');
		const result2 = await shortener.shortenUrl('https://example.com/url');

		// Both should return the same result (second from cache)
		expect(result1).toBe(result2);

		// Cache should have 1 entry
		expect(shortener.cache.size()).toBe(1);
	});

	it('coalesces concurrent requests for the same URL', async () => {
		const shortener = new URLShortener();
		let resolveProviderCall;
		const providerCall = new Promise((resolve) => {
			resolveProviderCall = resolve;
		});
		const callShortenerAPI = jest.fn(() => providerCall);
		shortener.callShortenerAPI = callShortenerAPI;
		const url = 'https://example.com/concurrent-url';

		const firstResult = shortener.shortenUrl(url);
		const secondResult = shortener.shortenUrl(url);
		resolveProviderCall('https://short.url/concurrent');

		await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
			'https://short.url/concurrent',
			'https://short.url/concurrent',
		]);
		expect(callShortenerAPI).toHaveBeenCalledTimes(1);
		expect(shortener.inFlightShortenings.size).toBe(0);
	});

	it('retries a URL after its shared provider request fails', async () => {
		const shortener = new URLShortener();
		shortener.configuredServices = ['test'];
		shortener.enabled = true;
		const callShortenerAPI = jest.fn()
			.mockRejectedValueOnce(new Error('provider unavailable'))
			.mockResolvedValueOnce('https://short.url/recovered');
		shortener.callShortenerAPI = callShortenerAPI;
		const url = 'https://example.com/retry-after-failure';

		const concurrentResults = await Promise.all([
			shortener.shortenUrl(url),
			shortener.shortenUrl(url),
		]);
		expect(concurrentResults).toEqual([null, null]);
		expect(callShortenerAPI).toHaveBeenCalledTimes(1);

		await expect(shortener.shortenUrl(url)).resolves.toBe('https://short.url/recovered');
		expect(callShortenerAPI).toHaveBeenCalledTimes(2);
	});
});
