/**
 * WhatsAppMarkdownFormatter - Formats enriched alerts for WhatsApp
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, `code`, ```monospace```
 * Converts MarkdownV2 escape sequences to WhatsApp-friendly format
 */

const { formatHtfAlignment } = require('./htfAlignmentFormatter');

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
		const {
			originalText = '',
			summary = '',
			citations = [],
			extraText = '',
			tokenUsage,
			time_horizon,
			timeHorizon,
			invalidation_hint,
			invalidationHint,
		} = enriched;

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

		const horizonVal = time_horizon || timeHorizon;
		if (horizonVal && typeof horizonVal === 'string' && horizonVal.trim() && (!summary || !summary.includes('Horizonte:'))) {
			const horizonLabels = {
				very_short_term: 'Muy corto plazo',
				short_term: 'Corto plazo',
				medium_term: 'Medio plazo',
				long_term: 'Largo plazo',
			};
			const horizonLabel = horizonLabels[horizonVal.toLowerCase()] || horizonVal;
			message += `\n\n*Horizonte:* ${horizonLabel}`;
		}

		const invalidationVal = invalidation_hint || invalidationHint;
		if (invalidationVal && typeof invalidationVal === 'string' && invalidationVal.trim() && (!summary || !summary.includes('Invalidación:'))) {
			const cleanInvalidation = invalidationVal.trim().replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
			message += `\n\n*Invalidación:* ${cleanInvalidation}`;
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
		const {
			original_text = '',
			sentiment = 'NEUTRAL',
			sentiment_score = 0,
			insights = [],
			technical_levels = { supports: [], resistances: [] },
			invalidation_level,
			target_level,
			setup_type,
			risk_reward_ratio,
			sources = [],
			truncated = false,
			extraText = '',
			tokenUsage,
		} = enriched;

		// Unescape MarkdownV2 sequences to get plain text/WhatsApp markdown
		const unescapedText = original_text.replace(
			/\\([_*[\]()~`>#+\-=|{}.!])/g,
			'$1',
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
				const cleanInsight = insight.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
				message += `\n• ${cleanInsight}`;
			});
		}

		// Sentiment
		const sentimentEmoji = sentiment === 'BULLISH' ? '🚀' : sentiment === 'BEARISH' ? '🔻' : '😐';
		const score = sentiment_score.toFixed(2);
		message += `\n\nSentiment: ${sentiment} ${sentimentEmoji} (${score})`;

		const htfLine = formatHtfAlignment(enriched);
		if (htfLine) {
			message += `\n${htfLine}`;
		}

		// Technical Levels
		const hasSupports = technical_levels.supports && technical_levels.supports.length > 0;
		const hasResistances = technical_levels.resistances && technical_levels.resistances.length > 0;

		if (hasSupports || hasResistances) {
			message += '\n\n*Technical Levels*';
			if (hasSupports) {
				const supports = technical_levels.supports.map(s => String(s)).join(', ');
				message += `\nSupports: ${supports}`;
			}
			if (hasResistances) {
				const resistances = technical_levels.resistances.map(r => String(r)).join(', ');
				message += `\nResistances: ${resistances}`;
			}
		}

		const riskParameters = [
			['Setup', setup_type],
			['Invalidation', invalidation_level],
			['Target', target_level],
			['Risk/Reward', risk_reward_ratio],
		]
			.map(([label, value]) => [
				label,
				typeof value === 'number' && Number.isFinite(value)
					? String(value)
					: typeof value === 'string' ? value.trim() : '',
			])
			.filter(([, value]) => value);

		if (riskParameters.length > 0) {
			message += '\n\n*Risk Parameters*';
			riskParameters.forEach(([label, value]) => {
				const cleanValue = value.replace(/\\([_*[\]()~`>#+\-=|{}.!])/g, '$1');
				message += `\n${label}: ${cleanValue}`;
			});
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
			sources.forEach(({ title = '', url = '' }) => {
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

		// Model metadata footer
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
