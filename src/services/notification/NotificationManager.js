/**
 * NotificationManager - Orchestrates multi-channel alert sending
 * Manages Telegram and WhatsApp services, handles parallel sending and retry logic
 */

const sentryService = require('../monitoring/SentryService');

class NotificationManager {
	/**
   * @param {Object} telegramService - TelegramService instance
   * @param {Object} whatsappService - WhatsAppService instance
   */
	constructor(telegramService, whatsappService) {
		this.channels = new Map([
			['telegram', telegramService],
			['whatsapp', whatsappService],
		]);
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
