/**
 * MarkdownV2Formatter - Escapes and formats text for Telegram MarkdownV2
 * Handles special character escaping according to Telegram MarkdownV2 spec
 */

/**
 * Escape special characters for Telegram MarkdownV2
 * MarkdownV2 requires escaping: _ * [ ] ( ) ~ ` > # + - = | { } . !
 * @param {string} text - Text to escape
 * @returns {string} Escaped text safe for MarkdownV2
 */
function escapeMarkdownV2(text) {
	if (!text || typeof text !== 'string') {
		return '';
	}

	// Escape all MarkdownV2 special characters
	return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

/**
 * Normalize backslashes to avoid double-escaping
 * Collapses sequences like "\\\\" -> "\\"
 * @param {string} text - Text with potential backslash sequences
 * @returns {string} Normalized text
 */
function normalizeBackslashes(text = '') {
	return text.replace(/\\\\+/g, '\\');
}

/**
 * MarkdownV2Formatter - Formats text for Telegram MarkdownV2 parse mode
 */
class MarkdownV2Formatter {
	/**
   * Format text for Telegram MarkdownV2
   * @param {string} text - Raw or enriched alert text
   * @returns {string} Formatted text with MarkdownV2 escaping
   */
	format(text) {
		if (!text || typeof text !== 'string') {
			return '';
		}

		// Normalize backslashes first to avoid double-escaping
		const normalized = normalizeBackslashes(text);

		// Escape MarkdownV2 special characters
		return escapeMarkdownV2(normalized);
	}

	/**
   * Format an enriched alert with summary and citations
   * @param {Object} enriched - Enriched alert object with originalText, summary, citations, etc.
   * @returns {string} Formatted message with bold title, summary, and sources
   */
	formatEnriched(enriched = {}) {
		const { originalText = '', summary = '', citations = [], extraText = '', truncated = false } = enriched;

		// Escape and normalize individual components
		const escapedText = escapeMarkdownV2(normalizeBackslashes(originalText));
		const escapedSummary = escapeMarkdownV2(normalizeBackslashes(summary));
		const escapedExtraText = escapeMarkdownV2(extraText);

		// Format citations: [escapedTitle](url) - must keep URL unescaped for links to work
		const formattedSources = citations
			.map(({ title = '', url = '' }) => {
				const escapedTitle = escapeMarkdownV2(normalizeBackslashes(title));
				// URLs in MarkdownV2 must not be escaped
				return `[${escapedTitle}](${url})`;
			})
			.join(' / ');

		// Build the message
		let message = `*${escapedText}*`;

		// Add truncation notice if needed
		if (truncated) {
			message += '\n\n_(Message was truncated due to length)_';
		}

		// Add enriched content sections
		message += `\n\n*Contexto:*\n\n${escapedSummary}`;

		if (citations.length > 0) {
			message += `\n\n*Fuentes:* ${formattedSources}`;
		}

		message += `\n\n_${escapedExtraText}_`;

		return message;
	}
}

module.exports = MarkdownV2Formatter;
