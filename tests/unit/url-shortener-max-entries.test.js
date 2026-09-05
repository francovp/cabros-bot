/**
 * Unit Tests for URLShortener / URLShortenerCache Max Entries
 * Covers issue #689: bound in-memory growth of URL shortener caches
 */

const { URLShortener, URLShortenerCache } = require('../../src/controllers/webhooks/handlers/newsMonitor/urlShortener');

describe('URLShortenerCache - Max Entries / LRU', () => {
	describe('bounded by maxEntries', () => {
		let cache;

		beforeEach(() => {
			cache = new URLShortenerCache({ maxEntries: 3 });
		});

		it('respects the configured maxEntries cap', () => {
			cache.set('https://example.com/a', 'https://bit.ly/a');
			cache.set('https://example.com/b', 'https://bit.ly/b');
			cache.set('https://example.com/c', 'https://bit.ly/c');
			expect(cache.size()).toBe(3);

			cache.set('https://example.com/d', 'https://bit.ly/d');
			expect(cache.size()).toBe(3);
			expect(cache.evictionCount).toBeGreaterThanOrEqual(1);
		});

		it('exposes getStats() with size + maxEntries + evictionCount', () => {
			const stats = cache.getStats();
			expect(stats.size).toBe(0);
			expect(stats.maxEntries).toBe(3);
			expect(stats.evictionCount).toBe(0);
		});

		it('evicts the oldest inserted entry first', () => {
			cache.set('https://example.com/old', 'https://bit.ly/old');
			cache.set('https://example.com/mid', 'https://bit.ly/mid');
			cache.set('https://example.com/new', 'https://bit.ly/new');

			cache.set('https://example.com/evict', 'https://bit.ly/evict');

			expect(cache.get('https://example.com/old')).toBeNull();
			expect(cache.get('https://example.com/mid')).toBe('https://bit.ly/mid');
			expect(cache.get('https://example.com/new')).toBe('https://bit.ly/new');
			expect(cache.get('https://example.com/evict')).toBe('https://bit.ly/evict');
		});
	});

	describe('env var fallback', () => {
		const originalMax = process.env.URL_SHORTENER_CACHE_MAX_ENTRIES;

		afterEach(() => {
			if (originalMax === undefined) {
				delete process.env.URL_SHORTENER_CACHE_MAX_ENTRIES;
			} else {
				process.env.URL_SHORTENER_CACHE_MAX_ENTRIES = originalMax;
			}
		});

		it('defaults to 1000 when env var is missing', () => {
			delete process.env.URL_SHORTENER_CACHE_MAX_ENTRIES;
			const cache = new URLShortenerCache();
			expect(cache.maxEntries).toBe(1000);
		});

		it('parses valid env override', () => {
			process.env.URL_SHORTENER_CACHE_MAX_ENTRIES = '500';
			const cache = new URLShortenerCache();
			expect(cache.maxEntries).toBe(500);
		});

		it('falls back to default on malformed env override', () => {
			process.env.URL_SHORTENER_CACHE_MAX_ENTRIES = 'garbage';
			const cache = new URLShortenerCache();
			expect(cache.maxEntries).toBe(1000);
		});
	});
});

describe('URLShortener.serviceFailures size bound', () => {
	const originalMax = process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES;
	let shortener;

	beforeEach(() => {
		shortener = new URLShortener();
	});

	afterEach(() => {
		if (originalMax === undefined) {
			delete process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES;
		} else {
			process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES = originalMax;
		}
	});

	it('defaults to 32 entries', () => {
		expect(shortener._serviceFailuresMaxEntries).toBe(32);
	});

	it('respects the configured cap via env var', () => {
		process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES = '4';
		const localShortener = new URLShortener();
		expect(localShortener._serviceFailuresMaxEntries).toBe(4);

		for (let i = 0; i < 10; i += 1) {
			localShortener.recordServiceFailure(`svc-${i}`);
		}
		expect(localShortener.serviceFailures.size).toBeLessThanOrEqual(4);
		expect(localShortener._serviceFailureEvictionCount).toBeGreaterThanOrEqual(1);
	});

	it('exposes serviceFailuresStats for status reporting', () => {
		const stats = shortener.serviceFailuresStats;
		expect(stats.size).toBe(0);
		expect(stats.maxEntries).toBeGreaterThan(0);
		expect(stats.evictionCount).toBe(0);
	});

	it('falls back to default on malformed env override', () => {
		process.env.URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES = 'garbage';
		const localShortener = new URLShortener();
		expect(localShortener._serviceFailuresMaxEntries).toBe(32);
	});

	it('allows explicit constructor options to override runtime config', () => {
		const localShortener = new URLShortener({ serviceFailuresMaxEntries: 10 });
		expect(localShortener.serviceFailuresMaxEntries).toBe(10);
		expect(localShortener._serviceFailuresMaxEntries).toBe(10);
	});
});