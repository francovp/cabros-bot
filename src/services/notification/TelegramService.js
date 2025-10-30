/**
 * TelegramService - Telegraf bot integration for Telegram alerts
 * Extends NotificationChannel to wrap existing Telegram bot functionality
 */

const NotificationChannel = require('./NotificationChannel');
const MarkdownV2Formatter = require('./formatters/markdownV2Formatter');

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
    this.enabled = false;
  }

  /**
   * Validate Telegram configuration on startup
   * @returns {Promise<{valid: boolean, message: string, fields?: Object}>}
   */
  async validate() {
    if (!this.botToken) {
      return { valid: false, message: 'Missing BOT_TOKEN' };
    }

    if (!this.chatId) {
      return { valid: false, message: 'Missing TELEGRAM_CHAT_ID' };
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
      } else {
        formattedText = this.formatter.format(alert.enriched || alert.text);
      }

      this.logger?.debug?.(`Sending to Telegram chat ${this.chatId}`);

      // Send to Telegram
      const result = await this.bot.telegram.sendMessage(this.chatId, formattedText, {
        parse_mode: 'MarkdownV2',
        disable_web_page_preview: !!alert.enriched,
      });

      return {
        success: true,
        channel: 'telegram',
        messageId: String(result.message_id),
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

module.exports = TelegramService;
