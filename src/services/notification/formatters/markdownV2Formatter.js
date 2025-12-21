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

function formatTokenUsageMarkdown(tokenUsage) {
	if (!tokenUsage) return '';
	const input = Number(tokenUsage.inputTokens) || 0;
	const output = Number(tokenUsage.outputTokens) || 0;
	const total = Number(tokenUsage.totalTokens || (input + output));
	const inputCost = Number(tokenUsage.inputCost || 0);
	const outputCost = Number(tokenUsage.outputCost || 0);
	const totalCost = Number(tokenUsage.totalCost || (Number(inputCost) + Number(outputCost))).toFixed(4);
	const line = `Tokens usage: ${total} ($${totalCost})`;
	return smartEscapeMarkdownV2(normalizeBackslashes(line));
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
   * Format an enriched alert with sentiment, insights, technical levels, and sources
   * Dispatches to specific formatter based on enriched data structure
   * @param {Object} enriched - Enriched alert object
   * @returns {string} Formatted message with MarkdownV2 escaping
   */
	formatEnriched(enriched = {}) {
		// Check for Feature 004 EnrichedAlert structure (has original_text or insights array)
		if (enriched.original_text || (enriched.insights && Array.isArray(enriched.insights))) {
			return this.formatWebhookAlert(enriched);
		}
		// Fallback to Feature 003 NewsAlert structure
		return this.formatNewsAlert(enriched);
	}

	/**
   * Format Feature 004 EnrichedAlert (Webhook)
   * @param {Object} enriched - EnrichedAlert object
   * @returns {string} Formatted message
   */
	formatWebhookAlert(enriched = {}) {
		const {
			original_text = '',
			sentiment = 'NEUTRAL',
			sentiment_score = 0,
			insights = [],
			technical_levels = { supports: [], resistances: [] },
			sources = [],
			truncated = false,
			tokenUsage,
		} = enriched;

		// Use smart escape for content
		const escapedText = smartEscapeMarkdownV2(normalizeBackslashes(original_text));

		// Build the message
		let message = `*${escapedText}*`;

		if (truncated) {
			message += '\n\n_\\(Message was truncated due to length\\)_';
		}


		// Insights
		if (insights.length > 0) {
			message += '\n\n*Key Insights*';
			insights.forEach(insight => {
				message += `\n• ${smartEscapeMarkdownV2(normalizeBackslashes(insight))}`;
			});
		}

		// Sentiment
		const sentimentEmoji = sentiment === 'BULLISH' ? '🚀' : sentiment === 'BEARISH' ? '🔻' : '😐';
		const score = sentiment_score.toFixed(2).replace('.', '\\.');
		message += `\n\nSentiment: ${sentiment} ${sentimentEmoji} \\(${score}\\)`;

		// Technical Levels
		const hasSupports = technical_levels.supports && technical_levels.supports.length > 0;
		const hasResistances = technical_levels.resistances && technical_levels.resistances.length > 0;

		if (hasSupports || hasResistances) {
			message += '\n\n*Technical Levels*';
			if (hasSupports) {
				const supports = technical_levels.supports.map(s => smartEscapeMarkdownV2(s)).join(', ');
				message += `\nSupports: ${supports}`;
			}
			if (hasResistances) {
				const resistances = technical_levels.resistances.map(r => smartEscapeMarkdownV2(r)).join(', ');
				message += `\nResistances: ${resistances}`;
			}
		}

		// Sources
		if (sources.length > 0) {
			const formattedSources = sources
				.map(({ title = '', url = '' }) => {
					const unescapedTitle = title.replace(/\\([_*[\]~`>#{=|\.}])/g, '$1');
					const escapedTitleForLink = smartEscapeMarkdownV2(normalizeBackslashes(unescapedTitle));
					return `[${escapedTitleForLink}](${url})`;
				})
				.join(' / ');
			message += `\n\n*Sources*\n${formattedSources}`;
		}

		const tokenLine = formatTokenUsageMarkdown(tokenUsage);
		if (tokenLine) {
			message += `\n\n_${tokenLine}_`;
		}

		return message;
	}

	/**
   * Format Feature 003 NewsAlert (News Monitor)
   * @param {Object} enriched - NewsAlert enriched object
   * @returns {string} Formatted message
   */
	formatNewsAlert(enriched = {}) {
		const { originalText = '', summary = '', citations = [], extraText = '', tokenUsage } = enriched;

		// Escape title
		const escapedTitle = smartEscapeMarkdownV2(normalizeBackslashes(originalText));
		let message = `*${escapedTitle}*`;

		// Summary - assume it contains some markdown (*Sentiment:*) but also dynamic text.
		// We append it as is to preserve NewsAnalyzer formatting.
		if (summary) {
			message += `\n\n${summary}`;
		}

		// Citations
		if (citations && citations.length > 0) {
			const formattedCitations = citations
				.map(c => {
					const escapedCitationTitle = smartEscapeMarkdownV2(normalizeBackslashes(c.title || 'Source'));
					return `[${escapedCitationTitle}](${c.url})`;
				})
				.join(' \\| ');
			message += `\n\nSources: ${formattedCitations}`;
		}

		// Extra text (Model confidence etc) - contains markdown (_)
		if (extraText) {
			message += `\n\n${extraText}`;
		}

		const tokenLine = formatTokenUsageMarkdown(tokenUsage);
		if (tokenLine) {
			message += `\n\n_${tokenLine}_`;
		}

		return message;
	}
}

module.exports = MarkdownV2Formatter;
