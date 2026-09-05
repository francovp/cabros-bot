/**
 * WhatsAppService - GreenAPI integration for WhatsApp alerts
 * Extends NotificationChannel to provide WhatsApp-specific sending logic
 */

const NotificationChannel = require('./NotificationChannel');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');
const { isPreviewEnvironment } = require('../../lib/deploymentEnvironment');

const GREEN_API_MESSAGE_LIMIT = 20000;

const WHATSAPP_MAX_RETRIES = 3;
const WHATSAPP_FALLBACK_RETRY_DELAY_MS = 1000;
const WHATSAPP_MAX_RETRY_DELAY_MS = 10000;
const WHATSAPP_MAX_TOTAL_RETRY_WAIT_MS = 10000;

const RETRYABLE_CATEGORIES = new Set(['RATE_LIMITED', 'TIMEOUT', 'PROVIDER_ERROR']);

function parseRetryAfterHeader(value) {
	if (typeof value !== 'string' || !value) {
		return null;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return null;
	}
	// Honor decimal seconds and integer seconds, but ignore HTTP-date values.
	if (/^\d+(\.\d+)?$/.test(trimmed)) {
		const seconds = Number(trimmed);
		if (Number.isFinite(seconds) && seconds >= 0) {
			return Math.max(1, Math.round(seconds * 1000));
		}
	}
	return null;
}

function isRetryableResult(result) {
	if (!result) {
		return true; // Treat thrown errors as retryable transport failures.
	}
	if (result.aborted) {
		return false;
	}
	const category = result.category;
	if (category === 'UNAUTHORIZED' || category === 'CLIENT_ERROR') {
		return false;
	}
	if (category === 'AMBIGUOUS_OUTCOME' || category === 'INVALID_RESPONSE') {
		return false;
	}
	return RETRYABLE_CATEGORIES.has(category);
}

function extractRetryAfterMs(result) {
	if (!result) {
		return null;
	}
	const headerValue = typeof result.retryAfterHeader === 'string' ? result.retryAfterHeader : null;
	return parseRetryAfterHeader(headerValue);
}

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
		const isPreview = isPreviewEnvironment() || process.env.IS_PULL_REQUEST === 'true';
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
	async send(alert, options = {}) {
		try {
			if (options.signal?.aborted) {
				return {
					success: false,
					channel: 'whatsapp',
					error: options.signal.reason?.message || options.signal.reason || 'Operation aborted',
					category: 'TIMEOUT',
					aborted: true,
				};
			}
			const formattedText = await this._formatAlert(alert);
			const messageChunks = splitMessageIntoChunks(formattedText, GREEN_API_MESSAGE_LIMIT);
			const chatId = alert.whatsappChatId || this.chatId;

			if (messageChunks.length > 1) {
				this.logger?.warn?.(
					`WhatsApp message exceeded ${GREEN_API_MESSAGE_LIMIT} characters; sending ${messageChunks.length} parts instead of truncating`,
				);
				return this._sendChunkedMessage(messageChunks, chatId, options);
			}

			return this._sendChunkWithRetry(messageChunks[0], {
				chatId,
				includePreview: true,
			}, options);
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
	 * Send a single WhatsApp chunk with a category-aware retry loop.
	 * Only RATE_LIMITED, TIMEOUT, and 5xx PROVIDER_ERROR responses are retried;
	 * UNAUTHORIZED, CLIENT_ERROR, AMBIGUOUS_OUTCOME, and INVALID_RESPONSE are
	 * treated as terminal after the first attempt to prevent duplicate delivery
	 * and wasted latency (parity with TelegramService / DiscordService).
	 * @private
	 * @param {string} message - Pre-formatted WhatsApp payload
	 * @param {Object} chunkOptions - Chunk delivery options (chatId, includePreview)
	 * @param {Object} options - Top-level delivery options (signal)
	 * @returns {Promise<Object>} SendResult with attemptCount/statusCode/category telemetry
	 */
	async _sendChunkWithRetry(message, chunkOptions, options = {}) {
		const startedAt = Date.now();
		const signal = options.signal;
		const sendChunk = ({ signal: innerSignal } = {}) => this._sendMessageChunk(message, {
			...chunkOptions,
			signal: innerSignal,
		});

		let lastResult = null;
		let totalAttempts = 0;
		let totalWaitMs = 0;

		for (let attempt = 1; attempt <= WHATSAPP_MAX_RETRIES; attempt += 1) {
			if (signal?.aborted) {
				return this._finalizeAbortedResult(lastResult, totalAttempts, startedAt, signal);
			}

			let result;
			try {
				result = await sendChunk({ signal });
			} catch (error) {
				const isAbort = error?.name === 'AbortError'
					|| error?.name === 'AbortSignalError'
					|| (signal && signal.aborted);
				if (isAbort) {
					return {
						success: false,
						channel: 'whatsapp',
						error: signal?.reason?.message || signal?.reason || error.message || 'Operation aborted',
						category: 'TIMEOUT',
						attemptCount: totalAttempts + 1,
						durationMs: Date.now() - startedAt,
						aborted: true,
					};
				}
				// Transport-level throw — treat as retryable PROVIDER_ERROR.
				result = {
					success: false,
					channel: 'whatsapp',
					error: this._sanitizeText(error?.message || String(error)),
					category: 'PROVIDER_ERROR',
				};
			}

			totalAttempts += 1;
			lastResult = result;

			if (result.success) {
				return {
					...result,
					attemptCount: totalAttempts,
					durationMs: Date.now() - startedAt,
				};
			}

			if (result.aborted) {
				return {
					...result,
					attemptCount: totalAttempts,
					durationMs: Date.now() - startedAt,
				};
			}

			const isLastAttempt = attempt >= WHATSAPP_MAX_RETRIES;
			if (!isRetryableResult(result) || isLastAttempt) {
				return {
					...result,
					attemptCount: totalAttempts,
					durationMs: Date.now() - startedAt,
				};
			}

			const headerDelayMs = extractRetryAfterMs(result);
			const delayMs = Math.min(
				headerDelayMs ?? WHATSAPP_FALLBACK_RETRY_DELAY_MS * Math.pow(2, attempt - 1),
				WHATSAPP_MAX_RETRY_DELAY_MS,
			);
			if (totalWaitMs + delayMs > WHATSAPP_MAX_TOTAL_RETRY_WAIT_MS) {
				this.logger?.warn?.(`WhatsApp retry wait (${delayMs}ms) exceeds total budget; aborting retries`);
				return {
					...result,
					attemptCount: totalAttempts,
					durationMs: Date.now() - startedAt,
				};
			}

			this.logger?.warn?.(
				`WhatsApp send failed (${result.statusCode || result.category || 'transport error'}); retrying in ${delayMs}ms`,
			);

			try {
				await this._sleep(delayMs, signal);
			} catch (abortError) {
				return this._finalizeAbortedResult(result, totalAttempts, startedAt, signal);
			}
			totalWaitMs += delayMs;
		}

		return {
			...lastResult,
			success: false,
			channel: 'whatsapp',
			attemptCount: totalAttempts,
			durationMs: Date.now() - startedAt,
		};
	}

	_finalizeAbortedResult(lastResult, attemptCount, startedAt, signal) {
		return {
			...lastResult,
			success: false,
			channel: 'whatsapp',
			error: signal?.reason?.message || signal?.reason || lastResult?.error || 'Operation aborted',
			category: lastResult?.category || 'TIMEOUT',
			attemptCount,
			durationMs: Date.now() - startedAt,
			aborted: true,
		};
	}

	_sleep(ms, signal) {
		if (!ms || ms <= 0) {
			return Promise.resolve();
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener('abort', onAbort);
				resolve();
			}, ms);
			const onAbort = () => {
				clearTimeout(timer);
				const error = new Error(signal?.reason?.message || signal?.reason || 'Operation aborted');
				error.name = 'AbortError';
				reject(error);
			};
			signal?.addEventListener('abort', onAbort, { once: true });
		});
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
					const retryAfterHeader = response.status === 429
						? (response.headers?.get?.('Retry-After') ?? null)
						: null;
					return {
						success: false,
						channel: 'whatsapp',
						error: sanitizedMessage,
						category,
						statusCode: response.status,
						retryAfterHeader,
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
   * Each chunk retries independently to avoid duplicating already delivered parts,
   * and only transient categories (RATE_LIMITED, TIMEOUT, 5xx PROVIDER_ERROR) are
   * retried — terminal categories stop the chunk loop immediately to prevent
   * duplicate delivery and waste GreenAPI quota.
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
			const result = await this._sendChunkWithRetry(messageChunks[index], {
				chatId,
				includePreview,
			}, options);
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
					statusCode: result.statusCode,
					attemptCount: totalAttempts,
					durationMs: Date.now() - startedAt,
					splitMessageCount: messageChunks.length,
					failedPart: index + 1,
					ambiguous: result.ambiguous === true,
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
