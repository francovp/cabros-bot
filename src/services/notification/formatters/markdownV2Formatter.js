/**
 * MarkdownV2Formatter - Escapes and formats text for Telegram MarkdownV2
 * Handles special character escaping according to Telegram MarkdownV2 spec
 * Key: Only escape characters that are true markdown syntax elements
 *
 * Reference: https://core.telegram.org/bots/api#markdownv2-style
 */

const { getWebhookCopy, normalizeActionableAlert } = require('../../alerts/actionableAlert');

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

function escapeDynamicText(text) {
	return smartEscapeMarkdownV2(normalizeBackslashes(text));
}

function getUrgencyEmoji(level) {
	if (level === 'HIGH') {
		return '🔴';
	}

	if (level === 'MEDIUM') {
		return '🟡';
	}

	return '🟢';
}

function formatScenarioBlock(label, scenario) {
	if (!scenario || (!scenario.trigger && !scenario.outcome)) {
		return '';
	}

	const lines = [`*${label}*`];
	if (scenario.trigger) {
		lines.push(`• ${escapeDynamicText(scenario.trigger)}`);
	}
	if (scenario.outcome) {
		lines.push(`• ${escapeDynamicText(scenario.outcome)}`);
	}

	return lines.join('\n');
}

function formatKeyLevels(copy, technicalLevels = {}) {
	const supports = technicalLevels.supports || [];
	const resistances = technicalLevels.resistances || [];
	const lines = [`*${copy.labels.keyLevels}*`];

	if (supports.length > 0) {
		lines.push(`${copy.labels.supports}: ${supports.map(level => escapeDynamicText(level)).join(', ')}`);
	}

	if (resistances.length > 0) {
		lines.push(`${copy.labels.resistances}: ${resistances.map(level => escapeDynamicText(level)).join(', ')}`);
	}

	return lines.length > 1 ? lines.join('\n') : '';
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
		const normalized = normalizeActionableAlert(enriched);
		const {
			headline = '',
			recommended_action = '',
			urgency_level = 'LOW',
			urgency_reason = '',
			risk_warning = null,
			insights = [],
			technical_levels = { supports: [], resistances: [] },
			scenarios = { bull: null, bear: null },
			sources = [],
			truncated = false,
			language = 'es',
			reminder = null,
			extraText = '',
			tokenUsage,
		} = normalized;

		const copy = getWebhookCopy(language);
		const sections = [];

		if (reminder && reminder.text) {
			sections.push(`*🔔 ${copy.labels.reminder}*\n${escapeDynamicText(reminder.text)}`);
		}

		if (recommended_action) {
			sections.push(`*🚨 ${copy.labels.action}*\n${escapeDynamicText(recommended_action)}`);
		}

		if (headline) {
			sections.push(escapeDynamicText(headline));
		}

		const urgencyLabel = copy.urgencyLabels[urgency_level] || urgency_level;
		sections.push(`*${getUrgencyEmoji(urgency_level)} ${copy.labels.urgency}: ${escapeDynamicText(urgencyLabel)}*\n${escapeDynamicText(urgency_reason)}`);

		if (risk_warning) {
			sections.push(`*⚠️ ${copy.labels.caution}*\n${escapeDynamicText(risk_warning)}`);
		}

		const bullScenario = formatScenarioBlock(copy.labels.bull, scenarios.bull);
		const bearScenario = formatScenarioBlock(copy.labels.bear, scenarios.bear);
		if (bullScenario || bearScenario) {
			sections.push([`*${copy.labels.scenarios}*`, bullScenario, bearScenario].filter(Boolean).join('\n'));
		}

		if (insights.length > 0) {
			const insightSection = [`*${copy.labels.quickRead}*`];
			insights.forEach(insight => {
				insightSection.push(`• ${escapeDynamicText(insight)}`);
			});
			sections.push(insightSection.join('\n'));
		}

		const hasSupports = technical_levels.supports && technical_levels.supports.length > 0;
		const hasResistances = technical_levels.resistances && technical_levels.resistances.length > 0;
		if (!bullScenario && !bearScenario && (hasSupports || hasResistances)) {
			sections.push(formatKeyLevels(copy, technical_levels));
		}

		if (truncated) {
			sections.push('_\\(Message was truncated due to length\\)_');
		}

		if (sources.length > 0) {
			const formattedSources = sources
				.map(({ title = '', url = '' }) => {
					const unescapedTitle = title.replace(/\\([_*[\]~`>#{=|.}])/g, '$1');
					const escapedTitleForLink = smartEscapeMarkdownV2(normalizeBackslashes(unescapedTitle));
					return `[${escapedTitleForLink}](${url})`;
				})
				.join(' / ');
			sections.push(`*${copy.labels.sources}*\n${formattedSources}`);
		}

		if (extraText) {
			sections.push(extraText);
		}

		const tokenLine = formatTokenUsageMarkdown(tokenUsage);
		if (tokenLine) {
			sections.push(`_${tokenLine}_`);
		}

		return sections.filter(Boolean).join('\n\n');
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
