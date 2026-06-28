/**
 * NotificationManager - Orchestrates multi-channel alert sending
 * Manages Telegram and WhatsApp services, handles parallel sending and retry logic
 */

const sentryService = require('../monitoring/SentryService');

class NotificationManager {
	/**
   * @param {Object} telegramService - TelegramService instance
   * @param {Object} whatsappService - WhatsAppService instance
   * @param {Object} discordService - DiscordService instance
   */
	constructor(telegramService, whatsappService, discordService) {
		this.channels = new Map(
			[
				['telegram', telegramService],
				['whatsapp', whatsappService],
				['discord', discordService],
			].filter(([, channel]) => !!channel),
		);
	}

	/**
   * Validate all notification channels on startup
   * @returns {Promise<Array>} Array of validation results
   */
	async validateAll() {
		const channelsArray = Array.from(this.channels.entries());
		const validationPromises = channelsArray.map(async ([name, channel]) => {
			try {
				const result = await channel.validate();
				console.debug(
					`Notification channel ${name}: ${result.valid ? 'ENABLED' : 'DISABLED'} - ${result.message}`,
				);
				return result;
			} catch (error) {
				console.error(`Error validating ${name} channel:`, error.message);
				return { valid: false, message: `Validation error: ${error.message}` };
			}
		});

		return await Promise.all(validationPromises);
	}

	/**
   * Get list of enabled channel names
   * @returns {Array<string>} Array of enabled channel names
   */
	getEnabledChannels() {
		return Array.from(this.channels.values())
			.filter((ch) => ch.isEnabled())
			.map((ch) => ch.name);
	}

	async notifyAdminOfFailures(alert, results) {
		const failures = results.filter(result => !result.success);
		if (failures.length === 0) {
			return;
		}

		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const telegramService = this.channels.get('telegram');
		if (!adminChatId) {
			console.warn('[NotificationManager] Admin chat is not configured; delivery failure notification skipped');
			return;
		}
		if (!telegramService || !telegramService.isEnabled()) {
			console.warn('[NotificationManager] Telegram is disabled; delivery failure notification skipped');
			return;
		}

		const succeededChannels = results.filter(result => result.success).map(result => result.channel);
		const failureDetails = failures.map((result) => {
			const metadata = [
				result.statusCode ? `status ${result.statusCode}` : null,
				result.attemptCount ? `attempts ${result.attemptCount}` : null,
			].filter(Boolean);
			return `- ${result.channel}: ${result.error || 'Unknown error'}${metadata.length ? ` (${metadata.join(', ')})` : ''}`;
		});
		const requestId = alert && (alert.requestId || alert.correlationId);
		const message = [
			'Notification delivery failure',
			`Failed channels: ${failures.map(result => result.channel).join(', ')}`,
			`Succeeded channels: ${succeededChannels.length ? succeededChannels.join(', ') : 'none'}`,
			...failureDetails,
			...(requestId ? [`Request ID: ${requestId}`] : []),
		].join('\n');

		try {
			const adminResult = await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			if (adminResult && adminResult.success) {
				console.info('[NotificationManager] Admin delivery failure notification sent');
			} else {
				console.error('[NotificationManager] Admin delivery failure notification failed:', adminResult && adminResult.error);
			}
		} catch (error) {
			console.error('[NotificationManager] Admin delivery failure notification failed:', error.message);
		}
	}

	/**
    * Send alert to specific channels by name, in parallel
    * @param {Object} alert - Alert object with text and optional enriched content
    * @param {Array<string>} channelNames - Array of channel names to send to (e.g. ['telegram', 'whatsapp'])
    * @param {Object} [options] - Optional options (e.g. { parentSpan })
    * @returns {Promise<Array>} Array of SendResult objects
    */
	async sendToChannels(alert, channelNames = [], options = {}) {
		if (!channelNames || channelNames.length === 0) {
			console.warn('[NotificationManager] No channels specified for sendToChannels');
			return [];
		}

		const channels = channelNames
			.map(name => {
				const ch = this.channels.get(name);
				if (!ch) {
					console.warn(`[NotificationManager] Unknown channel: ${name}`);
					return null;
				}
				if (!ch.isEnabled()) {
					console.debug(`[NotificationManager] Channel ${name} is not enabled, skipping`);
					return null;
				}
				return ch;
			})
			.filter(Boolean);

		if (channels.length === 0) {
			console.warn('[NotificationManager] No enabled channels matched the requested channel names');
			return [];
		}

		const startTime = Date.now();
		const { parentSpan } = options;

		console.debug('[NotificationManager] Sending alert to', channels.length, 'specific channel(s):', channels.map(ch => ch.name).join(', '));
		const dispatchSpan = sentryService.startInactiveSpan({
			name: 'notification.send_to_channels',
			op: 'notification.dispatch',
			onlyIfParent: true,
			parentSpan,
			attributes: {
				'notification.requested_channels': channelNames.join(','),
				'notification.enabled_channels_count': channels.length,
				'alert.enriched': !!(alert && alert.enriched),
			},
		});

		let results;
		try {
			const sendPromises = channels.map((ch) => {
				const sendSpan = sentryService.startInactiveSpan({
					name: `notification.send.${ch.name}`,
					op: 'notification.send',
					onlyIfParent: true,
					parentSpan: dispatchSpan,
					attributes: {
						'notification.channel': ch.name,
						'alert.enriched': !!(alert && alert.enriched),
						'alert.length': alert && alert.text ? alert.text.length : 0,
					},
				});

				return Promise.resolve()
					.then(() => ch.send(alert))
					.finally(() => {
						sentryService.endSpan(sendSpan);
					});
			});

			results = await Promise.allSettled(sendPromises);
		} finally {
			sentryService.endSpan(dispatchSpan);
		}

		const formattedResults = results.map((r, idx) =>
			r.status === 'fulfilled'
				? r.value
				: {
					success: false,
					channel: channels[idx].name,
					error: (r.reason && r.reason.message) || 'Unknown error',
				},
		);

		// Report external failures to Sentry
		const totalDurationMs = Date.now() - startTime;
		for (const result of formattedResults) {
			if (!result.success && result.error) {
				const providerMap = {
					telegram: 'telegram-api',
					whatsapp: 'whatsapp-greenapi',
					discord: 'discord-webhook',
				};
				const provider = providerMap[result.channel] || result.channel;

				sentryService.captureExternalFailure({
					channel: result.channel,
					external: {
						provider,
						attemptCount: result.attemptCount || 1,
						durationMs: result.durationMs || totalDurationMs,
						lastErrorMessage: result.error,
						lastErrorCode: result.statusCode,
					},
				});
			}
		}

		void this.notifyAdminOfFailures(alert, formattedResults).catch((error) => {
			console.error('[NotificationManager] Unexpected admin notification failure:', error.message);
		});

		console.info('[NotificationManager] Delivery results:', JSON.stringify(formattedResults.map(r => ({
			channel: r.channel,
			success: r.success,
			messageId: r.messageId,
			error: r.error,
		}))));

		return formattedResults;
	}

	/**
    * Send alert to all enabled channels in parallel
    * @param {Object} alert - Alert object with text and optional enriched content
    * @returns {Promise<Array>} Array of SendResult objects (one per enabled channel)
    */
	async sendToAll(alert, options = {}) {
		const enabledChannels = Array.from(this.channels.values()).filter((ch) => ch.isEnabled());
		const startTime = Date.now();
		const { parentSpan } = options;

		if (enabledChannels.length === 0) {
			console.warn('[NotificationManager] No notification channels enabled');
			return [];
		}

		console.debug('[NotificationManager] Sending alert to', enabledChannels.length, 'enabled channel(s):', enabledChannels.map(ch => ch.name).join(', '));
		const dispatchSpan = sentryService.startInactiveSpan({
			name: 'notification.send_to_all',
			op: 'notification.dispatch',
			onlyIfParent: true,
			parentSpan,
			attributes: {
				'notification.enabled_channels_count': enabledChannels.length,
				'notification.enabled_channels': enabledChannels.map(ch => ch.name).join(','),
				'alert.enriched': !!(alert && alert.enriched),
			},
		});

		let results;
		try {
			const sendPromises = enabledChannels.map((ch) => {
				const sendSpan = sentryService.startInactiveSpan({
					name: `notification.send.${ch.name}`,
					op: 'notification.send',
					onlyIfParent: true,
					parentSpan: dispatchSpan,
					attributes: {
						'notification.channel': ch.name,
						'alert.enriched': !!(alert && alert.enriched),
						'alert.length': alert && alert.text ? alert.text.length : 0,
					},
				});

				return Promise.resolve()
					.then(() => ch.send(alert))
					.finally(() => {
						sentryService.endSpan(sendSpan);
					});
			});

			results = await Promise.allSettled(sendPromises);
		} finally {
			sentryService.endSpan(dispatchSpan);
		}

		const formattedResults = results.map((r, idx) =>
			r.status === 'fulfilled'
				? r.value
				: {
					success: false,
					channel: enabledChannels[idx].name,
					error: (r.reason && r.reason.message) || 'Unknown error',
				},
		);

		// Report external failures to Sentry (T014)
		const totalDurationMs = Date.now() - startTime;
		for (const result of formattedResults) {
			if (!result.success && result.error) {
				const providerMap = {
					telegram: 'telegram-api',
					whatsapp: 'whatsapp-greenapi',
					discord: 'discord-webhook',
				};
				const provider = providerMap[result.channel] || result.channel;

				sentryService.captureExternalFailure({
					channel: result.channel,
					external: {
						provider,
						attemptCount: result.attemptCount || 1,
						durationMs: result.durationMs || totalDurationMs,
						lastErrorMessage: result.error,
						lastErrorCode: result.statusCode,
					},
				});
			}
		}

		void this.notifyAdminOfFailures(alert, formattedResults).catch((error) => {
			console.error('[NotificationManager] Unexpected admin notification failure:', error.message);
		});

		console.info('[NotificationManager] Delivery results:', JSON.stringify(formattedResults.map(r => ({
			channel: r.channel,
			success: r.success,
			messageId: r.messageId,
			error: r.error,
		}))));

		return formattedResults;
	}
}

module.exports = NotificationManager;
