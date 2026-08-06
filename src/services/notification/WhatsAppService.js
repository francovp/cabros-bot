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
	 * Sanitize text to remove raw HTML tags and sensitive secrets (API keys, tokens)
	 * @private
	 * @param {string} text - Raw text to sanitize
	 * @returns {string} Sanitized string
	 */
	_sanitizeText(text) {
		if (typeof text !== 'string') {
			return '';
		}

		let sanitized = text.replace(/<[^>]*>/g, '');
		if (this.apiKey) {
			sanitized = sanitized.split(this.apiKey).join('[REDACTED]');
		}
		if (process.env.WHATSAPP_API_KEY) {
			sanitized = sanitized.split(process.env.WHATSAPP_API_KEY).join('[REDACTED]');
		}

		// Mask generic token patterns (e.g. secret_token_...)
		sanitized = sanitized.replace(/secret_token_\w+/gi, '[REDACTED]');
		return sanitized.trim();
	}

	/**
	 * Classify HTTP status and sanitize raw error text from GreenAPI
	 * @private
	 * @param {number} status - HTTP status code
	 * @param {string} rawText - Raw error response text
	 * @returns {{category: string, sanitizedMessage: string}}
	 */
	_classifyAndSanitizeHttpError(status, rawText) {
		const cleanText = this._sanitizeText(rawText);
		let category = 'PROVIDER_ERROR';
		let label = 'Provider server error';

		if (status === 401 || status === 403) {
			category = 'UNAUTHORIZED';
			label = 'Provider authentication failed';
		} else if (status === 429) {
			category = 'RATE_LIMITED';
			label = 'Provider rate limit exceeded';
		} else if (status >= 400 && status < 500) {
			category = 'CLIENT_ERROR';
			label = 'Provider request rejected';
		} else if (status >= 500) {
			category = 'PROVIDER_ERROR';
			label = 'Provider server error';
		}

		const detail = cleanText ? `: ${cleanText.substring(0, 150)}` : '';
		return {
			category,
			sanitizedMessage: `GreenAPI ${status} (${label})${detail}`,
		};
	}

	/**
   * Send alert to WhatsApp via GreenAPI with retry logic
   * @param {Object} alert - Alert object with text and optional enriched content
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, error?: string, category?: string, attemptCount?: number, durationMs?: number}>}
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
			const errorMsg = this._sanitizeText((error && error.message) || String(error));
			this.logger?.error?.(`Failed to send to WhatsApp: ${errorMsg}`);
			return {
				success: false,
				channel: 'whatsapp',
				error: errorMsg,
				category: 'PROVIDER_ERROR',
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
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, messageIds?: string[], messageCount?: number, error?: string, category?: string, ambiguous?: boolean}>}
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

			const keySnippet = this.apiKey ? `${String(this.apiKey).substring(0, 5)}...` : 'undefined';
			this.logger?.debug?.(`Sending to GreenAPI: ${this.apiUrl}${keySnippet}`);

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
					const rawText = await response.text().catch(() => '');
					const { category, sanitizedMessage } = this._classifyAndSanitizeHttpError(response.status, rawText);
					this.logger?.error?.(`GreenAPI error: ${response.status} ${category}`);
					return {
						success: false,
						channel: 'whatsapp',
						error: sanitizedMessage,
						category,
						statusCode: response.status,
					};
				}

				let data;
				try {
					data = await response.json();
				} catch (jsonErr) {
					this.logger?.error?.('GreenAPI returned non-JSON response');
					return {
						success: false,
						channel: 'whatsapp',
						error: 'WhatsApp provider returned non-JSON response',
						category: 'INVALID_RESPONSE',
						statusCode: response.status,
					};
				}

				// GreenAPI returns idMessage on success, or error properties on failure
				// Note: data.success field is unreliable; check for idMessage presence instead
				if (data && data.idMessage) {
					return {
						success: true,
						channel: 'whatsapp',
						messageId: data.idMessage,
						messageIds: [data.idMessage],
						messageCount: 1,
					};
				}

				// If no idMessage, check for error property or handle ambiguous outcome
				const rawErr = data?.error || data?.errorMessage || data?.message;
				if (rawErr) {
					const errorMsg = this._sanitizeText(String(rawErr));
					this.logger?.warn?.(`GreenAPI returned error: ${errorMsg}`);
					return {
						success: false,
						channel: 'whatsapp',
						error: `GreenAPI error: ${errorMsg}`,
						category: 'PROVIDER_ERROR',
					};
				}

				this.logger?.warn?.('GreenAPI response missing message ID (ambiguous outcome)');
				return {
					success: false,
					channel: 'whatsapp',
					error: 'WhatsApp provider response missing message ID (ambiguous outcome)',
					category: 'AMBIGUOUS_OUTCOME',
					ambiguous: true,
				};
			} catch (error) {
				if (error.name === 'AbortError') {
					this.logger?.error?.('GreenAPI request timeout (10s)');
					return {
						success: false,
						channel: 'whatsapp',
						error: 'WhatsApp provider request timeout (10s)',
						category: 'TIMEOUT',
					};
				}

				throw error;
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			const errorMsg = this._sanitizeText((error && error.message) || String(error));
			this.logger?.error?.(`Failed to send to WhatsApp: ${errorMsg}`);
			return {
				success: false,
				channel: 'whatsapp',
				error: errorMsg,
				category: 'PROVIDER_ERROR',
			};
		}
	}

	/**
   * Send a WhatsApp message that has been split into multiple chunks.
   * Each chunk retries independently to avoid duplicating already delivered parts.
   * @private
   * @param {Array<string>} messageChunks - Ordered message chunks
	 * @param {string} chatId - Destination WhatsApp chat/group ID
   * @returns {Promise<{success: boolean, channel: string, messageId?: string, messageIds?: string[], messageCount?: number, error?: string, category?: string}>}
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
					category: result.category || 'PROVIDER_ERROR',
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

