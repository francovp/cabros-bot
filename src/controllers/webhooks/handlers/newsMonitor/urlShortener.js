/**
 * URL Shortener Utility for WhatsApp Citations
 * 003-news-monitor: User Story 2b (WhatsApp URL shortening via Bitly/TinyURL/PicSee/reurl/Cutt.ly/Pixnet0rz.tw)
 */

const { sendWithRetry } = require("../../../../lib/retryHelper");
const Prettylink = require('prettylink');

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
    this.primaryService = (process.env.URL_SHORTENER_SERVICE || "reurl").toLowerCase();
    this.timeout = 60000; // 5s timeout per call
    this.cache = new URLShortenerCache();
    this.serviceFailures = new Map(); // Track consecutive failures per service

    // Validate service
    this.validServices = [
      "test",
      "bitly",
      "tinyurl",
      "picsee",
      "reurl",
      "cuttly",
      "pixnet0rz.tw",
    ];

    if (!this.validServices.includes(this.primaryService)) {
      console.warn(
        `[URLShortener] Invalid service: ${this.primaryService}, defaulting to reurl`
      );
      this.primaryService = "reurl";
    }

    // Build list of configured services in preferred order
    this.configuredServices = this.buildConfiguredServicesList();
    this.enabled = this.configuredServices.length > 0;
    
    if (!this.enabled) {
      console.warn("[URLShortener] No URL shortening services configured. URL shortening disabled.");
    }
  }

  /**
   * Get required environment variable names for each service
   */
  getRequiredEnvVars() {
    const envVarMap = {
      bitly: ["BITLY_ACCESS_TOKEN", "BITLY_API_KEY"],
      picsee: ["PICSEE_API_KEY"],
      reurl: ["REURL_API_KEY"],
      cuttly: ["CUTTLY_API_KEY"],
      "pixnet0rz.tw": ["PIXNET0RZ_API_KEY"],
    };
    return envVarMap;
  }

  /**
   * Build list of configured services, with primary service first
   */
  buildConfiguredServicesList() {
    const configured = [];
    const envVars = this.getRequiredEnvVars();

    // Add primary service first if configured
    if (this.isServiceConfigured(this.primaryService)) {
      configured.push(this.primaryService);
    }

    // Add other configured services as fallbacks
    for (const service of this.validServices) {
      if (service !== this.primaryService && this.isServiceConfigured(service)) {
        configured.push(service);
      }
    }

    return configured;
  }

  /**
   * Check if service is properly configured with required API key
   */
  isServiceConfigured(service) {
    const envVars = this.getRequiredEnvVars();
    const envVarKeys = envVars[service];
    
    if (!envVarKeys) {
      // Some services don't require API keys
      if (service === "tinyurl" || service === "pixnet0rz.tw" || service === "test") {
        return true; // These have free/open APIs
      }
    }

    // Check if at least one env var is defined for the service
    for (const envVar of envVarKeys) {
      if (process.env[envVar]) {
        return true;
      }
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
   * Get API key for a service (checks primary and fallback env vars)
   */
  getAPIKey(service) {
    const envVars = this.getRequiredEnvVars();
    const envVarKeys = envVars[service];
    
    if (!envVarKeys) {
      return "";
    }

    // Try each potential env var name for this service
    for (const envVar of envVarKeys) {
      const value = process.env[envVar];
      if (value) {
        return value;
      }
    }
    
    return "";
  }

  /**
   * Track service failure and check if service should be skipped
   */
  recordServiceFailure(service) {
    const count = (this.serviceFailures.get(service) || 0) + 1;
    this.serviceFailures.set(service, count);
    return count;
  }

  /**
   * Clear failure tracking (useful for testing or explicit reset)
   */
  clearFailureTracking() {
    this.serviceFailures.clear();
  }

  /**
   * Check if service has too many consecutive failures
   */
  shouldSkipService(service) {
    const failureCount = this.serviceFailures.get(service) || 0;
    const maxConsecutiveFailures = 2; // Skip after 2 consecutive failures
    return failureCount >= maxConsecutiveFailures;
  }

  /**
   * Track service failure and check if service should be skipped
   */
  recordServiceFailure(service) {
    const count = (this.serviceFailures.get(service) || 0) + 1;
    this.serviceFailures.set(service, count);
    return count;
  }

  /**
   * Clear failure tracking (useful for testing or explicit reset)
   */
  clearFailureTracking() {
    this.serviceFailures.clear();
  }

  /**
   * Check if service has too many consecutive failures
   */
  shouldSkipService(service) {
    const failureCount = this.serviceFailures.get(service) || 0;
    const maxConsecutiveFailures = 2; // Skip after 2 consecutive failures
    return failureCount >= maxConsecutiveFailures;
  }

  /**
   * Shorten a single URL using configured services with fallback
   */
  async shortenUrl(longUrl) {
    // Check cache first
    const cached = this.cache.get(longUrl);
    if (cached) {
      console.debug(
        "[URLShortener] Cache hit for URL:",
        longUrl.substring(0, 50)
      );
      return cached;
    }

    if (!this.enabled) {
      console.warn("[URLShortener] URL shortening disabled, returning null");
      return null;
    }

    const failedServices = new Set();
    let lastError = null;

    // Try each configured service in order
    for (const service of this.configuredServices) {
      if (failedServices.has(service)) {
        continue; // Skip already failed services
      }

      if (this.shouldSkipService(service)) {
        console.debug(`[URLShortener] Skipping service ${service} due to repeated failures`);
        failedServices.add(service);
        continue;
      }

      try {
        console.debug(
          `[URLShortener] Attempting to shorten URL via ${service}:`,
          longUrl.substring(0, 50)
        );

        const shortUrl = await this.callShortenerAPI(longUrl, service);
        
        if (shortUrl) {
          this.cache.set(longUrl, shortUrl);
          // Reset failure count on success
          this.serviceFailures.set(service, 0);
          console.debug(
            `[URLShortener] Successfully shortened URL via ${service}`
          );
          return shortUrl;
        } else {
          failedServices.add(service);
          this.recordServiceFailure(service);
          lastError = "Empty response from shortener";
          console.warn(
            `[URLShortener] Failed with ${service}: ${lastError}. Switching to alternative service...`
          );
        }
      } catch (error) {
        failedServices.add(service);
        this.recordServiceFailure(service);
        lastError = error.message;
        console.warn(
          `[URLShortener] Failed with ${service}: ${lastError}`
        );
        const nextService = this.getNextService(service);
        if (nextService) {
          console.warn(
            `[URLShortener] Switching to alternative service: ${nextService}`
          );
        }
      }
    }

    console.warn(
      `All URL shortening services failed. Last error: ${lastError}`
    );
    return null;
  }

  /**
   * Get next service after current one fails
   */
  getNextService(currentService) {
    const idx = this.configuredServices.indexOf(currentService);
    if (idx < this.configuredServices.length - 1) {
      return this.configuredServices[idx + 1];
    }
    return null;
  }

  /**
   * Call URL shortener API using prettylink
   */
  async callShortenerAPI(longUrl, service) {
    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error("URL shortening timeout"));
      }, this.timeout);

      try {
        let prettyLink;
        switch (service) {
          case "bitly":
            prettyLink = new Prettylink.Bitly({
              accessToken: this.getAPIKey(service),
            });
            break;
          case "tinyurl":
            prettyLink = new Prettylink.TinyURL();
            break;
          case "picsee":
            prettyLink = new Prettylink.Picsee({
              accessToken: this.getAPIKey(service),
            });
            break;
          case "reurl":
            prettyLink = new Prettylink.Reurl({
              apiKey: this.getAPIKey(service),
            });
            break;
          case "cuttly":
            prettyLink = new Prettylink.Cuttly({
              apiKey: this.getAPIKey(service),
            });
            break;
          case "pixnet0rz.tw":
            prettyLink = Prettylink.Pixnet0rz();
            break;
          case "test":
            // Test service that returns a dummy short URL
            clearTimeout(timeoutId);
            resolve("https://short.url/test");
            return;
          default:
            clearTimeout(timeoutId);
            return reject(new Error(`Unsupported URL shortener service: ${service}`));
        }

        prettyLink
          .short(longUrl)
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
   * Shorten multiple URLs in parallel
   */
  async shortenUrlsParallel(urls) {
    if (!this.enabled || !urls || urls.length === 0) {
      return {};
    }

    const results = {};
    const promises = urls.map(async (url) => {
      try {
        console.debug("[URLShortener] Shortening URL in parallel:", url.substring(0, 50));
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
      configuredServices: this.configuredServices,
      primaryService: this.primaryService,
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
