/**
 * URL Shortener Utility for WhatsApp Citations
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly/TinyURL/PicSee/reurl/Cutt.ly/Pixnet0rz.tw)
 */

const { sendWithRetry } = require("../../../../lib/retryHelper");
const PrettyLink = require("prettylink");

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
 * URLShortener - Handles URL shortening via multiple services
 * Supports: Bitly, TinyURL, PicSee, reurl, Cutt.ly, Pixnet0rz.tw (via prettylink)
 */
class URLShortener {
  constructor() {
    this.service = (process.env.URL_SHORTENER_SERVICE || "bitly").toLowerCase();
    this.timeout = 5000; // 5s timeout per call
    this.cache = new URLShortenerCache();

    // Validate service
    this.validServices = [
      "bitly",
      "tinyurl",
      "picsee",
      "reurl",
      "cuttly",
      "pixnet0rz.tw",
    ];
    if (!this.validServices.includes(this.service)) {
      console.warn(
        `[URLShortener] Invalid service: ${this.service}, defaulting to bitly`
      );
      this.service = "bitly";
    }

    this.enabled = this.isServiceConfigured();

    if (this.enabled) {
      console.debug(
        `[URLShortener] Initialized with service: ${this.service}`
      );
    } else {
      console.debug(
        `[URLShortener] Disabled - ${this.getRequiredEnvVar()} not configured`
      );
    }
  }

  /**
   * Get required environment variable name(s) for current service
   */
  getRequiredEnvVar() {
    const envVarMap = {
      bitly: ["BITLY_ACCESS_TOKEN", "BITLY_API_KEY"], // Support both for backward compat
      tinyurl: ["TINYURL_API_KEY"],
      picsee: ["PICSEE_API_KEY"],
      reurl: ["REURL_API_KEY"],
      cuttly: ["CUTTLY_API_KEY"],
      "pixnet0rz.tw": ["PIXNET0RZ_API_KEY"],
    };
    return envVarMap[this.service] || ["API_KEY"];
  }

  /**
   * Check if service is properly configured with required API key
   */
  isServiceConfigured() {
    const envVars = this.getRequiredEnvVar();
    
    // Check if any of the env vars is set
    for (const envVar of envVars) {
      const value = process.env[envVar];
      if (value) {
        return true;
      }
    }

    // Some services might not require API keys initially
    if (
      this.service === "tinyurl" ||
      this.service === "picsee" ||
      this.service === "pixnet0rz.tw"
    ) {
      return true; // These may have default APIs
    }

    return false;
  }

  /**
   * Check if URL shortening is enabled
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Shorten a single URL using configured service
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
      const result = await sendWithRetry(
        async () => {
          try {
            const shortUrl = await this.callShortenerAPI(longUrl);
            return { success: true, data: shortUrl };
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
      console.debug(
        `[URLShortener] Successfully shortened URL via ${this.service}`
      );

      return shortUrl;
    } catch (error) {
      console.warn("[URLShortener] Failed to shorten URL:", error.message);
      return null;
    }
  }

  /**
   * Call URL shortener API using prettylink
   */
  async callShortenerAPI(longUrl) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("URL shortening timeout"));
      }, this.timeout);

      try {
        const prettyLink = new PrettyLink({
          service: this.service,
          apiKey: this.getAPIKey(),
        });

        prettyLink
          .shorten(longUrl)
          .then((shortUrl) => {
            clearTimeout(timeoutId);
            if (!shortUrl) {
              reject(new Error("Empty response from shortener"));
            } else {
              resolve(shortUrl);
            }
          })
          .catch((error) => {
            clearTimeout(timeoutId);
            reject(error);
          });
      } catch (error) {
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }

  /**
   * Get API key for current service (checks primary and fallback env vars)
   */
  getAPIKey() {
    const envVars = this.getRequiredEnvVar();
    
    // Try each env var in order
    for (const envVar of envVars) {
      const value = process.env[envVar];
      if (value) {
        return value;
      }
    }
    
    return "";
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
        console.warn(
          "[URLShortener] Failed to shorten parallel URL:",
          error.message
        );
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
      service: this.service,
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
