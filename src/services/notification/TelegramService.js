/**
 * TelegramService - Telegraf bot integration for Telegram alerts
 * Extends NotificationChannel to wrap existing Telegram bot functionality
 */

const NotificationChannel = require('./NotificationChannel');
const MarkdownV2Formatter = require('./formatters/markdownV2Formatter');

const DEFAULT_MAX_MESSAGE_LENGTH = 4000;

class TelegramService extends NotificationChannel {
	/**
   * @param {Object} config
   * @param {Object} config.bot - Telegraf bot instance
   * @param {string} config.botToken - Telegram bot token (optional, for validation)
   * @param {string} config.chatId - Destination Telegram chat ID
   * @param {Object} config.formatter - Message formatter (default: MarkdownV2Formatter)
   * @param {Object} config.logger - Logger instance (optional)
   */
	constructor(config = {}) {
		super();
		this.name = 'telegram';
		this.bot = config.bot;
		this.botToken = config.botToken || process.env.BOT_TOKEN;
		this.chatId = config.chatId || process.env.TELEGRAM_CHAT_ID;
		this.formatter = config.formatter || new MarkdownV2Formatter();
		this.logger = config.logger;
		this.maxMessageLength = config.maxMessageLength || DEFAULT_MAX_MESSAGE_LENGTH;
		this.enabled = false;
	}

	/**
   * Validate Telegram configuration on startup
   * @returns {Promise<{valid: boolean, message: string, fields?: Object}>}
   */
	async validate() {
		if (process.env.ENABLE_TELEGRAM_BOT !== 'true') {
			this.enabled = false;
			return { valid: true, message: 'Telegram disabled via env' };
		}

		if (!this.botToken) {
			return { valid: false, message: 'Missing BOT_TOKEN' };
		}

		if (!this.chatId) {
			return { valid: false, message: 'Missing TELEGRAM_CHAT_ID' };
		}

		if (!this.bot) {
			return { valid: false, message: 'Bot instance not provided' };
		}

		// Verify bot token by calling getMe
		try {
			const botInfo = await this.bot.telegram.getMe();
			this.logger?.info?.(`Telegram bot connected as @${botInfo.username} (ID: ${botInfo.id})`);
		} catch (error) {
			return { valid: false, message: `Invalid BOT_TOKEN: ${error.message}` };
		}

		this.enabled = true;
		return { valid: true, message: 'Telegram configured' };
	}

	/**
   * Check if service is enabled
   * @returns {boolean}
   */
	isEnabled() {
		return this.enabled;
	}

	/**
   * Send alert to Telegram via Telegraf bot
   * @param {Object} alert - Alert object with text and optional enriched content
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, error?: string}>}
   */
	async send(alert) {
		try {
			if (!this.bot) {
				return {
					success: false,
					channel: 'telegram',
					error: 'Bot instance not available',
				};
			}

			// Format message for Telegram MarkdownV2
			// If enriched is an object, use formatEnriched, otherwise format the text
			let formattedText;
			if (alert.enriched && typeof alert.enriched === 'object') {
				formattedText = this.formatter.formatEnriched(alert.enriched);
				console.debug('Formatted enriched content for Telegram:', formattedText);
			} else {
				formattedText = this.formatter.format(alert.enriched || alert.text);
				console.debug('Formatted text for Telegram:', formattedText);
			}

			const chatId = alert.telegramChatId || this.chatId;
			this.logger?.debug?.(`Sending to Telegram chat ${chatId}`);
			const messageParts = splitTelegramMessage(formattedText, this.maxMessageLength);

			// Send to Telegram with MarkdownV2 first, fallback to plain text on parse errors
			const messageIds = [];
			for (const messagePart of messageParts) {
				const result = await this.bot.telegram.sendMessage(chatId, messagePart, {
					parse_mode: 'MarkdownV2',
					disable_web_page_preview: !!alert.enriched,
				}).catch((err) => {
					const errMsg = (err && (err.description || err.message)) || '';
					// If MarkdownV2 parse fails (400 can't parse entities), retry as plain text
					if (errMsg.includes("can't parse entities")) {
						this.logger?.warn?.(`Telegram MarkdownV2 parse failed, retrying as plain text: ${errMsg}`);
						return this.bot.telegram.sendMessage(this.chatId, messagePart, {
							disable_web_page_preview: !!alert.enriched,
						});
					}
					throw err;
				});
				messageIds.push(String(result.message_id));
			}

			return {
				success: true,
				channel: 'telegram',
				messageId: messageIds.join(','),
				messageIds,
				messageCount: messageIds.length,
			};
		} catch (error) {
			this.logger?.error?.(`Failed to send to Telegram: ${error.message}`);
			return {
				success: false,
				channel: 'telegram',
				error: `Telegram error: ${error.message}`,
			};
		}
	}
}

function splitTelegramMessage(text, maxLength = DEFAULT_MAX_MESSAGE_LENGTH) {
	if (!text || typeof text !== 'string') {
		return [''];
	}

	if (text.length <= maxLength) {
		return [text];
	}

	const chunks = [];
	let remaining = text;

	while (remaining.length > maxLength) {
		let splitAt = remaining.lastIndexOf('\n\n', maxLength);
		if (splitAt < Math.floor(maxLength / 2)) {
			splitAt = remaining.lastIndexOf('\n', maxLength);
		}
		if (splitAt <= 0) {
			splitAt = maxLength;
		}

		const chunk = remaining.slice(0, splitAt).trimEnd();
		chunks.push(chunk || remaining.slice(0, maxLength));
		remaining = remaining.slice(splitAt).trimStart();
	}

	if (remaining) {
		chunks.push(remaining);
	}

	return chunks;
}

module.exports = TelegramService;
