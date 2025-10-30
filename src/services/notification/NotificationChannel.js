/**
 * NotificationChannel - Abstract base class for notification channels
 * Defines interface all notification channels must implement
 */

class NotificationChannel {
  /**
   * Channel identifier (e.g., "telegram", "whatsapp")
   * @type {string}
   */
  name = null;

  /**
   * Whether channel is configured and ready to send
   * @type {boolean}
   */
  enabled = false;

  /**
   * Check if channel is enabled
   * @returns {boolean}
   */
  isEnabled() {
    throw new Error('isEnabled() must be implemented by subclass');
  }

  /**
   * Send alert through this channel
   * @param {Object} alert - Alert object with text and optional enriched content
   * @returns {Promise<Object>} SendResult object with success, channel, messageId, error, etc.
   * @throws {Error} If not implemented by subclass
   */
  async send(alert) {
    throw new Error('send() must be implemented by subclass');
  }

  /**
   * Validate channel configuration on startup
   * @returns {Promise<Object>} ValidationResult with valid, message, and optional fields details
   * @throws {Error} If not implemented by subclass
   */
  async validate() {
    throw new Error('validate() must be implemented by subclass');
  }
}

module.exports = NotificationChannel;
