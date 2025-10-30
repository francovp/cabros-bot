require('dotenv').config();
const { enrichAlert } = require('./grounding');
const { validateAlert } = require('../../../../lib/validation');

// Telegram configuration
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;

// Markdown escaping utilities
const escapeMarkdown = (text) => {
	return text.replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
};

/**
 * Format enriched message content in MarkdownV2 style
 * @param {import('./types').EnrichedAlert} enriched Alert with grounding
 * @param {import('./types').MessageFormatterOptions} options Formatting options
 * @returns {string} Formatted message text with Markdown
 */
const formatEnrichedMessage = (enriched, options = {}) => {
	const { originalText, summary, citations, extraText, truncated = false } = enriched;

	// Normalize repeated backslashes (collapse sequences like "\\\\" -> "\\")
	// This helps when input already contains manual escaping so we avoid producing
	// excessive double-backslashes in the final message.
	const normalizeBackslashes = (s = '') => s.replace(/\\\\+/g, '\\');

	// Escape markdown special characters on normalized input
	const escapedText = escapeMarkdown(normalizeBackslashes(originalText));
	const escapedSummary = escapeMarkdown(normalizeBackslashes(summary));

	// Format citations with escaped titles and URLs
	const formattedSources = citations
		.map(({ title, url }) => {
			const escapedTitle = escapeMarkdown(normalizeBackslashes(title));
			// URLs must be formatted as [text](URL) in MarkdownV2
			return `[${escapedTitle}](${url})`;
		})
		.join(' / ');

	// Build the message
	let message = `*${escapedText}*`;

	// Add truncation notice if needed
	if (truncated) {
		message += '\n\n_(Message was truncated due to length)_';
	}

	// Add enriched content (we escape only the dynamic text parts above,
	// and avoid escaping the whole assembled message which would break
	// MarkdownV2 link markup like [title](url)).
	// Escape the small literal "extraText" snippet so special chars are safe.
	const escapedExtraText = escapeMarkdown(extraText);

	message += `\n\n*Contexto:*\n\n${escapedSummary}`;

	if (citations.length > 0) {
		message += `\n\n*Fuentes:* ${formattedSources}`;
	}

	message += `\n\n_${escapedExtraText}_`;

	console.debug('Formatted enriched message:', message);

	// Return the assembled message. Individual parts were escaped where needed
	// (originalText, summary, titles, and the small poweredBy snippet). Do not
	// run a second global escape over the whole message because that would
	// escape MarkdownV2 syntax characters (like '[' and '(') and break links.
	return message;
};

const sendAdminNotification = async (bot, error) => {
	if (ADMIN_CHAT_ID && bot) {
		try {
			const message = escapeMarkdown(`⚠️ Alert Grounding Error:\n${error.message}`);
			await bot.telegram.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'MarkdownV2' });
		} catch (e) {
			console.error('Failed to send admin notification:', e);
		}
	}
};

function postAlert(bot) {
	return async (req, res) => {
		const { body } = req;
		try {
			// Parse and validate alert text
			let alertText = '';
			if (typeof body === 'object' && 'text' in body) {
				console.debug('webhook/alert handler: body is an object');
				alertText = body.text;
			} else {
				console.debug('webhook/alert handler: body is text');
				alertText = body;
			}

			const { text } = validateAlert(alertText);

			let messageText;
			let enriched = false;

			// Only attempt grounding if enabled (check env at runtime so tests can toggle)
			if (process.env.ENABLE_GEMINI_GROUNDING === 'true') {
				try {
					console.debug('Starting grounding process');

					const enrichedAlert = await enrichAlert({ text });
					enriched = true;
					console.debug('Enriched alert result: ', enrichedAlert);
					messageText = formatEnrichedMessage(enrichedAlert);

					console.debug('Generated grounded summary with citations');
				} catch (error) {
					console.error('Grounding failed:', error);
					await sendAdminNotification(bot, error);

					// Fall back to original text
					messageText = escapeMarkdown(text);
					console.debug('Using original text due to grounding failure');
				}
			} else {
				// If grounding is disabled, just escape markdown
				messageText = escapeMarkdown(text);
				console.debug('Grounding disabled, using original text');
			}

			// Send message to Telegram
			if (bot && CHAT_ID) {
				console.debug('Sending message to telegram chat ID:', CHAT_ID);

				// Disable web page previews when we have our own enriched content
				const result = await bot.telegram.sendMessage(CHAT_ID, messageText, {
					parse_mode: 'MarkdownV2',
					disable_web_page_preview: enriched,
				});

				res.json({ success: true, messageId: result.message_id, enriched });
			} else {
				console.debug('Bot or chat ID undefined');
				res.sendStatus(200);
			}
		} catch (error) {
			console.debug('webhook/alert handler: Error processing request');
			console.error('webhook/alert handler:', error);
			const status = (error.response && error.response.error_code) || 500;
			const errorResponse = error.response || { error: 'Internal server error', details: error.message };
			res.status(status).send(errorResponse);
		}
	};
}

module.exports = {
	postAlert,
};
