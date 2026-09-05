/**
 * NotificationManager - Orchestrates multi-channel alert sending
 * Manages Telegram and WhatsApp services, handles parallel sending and retry logic
 */

const sentryService = require('../monitoring/SentryService');
const remoteConfigService = require('../remoteConfig/RemoteConfigService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { notificationRedriveService } = require('./NotificationRedriveService');
const { deliveryMetricsService } = require('./DeliveryMetricsService');

const DEFAULT_ZERO_CHANNEL_ALERT_COOLDOWN_MS = 300000;

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
		this.zeroChannelBroadcastCount = 0;
		this.lastZeroChannelAlertAt = 0;
		notificationRedriveService.setNotificationManagerGetter(() => this);
	}

	/**
   * Check if zero-channel broadcast is intentional (API-only mode)
   * @returns {boolean}
   */
	isIntentionalApiOnly() {
		const runtimeConfig = remoteConfigService.getRuntimeConfig();
		if (runtimeConfig.ENABLE_API_ONLY_MODE) {
			return true;
		}
		const hasAnyConfig = Boolean(
			process.env.BOT_TOKEN ||
			process.env.TELEGRAM_CHAT_ID ||
			process.env.ENABLE_TELEGRAM_BOT === 'true' ||
			process.env.ENABLE_WHATSAPP_ALERTS === 'true' ||
			process.env.ENABLE_DISCORD_ALERTS === 'true' ||
			process.env.WHATSAPP_API_KEY ||
			process.env.WHATSAPP_API_URL ||
			process.env.WHATSAPP_CHAT_ID ||
			process.env.DISCORD_WEBHOOK_URL,
		);
		return !hasAnyConfig;
	}

	getZeroChannelBroadcastCount() {
		return this.zeroChannelBroadcastCount;
	}

	resetForTesting() {
		this.zeroChannelBroadcastCount = 0;
		this.lastZeroChannelAlertAt = 0;
	}

	/**
	 * Resolve the effective idempotency key for a dispatch, preferring
	 * the per-channel key on the alert (set by the redrive dispatcher) and
	 * falling back to the alert/options level key. Returns undefined when no
	 * dedupe key is supplied so callers can include `idempotencyKey: undefined`
	 * in their `SendResult` without forcing consumers to filter.
	 *
	 * @param {Object} alert - The alert object being dispatched
	 * @param {Object} [options] - Dispatch options from the caller
	 * @returns {string|undefined}
	 */
	resolveIdempotencyKey(alert, options = {}) {
		if (alert && typeof alert === 'object') {
			if (typeof alert.idempotencyKey === 'string' && alert.idempotencyKey.length > 0) {
				return alert.idempotencyKey;
			}
			const channelKeys = alert.idempotencyKeysByChannel;
			if (channelKeys && typeof channelKeys === 'object') {
				for (const [channelName, value] of Object.entries(channelKeys)) {
					if (typeof value === 'string' && value.length > 0) {
						return value;
					}
				}
			}
		}

		if (options && typeof options === 'object' && typeof options.idempotencyKey === 'string' && options.idempotencyKey.length > 0) {
			return options.idempotencyKey;
		}

		return undefined;
	}

	/**
	 * Build a partial `SendResult` shell that exposes the dispatch-level
	 * idempotency key. Channel `send()` implementations merge their own fields
	 * into this shell via spread, so the dedupe key survives any channel
	 * implementation that ignores it.
	 *
	 * @param {string} channelName - Channel name (e.g. `telegram`, `whatsapp`)
	 * @param {string|undefined} idempotencyKey - Effective idempotency key
	 * @returns {{ channel: string, idempotencyKey: string|undefined }}
	 */
	buildSendResultShell(channelName, idempotencyKey) {
		return {
			channel: channelName,
			idempotencyKey,
		};
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

	async notifyAdminOfFailures(alert, results, options = {}) {
		if (options && options.isRedrive) {
			return;
		}

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
				result.attemptCount !== null && result.attemptCount !== undefined ? `attempts ${result.attemptCount}` : null,
			].filter(Boolean);
			return `- ${result.channel}: ${result.error || 'Unknown error'}${metadata.length ? ` (${metadata.join(', ')})` : ''}`;
		});
		const requestId = alert && (alert.requestId || alert.correlationId);
		const redriveContext = notificationRedriveService.isEnabled()
			? [`Dead-letters queued for redrive (pending: ${notificationRedriveService.getPendingCount()})`]
			: [];
		const message = [
			'Notification delivery failure',
			`Failed channels: ${failures.map(result => result.channel).join(', ')}`,
			`Succeeded channels: ${succeededChannels.length ? succeededChannels.join(', ') : 'none'}`,
			...failureDetails,
			...redriveContext,
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

	async notifyAdminOfZeroChannels(alert, options = {}) {
		if (options && options.isRedrive) {
			return;
		}

		const runtimeConfig = remoteConfigService.getRuntimeConfig();
		const cooldownMs = runtimeConfig.ZERO_CHANNEL_ALERT_COOLDOWN_MS ?? DEFAULT_ZERO_CHANNEL_ALERT_COOLDOWN_MS;
		const now = Date.now();
		if (now - this.lastZeroChannelAlertAt < cooldownMs) {
			console.debug('[NotificationManager] Zero-channel admin notification suppressed due to cooldown');
			return;
		}
		this.lastZeroChannelAlertAt = now;

		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const telegramService = this.channels.get('telegram');
		if (!adminChatId) {
			console.warn('[NotificationManager] Admin chat is not configured; zero-channel alert notification skipped');
			return;
		}
		if (!telegramService || !telegramService.isEnabled()) {
			console.warn('[NotificationManager] Telegram is disabled; zero-channel alert notification skipped');
			return;
		}

		const requestId = alert && (alert.requestId || alert.correlationId);
		const redriveContext = notificationRedriveService.isEnabled()
			? [`Dead-letters queued for redrive (pending: ${notificationRedriveService.getPendingCount()})`]
			: [];
		const message = [
			'🚨 CRITICAL: Notification delivery failure (Zero channels enabled)',
			'All notification channels are currently disabled or failing validation.',
			'Broadcast alerts are being dropped and dead-lettered.',
			`Total zero-channel broadcasts dropped: ${this.zeroChannelBroadcastCount}`,
			...redriveContext,
			...(requestId ? [`Request ID: ${requestId}`] : []),
		].join('\n');

		try {
			const adminResult = await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			if (adminResult && adminResult.success) {
				console.info('[NotificationManager] Admin zero-channel notification sent');
			} else {
				console.error('[NotificationManager] Admin zero-channel notification failed:', adminResult && adminResult.error);
			}
		} catch (error) {
			console.error('[NotificationManager] Admin zero-channel notification failed:', error.message);
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
					.then(() => ch.send(alert, {
						...options,
						signal: options.signalByChannel?.[ch.name] || options.signal,
					}))
					.finally(() => {
						sentryService.endSpan(sendSpan);
					});
			});

			results = await Promise.allSettled(sendPromises);
		} finally {
			sentryService.endSpan(dispatchSpan);
		}

		const formattedResults = results.map((r, idx) => {
			const chName = channels[idx] ? channels[idx].name : 'unknown';
			const channelKey = this.resolveIdempotencyKey(alert, {
				...options,
				idempotencyKey: alert?.idempotencyKeysByChannel?.[chName] || options.idempotencyKey,
			});
			const shell = this.buildSendResultShell(chName, channelKey);
			if (r.status === 'fulfilled') {
				if (r.value && typeof r.value === 'object') {
					return {
						...shell,
						...r.value,
						idempotencyKey: r.value.idempotencyKey ?? shell.idempotencyKey,
					};
				}
				return {
					...shell,
					success: false,
					error: 'Channel returned empty response',
				};
			}
			return {
				...shell,
				success: false,
				error: (r.reason && (r.reason.message || String(r.reason))) || 'Unknown error',
			};
		});

		// Report external failures to Sentry
		const totalDurationMs = Date.now() - startTime;
		const httpContext = options.http || (options.endpoint ? {
			endpoint: options.endpoint,
			method: options.method || 'POST',
			statusCode: 500,
		} : undefined);

		for (const result of formattedResults) {
			if (result && !result.success && result.error) {
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
						attemptCount: result.attemptCount ?? 1,
						durationMs: result.durationMs || totalDurationMs,
						lastErrorMessage: result.error,
						lastErrorCode: result.statusCode,
					},
					http: httpContext,
				});
			}
		}

		if (!options.isRedrive && notificationRedriveService.isEnabled()) {
			const failedResults = formattedResults.filter(result => result && !result.success);
			if (failedResults.length > 0) {
				trackBackgroundTask(notificationRedriveService.recordDeliveryResults(alert, formattedResults, options)).catch((error) => {
					console.warn('[NotificationManager] Failed to record dead-letters for redrive:', error.message);
				});
			}
		}

		trackBackgroundTask(this.notifyAdminOfFailures(alert, formattedResults, options)).catch((error) => {
			console.error('[NotificationManager] Unexpected admin notification failure:', error.message);
		});

				this._recordDeliveryMetrics(formattedResults, totalDurationMs);

				console.info('[NotificationManager] Delivery results:', JSON.stringify(formattedResults.map(r => ({
					channel: r ? r.channel : 'unknown',
					success: r ? r.success : false,
					messageId: r ? r.messageId : undefined,
					error: r ? r.error : undefined,
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
			if (this.isIntentionalApiOnly()) {
				console.debug('[NotificationManager] No notification channels enabled (intentional API-only mode)');
				return [];
			}

			this.zeroChannelBroadcastCount += 1;
			notificationRedriveService.incrementZeroChannelBroadcasts();
			console.warn('[NotificationManager] No notification channels enabled; alert dropped and dead-lettered');

			const totalDurationMs = Date.now() - startTime;
			const httpContext = options.http || (options.endpoint ? {
				endpoint: options.endpoint,
				method: options.method || 'POST',
				statusCode: 500,
			} : undefined);

			sentryService.captureExternalFailure({
				channel: 'none',
				external: {
					provider: 'none',
					attemptCount: 0,
					durationMs: totalDurationMs,
					lastErrorMessage: 'No notification channels enabled at broadcast time (zero-channel drop)',
					lastErrorCode: 'NO_ENABLED_CHANNELS',
				},
				http: httpContext,
			});

			if (!options.isRedrive && notificationRedriveService.isEnabled()) {
				const candidateChannels = Array.from(this.channels.keys());
				const channelsToQueue = candidateChannels.length > 0 ? candidateChannels : ['telegram', 'whatsapp', 'discord'];
				const syntheticResults = channelsToQueue.map(channelName => ({
					channel: channelName,
					success: false,
					error: 'No notification channels enabled at broadcast time (zero-channel drop)',
					statusCode: 0,
					attemptCount: 1,
				}));

				trackBackgroundTask(
					notificationRedriveService.recordDeliveryResults(alert, syntheticResults, options),
				).catch((error) => {
					console.warn('[NotificationManager] Failed to record dead-letters for zero-channel broadcast:', error.message);
				});
			}

			trackBackgroundTask(this.notifyAdminOfZeroChannels(alert, options)).catch((error) => {
				console.error('[NotificationManager] Unexpected zero-channel admin notification failure:', error.message);
			});

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
					.then(() => ch.send(alert, {
						...options,
						signal: options.signalByChannel?.[ch.name] || options.signal,
					}))
					.finally(() => {
						sentryService.endSpan(sendSpan);
					});
			});

			results = await Promise.allSettled(sendPromises);
		} finally {
			sentryService.endSpan(dispatchSpan);
		}

		const formattedResults = results.map((r, idx) => {
			const chName = enabledChannels[idx] ? enabledChannels[idx].name : 'unknown';
			const channelKey = this.resolveIdempotencyKey(alert, {
				...options,
				idempotencyKey: alert?.idempotencyKeysByChannel?.[chName] || options.idempotencyKey,
			});
			const shell = this.buildSendResultShell(chName, channelKey);
			if (r.status === 'fulfilled') {
				if (r.value && typeof r.value === 'object') {
					return {
						...shell,
						...r.value,
						idempotencyKey: r.value.idempotencyKey ?? shell.idempotencyKey,
					};
				}
				return {
					...shell,
					success: false,
					error: 'Channel returned empty response',
				};
			}
			return {
				...shell,
				success: false,
				error: (r.reason && (r.reason.message || String(r.reason))) || 'Unknown error',
			};
		});

		// Report external failures to Sentry (T014)
		const totalDurationMs = Date.now() - startTime;
		const httpContext = options.http || (options.endpoint ? {
			endpoint: options.endpoint,
			method: options.method || 'POST',
			statusCode: 500,
		} : undefined);

		for (const result of formattedResults) {
			if (result && !result.success && result.error) {
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
						attemptCount: result.attemptCount ?? 1,
						durationMs: result.durationMs || totalDurationMs,
						lastErrorMessage: result.error,
						lastErrorCode: result.statusCode,
					},
					http: httpContext,
				});
			}
		}

		if (!options.isRedrive && notificationRedriveService.isEnabled()) {
			const failedResults = formattedResults.filter(result => result && !result.success);
			if (failedResults.length > 0) {
				trackBackgroundTask(notificationRedriveService.recordDeliveryResults(alert, formattedResults, options)).catch((error) => {
					console.warn('[NotificationManager] Failed to record dead-letters for redrive:', error.message);
				});
			}
		}

		trackBackgroundTask(this.notifyAdminOfFailures(alert, formattedResults, options)).catch((error) => {
			console.error('[NotificationManager] Unexpected admin notification failure:', error.message);
		});

		this._recordDeliveryMetrics(formattedResults, totalDurationMs);

		console.info('[NotificationManager] Delivery results:', JSON.stringify(formattedResults.map(r => ({
			channel: r ? r.channel : 'unknown',
			success: r ? r.success : false,
			messageId: r ? r.messageId : undefined,
			error: r ? r.error : undefined,
		}))));

		return formattedResults;
	}

	_recordDeliveryMetrics(formattedResults, fallbackDurationMs) {
		if (!Array.isArray(formattedResults) || formattedResults.length === 0) {
			return;
		}
		for (const result of formattedResults) {
			if (!result || typeof result !== 'object') {
				continue;
			}
			const durationMs = typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
				? result.durationMs
				: fallbackDurationMs;
			deliveryMetricsService.record({
				channel: result.channel,
				success: result.success === true,
				durationMs,
			});
		}
	}
}

module.exports = NotificationManager;
