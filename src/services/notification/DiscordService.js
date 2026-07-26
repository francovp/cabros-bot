const NotificationChannel = require('./NotificationChannel');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_TOTAL_RETRY_WAIT_MS = 5000;
const DISCORD_MESSAGE_LIMIT = 2000;
const DISCORD_RATE_LIMIT_ERROR_CODE = 'DISCORD_RATE_LIMITED';

function normalizeNonNegativeInteger(value, fallback) {
	return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function parseRetryDelayMs(value) {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) {
		return null;
	}
	if (typeof value !== 'number' && typeof value !== 'string') {
		return null;
	}

	const seconds = typeof value === 'number' ? value : Number(value);
	if (!Number.isFinite(seconds) || seconds < 0) {
		return null;
	}

	return Math.ceil(seconds * 1000);
}

function parseRateLimitRetryDelayMs(response, responseText) {
	const headerValue = response.headers?.get?.('retry-after') ?? response.headers?.get?.('Retry-After');
	const headerDelayMs = parseRetryDelayMs(headerValue);
	if (headerDelayMs !== null) {
		return headerDelayMs;
	}

	try {
		const body = JSON.parse(responseText);
		return parseRetryDelayMs(body?.retry_after);
	} catch {
		return null;
	}
}

class DiscordService extends NotificationChannel {
	constructor(config = {}) {
		super();
		this.name = 'discord';
		this.webhookUrl = config.webhookUrl || process.env.DISCORD_WEBHOOK_URL;
		this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
		this.maxRetries = normalizeNonNegativeInteger(config.maxRetries, DEFAULT_MAX_RETRIES);
		this.maxRetryDelayMs = normalizeNonNegativeInteger(config.maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS);
		this.maxTotalRetryWaitMs = normalizeNonNegativeInteger(
			config.maxTotalRetryWaitMs,
			DEFAULT_MAX_TOTAL_RETRY_WAIT_MS,
		);
		this.sleep = config.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
		this.logger = config.logger;
		this.formatter = config.formatter || new WhatsAppMarkdownFormatter();
		this.enabled = false;
	}

	async validate() {
		if (process.env.ENABLE_DISCORD_ALERTS !== 'true') {
			this.enabled = false;
			return { valid: true, message: 'Discord disabled via env' };
		}

		if (!this.webhookUrl) {
			this.enabled = false;
			return { valid: false, message: 'Missing DISCORD_WEBHOOK_URL' };
		}

		this.enabled = true;
		return { valid: true, message: 'Discord configured' };
	}

	isEnabled() {
		return this.enabled;
	}

	async send(alert) {
		try {
			const content = await this.formatAlert(alert);
			const chunks = splitMessageIntoChunks(content, DISCORD_MESSAGE_LIMIT);
			const messageIds = [];

			for (const chunk of chunks) {
				const result = await this.sendChunk(chunk);
				if (!result.success) {
					return result;
				}
				messageIds.push(result.messageId);
			}

			return {
				success: true,
				channel: 'discord',
				messageId: messageIds.join(','),
				messageIds,
				messageCount: messageIds.length,
			};
		} catch (error) {
			this.logger?.error?.(`Failed to send to Discord: ${error.message}`);
			return {
				success: false,
				channel: 'discord',
				error: error.message,
			};
		}
	}

	getExecutionUrl() {
		return this.webhookUrl.includes('?')
			? `${this.webhookUrl}&wait=true`
			: `${this.webhookUrl}?wait=true`;
	}

	async formatAlert(alert = {}) {
		if (alert.enriched && typeof alert.enriched === 'object') {
			return this.formatter.formatEnriched(alert.enriched);
		}

		return typeof alert.text === 'string' ? alert.text : '';
	}

	async sendChunk(content) {
		let retryCount = 0;
		let totalRetryWaitMs = 0;

		while (true) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
			let response;

			try {
				response = await fetch(this.getExecutionUrl(), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content }),
					signal: controller.signal,
				});
			} catch (error) {
				if (error && error.name === 'AbortError') {
					return {
						success: false,
						channel: 'discord',
						error: 'Discord webhook request timeout',
					};
				}

				throw error;
			} finally {
				clearTimeout(timeoutId);
			}

			if (response.ok) {
				const data = await response.json();
				return {
					success: true,
					channel: 'discord',
					messageId: data.id || 'discord-webhook',
				};
			}

			const errorText = await response.text();
			if (response.status !== 429) {
				return {
					success: false,
					channel: 'discord',
					error: `Discord webhook ${response.status}: ${errorText}`,
					statusCode: response.status,
				};
			}

			const retryDelayMs = parseRateLimitRetryDelayMs(response, errorText);
			const nextRetryWaitMs = totalRetryWaitMs + (retryDelayMs || 0);
			if (
				retryDelayMs === null
				|| retryDelayMs > this.maxRetryDelayMs
				|| nextRetryWaitMs > this.maxTotalRetryWaitMs
				|| retryCount >= this.maxRetries
			) {
				return {
					success: false,
					channel: 'discord',
					error: `Discord webhook 429: ${errorText}`,
					errorCode: DISCORD_RATE_LIMIT_ERROR_CODE,
					statusCode: 429,
					attemptCount: retryCount + 1,
				};
			}

			await this.sleep(retryDelayMs);
			totalRetryWaitMs = nextRetryWaitMs;
			retryCount += 1;
		}
	}
}

module.exports = DiscordService;
