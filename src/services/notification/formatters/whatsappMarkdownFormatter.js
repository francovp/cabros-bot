/**
 * WhatsAppMarkdownFormatter - Formats enriched alerts for WhatsApp
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, `code`, ```monospace```
 * Converts MarkdownV2 escape sequences to WhatsApp-friendly format
 */

/**
 * WhatsAppMarkdownFormatter - Formats text for WhatsApp markdown
 * WhatsApp supports: *bold*, _italic*, ~strikethrough~, `code`, ```monospace```
 */
class WhatsAppMarkdownFormatter {
  /**
   * @param {Object} config - Configuration object
   * @param {Object} config.logger - Logger for conversion tracking (optional)
   * @param {Object} config.urlShortener - URL shortener instance for URL integration (optional)
   */
  constructor(config = {}) {
    this.logger = config.logger || null;
    this.urlShortener = config.urlShortener || null;
  }

  /**
   * Format text for WhatsApp markdown
   * Converts MarkdownV2 or plain text to WhatsApp-compatible format
   * @param {string} text - Raw or enriched alert text
   * @returns {string} Formatted text with WhatsApp markdown
   */
  format(text) {
    if (!text || typeof text !== 'string') {
      return '';
    }

    // Strip MarkdownV2 escape sequences (backslashes before special chars)
    let result = text.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

    // Log conversion if needed
    if (this.logger) {
      this.logger.debug?.('WhatsApp formatter: Converted MarkdownV2 escape sequences');
    }

    return result;
  }

  /**
   * Format enriched alert for WhatsApp with optional URL shortening for citations
   * @async
   * @param {Object} enriched - Enriched alert object with citations
   * @param {string} enriched.originalText - Original alert text
   * @param {string} enriched.summary - AI-generated summary
   * @param {Array<{title: string, url: string}>} enriched.citations - Source citations with URLs
   * @param {string} enriched.extraText - Additional text/metadata
   * @param {boolean} enriched.truncated - Whether message was truncated
   * @returns {Promise<string>} Formatted WhatsApp message
   */
  async formatEnriched(enriched = {}) {
    const { originalText = '', summary = '', citations = [], extraText = '', truncated = false } = enriched;

    // Unescape MarkdownV2 sequences to get plain text/WhatsApp markdown
    const unescapedText = originalText.replace(
      /\\([_*[\]()~`>#+\-=|{}.!])/g,
      "$1"
    );
    let unescapedSummary = summary.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
    const unescapedExtraText = extraText.replace(
      /\\([_*[\]()~`>#+\-=|{}.!])/g,
      "$1"
    );

    // Convert MarkdownV2 bold (**text**) to WhatsApp bold (*text*)
    unescapedSummary = unescapedSummary.replace(/\*\*/g, "*");

    // Convert bullet points from * to - for WhatsApp compatibility
    unescapedSummary = unescapedSummary.replace(/^\*\s+/gm, "- ");
    unescapedSummary = unescapedSummary.replace(/\n\*\s+/g, "\n- ");

    // Format citations: attempt URL shortening via Bitly, fallback to title-only on failure
    let formattedSources = '';
    let shortenedUrls = 0;
    let failedShortening = 0;

    if (citations.length > 0) {
      // Extract URLs for shortening if URL shortener is available
      const urls = citations.map(c => c.url).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
      
      let shortenedMap = {};
      if (this.urlShortener && urls.length > 0) {
        try {
          // Call shortenUrlsParallel to shorten all URLs at once
          shortenedMap = await this.urlShortener.shortenUrlsParallel(urls);
          shortenedUrls = Object.keys(shortenedMap).length;
        } catch (error) {
          // Log shortening failure but don't block message delivery
          if (this.logger) {
            this.logger.warn?.(`WhatsApp formatter: URL shortening failed, falling back to title-only: ${error.message}`);
          }
          failedShortening = urls.length;
        }
      }

      // Build formatted sources with shortened URLs or title-only fallback
      const sourcesArray = citations.map(({ title = "", url = "" }) => {
        const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");

        // Try to use shortened URL if available, otherwise just title
        if (shortenedMap[url]) {
          return `- ${cleanTitle} (${shortenedMap[url]})`;
        } else {
          return `- ${cleanTitle}`;
        }
      });

      formattedSources = sourcesArray.join("\n");

      // Log shortening results
      if ((shortenedUrls > 0 || failedShortening > 0) && this.logger) {
        this.logger.debug?.(`WhatsApp formatter: Shortened ${shortenedUrls} URL(s), failed: ${failedShortening}`);
      }
    }

    // Build the message
    let message = `*${unescapedText}*`;

    // Add truncation notice if needed
    if (truncated) {
      message += '\n\n_(Message was truncated due to length)_';
    }

    // Add enriched content sections
    message += `\n\n*Contexto:*\n\n${unescapedSummary}`;

    if (formattedSources) {
      message += `\n\n*Fuentes:*\n${formattedSources}`;
    }

    if (unescapedExtraText) {
      message += `\n\n${unescapedExtraText}`;
    }

    return message;
  }
}

module.exports = WhatsAppMarkdownFormatter;
