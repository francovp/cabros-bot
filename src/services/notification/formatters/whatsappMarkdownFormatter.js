/**
 * WhatsAppMarkdownFormatter - Converts MarkdownV2 tokens to WhatsApp markdown format
 * WhatsApp supports limited markdown: *bold*, _italic_, ~strikethrough~, `code`, ```monospace```
 * This formatter strips unsupported formats (links, underline, nested) to plain text
 */

/**
 * Parse markdown token from MarkdownV2 format
 * Supports: *bold*, _italic_, ~strikethrough~, `code`, ```monospace```
 * @private
 */
function parseMarkdownToken(text) {
  const tokens = [];

  // Pattern: **bold** or ~~strikethrough~~ or _italic_ or `code` or ```monospace```
  const patterns = [
    { regex: /\*\*(.+?)\*\*/g, type: 'bold', wrapper: '*' },
    { regex: /~~(.+?)~~/g, type: 'strikethrough', wrapper: '~' },
    { regex: /_(.+?)_/g, type: 'italic', wrapper: '_' },
    { regex: /`{3}(.+?)`{3}/g, type: 'monospace', wrapper: '```' },
    { regex: /`(.+?)`/g, type: 'code', wrapper: '`' },
    { regex: /__(.+?)__/g, type: 'underline', wrapper: null }, // Not supported
    { regex: /\[(.+?)\]\((.+?)\)/g, type: 'link', wrapper: null }, // Not supported
  ];

  let result = text;
  const strippedFormats = { links: 0, underlines: 0, nested: 0 };

  // Process each pattern
  patterns.forEach(({ regex, type, wrapper }) => {
    if (!wrapper) {
      // Unsupported format: strip to plain text content
      if (type === 'link') {
        result = result.replace(regex, '$1'); // Keep link text, discard URL
        strippedFormats.links++;
      } else if (type === 'underline') {
        result = result.replace(regex, '$1'); // Keep text, remove underline
        strippedFormats.underlines++;
      }
    } else {
      // Supported format: convert to WhatsApp markdown
      // For simplicity, assume input is well-formed MarkdownV2
      // and convert directly: *text* → *text* (already WhatsApp compatible)
      // No special conversion needed for bold, italic, strikethrough, code, monospace
    }
  });

  return { result, strippedFormats };
}

/**
 * WhatsAppMarkdownFormatter - Formats text for WhatsApp markdown
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, `code`, ```monospace```
 */
class WhatsAppMarkdownFormatter {
  /**
   * @param {Object} config - Configuration object
   * @param {Object} config.logger - Logger for conversion tracking (optional)
   * @param {Object} config.urlShortener - URL shortener instance for Bitly integration (optional)
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

    // WhatsApp markdown is fairly similar to MarkdownV2
    // Main differences: WhatsApp doesn't support links, underline, nested formatting
    // For now, just return text as-is (links will work as plain text)
    // In a more sophisticated implementation, we'd parse and strip unsupported formats

    // Strip MarkdownV2 escape sequences (backslashes before special chars)
    // This converts escaped text like "Hello \*world\*" to "Hello *world*"
    let result = text.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

    // Log conversion if needed
    if (this.logger) {
      this.logger.debug?.('WhatsApp formatter: Converted MarkdownV2 escape sequences');
    }

    return result;
  }

  /**
   * Format an enriched alert with summary and citations
   * Converts to WhatsApp-compatible markdown
   * @param {Object} enriched - Enriched alert object
   * @returns {string} Formatted message with bold text and sources
   */
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

    // Unescape MarkdownV2 sequences
    const unescapedText = originalText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
    const unescapedSummary = summary.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
    const unescapedExtraText = extraText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

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
      citations.forEach(({ title = '', url = '' }) => {
        const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

        // Try to use shortened URL if available, otherwise just title
        if (shortenedMap[url]) {
          formattedSources += `\n- ${cleanTitle} (${shortenedMap[url]})`;
        } else {
          formattedSources += `- ${cleanTitle}`;
        }
      });

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

    if (citations.length > 0) {
      message += `\n\n*Fuentes:* ${formattedSources}`;
    }

    message += `\n\n${unescapedExtraText}`;

    return message;
  }
}

module.exports = WhatsAppMarkdownFormatter;
