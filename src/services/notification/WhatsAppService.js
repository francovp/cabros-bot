/**
 * WhatsAppService - GreenAPI integration for WhatsApp alerts
 * Extends NotificationChannel to provide WhatsApp-specific sending logic
 */

const NotificationChannel = require('./NotificationChannel');
const { sendWithRetry } = require('../../lib/retryHelper');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');
const { isPreviewEnvironment } = require('../../lib/deploymentEnvironment');

const GREEN_API_MESSAGE_LIMIT = 20000;

// GreenAPI /sendTemplate 4xx error bodies that indicate the template is definitively broken.
// On these, we fall back to freeform; other 4xx (auth, rate-limit) remain non-fallback failures.
const TEMPLATE_FALLBACK_ERROR_PATTERNS = [
	/template\s+not\s+found/i,
	/parameter\s+count\s+mismatch/i,
	/invalid\s+template/i,
	/template\s+does\s+not\s+exist/i,
	/unknown\s+template/i,
];

/**
 * Determine whether a raw 4xx body string matches a known template-definition error
 * that should trigger a freeform fallback for this delivery.
 * @param {string} rawBody
 * @returns {boolean}
 */
function isTemplateFallbackError(rawBody) {
	if (!rawBody || typeof rawBody !== 'string') return false;
	return TEMPLATE_FALLBACK_ERROR_PATTERNS.some((re) => re.test(rawBody));
}

class WhatsAppService extends NotificationChannel {
	/**
	 * @param {Object} config
	 * @param {string} config.apiUrl        - GreenAPI base URL (e.g. https://xxxx.api.green-api.com/waInstance1234/)
	 * @param {string} config.apiKey        - GreenAPI API key
	 * @param {string} config.chatId        - Destination WhatsApp chat/group ID
	 * @param {Object} config.formatter     - Message formatter (default: WhatsAppMarkdownFormatter)
	 * @param {Object} config.logger        - Logger instance (optional)
	 */
	constructor(config = {}) {
		super();
		this.name = 'whatsapp';
		this.apiUrl = config.apiUrl || process.env.WHATSAPP_API_URL;
		this.apiKey = config.apiKey || process.env.WHATSAPP_API_KEY;

		// In preview environments (IS_PULL_REQUEST=true), prefer WHATSAPP_PREVIEW_CHAT_ID
		const isPreview = isPreviewEnvironment() || process.env.IS_PULL_REQUEST === 'true';
		this.chatId = config.chatId || (isPreview && process.env.WHATSAPP_PREVIEW_CHAT_ID) || process.env.WHATSAPP_CHAT_ID;
		this.urlShortener = config.urlShortener || null;
		this.formatter = config.formatter || new WhatsAppMarkdownFormatter({ urlShortener: this.urlShortener });
		this.logger = config.logger;
		this.enabled = false;

		// Template mode counters and last-error tracking for /api/status
		this._templateSent = 0;
		this._templateFallbacks = 0;
		this._lastTemplateError = null;
		this._lastTemplateErrorAt = null;
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
	 * Return template-mode status (non-secret) for /api/status dependency reporting.
	 * @returns {{enabled: boolean, templateName: string|null, sent: number, fallbacks: number, lastError: string|null, lastErrorAt: string|null}}
	 */
	getTemplateStatus() {
		const templateName = process.env.WHATSAPP_TEMPLATE_NAME || null;
		return {
			enabled: !!templateName,
			templateName,
			sent: this._templateSent,
			fallbacks: this._templateFallbacks,
			lastError: this._lastTemplateError,
			lastErrorAt: this._lastTemplateErrorAt,
		};
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
	 * Build the GreenAPI sendTemplate endpoint URL from the freeform base URL.
	 * GreenAPI base URL format: https://XXXX.api.green-api.com/waInstanceYYYY/
	 * Template URL format:      https://XXXX.api.green-api.com/waInstanceYYYY/sendTemplate/APIKEY
	 * @private
	 * @returns {string|null} Full template URL or null if base URL is not set
	 */
	_buildTemplateUrl() {
		if (!this.apiUrl || !this.apiKey) return null;
		// Strip any trailing sendMessage path from the base URL, then append sendTemplate
		const base = this.apiUrl
			.replace(/\/sendMessage\/?$/i, '')
			.replace(/\/+$/, '');
		return `${base}/sendTemplate/${this.apiKey}`;
	}

	/**
	 * Extract ordered template parameters from an alert object.
	 * Missing fields produce an empty string, not an error.
	 * The parameter order follows WHATSAPP_TEMPLATE_PARAM_ORDER (default: symbol,price,action,setup,timeframe,source).
	 * @private
	 * @param {Object} alert - Alert object
	 * @returns {Array<{default: string}>} GreenAPI params array
	 */
	_extractTemplateParams(alert) {
		const rawOrder = process.env.WHATSAPP_TEMPLATE_PARAM_ORDER || 'symbol,price,action,setup,timeframe,source';
		const paramOrder = rawOrder.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

		const enriched = alert && typeof alert.enriched === 'object' ? alert.enriched : {};
		const text = (alert && alert.text) || '';

		// Best-effort extraction helpers — fall back to empty string (never throw)
		const extractors = {
			symbol: () => enriched.symbol || (text.match(/\b[A-Z]{2,10}(?:USDT?|BTC|ETH|USD)?\b/)?.[0]) || '',
			price: () => {
				const p = enriched.price;
				if (p !== undefined && p !== null) return String(p);
				return text.match(/\$[\d,.]+/)?.[0] || '';
			},
			action: () => enriched.action || enriched.signal || '',
			setup: () => enriched.setupType || enriched.setup || '',
			timeframe: () => enriched.timeframe || '',
			source: () => (alert && alert.source) || '',
		};

		return paramOrder.map((key) => {
			try {
				const value = extractors[key] ? extractors[key]() : (enriched[key] !== undefined ? String(enriched[key]) : '');
				return { default: String(value || '') };
			} catch {
				return { default: '' };
			}
		});
	}

	/**
	 * Attempt to send via GreenAPI sendTemplate endpoint.
	 * Returns { success, templateSent, shouldFallback } where shouldFallback=true means
	 * the caller should retry as freeform for this one alert.
	 * @private
	 * @param {Object} alert
	 * @param {string} chatId
	 * @param {AbortSignal|undefined} signal
	 * @returns {Promise<{success: boolean, channel: string, templateSent?: boolean, shouldFallback?: boolean, messageId?: string, error?: string, category?: string}>}
	 */
	async _sendTemplate(alert, chatId, signal) {
		const templateUrl = this._buildTemplateUrl();
		if (!templateUrl) {
			return { success: false, channel: 'whatsapp', error: 'Template URL could not be built', shouldFallback: true };
		}

		const templateName = process.env.WHATSAPP_TEMPLATE_NAME;
		const namespace = process.env.WHATSAPP_TEMPLATE_NAMESPACE || '';
		const languageCode = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en';
		const params = this._extractTemplateParams(alert);

		const payload = {
			chatId,
			name: templateName,
			languageCode,
			params,
		};
		if (namespace) {
			payload.namespace = namespace;
		}

		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 10000);
		const forwardAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener('abort', forwardAbort, { once: true });

		try {
			const response = await fetch(templateUrl, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload),
				signal: controller.signal,
			});

			const rawText = await response.text().catch(() => '');

			if (!response.ok) {
				const isFallback = response.status >= 400 && response.status < 500
					&& response.status !== 401
					&& response.status !== 429
					&& isTemplateFallbackError(rawText);

				const sanitizedError = this._sanitizeText(rawText).substring(0, 200)
					|| `GreenAPI template ${response.status}`;

				this._lastTemplateError = sanitizedError;
				this._lastTemplateErrorAt = new Date().toISOString();
				this.logger?.warn?.(`[WhatsApp] Template send failed (${response.status}): ${sanitizedError}. Fallback: ${isFallback}`);

				if (isFallback) {
					this._templateFallbacks += 1;
					return { success: false, channel: 'whatsapp', error: sanitizedError, shouldFallback: true };
				}

				const { category, sanitizedMessage } = this._classifyAndSanitizeHttpError(response.status, rawText);
				return { success: false, channel: 'whatsapp', error: sanitizedMessage, category };
			}

			let data;
			try {
				data = JSON.parse(rawText);
			} catch {
				// Some GreenAPI responses are empty on success
				data = {};
			}

			if (data && data.idMessage) {
				this._templateSent += 1;
				return {
					success: true,
					channel: 'whatsapp',
					messageId: data.idMessage,
					messageIds: [data.idMessage],
					messageCount: 1,
					templateSent: true,
				};
			}

			// Empty 2xx body — treat as success (some GreenAPI instances return 200 with no body)
			this._templateSent += 1;
			return {
				success: true,
				channel: 'whatsapp',
				messageId: null,
				messageCount: 1,
				templateSent: true,
			};
		} catch (err) {
			if (signal?.aborted) {
				return { success: false, channel: 'whatsapp', error: signal.reason?.message || 'Operation aborted', aborted: true };
			}
			if (err.name === 'AbortError') {
				this._lastTemplateError = 'Template request timeout (10s)';
				this._lastTemplateErrorAt = new Date().toISOString();
				return { success: false, channel: 'whatsapp', error: 'WhatsApp template request timeout (10s)', category: 'TIMEOUT' };
			}
			const msg = this._sanitizeText(err.message || String(err));
			this._lastTemplateError = msg;
			this._lastTemplateErrorAt = new Date().toISOString();
			return { success: false, channel: 'whatsapp', error: msg, category: 'PROVIDER_ERROR' };
		} finally {
			clearTimeout(timeoutId);
			signal?.removeEventListener('abort', forwardAbort);
		}
	}

	/**
	 * Send alert to WhatsApp via GreenAPI with retry logic.
	 * When options.template === true and WHATSAPP_TEMPLATE_NAME is set,
	 * attempts template delivery first with fail-open fallback to freeform.
	 * @param {Object} alert   - Alert object with text and optional enriched content
	 * @param {Object} options - Delivery options (signal, template)
	 * @returns {Promise<{success: boolean, channel: string, messageId?: string, error?: string, category?: string, attemptCount?: number, durationMs?: number, templateSent?: boolean}>}
	 */
	async send(alert, options = {}) {
		try {
			if (options.signal?.aborted) {
				return {
					success: false,
					channel: 'whatsapp',
					error: options.signal.reason?.message || options.signal.reason || 'Operation aborted',
					aborted: true,
				};
			}

			const chatId = (alert && alert.whatsappChatId) || this.chatId;
			const useTemplate = options.template === true && !!process.env.WHATSAPP_TEMPLATE_NAME;

			// --- Template path ---
			if (useTemplate) {
				const templateResult = await this._sendTemplate(alert, chatId, options.signal);
				if (templateResult.success || !templateResult.shouldFallback) {
					return templateResult;
				}
				// Fall through to freeform delivery for this single alert
				this.logger?.warn?.('[WhatsApp] Falling back from template to freeform delivery for this alert');
			}

			// --- Freeform path (default / fallback) ---
			const formattedText = await this._formatAlert(alert);
			const messageChunks = splitMessageIntoChunks(formattedText, GREEN_API_MESSAGE_LIMIT);

			if (messageChunks.length > 1) {
				this.logger?.warn?.(
					`WhatsApp message exceeded ${GREEN_API_MESSAGE_LIMIT} characters; sending ${messageChunks.length} parts instead of truncating`,
				);
				return this._sendChunkedMessage(messageChunks, chatId, options);
			}

			return sendWithRetry(
				({ signal } = {}) => this._sendMessageChunk(messageChunks[0], {
					chatId,
					includePreview: true,
					signal,
				}),
				3,
				this.logger,
				{ signal: options.signal },
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
	async _sendMessageChunk(message, { chatId = this.chatId, includePreview = false, signal } = {}) {
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
			const forwardAbort = () => controller.abort(signal.reason);
			signal?.addEventListener('abort', forwardAbort, { once: true });

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
				if (signal?.aborted) {
					return {
						success: false,
						channel: 'whatsapp',
						error: signal.reason?.message || signal.reason || 'Operation aborted',
						aborted: true,
					};
				}
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
				signal?.removeEventListener('abort', forwardAbort);
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
	async _sendChunkedMessage(messageChunks, chatId, options = {}) {
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
				{ signal: options.signal },
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

/**
 * Return a static snapshot of the WhatsApp template configuration for /api/status.
 * Does not expose secrets (WHATSAPP_TEMPLATE_NAME is a non-secret template ID).
 * Instance-level counters (sent, fallbacks) are not included here since status.js
 * has no access to the live WhatsAppService instance.
 * @returns {{enabled: boolean, templateName: string|null, languageCode: string|null}}
 */
module.exports.getWhatsAppTemplateStatus = function getWhatsAppTemplateStatus() {
	const templateName = process.env.WHATSAPP_TEMPLATE_NAME || null;
	const languageCode = templateName ? (process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'en') : null;
	return {
		enabled: !!templateName,
		templateName,
		languageCode,
	};
};
