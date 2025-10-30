/**
 * NotificationManager - Orchestrates multi-channel alert sending
 * Manages Telegram and WhatsApp services, handles parallel sending and retry logic
 */

class NotificationManager {
  /**
   * @param {Object} telegramService - TelegramService instance
   * @param {Object} whatsappService - WhatsAppService instance
   */
  constructor(telegramService, whatsappService) {
    this.channels = new Map([
      ['telegram', telegramService],
      ['whatsapp', whatsappService],
    ]);
  }

  /**
   * Validate all notification channels on startup
   * @returns {Promise<Array>} Array of validation results
   */
  async validateAll() {
    const results = [];
    for (const [name, channel] of this.channels) {
      try {
        const result = await channel.validate();
        console.log(
          `Notification channel ${name}: ${result.valid ? 'ENABLED' : 'DISABLED'} - ${result.message}`
        );
        results.push(result);
      } catch (error) {
        console.error(`Error validating ${name} channel:`, error.message);
        results.push({ valid: false, message: `Validation error: ${error.message}` });
      }
    }
    return results;
  }

  /**
   * Get list of enabled channel names
   * @returns {Array<string>} Array of enabled channel names
   */
  getEnabledChannels() {
    return Array.from(this.channels.values())
      .filter((ch) => ch.isEnabled())
      .map((ch) => ch.name);
  }

  /**
   * Send alert to all enabled channels in parallel
   * @param {Object} alert - Alert object with text and optional enriched content
   * @returns {Promise<Array>} Array of SendResult objects (one per enabled channel)
   */
  async sendToAll(alert) {
    const enabledChannels = Array.from(this.channels.values()).filter((ch) => ch.isEnabled());

    if (enabledChannels.length === 0) {
      console.warn('No notification channels enabled');
      return [];
    }

    const sendPromises = enabledChannels.map((ch) => ch.send(alert));
    const results = await Promise.allSettled(sendPromises);

    return results.map((r, idx) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            success: false,
            channel: enabledChannels[idx].name,
            error: r.reason?.message || 'Unknown error',
          }
    );
  }
}

module.exports = NotificationManager;
