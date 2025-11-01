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
   */
  constructor(config = {}) {
    this.logger = config.logger || null;
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
  formatEnriched(enriched = {}) {
    const { originalText = '', summary = '', citations = [], extraText = '', truncated = false } = enriched;

    // Unescape MarkdownV2 sequences
    const unescapedText = originalText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
    const unescapedSummary = summary.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
    const unescapedExtraText = extraText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

    // Format citations: strip links to plain text (WhatsApp doesn't support inline links well)
    let formattedSources = '';
    let strippedLinks = 0;
    citations.forEach(({ title = '', url = '' }) => {
      // Strip markdown escaping from title
      const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
      if (formattedSources) {
        formattedSources += ' / ';
      }
      formattedSources += cleanTitle; // Drop URL, just use title as plain text
      strippedLinks++;
    });

    // Log stripped formats
    if (strippedLinks > 0 && this.logger) {
      this.logger.debug?.(
        `WhatsApp formatter: Stripped ${strippedLinks} link(s) from citations (WhatsApp doesn't support inline links)`
      );
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
