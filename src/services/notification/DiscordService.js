const NotificationChannel = require('./NotificationChannel');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');

const DEFAULT_TIMEOUT_MS = 10000;
const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_FALLBACK_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_TOTAL_RETRY_WAIT_MS = 10000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseEnvInt(envVar, defaultValue) {
	if (!process.env[envVar]) return defaultValue;
	const val = parseInt(process.env[envVar], 10);
	return Number.isNaN(val) ? defaultValue : val;
}

class DiscordService extends NotificationChannel {
	constructor(config = {}) {
		super();
		this.name = 'discord';
		this.webhookUrl = config.webhookUrl || process.env.DISCORD_WEBHOOK_URL;
		this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
		this.logger = config.logger;
		this.formatter = config.formatter || new WhatsAppMarkdownFormatter();
		this.enabled = false;
		this.maxRetries = config.maxRetries ?? parseEnvInt('DISCORD_MAX_RETRIES', DEFAULT_MAX_RETRIES);
		this.fallbackRetryDelayMs = config.fallbackRetryDelayMs ?? parseEnvInt('DISCORD_FALLBACK_RETRY_DELAY_MS', DEFAULT_FALLBACK_RETRY_DELAY_MS);
		this.maxRetryDelayMs = config.maxRetryDelayMs ?? parseEnvInt('DISCORD_MAX_RETRY_DELAY_MS', DEFAULT_MAX_RETRY_DELAY_MS);
		this.maxTotalRetryWaitMs = config.maxTotalRetryWaitMs ?? parseEnvInt('DISCORD_MAX_TOTAL_RETRY_WAIT_MS', DEFAULT_MAX_TOTAL_RETRY_WAIT_MS);
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

	extractRetryAfterMs(response, bodyText) {
		let retryHeader = null;
		if (response && response.headers) {
			if (typeof response.headers.get === 'function') {
				retryHeader = response.headers.get('retry-after') || response.headers.get('Retry-After');
			} else if (typeof response.headers === 'object') {
				retryHeader = response.headers['retry-after'] || response.headers['Retry-After'];
			}
		}

		if (retryHeader) {
			const parsed = parseFloat(retryHeader);
			if (!Number.isNaN(parsed) && parsed > 0) {
				return parsed < 500 ? Math.round(parsed * 1000) : Math.round(parsed);
			}
			const dateMs = Date.parse(retryHeader);
			if (!Number.isNaN(dateMs)) {
				const diffMs = dateMs - Date.now();
				if (diffMs > 0) {
					return Math.round(diffMs);
				}
			}
		}

		if (bodyText) {
			try {
				const json = JSON.parse(bodyText);
				const val = json.retry_after ?? json.retryAfter;
				if (typeof val === 'number' && val > 0) {
					return val < 500 ? Math.round(val * 1000) : Math.round(val);
				}
				if (typeof val === 'string') {
					const parsed = parseFloat(val);
					if (!Number.isNaN(parsed) && parsed > 0) {
						return parsed < 500 ? Math.round(parsed * 1000) : Math.round(parsed);
					}
				}
			} catch (_) {
				// Ignore non-JSON body
			}
		}

		return this.fallbackRetryDelayMs;
	}

	async sendChunk(content) {
		let attempt = 0;
		let totalWaitMs = 0;

		while (attempt <= this.maxRetries) {
			attempt++;
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

			try {
				const response = await fetch(this.getExecutionUrl(), {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ content }),
					signal: controller.signal,
				});

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

				if (attempt > this.maxRetries) {
					return {
						success: false,
						channel: 'discord',
						error: `Discord webhook 429: ${errorText}`,
						statusCode: 429,
					};
				}

				const rawDelayMs = this.extractRetryAfterMs(response, errorText);
				const remainingWaitMs = this.maxTotalRetryWaitMs - totalWaitMs;

				if (rawDelayMs > this.maxRetryDelayMs || rawDelayMs > remainingWaitMs) {
					this.logger?.warn?.(
						`Discord 429 retry delay (${rawDelayMs}ms) exceeds retry budget (per-delay ${this.maxRetryDelayMs}ms, remaining total ${remainingWaitMs}ms). Aborting retries.`,
					);
					return {
						success: false,
						channel: 'discord',
						error: `Discord webhook 429: ${errorText}`,
						statusCode: 429,
					};
				}

				this.logger?.warn?.(
					`Discord webhook rate limited (429). Retrying in ${rawDelayMs}ms (attempt ${attempt}/${this.maxRetries + 1})...`,
				);

				await sleep(rawDelayMs);
				totalWaitMs += rawDelayMs;
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
		}

		return {
			success: false,
			channel: 'discord',
			error: 'Discord webhook 429 retries exhausted',
			statusCode: 429,
		};
	}
}

module.exports = DiscordService;
