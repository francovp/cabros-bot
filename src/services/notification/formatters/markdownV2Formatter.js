/**
 * MarkdownV2Formatter - Escapes and formats text for Telegram MarkdownV2
 * Handles special character escaping according to Telegram MarkdownV2 spec
 * Key: Only escape characters that are true markdown syntax elements
 *
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */

const SPECIAL_CHARS = [
	'\\',
	// '_',
	// '*',
	'[',
	']',
	'(',
	')',
	'~',
	'`',
	'>',
	'<',
	'&',
	'#',
	'+',
	'-',
	'=',
	'|',
	'{',
	'}',
	'.',
	'!',
];

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
 * Smart escape for MarkdownV2 content
 * Escapes characters that could break MarkdownV2 parsing
 *
 * This approach keeps output readable while preventing markdown injection
 *
 * @param {string} text - Text to escape selectively
 * @returns {string} Escaped text safe for MarkdownV2 parse_mode
 */
function smartEscapeMarkdownV2(text) {
	if (!text || typeof text !== 'string') {
		return '';
	}

	// Escape only characters that are true markdown syntax elements
	SPECIAL_CHARS.forEach(char => (text = text.replaceAll(char, `\\${char}`)));
	return text;
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
		return smartEscapeMarkdownV2(normalized);
	}

	/**
   * Format an enriched alert with summary and citations
   * @param {Object} enriched - Enriched alert object with originalText, summary, citations, etc.
   * @returns {string} Formatted message with bold title, summary, and sources
   */
	formatEnriched(enriched = {}) {
		const { originalText = '', summary = '', citations = [], extraText = '', truncated = false } = enriched;

		// Use smart escape for content (escape markdown syntax, not regular punctuation)
		const escapedText = smartEscapeMarkdownV2(
			normalizeBackslashes(originalText),
		);
		const escapedSummary = smartEscapeMarkdownV2(
			normalizeBackslashes(summary),
		);
		const escapedExtraText = smartEscapeMarkdownV2(
			normalizeBackslashes(extraText),
		);

		// Format citations: [escapedTitle](url) - must keep URL unescaped for links to work
		const formattedSources = citations
			.map(({ title = '', url = '' }) => {
				const unescapedTitle = title.replace(/\\([_*[\]~`>#{=|\.}])/g, '$1');
				const escapedTitle = smartEscapeMarkdownV2(
					normalizeBackslashes(unescapedTitle),
				);
				// URLs in MarkdownV2 must not be escaped
				return `[${escapedTitle}](${url})`;
			})
			.join(' / ');

		// Build the message - markdown delimiters (* for bold) are NOT escaped
		let message = `*${escapedText}*`;

		// Add truncation notice if needed
		if (truncated) {
			message += '\n\n_(Message was truncated due to length)_';
		}

		// Add enriched content sections - these delimiters are literal, not escaped
		message += `\n\n*Contexto:*\n\n${escapedSummary}`;

		if (citations.length > 0) {
			message += `\n\n*Fuentes:*\n${formattedSources}`;
		}

		if (escapedExtraText) {
			message += `\n\n${escapedExtraText}`;
		}

		return message;
	}
}

module.exports = MarkdownV2Formatter;
