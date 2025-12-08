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

  _formatTokenUsage(tokenUsage) {
    if (!tokenUsage) return '';
    const input = Number(tokenUsage.inputTokens) || 0;
    const output = Number(tokenUsage.outputTokens) || 0;
    const total = Number(tokenUsage.totalTokens || (input + output));
    return `Tokens: in ${input} | out ${output} | total ${total}`;
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
   * Format Feature 003 NewsAlert (News Monitor)
   * @async
   * @param {Object} enriched - NewsAlert enriched object
   * @returns {Promise<string>} Formatted WhatsApp message
   */
  async formatNewsAlert(enriched = {}) {
    const { originalText = '', summary = '', citations = [], extraText = '', tokenUsage } = enriched;

    // Unescape MarkdownV2 sequences if present in originalText
    const unescapedTitle = originalText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
    let message = `*${unescapedTitle}*`;

    if (summary) {
      // Unescape MarkdownV2 sequences in summary
      let unescapedSummary = summary.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
      // Convert MarkdownV2 bold (**text**) to WhatsApp bold (*text*)
      unescapedSummary = unescapedSummary.replace(/\*\*/g, "*");

      // Convert bullet points from * to - for WhatsApp compatibility
      unescapedSummary = unescapedSummary.replace(/^\*\s+/gm, "- ");
      unescapedSummary = unescapedSummary.replace(/\n\*\s+/g, "\n- ");

      message += `\n\n${unescapedSummary}`;
    }

    // Citations
    if (citations && citations.length > 0) {
      // Extract URLs for shortening if URL shortener is available
      const urls = citations.map(c => c.url).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
      
      let shortenedMap = {};
      if (this.urlShortener && urls.length > 0) {
        try {
          shortenedMap = await this.urlShortener.shortenUrlsParallel(urls);
        } catch (error) {
          if (this.logger) {
            this.logger.warn?.(`WhatsApp formatter: URL shortening failed, falling back to title-only: ${error.message}`);
          }
        }
      }

      message += '\n\n*Sources*';
      citations.forEach(({ title = "", url = "" }) => {
        const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
        if (shortenedMap[url]) {
          message += `\n- ${cleanTitle}: ${shortenedMap[url]}`;
        } else if (url) {
          message += `\n- ${cleanTitle}: ${url}`;
        } else {
          message += `\n- ${cleanTitle}`;
        }
      });
    }

    if (extraText) {
      const unescapedExtra = extraText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
      message += `\n\n${unescapedExtra}`;
    }

    const tokenLine = this._formatTokenUsage(tokenUsage);
    if (tokenLine) {
      message += `\n\n_${tokenLine}_`;
    }

    return message;
  }

  /**
   * Format Feature 004 EnrichedAlert (Webhook)
   * @async
   * @param {Object} enriched - EnrichedAlert object
   * @returns {Promise<string>} Formatted WhatsApp message
   */
  async formatWebhookAlert(enriched = {}) {
    const {
      original_text = '',
      sentiment = 'NEUTRAL',
      sentiment_score = 0,
      insights = [],
      technical_levels = { supports: [], resistances: [] },
      sources = [],
      truncated = false,
      extraText = '',
      tokenUsage,
    } = enriched;

    // Unescape MarkdownV2 sequences to get plain text/WhatsApp markdown
    const unescapedText = original_text.replace(
      /\\([_*[\]()~`>#+\-=|{}.!])/g,
      "$1"
    );

    // Build the message
    let message = `*${unescapedText}*`;

    if (truncated) {
      message += '\n\n_(Message was truncated due to length)_';
    }

    // Insights
    if (insights.length > 0) {
      message += '\n\n*Key Insights*';
      insights.forEach(insight => {
        const cleanInsight = insight.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
        message += `\n• ${cleanInsight}`;
      });
    }

    // Sentiment
    const sentimentEmoji = sentiment === 'BULLISH' ? '🚀' : sentiment === 'BEARISH' ? '🔻' : '😐';
    const score = sentiment_score.toFixed(2);
    message += `\n\nSentiment: ${sentiment} ${sentimentEmoji} (${score})`;

    // Technical Levels
    const hasSupports = technical_levels.supports && technical_levels.supports.length > 0;
    const hasResistances = technical_levels.resistances && technical_levels.resistances.length > 0;

    if (hasSupports || hasResistances) {
      message += '\n\n*Technical Levels*';
      if (hasSupports) {
        const supports = technical_levels.supports.join(', ');
        message += `\nSupports: ${supports}`;
      }
      if (hasResistances) {
        const resistances = technical_levels.resistances.join(', ');
        message += `\nResistances: ${resistances}`;
      }
    }

    // Sources
    if (sources.length > 0) {
      // Extract URLs for shortening if URL shortener is available
      const urls = sources.map(c => c.url).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
      
      let shortenedMap = {};
      if (this.urlShortener && urls.length > 0) {
        try {
          // Call shortenUrlsParallel to shorten all URLs at once
          shortenedMap = await this.urlShortener.shortenUrlsParallel(urls);
        } catch (error) {
          // Log shortening failure but don't block message delivery
          if (this.logger) {
            this.logger.warn?.(`WhatsApp formatter: URL shortening failed, falling back to title-only: ${error.message}`);
          }
        }
      }

      message += '\n\n*Sources*';
      sources.forEach(({ title = "", url = "" }) => {
        const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
        if (shortenedMap[url]) {
          message += `\n- ${cleanTitle}: ${shortenedMap[url]}`;
        } else if (url) {
          message += `\n- ${cleanTitle}: ${url}`;
        } else {
          message += `\n- ${cleanTitle}`;
        }
      });

      if (extraText) {
        const unescapedExtra = extraText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, "$1");
        message += `\n\n${unescapedExtra}`;
      }
    }

    const tokenLine = this._formatTokenUsage(tokenUsage);
    if (tokenLine) {
      message += `\n\n_${tokenLine}_`;
    }

    return message;
  }

  /**
   * Format enriched alert for WhatsApp with optional URL shortening for citations
   * Dispatches to specific formatter based on enriched data structure
   * @async
   * @param {Object} enriched - Enriched alert object
   * @returns {Promise<string>} Formatted WhatsApp message
   */
  async formatEnriched(enriched = {}) {
    // Check for Feature 004 EnrichedAlert structure (has original_text or insights array)
    if (enriched.original_text || (enriched.insights && Array.isArray(enriched.insights))) {
      return this.formatWebhookAlert(enriched);
    }
    // Fallback to Feature 003 NewsAlert structure
    return this.formatNewsAlert(enriched);
  }

}

module.exports = WhatsAppMarkdownFormatter;
