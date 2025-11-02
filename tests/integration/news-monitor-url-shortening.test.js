/**
 * News Monitor - URL Shortening Integration Tests
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly)
 */

const {
  getURLShortener,
} = require("../../src/controllers/webhooks/handlers/newsMonitor/urlShortener");

describe("URL Shortener - Integration Tests (US2b)", () => {
  let shortener;

  beforeEach(() => {
    shortener = getURLShortener();
    shortener.clearCache();
    delete process.env.BITLY_API_KEY;
  });

  afterEach(() => {
    shortener.clearCache();
  });

  describe("URL Shortening Disabled", () => {
    it("should return null when shortening disabled", async () => {
      const result = await shortener.shortenUrl(
        "https://example.com/very-long-url"
      );
      expect(result).toBeNull();
    });

    it("should return empty object when disabled", async () => {
      const urls = ["https://example.com/url1", "https://example.com/url2"];
      const results = await shortener.shortenUrlsParallel(urls);
      expect(results).toEqual({});
    });
  });

  describe("Cache Management", () => {
    it("should report cache statistics", () => {
      const stats = shortener.getCacheStats();
      expect(stats).toHaveProperty("size");
      expect(stats).toHaveProperty("enabled");
    });

    it("should clear cache on demand", () => {
      shortener.cache.set("https://example.com/url", "https://bit.ly/short");
      expect(shortener.cache.size()).toBeGreaterThan(0);
      shortener.clearCache();
      expect(shortener.cache.size()).toBe(0);
    });
  });

  describe("Singleton Pattern", () => {
    it("should return same instance on multiple calls", () => {
      const instance1 = getURLShortener();
      const instance2 = getURLShortener();
      expect(instance1).toBe(instance2);
    });
  });

  describe("Configuration Validation", () => {
    it("should indicate disabled when BITLY_API_KEY not set", () => {
      delete process.env.BITLY_API_KEY;
      const newShortener =
        new (require("../../src/controllers/webhooks/handlers/newsMonitor/urlShortener").URLShortener)();
      expect(newShortener.isEnabled()).toBe(false);
    });

    it("should indicate enabled when BITLY_API_KEY set", () => {
      process.env.BITLY_API_KEY = "test-key";
      const newShortener =
        new (require("../../src/controllers/webhooks/handlers/newsMonitor/urlShortener").URLShortener)();
      expect(newShortener.isEnabled()).toBe(true);
    });
  });
});
