/**
* WhatsAppMarkdownFormatter - Formats enriched alerts for WhatsApp
* WhatsApp supports: *bold*, _italic_, ~strikethrough~, `code`, ```monospace```
* Converts MarkdownV2 escape sequences to WhatsApp-friendly format
*/

const { getWebhookCopy, normalizeActionableAlert } = require('../../alerts/actionableAlert');

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
		const inputCost = Number(tokenUsage.inputCost || 0);
		const outputCost = Number(tokenUsage.outputCost || 0);
		const totalCost = Number(tokenUsage.totalCost || (Number(inputCost) + Number(outputCost))).toFixed(4);
		return `Tokens usage: ${total} ($${totalCost})`;
	}

	_getUrgencyEmoji(level) {
		if (level === 'HIGH') {
			return '🔴';
		}

		if (level === 'MEDIUM') {
			return '🟡';
		}

		return '🟢';
	}

	_formatScenarioBlock(label, scenario) {
		if (!scenario || (!scenario.trigger && !scenario.outcome)) {
			return '';
		}

		const lines = [`*${label}*`];
		if (scenario.trigger) {
			lines.push(`- ${scenario.trigger}`);
		}
		if (scenario.outcome) {
			lines.push(`- ${scenario.outcome}`);
		}

		return lines.join('\n');
	}

	_formatKeyLevels(copy, technicalLevels = {}) {
		const supports = technicalLevels.supports || [];
		const resistances = technicalLevels.resistances || [];
		const lines = [`*${copy.labels.keyLevels}*`];

		if (supports.length > 0) {
			lines.push(`${copy.labels.supports}: ${supports.join(', ')}`);
		}

		if (resistances.length > 0) {
			lines.push(`${copy.labels.resistances}: ${resistances.join(', ')}`);
		}

		return lines.length > 1 ? lines.join('\n') : '';
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
		const result = text.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');

		// Log conversion if needed
		if (this.logger) {
			if (typeof this.logger.debug === 'function') {
				this.logger.debug('WhatsApp formatter: Converted MarkdownV2 escape sequences');
			}
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
		const unescapedTitle = originalText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
		let message = `*${unescapedTitle}*`;

		if (summary) {
			// Unescape MarkdownV2 sequences in summary
			let unescapedSummary = summary.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
			// Convert MarkdownV2 bold (**text**) to WhatsApp bold (*text*)
			unescapedSummary = unescapedSummary.replace(/\*\*/g, '*');

			// Convert bullet points from * to - for WhatsApp compatibility
			unescapedSummary = unescapedSummary.replace(/^\*\s+/gm, '- ');
			unescapedSummary = unescapedSummary.replace(/\n\*\s+/g, '\n- ');

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
						if (typeof this.logger.warn === 'function') {
							this.logger.warn(`WhatsApp formatter: URL shortening failed, falling back to title-only: ${error.message}`);
						}
					}
				}
			}

			message += '\n\n*Sources*';
			citations.forEach(({ title = '', url = '' }) => {
				const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
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
			const unescapedExtra = extraText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
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
			sections.push(`*🔔 ${copy.labels.reminder}*\n${reminder.text}`);
		}

		if (recommended_action) {
			sections.push(`*🚨 ${copy.labels.action}*\n${recommended_action}`);
		}

		if (headline) {
			sections.push(headline);
		}

		const urgencyLabel = copy.urgencyLabels[urgency_level] || urgency_level;
		sections.push(`*${this._getUrgencyEmoji(urgency_level)} ${copy.labels.urgency}: ${urgencyLabel}*\n${urgency_reason}`);

		if (risk_warning) {
			sections.push(`*⚠️ ${copy.labels.caution}*\n${risk_warning}`);
		}

		const bullScenario = this._formatScenarioBlock(copy.labels.bull, scenarios.bull);
		const bearScenario = this._formatScenarioBlock(copy.labels.bear, scenarios.bear);
		if (bullScenario || bearScenario) {
			sections.push([`*${copy.labels.scenarios}*`, bullScenario, bearScenario].filter(Boolean).join('\n'));
		}

		if (insights.length > 0) {
			const insightSection = [`*${copy.labels.quickRead}*`];
			insights.forEach(insight => {
				const cleanInsight = insight.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
				insightSection.push(`- ${cleanInsight}`);
			});
			sections.push(insightSection.join('\n'));
		}

		const hasSupports = technical_levels.supports && technical_levels.supports.length > 0;
		const hasResistances = technical_levels.resistances && technical_levels.resistances.length > 0;
		if (!bullScenario && !bearScenario && (hasSupports || hasResistances)) {
			sections.push(this._formatKeyLevels(copy, technical_levels));
		}

		if (truncated) {
			sections.push('_(Message was truncated due to length)_');
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
						if (typeof this.logger.warn === 'function') {
							this.logger.warn(`WhatsApp formatter: URL shortening failed, falling back to title-only: ${error.message}`);
						}
					}
				}
			}

			const sourceLines = [`*${copy.labels.sources}*`];
			sources.forEach(({ title = '', url = '' }) => {
				const cleanTitle = title.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
				if (shortenedMap[url]) {
					sourceLines.push(`- ${cleanTitle}: ${shortenedMap[url]}`);
				} else if (url) {
					sourceLines.push(`- ${cleanTitle}: ${url}`);
				} else {
					sourceLines.push(`- ${cleanTitle}`);
				}
			});
			sections.push(sourceLines.join('\n'));
		}

		if (extraText) {
			const unescapedExtra = extraText.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
			sections.push(unescapedExtra);
		}

		const tokenLine = this._formatTokenUsage(tokenUsage);
		if (tokenLine) {
			sections.push(`_${tokenLine}_`);
		}

		return sections.filter(Boolean).join('\n\n');
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
