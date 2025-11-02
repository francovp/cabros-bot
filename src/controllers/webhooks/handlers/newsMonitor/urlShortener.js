/**
 * URL Shortener Utility for WhatsApp Citations
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly)
 */

const { sendWithRetry } = require("../../../../lib/retryHelper");

/**
 * URLShortenerCache - Session-scoped in-memory cache
 */
class URLShortenerCache {
  constructor() {
    this.cache = new Map();
    this.ttlMs = 60 * 60 * 1000; // 1 hour session cache
  }

  get(url) {
    const entry = this.cache.get(url);
    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(url);
      return null;
    }

    return entry.shortUrl;
  }

  set(url, shortUrl) {
    this.cache.set(url, {
      shortUrl,
      timestamp: Date.now(),
    });
  }

  clear() {
    this.cache.clear();
  }

  size() {
    return this.cache.size;
  }
}

/**
 * URLShortener - Handles URL shortening via Bitly API
 */
class URLShortener {
  constructor() {
    this.enabled = !!process.env.BITLY_API_KEY;
    this.apiKey = process.env.BITLY_API_KEY;
    this.timeout = 5000; // 5s timeout per call
    this.cache = new URLShortenerCache();

    if (this.enabled) {
      console.debug("[URLShortener] Initialized with Bitly API key");
    } else {
      console.debug("[URLShortener] Disabled - BITLY_API_KEY not configured");
    }
  }

  /**
   * Check if URL shortening is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Shorten a single URL using Bitly API
   */
  async shortenUrl(longUrl) {
    if (!this.enabled) {
      return null;
    }

    // Check cache first
    const cached = this.cache.get(longUrl);
    if (cached) {
      console.debug(
        "[URLShortener] Cache hit for URL:",
        longUrl.substring(0, 50)
      );
      return cached;
    }

    try {
      // Call Bitly API with retry logic
      // Wrap in format expected by sendWithRetry: { success: boolean, data?: string, error?: string }
      const result = await sendWithRetry(
        async () => {
          try {
            const url = await this.callBitlyAPI(longUrl);
            return { success: true, data: url };
          } catch (error) {
            return { success: false, error: error.message };
          }
        },
        3,
        console
      );

      if (!result.success) {
        console.warn("[URLShortener] Failed after retries:", result.error);
        return null;
      }

      const shortUrl = result.data;
      // Store in cache
      this.cache.set(longUrl, shortUrl);
      console.debug("[URLShortener] Successfully shortened URL");

      return shortUrl;
    } catch (error) {
      console.warn("[URLShortener] Failed to shorten URL:", error.message);
      return null;
    }
  }

  /**
   * Make HTTPS request to Bitly API
   */
  async callBitlyAPI(longUrl) {
    const https = require("https");

    return new Promise((resolve, reject) => {
      const postData = JSON.stringify({
        long_url: longUrl,
        domain: "bit.ly",
      });

      const options = {
        hostname: "api-ssl.bitly.com",
        path: "/v4/shorten",
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(postData),
        },
        timeout: this.timeout,
      };

      const req = https.request(options, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) {
              reject(
                new Error(`HTTP ${res.statusCode}: ${json.description || data}`)
              );
            } else if (json.link) {
              resolve(json.link);
            } else {
              reject(new Error("No link in response"));
            }
          } catch (e) {
            reject(new Error(`Failed to parse response: ${e.message}`));
          }
        });
      });

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });

      req.on("error", (err) => {
        reject(err);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Shorten multiple URLs in parallel
   */
  async shortenUrlsParallel(urls) {
    if (!this.enabled || !urls || urls.length === 0) {
      return {};
    }

    const results = {};
    const promises = urls.map(async (url) => {
      try {
        const shortUrl = await this.shortenUrl(url);
        if (shortUrl) {
          results[url] = shortUrl;
        }
      } catch (error) {
        console.warn("[URLShortener] Failed to shorten parallel URL");
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  /**
   * Get cache statistics
   */
  getCacheStats() {
    return {
      size: this.cache.size(),
      enabled: this.enabled,
    };
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.cache.clear();
    console.debug("[URLShortener] Cache cleared");
  }
}

// Singleton instance
let instance = null;

function getURLShortener() {
  if (!instance) {
    instance = new URLShortener();
  }
  return instance;
}

module.exports = {
  getURLShortener,
  URLShortener,
  URLShortenerCache,
};
