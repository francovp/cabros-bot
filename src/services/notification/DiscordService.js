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
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5000;
const DEFAULT_HEALTH_CHECK_CACHE_MS = 60000;
const DEFAULT_MAX_UNHEALTHY_DURATION_MS = 300000;
const DISCORD_WEBHOOK_HOST_PATTERN = /^(?:[a-z0-9-]+\.)*discord(?:app)?\.com$/i;
const DISCORD_WEBHOOK_PATH_PATTERN = /^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+(?:\/.*)?$/;
const ROTATION_STRATEGIES = new Set(['round-robin', 'random']);

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

function normalizeWebhookList(value) {
	if (!value) return [];
	const items = Array.isArray(value) ? value : String(value).split(',');
	const seen = new Set();
	const result = [];
	for (const raw of items) {
		const trimmed = String(raw || '').trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		result.push(trimmed);
	}
	return result;
}

function isValidDiscordWebhookUrl(value) {
	if (typeof value !== 'string' || !value) return false;
	let parsed;
	try {
		parsed = new URL(value);
	} catch (_) {
		return false;
	}
	if (parsed.protocol !== 'https:') return false;
	if (!DISCORD_WEBHOOK_HOST_PATTERN.test(parsed.hostname.toLowerCase())) return false;
	if (!DISCORD_WEBHOOK_PATH_PATTERN.test(parsed.pathname)) return false;
	return true;
}

class DiscordService extends NotificationChannel {
	constructor(config = {}) {
		super();
		this.name = 'discord';
		const envList = normalizeWebhookList(process.env.DISCORD_WEBHOOK_URLS);
		const configList = normalizeWebhookList(config.webhookUrls);
		const singleWebhook = config.webhookUrl || (!configList.length && !envList.length ? process.env.DISCORD_WEBHOOK_URL : undefined);
		const allCandidates = [
			...normalizeWebhookList(singleWebhook ? [singleWebhook] : []),
			...configList,
			...envList,
		];
		this.webhookUrls = allCandidates.filter(isValidDiscordWebhookUrl);
		this.webhookUrl = this.webhookUrls[0] || null;
		this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
		this.healthCheckTimeoutMs = config.healthCheckTimeoutMs || DEFAULT_HEALTH_CHECK_TIMEOUT_MS;
		this.healthCheckCacheMs = config.healthCheckCacheMs || DEFAULT_HEALTH_CHECK_CACHE_MS;
		this.maxUnhealthyDurationMs = config.maxUnhealthyDurationMs || DEFAULT_MAX_UNHEALTHY_DURATION_MS;
		this.rotationStrategy = ROTATION_STRATEGIES.has(config.rotationStrategy)
			? config.rotationStrategy
			: 'round-robin';
		this.logger = config.logger;
		this.formatter = config.formatter || new WhatsAppMarkdownFormatter();
		this.enabled = false;
		this.rotationIndex = 0;
		this.healthState = new Map();
		this._configMaxRetries = config.maxRetries;
		this._configFallbackRetryDelayMs = config.fallbackRetryDelayMs;
		this._configMaxRetryDelayMs = config.maxRetryDelayMs;
		this._configMaxTotalRetryWaitMs = config.maxTotalRetryWaitMs;
		this._healthCheckInFlight = null;
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

		if (!this.webhookUrls.length) {
			this.enabled = false;
			return { valid: false, message: 'Missing DISCORD_WEBHOOK_URL or DISCORD_WEBHOOK_URLS' };
		}

		let probeResult = [];
		try {
			probeResult = await this.probeHealth({ force: true });
		} catch (error) {
			this.logger?.warn?.(`Discord health probe failed during validate: ${error.message}`);
		}

		const anyHealthy = probeResult.some((entry) => entry.healthy);
		if (probeResult.length && !anyHealthy) {
			this.logger?.warn?.(
				`All ${probeResult.length} Discord webhooks failed startup health probe; service will stay enabled and degrade to per-request probes.`,
			);
		}

		this.enabled = true;
		const result = { valid: true, message: 'Discord configured' };
		if (probeResult.length) {
			result.webhooks = probeResult;
		}
		return result;
	}

	isEnabled() {
		return this.enabled;
	}

	async probeHealth({ force = false } = {}) {
		if (!this.webhookUrls.length) return [];
		if (!force && this._healthCheckInFlight) {
			return this._healthCheckInFlight;
		}

		const probe = async () => {
			const now = Date.now();
			const results = [];
			for (const url of this.webhookUrls) {
				const cached = this.healthState.get(url);
				if (!force && cached && now - cached.checkedAt < this.healthCheckCacheMs) {
					results.push({ url, ...cached.summary });
					continue;
				}
				const summary = await this.probeSingleWebhook(url);
				this.healthState.set(url, { checkedAt: now, summary });
				results.push({ url, ...summary });
			}
			return results;
		};

		const inFlight = probe().finally(() => {
			this._healthCheckInFlight = null;
		});
		this._healthCheckInFlight = inFlight;
		return inFlight;
	}

	async probeSingleWebhook(url) {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.healthCheckTimeoutMs);
		try {
			const response = await fetch(url, {
				method: 'GET',
				signal: controller.signal,
			});
			if (!response || typeof response.status !== 'number') {
				return {
					healthy: false,
					statusCode: null,
					checkedAt: Date.now(),
					error: 'invalid probe response',
					lastError: 'invalid probe response',
				};
			}
			const isHealthy = response.ok || response.status === 405;
			const errorText = isHealthy ? undefined : `HTTP ${response.status}`;
			return {
				healthy: isHealthy,
				statusCode: response.status,
				checkedAt: Date.now(),
				error: errorText,
				lastError: errorText,
			};
		} catch (error) {
			const errMessage = error.name === 'AbortError' ? 'probe timeout' : (error?.message || String(error));
			return {
				healthy: false,
				statusCode: null,
				checkedAt: Date.now(),
				error: errMessage,
				lastError: errMessage,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}

	getHealthyWebhookUrls() {
		if (!this.webhookUrls.length) return [];
		const now = Date.now();
		const candidates = [];
		for (const url of this.webhookUrls) {
			const state = this.healthState.get(url);
			if (!state || state.summary.healthy) {
				candidates.push(url);
				continue;
			}
			const summaryCheckedAt = state.summary.checkedAt || state.checkedAt || 0;
			if (now - summaryCheckedAt > this.maxUnhealthyDurationMs) {
				candidates.push(url);
			}
		}
		return candidates.length ? candidates : this.webhookUrls.slice();
	}

	pickNextWebhookUrl() {
		const candidates = this.getHealthyWebhookUrls();
		if (!candidates.length) return this.webhookUrl;
		if (this.rotationStrategy === 'random') {
			const index = Math.floor(Math.random() * candidates.length);
			return candidates[index];
		}
		const index = this.rotationIndex % candidates.length;
		this.rotationIndex = (this.rotationIndex + 1) % candidates.length;
		return candidates[index];
	}

	recordWebhookOutcome(url, success, error) {
		if (!url) return;
		const previous = this.healthState.get(url) || {};
		const summary = { ...previous.summary, checkedAt: Date.now() };
		if (success) {
			summary.healthy = true;
			summary.lastError = undefined;
			summary.error = undefined;
			summary.lastSuccessAt = Date.now();
		} else {
			summary.healthy = false;
			summary.lastError = error?.message || error || 'unknown error';
			summary.lastFailureAt = Date.now();
		}
		this.healthState.set(url, { checkedAt: Date.now(), summary });
	}

	getStatus() {
		return {
			enabled: this.enabled,
			rotationStrategy: this.rotationStrategy,
			webhookCount: this.webhookUrls.length,
			webhooks: this.webhookUrls.map((url) => {
				const state = this.healthState.get(url);
				return {
					url,
					healthy: state ? state.summary.healthy : true,
					lastError: state?.summary?.lastError,
					lastCheckedAt: state?.checkedAt || null,
					lastSuccessAt: state?.summary?.lastSuccessAt || null,
					lastFailureAt: state?.summary?.lastFailureAt || null,
				};
			}),
			healthCheckTimeoutMs: this.healthCheckTimeoutMs,
			healthCheckCacheMs: this.healthCheckCacheMs,
		};
	}

	async send(alert = {}, options = {}) {
		try {
			const overrideUrl = alert.discordWebhookUrl;
			if (overrideUrl) {
				if (!isValidDiscordWebhookUrl(overrideUrl)) {
					return {
						success: false,
						channel: 'discord',
						error: 'Invalid DISCORD_WEBHOOK_URL override',
					};
				}
				return await this.sendWithWebhookUrl(alert, overrideUrl, options);
			}

			const candidates = this.getHealthyWebhookUrls();
			if (!candidates.length) {
				return {
					success: false,
					channel: 'discord',
					error: 'Missing DISCORD_WEBHOOK_URL',
				};
			}

			let lastResult = null;
			const tried = new Set();
			for (let attempt = 0; attempt < candidates.length; attempt += 1) {
				const url = this.pickNextWebhookUrl();
				if (!url || tried.has(url)) break;
				tried.add(url);
				const result = await this.sendWithWebhookUrl(alert, url, options);
				if (result.success) {
					return result;
				}
				lastResult = result;
				if (result.statusCode === 429) {
					return result;
				}
			}

			return lastResult || {
				success: false,
				channel: 'discord',
				error: 'All Discord webhooks failed',
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

	async sendWithWebhookUrl(alert, webhookUrl, options = {}) {
		const content = await this.formatAlert(alert);
		const chunks = splitMessageIntoChunks(content, DISCORD_MESSAGE_LIMIT);
		const messageIds = [];
		let totalAttempts = 0;

		for (const chunk of chunks) {
			const result = await this.sendChunk(chunk, webhookUrl, options.signal);
			totalAttempts += result.attemptCount || 0;
			if (!result.success) {
				this.recordWebhookOutcome(webhookUrl, false, result.error);
				if (result.statusCode === 429) {
					return { ...result, attemptCount: totalAttempts };
				}
				return result;
			}
			messageIds.push(result.messageId);
		}

		this.recordWebhookOutcome(webhookUrl, true);
		return {
			success: true,
			channel: 'discord',
			messageId: messageIds.join(','),
			messageIds,
			messageCount: messageIds.length,
		};
	}

	getExecutionUrl(webhookUrl = this.webhookUrl) {
		const targetUrl = webhookUrl || this.webhookUrl;
		if (!targetUrl) return '';
		return targetUrl.includes('?')
			? `${targetUrl}&wait=true`
			: `${targetUrl}?wait=true`;
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
