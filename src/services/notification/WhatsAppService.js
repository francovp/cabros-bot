/**
 * WhatsAppService - GreenAPI integration for WhatsApp alerts
 * Extends NotificationChannel to provide WhatsApp-specific sending logic
 */

const NotificationChannel = require('./NotificationChannel');
const { sendWithRetry } = require('../../lib/retryHelper');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');

const GREEN_API_MESSAGE_LIMIT = 20000;

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

		// In preview environments (IS_PULL_REQUEST=true), prefer WHATSAPP_PREVIEW_CHAT_ID
		const isPreview = process.env.IS_PULL_REQUEST === 'true';
		this.chatId = config.chatId || (isPreview && process.env.WHATSAPP_PREVIEW_CHAT_ID) || process.env.WHATSAPP_CHAT_ID;
		this.urlShortener = config.urlShortener || null;
		this.formatter = config.formatter || new WhatsAppMarkdownFormatter({ urlShortener: this.urlShortener });
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
		try {
			const formattedText = await this._formatAlert(alert);
			const messageChunks = splitMessageIntoChunks(formattedText, GREEN_API_MESSAGE_LIMIT);
			const chatId = alert.whatsappChatId || this.chatId;

			if (messageChunks.length > 1) {
				this.logger?.warn?.(
					`WhatsApp message exceeded ${GREEN_API_MESSAGE_LIMIT} characters; sending ${messageChunks.length} parts instead of truncating`,
				);
				return this._sendChunkedMessage(messageChunks, chatId);
			}

			return sendWithRetry(
				({ signal } = {}) => this._sendMessageChunk(messageChunks[0], {
					chatId,
					includePreview: true,
					signal,
				}),
				3,
				this.logger,
			);
		} catch (error) {
			this.logger?.error?.(`Failed to send to WhatsApp: ${error.message}`);
			return {
				success: false,
				channel: 'whatsapp',
				error: error.message,
			};
		}
	}

	/**
   * Format alert text for WhatsApp delivery
   * @private
   * @param {Object} alert - Alert object
   * @returns {Promise<string>} Formatted message
   */
	async _formatAlert(alert) {
		// Format message for WhatsApp.
		// If enriched is an object, use formatEnriched (async with URL shortening), otherwise format the text.
		let formattedText;
		if (alert.enriched && typeof alert.enriched === 'object') {
			formattedText = await this.formatter.formatEnriched(alert.enriched);
			console.debug('Formatted enriched WhatsApp message length:', formattedText.length);
		} else {
			formattedText = this.formatter.format(alert.enriched || alert.text);
			console.debug('Formatted WhatsApp message length:', formattedText.length);
		}

		return formattedText;
	}

	/**
   * Send a formatted WhatsApp payload through GreenAPI
   * @private
   * @param {string} message - Preformatted WhatsApp message
   * @param {Object} options - Delivery options
	 * @param {string} options.chatId - Destination WhatsApp chat/group ID
   * @param {boolean} options.includePreview - Whether to include the custom preview payload
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, messageIds?: string[], messageCount?: number, error?: string}>}
   */
	async _sendMessageChunk(message, { chatId = this.chatId, includePreview = false } = {}) {
		try {
			const payload = {
				chatId,
				message,
			};

			if (includePreview) {
				payload.customPreview = {
					title: 'Trading View Alert',
				};
			}

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
						messageIds: [data.idMessage],
						messageCount: 1,
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
				if (error.name === 'AbortError') {
					this.logger?.error?.('GreenAPI request timeout (10s)');
					throw new Error('GreenAPI request timeout');
				}

				throw error;
			} finally {
				clearTimeout(timeoutId);
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

	/**
   * Send a WhatsApp message that has been split into multiple chunks.
   * Each chunk retries independently to avoid duplicating already delivered parts.
   * @private
   * @param {Array<string>} messageChunks - Ordered message chunks
	 * @param {string} chatId - Destination WhatsApp chat/group ID
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, messageIds?: string[], messageCount?: number, error?: string}>}
   */
	async _sendChunkedMessage(messageChunks, chatId) {
		const messageIds = [];
		const startedAt = Date.now();
		let totalAttempts = 0;

		for (let index = 0; index < messageChunks.length; index += 1) {
			const includePreview = index === 0;
			const result = await sendWithRetry(
				({ signal } = {}) => this._sendMessageChunk(messageChunks[index], {
					chatId,
					includePreview,
					signal,
				}),
				3,
				this.logger,
			);
			totalAttempts += result.attemptCount || 1;

			if (!result.success) {
				return {
					success: false,
					channel: 'whatsapp',
					messageId: messageIds.join(','),
					messageIds,
					messageCount: messageIds.length,
					error: result.error,
					attemptCount: totalAttempts,
					durationMs: Date.now() - startedAt,
					splitMessageCount: messageChunks.length,
					failedPart: index + 1,
				};
			}

			if (result.messageId) {
				messageIds.push(result.messageId);
			}
		}

		return {
			success: true,
			channel: 'whatsapp',
			messageId: messageIds.join(','),
			messageIds,
			messageCount: messageIds.length,
			attemptCount: totalAttempts,
			durationMs: Date.now() - startedAt,
			splitMessageCount: messageChunks.length,
		};
	}
}

module.exports = WhatsAppService;
