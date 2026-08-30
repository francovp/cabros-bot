/**
 * TelegramService - Telegraf bot integration for Telegram alerts
 * Extends NotificationChannel to wrap existing Telegram bot functionality
 */

const NotificationChannel = require('./NotificationChannel');
const MarkdownV2Formatter = require('./formatters/markdownV2Formatter');
const { parseTelegramTopicRoutes, resolveTelegramThreadId } = require('./telegramTopicRouting');

const DEFAULT_MAX_MESSAGE_LENGTH = 4000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_FALLBACK_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_TOTAL_RETRY_WAIT_MS = 10000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const MARKDOWN_V2_ESCAPE_CHARS = '\\_*[]()~`>#+-=|{}.!<&';

function sleepWithSignal(ms, signal) {
	if (!signal) {
		return new Promise(resolve => setTimeout(resolve, ms));
	}
	if (signal.aborted) {
		return Promise.reject(new Error(signal.reason?.message || signal.reason || 'Operation aborted'));
	}
	return new Promise((resolve, reject) => {
		const timeoutId = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timeoutId);
			signal.removeEventListener('abort', onAbort);
			reject(new Error(signal.reason?.message || signal.reason || 'Operation aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function getStatusCode(error) {
	const rawStatusCode = error?.response?.error_code
		?? error?.response?.statusCode
		?? error?.response?.status
		?? error?.statusCode
		?? error?.status;
	if (typeof rawStatusCode === 'number') {
		return rawStatusCode;
	}
	const parsed = Number(rawStatusCode);
	return Number.isSafeInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : null;
}

function getErrorMessage(error) {
	if (error?.response?.description || error?.response?.data?.description || error?.description || error?.message) {
		return String(error.response?.description || error.response?.data?.description || error.description || error.message);
	}
	if (error && typeof error === 'object') {
		return JSON.stringify(error);
	}
	return String(error || 'Unknown Telegram error');
}

function getCategory(error, statusCode) {
	if (error?.name === 'AbortError' || error?.message?.includes('timeout') || error?.message?.includes('aborted')) {
		return 'TIMEOUT';
	}
	if (statusCode === 429) {
		return 'RATE_LIMITED';
	}
	if (statusCode === 400 || statusCode === 401 || statusCode === 403 || statusCode === 404) {
		return 'PAYLOAD_ERROR';
	}
	return 'PROVIDER_ERROR';
}

function isRetryable(error, statusCode) {
	if (statusCode === 429) {
		return true;
	}
	const message = getErrorMessage(error).toLowerCase();
	return message.includes('retry_after') || message.includes('too many requests');
}

function getRetryAfterMs(error, fallbackDelayMs) {
	const rawRetryAfter = error?.response?.parameters?.retry_after;
	if (typeof rawRetryAfter === 'number' && Number.isFinite(rawRetryAfter) && rawRetryAfter > 0) {
		return Math.max(1, Math.round(rawRetryAfter * 1000));
	}
	return fallbackDelayMs;
}

function stripMarkdownV2Escapes(text) {
	return text.replace(/\\(.)/g, (match, character) => (
		MARKDOWN_V2_ESCAPE_CHARS.includes(character) ? character : match
	));
}

class TelegramService extends NotificationChannel {
	/**
   * @param {Object} config
   * @param {Object} config.bot - Telegraf bot instance
   * @param {string} config.botToken - Telegram bot token (optional, for validation)
   * @param {string} config.chatId - Destination Telegram chat ID
   * @param {Object|string} config.topicRoutes - Configured forum topic routes (optional)
   * @param {Object} config.formatter - Message formatter (default: MarkdownV2Formatter)
   * @param {Object} config.logger - Logger instance (optional)
   */
	constructor(config = {}) {
		super();
		this.name = 'telegram';
		this.bot = config.bot;
		this.botToken = config.botToken || process.env.BOT_TOKEN;
		this.chatId = config.chatId || process.env.TELEGRAM_CHAT_ID;
		this.logger = config.logger;
		this.topicRoutes = config.topicRoutes !== undefined
			? parseTelegramTopicRoutes(config.topicRoutes, this.logger)
			: parseTelegramTopicRoutes(process.env.TELEGRAM_TOPIC_ROUTES, this.logger);
		this.formatter = config.formatter || new MarkdownV2Formatter();
		this.maxMessageLength = config.maxMessageLength || DEFAULT_MAX_MESSAGE_LENGTH;
		this.maxRetries = Number.isInteger(config.maxRetries) && config.maxRetries >= 0 ? config.maxRetries : DEFAULT_MAX_RETRIES;
		this.fallbackRetryDelayMs = Number.isFinite(config.fallbackRetryDelayMs) && config.fallbackRetryDelayMs >= 0
			? config.fallbackRetryDelayMs
			: DEFAULT_FALLBACK_RETRY_DELAY_MS;
		this.maxRetryDelayMs = Number.isFinite(config.maxRetryDelayMs) && config.maxRetryDelayMs >= 0
			? config.maxRetryDelayMs
			: DEFAULT_MAX_RETRY_DELAY_MS;
		this.maxTotalRetryWaitMs = Number.isFinite(config.maxTotalRetryWaitMs) && config.maxTotalRetryWaitMs >= 0
			? config.maxTotalRetryWaitMs
			: DEFAULT_MAX_TOTAL_RETRY_WAIT_MS;
		this.requestTimeoutMs = Number.isFinite(config.requestTimeoutMs) && config.requestTimeoutMs > 0
			? config.requestTimeoutMs
			: DEFAULT_REQUEST_TIMEOUT_MS;
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
   * Resolve topic thread ID for an alert
   * @param {Object} alert
   * @returns {number|null}
   */
	resolveThreadId(alert = {}) {
		return resolveTelegramThreadId(alert, this.topicRoutes, this.logger);
	}

	/**
   * Send alert to Telegram via Telegraf bot
   * @param {Object} alert - Alert object with text and optional enriched content
	 * @returns {Promise<{success: boolean, channel: string, messageId?: string, error?: string, statusCode?: number|null, category?: string, attemptCount: number, durationMs: number}>}
   */
	async send(alert, options = {}) {
		const startedAt = Date.now();
		const buildResult = (result) => ({
			statusCode: null,
			category: 'PROVIDER_ERROR',
			attemptCount: 0,
			durationMs: Date.now() - startedAt,
			...result,
		});

		const signal = options.signal;
		try {
			if (signal?.aborted) {
				return buildResult({
					success: false,
					channel: 'telegram',
					error: signal.reason?.message || signal.reason || 'Operation aborted',
					category: 'TIMEOUT',
					aborted: true,
				});
			}
			if (!this.bot) {
				return buildResult({
					success: false,
					channel: 'telegram',
					error: 'Bot instance not available',
					category: 'CLIENT_ERROR',
				});
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
			const threadId = this.resolveThreadId(alert);
			this.logger?.debug?.(`Sending to Telegram chat ${chatId}${threadId ? ` (topic ${threadId})` : ''}`);
			const messageParts = splitTelegramMessage(formattedText, this.maxMessageLength);
			const sendMessage = (targetChatId, messagePart, extra, requestSignal) => {
				if (typeof this.bot.telegram.callApi === 'function') {
					return this.bot.telegram.callApi('sendMessage', {
						chat_id: targetChatId,
						...extra,
						text: messagePart,
					}, { signal: requestSignal });
				}
				return this.bot.telegram.sendMessage(targetChatId, messagePart, extra);
			};

			// Send to Telegram with MarkdownV2 first, fallback to plain text on parse errors
			const messageIds = [];
			let attemptCount = 0;
			const retryState = { totalWaitMs: 0 };
			for (const messagePart of messageParts) {
				if (signal?.aborted) {
					return buildResult({
						success: false,
						channel: 'telegram',
						error: signal.reason?.message || signal.reason || 'Operation aborted',
						category: 'TIMEOUT',
						attemptCount,
						messageIds,
						messageId: messageIds.join(','),
						messageCount: messageIds.length,
						aborted: true,
						threadId,
					});
				}
				const result = await this.sendMessagePart(sendMessage, chatId, messagePart, !!alert.enriched, signal, retryState, threadId);
				attemptCount += result.attemptCount;
				if (!result.success) {
					if (result.aborted) {
						return buildResult({
							success: false,
							channel: 'telegram',
							error: getErrorMessage(result.error),
							category: 'TIMEOUT',
							attemptCount,
							messageIds,
							messageId: messageIds.join(','),
							messageCount: messageIds.length,
							aborted: true,
							threadId,
						});
					}
					const statusCode = getStatusCode(result.error);
					return buildResult({
						success: false,
						channel: 'telegram',
						error: `Telegram error: ${getErrorMessage(result.error)}`,
						statusCode,
						category: getCategory(result.error, statusCode),
						attemptCount,
						messageIds,
						messageId: messageIds.join(','),
						messageCount: messageIds.length,
						threadId,
					});
				}
				messageIds.push(String(result.response.message_id));
			}

			return buildResult({
				success: true,
				channel: 'telegram',
				messageId: messageIds.join(','),
				messageIds,
				messageCount: messageIds.length,
				statusCode: 200,
				category: 'SUCCESS',
				attemptCount,
				threadId,
			});
		} catch (error) {
			this.logger?.error?.(`Failed to send to Telegram: ${error.message}`);
			return buildResult({
				success: false,
				channel: 'telegram',
				error: `Telegram error: ${getErrorMessage(error)}`,
				statusCode: getStatusCode(error),
				category: getCategory(error, getStatusCode(error)),
			});
		}
	}

	async sendMessagePart(sendMessage, chatId, messagePart, enriched, signal, retryState = { totalWaitMs: 0 }, threadId = null) {
		let totalAttempts = 0;
		let lastError = null;

		for (let retry = 0; retry <= this.maxRetries; retry += 1) {
			if (signal?.aborted) {
				return {
					success: false,
					error: new Error(signal.reason?.message || signal.reason || 'Operation aborted'),
					attemptCount: totalAttempts,
					aborted: true,
				};
			}

			const result = await this.sendFormattedMessage(sendMessage, chatId, messagePart, enriched, signal, threadId);
			totalAttempts += result.attemptCount;
			if (result.success) {
				return { ...result, attemptCount: totalAttempts };
			}
			if (result.aborted) {
				return { ...result, attemptCount: totalAttempts };
			}

			lastError = result.error;
			const statusCode = getStatusCode(lastError);
			if (!isRetryable(lastError, statusCode) || retry === this.maxRetries) {
				break;
			}

			const delayMs = statusCode === 429
				? getRetryAfterMs(lastError, this.fallbackRetryDelayMs)
				: this.fallbackRetryDelayMs;
			if (delayMs > this.maxRetryDelayMs || retryState.totalWaitMs + delayMs > this.maxTotalRetryWaitMs) {
				this.logger?.warn?.(`Telegram retry delay (${delayMs}ms) exceeds retry budget; aborting retries`);
				break;
			}

			this.logger?.warn?.(`Telegram send failed (${statusCode || 'transport error'}), retrying in ${delayMs}ms`);
			try {
				await sleepWithSignal(delayMs, signal);
			} catch (error) {
				return {
					success: false,
					error,
					attemptCount: totalAttempts,
					aborted: !!signal?.aborted,
				};
			}
			retryState.totalWaitMs += delayMs;
		}

		return {
			success: false,
			error: lastError,
			attemptCount: totalAttempts,
		};
	}

	async sendFormattedMessage(sendMessage, chatId, messagePart, enriched, signal, threadId = null) {
		const getAbortError = () => new Error(signal?.reason?.message || signal?.reason || 'Operation aborted');
		const sendAttempt = async (text, extra) => {
			const attemptController = new AbortController();
			const parentAbortListener = signal ? () => attemptController.abort(signal.reason || new Error('Operation aborted')) : null;
			if (signal) {
				if (signal.aborted) parentAbortListener();
				else signal.addEventListener('abort', parentAbortListener, { once: true });
			}
			const timeoutId = setTimeout(() => attemptController.abort(new Error('Telegram request timeout')), this.requestTimeoutMs);
			let abortListener;
			const abortPromise = new Promise((resolve, reject) => {
				abortListener = () => reject(attemptController.signal.reason || new Error('Operation aborted'));
				if (attemptController.signal.aborted) abortListener();
				else attemptController.signal.addEventListener('abort', abortListener, { once: true });
			});
			try {
				return await Promise.race([
					sendMessage(chatId, text, extra, attemptController.signal),
					abortPromise,
				]);
			} finally {
				clearTimeout(timeoutId);
				attemptController.signal.removeEventListener('abort', abortListener);
				if (signal && parentAbortListener) signal.removeEventListener('abort', parentAbortListener);
			}
		};
		const topicExtra = threadId ? { message_thread_id: threadId } : {};
		try {
			const response = await sendAttempt(messagePart, {
				parse_mode: 'MarkdownV2',
				disable_web_page_preview: enriched,
				...topicExtra,
			});
			return { success: true, response, attemptCount: 1 };
		} catch (error) {
			if (signal?.aborted) {
				return { success: false, error: getAbortError(), attemptCount: 1, aborted: true };
			}
			const errorMessage = getErrorMessage(error);
			if (!errorMessage.includes("can't parse entities")) {
				return { success: false, error, attemptCount: 1 };
			}

			this.logger?.warn?.(`Telegram MarkdownV2 parse failed, retrying as plain text: ${errorMessage}`);
			if (signal?.aborted) {
				return { success: false, error: getAbortError(), attemptCount: 1, aborted: true };
			}
			try {
				const response = await sendAttempt(stripMarkdownV2Escapes(messagePart), {
					disable_web_page_preview: enriched,
					...topicExtra,
				});
				return { success: true, response, attemptCount: 2 };
			} catch (fallbackError) {
				if (signal?.aborted) {
					return { success: false, error: getAbortError(), attemptCount: 2, aborted: true };
				}
				return { success: false, error: fallbackError, attemptCount: 2 };
			}
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
