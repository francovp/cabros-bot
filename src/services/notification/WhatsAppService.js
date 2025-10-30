/**
 * WhatsAppService - GreenAPI integration for WhatsApp alerts
 * Extends NotificationChannel to provide WhatsApp-specific sending logic
 */

const NotificationChannel = require('./NotificationChannel');
const { sendWithRetry } = require('../../lib/retryHelper');
const { truncateMessage } = require('../../lib/messageHelper');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');

class WhatsAppService extends NotificationChannel {
  /**
   * @param {Object} config
   * @param {string} config.apiUrl - GreenAPI base URL
   * @param {string} config.apiKey - GreenAPI API key
   * @param {string} config.chatId - Destination WhatsApp chat/group ID
   * @param {Object} config.formatter - Message formatter (default: WhatsAppMarkdownFormatter)
   * @param {Object} config.logger - Logger instance (optional)
   */
  constructor(config = {}) {
    super();
    this.name = 'whatsapp';
    this.apiUrl = config.apiUrl || process.env.WHATSAPP_API_URL;
    this.apiKey = config.apiKey || process.env.WHATSAPP_API_KEY;
    this.chatId = config.chatId || process.env.WHATSAPP_CHAT_ID;
    this.formatter = config.formatter || new WhatsAppMarkdownFormatter();
    this.logger = config.logger;
    this.enabled = false;
  }

  /**
   * Validate WhatsApp configuration on startup
   * @returns {Promise<{valid: boolean, message: string, fields?: Object}>}
   */
  async validate() {
    if (process.env.ENABLE_WHATSAPP_ALERTS !== 'true') {
      this.enabled = false;
      return { valid: true, message: 'WhatsApp disabled via env' };
    }

    if (!this.apiUrl || !this.apiKey || !this.chatId) {
      return {
        valid: false,
        message: 'Missing WHATSAPP_API_URL, WHATSAPP_API_KEY, or WHATSAPP_CHAT_ID',
        fields: {
          apiUrl: !!this.apiUrl,
          apiKey: !!this.apiKey,
          chatId: !!this.chatId,
        },
      };
    }

    this.enabled = true;
    return { valid: true, message: 'WhatsApp configured' };
  }

  /**
   * Check if service is enabled
   * @returns {boolean}
   */
  isEnabled() {
    return this.enabled;
  }

  /**
   * Send alert to WhatsApp via GreenAPI with retry logic
   * @param {Object} alert - Alert object with text and optional enriched content
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, error?: string, attemptCount?: number, durationMs?: number}>}
   */
  async send(alert) {
    const sendFn = async () => {
      return this._sendSingle(alert);
    };

    return sendWithRetry(sendFn, 3, this.logger);
  }

  /**
   * Single send attempt to GreenAPI
   * @private
   * @param {Object} alert - Alert object
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, error?: string}>}
   */
  async _sendSingle(alert) {
    try {
      // Format message for WhatsApp
      // If enriched is an object, use formatEnriched, otherwise format the text
      let formattedText;
      if (alert.enriched && typeof alert.enriched === 'object') {
        formattedText = this.formatter.formatEnriched(alert.enriched);
      } else {
        formattedText = this.formatter.format(alert.enriched || alert.text);
      }

      // Truncate to GreenAPI limit
      const truncatedText = truncateMessage(formattedText, 20000);

      // Build GreenAPI payload
      const payload = {
        chatId: this.chatId,
        message: truncatedText,
        customPreview: {
          title: 'Trading View Alert',
        },
      };

      this.logger?.debug?.(`Sending to GreenAPI: ${this.apiUrl}${this.apiKey.substring(0, 5)}...`);

      // Use native fetch with timeout
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s timeout

      try {
        const response = await fetch(`${this.apiUrl}${this.apiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorText = await response.text();
          this.logger?.error?.(`GreenAPI error: ${response.status} ${errorText}`);
          return {
            success: false,
            channel: 'whatsapp',
            error: `GreenAPI ${response.status}: ${errorText}`,
          };
        }

        const data = await response.json();

        // GreenAPI returns idMessage on success, or error properties on failure
        // Note: data.success field is unreliable; check for idMessage presence instead
        if (data.idMessage) {
          return {
            success: true,
            channel: 'whatsapp',
            messageId: data.idMessage,
          };
        }

        // If no idMessage, treat as error
        const errorMsg = data.error || data.errorMessage || 'Unknown error';
        this.logger?.warn?.(`GreenAPI returned error: ${errorMsg}`);
        return {
          success: false,
          channel: 'whatsapp',
          error: `GreenAPI error: ${errorMsg}`,
        };
      } catch (error) {
        clearTimeout(timeoutId);

        if (error.name === 'AbortError') {
          this.logger?.error?.('GreenAPI request timeout (10s)');
          throw new Error('GreenAPI request timeout');
        }

        throw error;
      }
    } catch (error) {
      this.logger?.error?.(`Failed to send to WhatsApp: ${error.message}`);
      return {
        success: false,
        channel: 'whatsapp',
        error: error.message,
      };
    }
  }
}

module.exports = WhatsAppService;
