/**
 * URL Shortener - Unit Tests
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly)
 */

const {
  URLShortener,
  URLShortenerCache,
} = require("../../src/controllers/webhooks/handlers/newsMonitor/urlShortener");

describe("URLShortenerCache - Unit Tests", () => {
  let cache;

  beforeEach(() => {
    cache = new URLShortenerCache();
  });

  it("should store and retrieve URL mappings", () => {
    const url = "https://example.com/long-url";
    const shortUrl = "https://bit.ly/abc123";

    cache.set(url, shortUrl);
    const result = cache.get(url);

    expect(result).toBe(shortUrl);
  });

  it("should return null for non-existent URLs", () => {
    const result = cache.get("https://nonexistent.com");
    expect(result).toBeNull();
  });

  it("should report correct cache size", () => {
    expect(cache.size()).toBe(0);
    cache.set("https://example.com/url1", "https://bit.ly/short1");
    expect(cache.size()).toBe(1);
  });

  it("should clear all entries", () => {
    cache.set("https://example.com/url1", "https://bit.ly/short1");
    cache.clear();
    expect(cache.size()).toBe(0);
  });
});

describe("URLShortener - Unit Tests", () => {
  let shortener;

  beforeEach(() => {
    shortener = new URLShortener();
    shortener.clearCache();
  });

  it("should be disabled when BITLY_API_KEY is not set", () => {
    delete process.env.BITLY_API_KEY;
    const urlShortener = new URLShortener();
    expect(urlShortener.isEnabled()).toBe(false);
  });

  it("should be enabled when BITLY_API_KEY is set", () => {
    process.env.BITLY_API_KEY = "test-api-key";
    const urlShortener = new URLShortener();
    expect(urlShortener.isEnabled()).toBe(true);
  });

  it("should have 5 second timeout", () => {
    expect(shortener.timeout).toBe(5000);
  });

  it("should return null when shortening disabled", async () => {
    delete process.env.BITLY_API_KEY;
    const disabledShortener = new URLShortener();
    const result = await disabledShortener.shortenUrl(
      "https://example.com/url"
    );
    expect(result).toBeNull();
  });

  it("should return empty object for parallel shortening when disabled", async () => {
    delete process.env.BITLY_API_KEY;
    const disabledShortener = new URLShortener();
    const results = await disabledShortener.shortenUrlsParallel([
      "https://example.com/url1",
    ]);
    expect(results).toEqual({});
  });

  it("should have correct cache statistics", () => {
    const stats = shortener.getCacheStats();
    expect(stats).toHaveProperty("size");
    expect(stats).toHaveProperty("enabled");
  });
});
