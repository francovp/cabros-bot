const NotificationChannel = require('./NotificationChannel');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_TIMEOUT_MS = 10000;
const DISCORD_MESSAGE_LIMIT = 2000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_FALLBACK_RETRY_DELAY_MS = 500;
const DEFAULT_MAX_RETRY_DELAY_MS = 5000;
const DEFAULT_MAX_TOTAL_RETRY_WAIT_MS = 10000;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sleepWithSignal(ms, signal) {
	if (!signal) return sleep(ms);
	if (signal.aborted) return Promise.reject(new Error(signal.reason?.message || signal.reason || 'Operation aborted'));
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
		this._configMaxRetries = config.maxRetries;
		this._configFallbackRetryDelayMs = config.fallbackRetryDelayMs;
		this._configMaxRetryDelayMs = config.maxRetryDelayMs;
		this._configMaxTotalRetryWaitMs = config.maxTotalRetryWaitMs;
	}

	get maxRetries() {
		if (this._maxRetries !== undefined) return this._maxRetries;
		if (this._configMaxRetries !== undefined) return this._configMaxRetries;
		return getRuntimeConfig().DISCORD_MAX_RETRIES;
	}

	set maxRetries(val) {
		this._maxRetries = val;
	}

	get fallbackRetryDelayMs() {
		if (this._fallbackRetryDelayMs !== undefined) return this._fallbackRetryDelayMs;
		if (this._configFallbackRetryDelayMs !== undefined) return this._configFallbackRetryDelayMs;
		return getRuntimeConfig().DISCORD_FALLBACK_RETRY_DELAY_MS;
	}

	set fallbackRetryDelayMs(val) {
		this._fallbackRetryDelayMs = val;
	}

	get maxRetryDelayMs() {
		if (this._maxRetryDelayMs !== undefined) return this._maxRetryDelayMs;
		if (this._configMaxRetryDelayMs !== undefined) return this._configMaxRetryDelayMs;
		return getRuntimeConfig().DISCORD_MAX_RETRY_DELAY_MS;
	}

	set maxRetryDelayMs(val) {
		this._maxRetryDelayMs = val;
	}

	get maxTotalRetryWaitMs() {
		if (this._maxTotalRetryWaitMs !== undefined) return this._maxTotalRetryWaitMs;
		if (this._configMaxTotalRetryWaitMs !== undefined) return this._configMaxTotalRetryWaitMs;
		return getRuntimeConfig().DISCORD_MAX_TOTAL_RETRY_WAIT_MS;
	}

	set maxTotalRetryWaitMs(val) {
		this._maxTotalRetryWaitMs = val;
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

	/**
	 * Check if Discord is configured for alert delivery by operator intent.
	 * Requires the ENABLE_DISCORD_ALERTS flag and a webhook URL.
	 * @returns {boolean}
	 */
	isConfigured() {
		return (
			process.env.ENABLE_DISCORD_ALERTS === 'true' &&
			Boolean(this.webhookUrl || process.env.DISCORD_WEBHOOK_URL)
		);
	}

	async send(alert = {}, options = {}) {
		const startedAt = Date.now();
		try {
			const webhookUrl = alert.discordWebhookUrl || this.webhookUrl;
			this._logChartAttachmentSkipped(alert);
			if (!webhookUrl) {
				return {
					success: false,
					channel: 'discord',
					error: 'Missing DISCORD_WEBHOOK_URL',
					durationMs: Date.now() - startedAt,
				};
			}

			const content = await this.formatAlert(alert);
			const chunks = splitMessageIntoChunks(content, DISCORD_MESSAGE_LIMIT);
			const isChunked = chunks.length > 1;
			const resumeFromChunk = Number.isInteger(options.startChunk) && options.startChunk > 0
				? Math.min(options.startChunk, chunks.length - 1)
				: 0;
			const messageIds = [];
			let totalAttempts = 0;

			for (let index = resumeFromChunk; index < chunks.length; index += 1) {
				const result = await this.sendChunk(chunks[index], webhookUrl, options.signal);
				totalAttempts += result.attemptCount || 0;
				if (!result.success) {
					if (result.statusCode === 429) {
						return {
							...result,
							attemptCount: totalAttempts,
							durationMs: Date.now() - startedAt,
							messageIds,
							messageCount: messageIds.length,
							...(isChunked ? {
								splitMessageCount: chunks.length,
								failedPart: index + 1,
								resumedFromChunk: resumeFromChunk,
							} : {}),
						};
					}
					return {
						...result,
						durationMs: Date.now() - startedAt,
						messageIds,
						messageCount: messageIds.length,
						...(isChunked ? {
							splitMessageCount: chunks.length,
							failedPart: index + 1,
							resumedFromChunk: resumeFromChunk,
						} : {}),
					};
				}
				messageIds.push(result.messageId);
			}

			return {
				success: true,
				channel: 'discord',
				messageId: messageIds.join(','),
				messageIds,
				messageCount: messageIds.length,
					durationMs: Date.now() - startedAt,
				...(isChunked ? {
					splitMessageCount: chunks.length,
					resumedFromChunk: resumeFromChunk,
				} : {}),
			};
		} catch (error) {
			this.logger?.error?.(`Failed to send to Discord: ${error.message}`);
			return {
				success: false,
				channel: 'discord',
				error: error.message,
				durationMs: Date.now() - startedAt,
			};
		}
	}

	getExecutionUrl(webhookUrl = this.webhookUrl) {
		const targetUrl = webhookUrl || this.webhookUrl;
		if (!targetUrl) return '';
		return targetUrl.includes('?')
			? `${targetUrl}&wait=true`
			: `${targetUrl}?wait=true`;
	}

	/**
	 * Discord webhooks accept only remote image URLs in `embeds[].image`; there is
	 * no inline-upload path. Rather than inventing a temporary-bucket dependency
	 * for one notification channel, chart attachments are explicitly skipped here
	 * and the text-only payload is delivered unchanged. This log line is the
	 * documented "chart attachment skipped: discord" behavior.
	 * @private
	 */
	_logChartAttachmentSkipped(alert = {}) {
		if (alert.chartBars?.length && process.env.ENABLE_CHART_ATTACHMENTS === 'true') {
			this.logger?.debug?.('chart attachment skipped: discord has no inline image upload path');
		}
	}

	async formatAlert(alert = {}) {
		const signalClass = alert.signalClass || (alert.enriched && typeof alert.enriched === 'object' ? alert.enriched.signalClass : undefined);
		if (alert.enriched && typeof alert.enriched === 'object') {
			return this.formatter.formatEnriched(alert.enriched, { signalClass });
		}

		return typeof alert.text === 'string'
			? this.formatter.format(alert.text, { signalClass })
			: '';
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

	async sendChunk(content, webhookUrl = this.webhookUrl, signal) {
		let attempt = 0;
		let totalWaitMs = 0;

		while (attempt <= this.maxRetries) {
			if (signal?.aborted) {
				return {
					success: false,
					channel: 'discord',
					error: signal.reason?.message || signal.reason || 'Operation aborted',
					aborted: true,
				};
			}
			attempt++;
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
			const forwardAbort = () => controller.abort(signal.reason);
			signal?.addEventListener('abort', forwardAbort, { once: true });

			try {
				const response = await fetch(this.getExecutionUrl(webhookUrl), {
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
						attemptCount: attempt,
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
						attemptCount: attempt,
					};
				}

				const requiredDelayMs = this.extractRetryAfterMs(response, errorText);

				if (requiredDelayMs > this.maxRetryDelayMs) {
					this.logger?.warn?.(
						`Discord 429 retry delay (${requiredDelayMs}ms) exceeds max retry delay limit (${this.maxRetryDelayMs}ms). Aborting retries.`,
					);
					return {
						success: false,
						channel: 'discord',
						error: `Discord webhook 429: ${errorText}`,
						statusCode: 429,
						attemptCount: attempt,
					};
				}

				if (totalWaitMs + requiredDelayMs > this.maxTotalRetryWaitMs) {
					this.logger?.warn?.(
						`Discord 429 retry delay (${requiredDelayMs}ms) exceeds remaining total wait budget (${this.maxTotalRetryWaitMs - totalWaitMs}ms). Aborting retries.`,
					);
					return {
						success: false,
						channel: 'discord',
						error: `Discord webhook 429: ${errorText}`,
						statusCode: 429,
						attemptCount: attempt,
					};
				}

				this.logger?.warn?.(
					`Discord webhook rate limited (429). Retrying in ${requiredDelayMs}ms (attempt ${attempt}/${this.maxRetries + 1})...`,
				);

				await sleepWithSignal(requiredDelayMs, signal);
				totalWaitMs += requiredDelayMs;
			} catch (error) {
				if (signal?.aborted) {
					return {
						success: false,
						channel: 'discord',
						error: signal.reason?.message || signal.reason || 'Operation aborted',
						aborted: true,
					};
				}
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
				signal?.removeEventListener('abort', forwardAbort);
			}
		}

		return {
			success: false,
			channel: 'discord',
			error: 'Discord webhook 429 retries exhausted',
			statusCode: 429,
			attemptCount: attempt,
		};
	}
}

module.exports = DiscordService;
