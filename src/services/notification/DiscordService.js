const NotificationChannel = require('./NotificationChannel');
const WhatsAppMarkdownFormatter = require('./formatters/whatsappMarkdownFormatter');
const { splitMessageIntoChunks } = require('../../lib/messageHelper');

const DEFAULT_TIMEOUT_MS = 10000;
const DISCORD_MESSAGE_LIMIT = 2000;

class DiscordService extends NotificationChannel {
	constructor(config = {}) {
		super();
		this.name = 'discord';
		this.webhookUrl = config.webhookUrl || process.env.DISCORD_WEBHOOK_URL;
		this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
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
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

		try {
			const response = await fetch(this.getExecutionUrl(), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ content }),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				return {
					success: false,
					channel: 'discord',
					error: `Discord webhook ${response.status}: ${errorText}`,
					statusCode: response.status,
				};
			}

			const data = await response.json();
			return {
				success: true,
				channel: 'discord',
				messageId: data.id || 'discord-webhook',
			};
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
}

module.exports = DiscordService;
