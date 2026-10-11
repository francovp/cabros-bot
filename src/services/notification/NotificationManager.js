/**
 * NotificationManager - Orchestrates multi-channel alert sending
 * Manages Telegram and WhatsApp services, handles parallel sending and retry logic
 */

const sentryService = require('../monitoring/SentryService');
const remoteConfigService = require('../remoteConfig/RemoteConfigService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { notificationRedriveService } = require('./NotificationRedriveService');
const { deliveryMetricsService } = require('./DeliveryMetricsService');
const { chatPreferenceService } = require('../preferences/ChatPreferenceService');
const NotificationChannel = require('./NotificationChannel');
const { registerAdminPagingManager } = require('./adminPagingStatus');

const DEFAULT_ZERO_CHANNEL_ALERT_COOLDOWN_MS = 300000;

// Deterministic admin-paging fallback order. WhatsApp and Discord are independent
// providers from Telegram, so a Telegram-specific breakage (invalid admin chat id,
// bot removed from the admin group) cannot affect them.
const ADMIN_PAGING_FALLBACK_ORDER = ['discord', 'whatsapp'];

// Health state rank used to prefer a channel that is actually delivering over one that
// is merely configured. Lower is better.
// Note: there is deliberately no `failing` rank. A channel whose observed health is
// `failing` is EXCLUDED from the candidate list before this ranking is applied, so it
// can never be compared here.
const CHANNEL_HEALTH_RANK = {
	healthy: 0,
	unknown: 1,
	degraded: 2,
};

class NotificationManager {
	/**
   * @param {Object} telegramService - TelegramService instance
   * @param {Object} whatsappService - WhatsAppService instance
   * @param {Object} discordService - DiscordService instance
   * @param {Object} [preferenceService] - ChatPreferenceService instance
   */
	constructor(telegramService, whatsappService, discordService, preferenceService = chatPreferenceService) {
		this.channels = new Map(
			[
				['telegram', telegramService],
				['whatsapp', whatsappService],
				['discord', discordService],
			].filter(([, channel]) => !!channel),
		);
		this.chatPreferenceService = preferenceService || chatPreferenceService;
		this.zeroChannelBroadcastCount = 0;
		this.lastZeroChannelAlertAt = 0;
		this.adminPagingState = this._createAdminPagingState();
		notificationRedriveService.setNotificationManagerGetter(() => this);
		registerAdminPagingManager(this);
	}

	_createAdminPagingState() {
		return {
			attempts: 0,
			successes: 0,
			failures: 0,
			consecutiveFailures: 0,
			lastSuccessAt: null,
			lastFailureAt: null,
			lastSuccessChannel: null,
			lastAttemptChannel: null,
			lastErrorCategory: null,
			lastError: null,
			byChannel: new Map(),
		};
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
		this.adminPagingState = this._createAdminPagingState();
	}

	_recordAdminPagingAttempt(pageType, channelName, outcome) {
		const state = this.adminPagingState;
		state.attempts += 1;
		state.lastAttemptChannel = channelName;
		const now = new Date().toISOString();

		if (outcome.success) {
			state.successes += 1;
			state.consecutiveFailures = 0;
			state.lastSuccessAt = now;
			state.lastSuccessChannel = channelName;
			state.lastErrorCategory = null;
			state.lastError = null;
		} else {
			state.failures += 1;
			state.consecutiveFailures += 1;
			state.lastFailureAt = now;
			state.lastErrorCategory = outcome.category || null;
			state.lastError = outcome.error ? String(outcome.error).slice(0, 200) : null;
		}

		const key = `${pageType}:${channelName || 'none'}`;
		const bucket = state.byChannel.get(key) || { pageType, channel: channelName, success: 0, failure: 0 };
		if (outcome.success) {
			bucket.success += 1;
		} else {
			bucket.failure += 1;
		}
		state.byChannel.set(key, bucket);
	}

	/**
	 * Non-secret admin-paging health for /api/status so an operator can distinguish a
	 * working operator path from a silent one. Exposes channel names and counters only —
	 * never tokens, webhook URLs, or chat IDs.
	 * @returns {Object}
	 */
	getAdminPagingStatus() {
		const state = this.adminPagingState;
		// Resolve the candidates ONCE. Previously evaluated twice here and twice more by
		// the caller, so a single /api/status read emitted four console.warn lines for one
		// failing channel - sustained log noise for any status poller.
		const fallbackChannels = this.getAdminPagingFallbackChannels();
		// Derived from CONSECUTIVE failures, not from "has ever succeeded". Keying on
		// lifetime successes pinned a block to 'ready' through any number of subsequent
		// total failures, which is the exact state an operator needs to see.
		let status = 'unknown';
		if (state.consecutiveFailures > 0) {
			status = 'degraded';
		} else if (state.successes > 0) {
			status = 'ready';
		}
		return {
			// True when ANY admin destination is usable. Keying this on the Telegram chat
			// alone reported `enabled: false` while a page was actually delivered over
			// WhatsApp, which is what OpenAPI documents it as.
			enabled: Boolean(process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID) || fallbackChannels.length > 0,
			status,
			telegramAdminChatConfigured: Boolean(process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID),
			fallbackEnabled: fallbackChannels.length > 0,
			fallbackChannels: fallbackChannels.map((channel) => channel.name),
			attempts: state.attempts,
			successes: state.successes,
			failures: state.failures,
			consecutiveFailures: state.consecutiveFailures,
			lastSuccessAt: state.lastSuccessAt,
			lastFailureAt: state.lastFailureAt,
			lastSuccessChannel: state.lastSuccessChannel,
			lastAttemptChannel: state.lastAttemptChannel,
			lastErrorCategory: state.lastErrorCategory,
			lastError: state.lastError,
			byChannel: Array.from(state.byChannel.values()),
		};
	}

	/**
	 * Candidate fallback channels for admin paging, ordered by observed delivery health.
	 * A channel the operator never configured is excluded so a never-configured channel can
	 * never produce a phantom admin page. A channel with a `failing` health state (deliveries
	 * attempted, zero succeeded) is excluded too: paging a destination that has never once
	 * delivered cannot inform anyone, it only duplicates the failure. Degraded channels stay
	 * eligible but rank behind healthy and unknown ones.
	 * @returns {Array<Object>} channel instances
	 */
	getAdminPagingFallbackChannels() {
		// Wrapped because this runs from /api/status as well as the dispatch path, and a
		// channel whose configuration probe throws would otherwise escape
		// _dispatchAdminPage, breaking its documented "never throws" contract.
		try {
			return this._collectAdminPagingFallbackChannels();
		} catch (error) {
			console.warn(`[NotificationManager] Failed to resolve admin paging fallbacks: ${error.message}`);
			return [];
		}
	}

	_collectAdminPagingFallbackChannels() {
		const candidates = [];
		for (const name of ADMIN_PAGING_FALLBACK_ORDER) {
			const channel = this.channels.get(name);
			if (!channel) {
				continue;
			}
			if (!this.isChannelConfigured(channel)) {
				continue;
			}
			if (deliveryMetricsService.getChannelHealth(name).state === 'failing') {
				console.warn(`[NotificationManager] Skipping ${name} for admin paging: no successful delivery recorded`);
				continue;
			}
			candidates.push({ name, channel });
		}
		return candidates
			.sort((a, b) => {
				const rankA = CHANNEL_HEALTH_RANK[deliveryMetricsService.getChannelHealth(a.name).state] ?? 1;
				const rankB = CHANNEL_HEALTH_RANK[deliveryMetricsService.getChannelHealth(b.name).state] ?? 1;
				if (rankA !== rankB) {
					return rankA - rankB;
				}
				return ADMIN_PAGING_FALLBACK_ORDER.indexOf(a.name) - ADMIN_PAGING_FALLBACK_ORDER.indexOf(b.name);
			})
			.map(entry => entry.channel);
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
   * Get per-channel runtime health (Discord health, future channel telemetry).
   * Channels without a getStatus() method are skipped.
   * @returns {Object<string, Object|null>}
   */
		getChannelStatuses() {
			const statuses = {};
			for (const [name, channel] of this.channels.entries()) {
				if (channel && typeof channel.getStatus === 'function') {
					statuses[name] = channel.getStatus();
				}
			}
			return statuses;
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
	 * Check if a channel is configured for delivery by operator intent.
	 * Subclasses of NotificationChannel report based on operator gates and credentials.
	 * Plain mocks in unit tests without isConfigured default to true for backward compatibility.
	 * @param {Object} channel
	 * @returns {boolean}
	 */
	isChannelConfigured(channel) {
		if (!channel) {
			return false;
		}
		if (typeof channel.isConfigured === 'function') {
			return Boolean(channel.isConfigured());
		}
		if (typeof channel.isConfigured === 'boolean') {
			return channel.isConfigured;
		}
		if (channel instanceof NotificationChannel) {
			return typeof channel.isEnabled === 'function' ? channel.isEnabled() : false;
		}
		return true;
	}

	/**
	 * Get array of names of channels that are configured by operator intent
	 * @returns {Array<string>}
	 */
	getConfiguredChannels() {
		return Array.from(this.channels.values())
			.filter(channel => this.isChannelConfigured(channel))
			.map(channel => channel.name);
	}

	/**
	 * Get array of names of registered channels the operator never configured.
	 * Used to make the zero-channel admin page actionable ("why did I get this?").
	 * @returns {Array<string>}
	 */
	getUnconfiguredChannels() {
		return Array.from(this.channels.values())
			.filter(channel => !this.isChannelConfigured(channel))
			.map(channel => channel.name);
	}

	/**
	 * Check if Telegram service is eligible to send admin notifications.
	 * Allows dedicated admin paging during zero-channel outages even when
	 * the default broadcast channel is disabled or missing its broadcast chat ID.
	 * @param {Object} telegramService
	 * @returns {boolean}
	 */
	isTelegramAdminDeliveryEligible(telegramService) {
		if (!telegramService) {
			return false;
		}
		if (typeof telegramService.isAdminDeliveryEligible === 'function') {
			return telegramService.isAdminDeliveryEligible();
		}
		if (telegramService.isEnabled?.()) {
			return true;
		}
		if (telegramService.bot) {
			return true;
		}
		if (typeof telegramService.send === 'function' && !('bot' in telegramService)) {
			return true;
		}
		return false;
	}

	/**
	 * Deliver an operator page over the non-recursive admin path.
	 *
	 * Primary destination is the Telegram admin chat. When that page cannot be delivered,
	 * it fails over to the other operator-configured channels, preferring channels whose
	 * observed delivery health is best. Each channel is invoked directly (channel.send())
	 * and never through sendToAll/sendToChannels, so admin paging cannot recurse and cannot
	 * inflate broadcast delivery metrics or dead-letter counters.
	 *
	 * Fail-open: never throws and never rejects.
	 * @param {Object} params
	 * @param {string} params.message - Plain-text page body
	 * @param {string} params.pageType - Page identifier used for telemetry only
	 * @returns {Promise<{delivered: boolean, channel: string|null, attempts: Array<{channel: string, success: boolean, error?: string, category?: string, attemptCount?: number, statusCode?: number|null}>}>}
	 */
	async _dispatchAdminPage({ message, pageType }) {
		const attempts = [];
		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const telegramService = this.channels.get('telegram');

		if (adminChatId && this.isTelegramAdminDeliveryEligible(telegramService)) {
			const startedAt = Date.now();
			let result;
			try {
				result = await telegramService.send({
					text: message,
					telegramChatId: adminChatId,
				});
			} catch (error) {
				result = { success: false, error: error.message };
			}
			const normalized = this._normalizeAdminAttempt('telegram', result, Date.now() - startedAt);
			attempts.push(normalized);
			this._recordAdminPagingAttempt(pageType, 'telegram', normalized);
			if (normalized.success) {
				console.info(`[NotificationManager] Admin ${pageType} notification sent via telegram`);
				return { delivered: true, channel: 'telegram', attempts };
			}
			console.error(`[NotificationManager] Admin ${pageType} notification failed on telegram: ${normalized.error}`);
		} else {
			const reason = !adminChatId ? 'admin chat is not configured' : 'telegram is not eligible for admin delivery';
			console.warn(`[NotificationManager] ${reason}; admin ${pageType} notification falling back to alternate channels`);
			// Deliberately NOT recorded as a channel attempt. Nothing was sent to
			// telegram, so counting it as a failure made consecutiveFailures - the
			// documented signal for uptime monitoring to page on - climb without bound
			// for an operator who never configured admin paging, and asserted in
			// byChannel that telegram was tried N times when it was tried zero times.
			// That is the phantom-alarm failure this work set out to prevent.
		}

		for (const channel of this.getAdminPagingFallbackChannels()) {
			const startedAt = Date.now();
			let result;
			try {
				result = await channel.send({ text: message });
			} catch (error) {
				result = { success: false, error: error.message };
			}
			const normalized = this._normalizeAdminAttempt(channel.name, result, Date.now() - startedAt);
			attempts.push(normalized);
			this._recordAdminPagingAttempt(pageType, channel.name, normalized);
			if (normalized.success) {
				console.info(`[NotificationManager] Admin ${pageType} notification delivered via fallback channel ${channel.name}`);
				return { delivered: true, channel: channel.name, attempts };
			}
			console.error(`[NotificationManager] Admin ${pageType} notification failed on fallback channel ${channel.name}: ${normalized.error}`);
		}

		// Every operator destination is unavailable. Make the blackout visible in Sentry so
		// sustained failure is not only in process logs.
		sentryService.captureExternalFailure({
			channel: 'admin-paging',
			feature: 'admin-paging',
			external: {
				provider: 'admin-paging',
				attemptCount: attempts.length,
				durationMs: attempts.reduce((total, attempt) => total + (attempt.durationMs || 0), 0),
				lastErrorMessage: attempts
					.map(attempt => `${attempt.channel}: ${attempt.error || 'Unknown error'}`)
					.join('; '),
				lastErrorCode: 'ADMIN_PAGING_UNDELIVERABLE',
			},
			extra: {
				page_type: pageType,
				attempted_channels: attempts.map(attempt => attempt.channel).join(','),
			},
		});
		console.error(`[NotificationManager] Admin ${pageType} notification undeliverable on every operator channel`);

		return { delivered: false, channel: null, attempts };
	}

	/**
	 * Normalize a channel send result into a stable admin-paging attempt record.
	 * Does not mutate counters, and preserves the real attemptCount reported by the channel.
	 */
	_normalizeAdminAttempt(channelName, result, durationMs) {
		const success = Boolean(result && result.success);
		return {
			channel: channelName,
			success,
			error: success ? undefined : (result && result.error) || 'Unknown error',
			category: (result && result.category) || (success ? null : 'PROVIDER_ERROR'),
			statusCode: result && result.statusCode !== undefined ? result.statusCode : null,
			attemptCount: result && typeof result.attemptCount === 'number' ? result.attemptCount : 1,
			durationMs: Number.isFinite(durationMs) ? durationMs : 0,
		};
	}

	_isRedriveIneligible(alert, options = {}) {
		return Boolean(options && options.isRedrive) ||
			(options && options.redriveEligible === false) ||
			Boolean(options && options.isProbe) ||
			Boolean(alert && alert.isProbe) ||
			Boolean(alert && alert.redriveEligible === false);
	}

	async notifyAdminOfFailures(alert, results, options = {}) {
		if (options && options.isRedrive) {
			return;
		}

		const failures = results.filter(result => !result.success);
		if (failures.length === 0) {
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
		const isRedriveIneligible = this._isRedriveIneligible(alert, options);
		const redriveContext = !isRedriveIneligible && notificationRedriveService.isEnabled()
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

		await this._dispatchAdminPage({ message, pageType: 'delivery-failure' });
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

		const requestId = alert && (alert.requestId || alert.correlationId);
		const configuredChannels = this.getConfiguredChannels();
		const unconfiguredChannels = this.getUnconfiguredChannels();
		const isRedriveIneligible = this._isRedriveIneligible(alert, options);
		const redriveContext = !isRedriveIneligible && notificationRedriveService.isEnabled() && configuredChannels.length > 0
			? [`Dead-letters queued for redrive (pending: ${notificationRedriveService.getPendingCount()})`]
			: [];
		const droppedMessage = configuredChannels.length > 0 && !isRedriveIneligible
			? 'Broadcast alerts are being dropped and dead-lettered.'
			: 'Broadcast alerts are being dropped.';
		// Operator intent is the difference between "a channel broke" and "a channel was never
		// configured". Reporting both sets makes the page self-diagnosing.
		const channelContext = configuredChannels.length === 0
			? ['No notification channels are configured (operator intent).']
			: [`Configured channels (failing validation or disabled at runtime): ${configuredChannels.join(', ')}`];
		if (unconfiguredChannels.length > 0) {
			channelContext.push(`Not configured: ${unconfiguredChannels.join(', ')}`);
		}
		const message = [
			'🚨 CRITICAL: Notification delivery failure (Zero channels enabled)',
			'All notification channels are currently disabled or failing validation.',
			droppedMessage,
			`Total zero-channel broadcasts dropped: ${this.zeroChannelBroadcastCount}`,
			...channelContext,
			...redriveContext,
			...(requestId ? [`Request ID: ${requestId}`] : []),
		].join('\n');

		await this._dispatchAdminPage({ message, pageType: 'zero-channel' });
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

				const channelStartTime = Date.now();
				return Promise.resolve()
					.then(async () => {
						const prefCheck = await this._evaluateChatPreferences(ch, alert, options);
						if (!prefCheck.deliver) {
							return {
								channel: ch.name,
								success: true,
								skipped: true,
								reason: 'PREFERENCE_FILTER',
								filterReason: prefCheck.reason,
							};
						}
						const channelSignal = options.signalByChannel?.[ch.name];
						let signal = options.signal;
						if (channelSignal && signal) {
							signal = AbortSignal.any([channelSignal, signal]);
						} else if (channelSignal) {
							signal = channelSignal;
						}
						return ch.send(alert, {
							...options,
							signal,
						});
					})
					.then((value) => ({
						value,
						durationMs: Date.now() - channelStartTime,
					}))
					.catch((error) => Promise.reject({
						error,
						durationMs: Date.now() - channelStartTime,
					}))
					.finally(() => {
						sentryService.endSpan(sendSpan);
					});
			});

			results = await Promise.allSettled(sendPromises);
		} finally {
			sentryService.endSpan(dispatchSpan);
		}

		const totalDurationMs = Date.now() - startTime;

		const formattedResults = results.map((r, idx) => {
			const chName = channels[idx] ? channels[idx].name : 'unknown';
			if (r.status === 'fulfilled') {
				const val = r.value && r.value.value;
				const fallbackDuration = (r.value && typeof r.value.durationMs === 'number')
					? r.value.durationMs
					: Math.max(Date.now() - startTime, 0);

				if (val && typeof val === 'object') {
					const item = {
						channel: chName,
						...val,
					};
					if (typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0) {
						item.durationMs = fallbackDuration;
					}
					return item;
				}
				return {
					success: false,
					channel: chName,
					error: 'Channel returned empty response',
					durationMs: fallbackDuration,
				};
			}

			const reasonErr = r.reason && r.reason.error !== undefined ? r.reason.error : r.reason;
			const fallbackDuration = (r.reason && typeof r.reason.durationMs === 'number')
				? r.reason.durationMs
				: Math.max(Date.now() - startTime, 0);

			return {
				success: false,
				channel: chName,
				error: (reasonErr && (reasonErr.message || String(reasonErr))) || 'Unknown error',
				durationMs: fallbackDuration,
			};
		});

		// Report external failures to Sentry
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

		const isRedriveIneligible = this._isRedriveIneligible(alert, options);

		if (!isRedriveIneligible && notificationRedriveService.isEnabled()) {
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

		const isRedriveIneligible = this._isRedriveIneligible(alert, options);

		if (!isRedriveIneligible && notificationRedriveService.isEnabled()) {
				const candidateChannels = this.getConfiguredChannels();
				if (candidateChannels.length > 0) {
					const syntheticResults = candidateChannels.map(channelName => ({
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

				const channelStartTime = Date.now();
				return Promise.resolve()
					.then(async () => {
						const prefCheck = await this._evaluateChatPreferences(ch, alert, options);
						if (!prefCheck.deliver) {
							return {
								channel: ch.name,
								success: true,
								skipped: true,
								reason: 'PREFERENCE_FILTER',
								filterReason: prefCheck.reason,
							};
						}
						return ch.send(alert, {
							...options,
							signal: options.signalByChannel?.[ch.name] || options.signal,
						});
					})
					.then((value) => ({
						value,
						durationMs: Date.now() - channelStartTime,
					}))
					.catch((error) => Promise.reject({
						error,
						durationMs: Date.now() - channelStartTime,
					}))
					.finally(() => {
						sentryService.endSpan(sendSpan);
					});
			});

			results = await Promise.allSettled(sendPromises);
		} finally {
			sentryService.endSpan(dispatchSpan);
		}

		const totalDurationMs = Date.now() - startTime;

		const formattedResults = results.map((r, idx) => {
			const chName = enabledChannels[idx] ? enabledChannels[idx].name : 'unknown';
			if (r.status === 'fulfilled') {
				const val = r.value && r.value.value;
				const fallbackDuration = (r.value && typeof r.value.durationMs === 'number')
					? r.value.durationMs
					: Math.max(Date.now() - startTime, 0);

				if (val && typeof val === 'object') {
					const item = {
						channel: chName,
						...val,
					};
					if (typeof item.durationMs !== 'number' || !Number.isFinite(item.durationMs) || item.durationMs < 0) {
						item.durationMs = fallbackDuration;
					}
					return item;
				}
				return {
					success: false,
					channel: chName,
					error: 'Channel returned empty response',
					durationMs: fallbackDuration,
				};
			}

			const reasonErr = r.reason && r.reason.error !== undefined ? r.reason.error : r.reason;
			const fallbackDuration = (r.reason && typeof r.reason.durationMs === 'number')
				? r.reason.durationMs
				: Math.max(Date.now() - startTime, 0);

			return {
				success: false,
				channel: chName,
				error: (reasonErr && (reasonErr.message || String(reasonErr))) || 'Unknown error',
				durationMs: fallbackDuration,
			};
		});

		// Report external failures to Sentry (T014)
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

		const isRedriveIneligible = this._isRedriveIneligible(alert, options);

		if (!isRedriveIneligible && notificationRedriveService.isEnabled()) {
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

	async _evaluateChatPreferences(channel, alert, options = {}) {
		if (options.bypassPreferences || alert?.bypassPreferences || alert?.isProbe || options.isProbe) {
			return { deliver: true };
		}
		const chatId = channel.name === 'telegram'
			? (alert?.telegramChatId || channel.chatId)
			: channel.name === 'whatsapp'
				? (alert?.whatsappChatId || channel.chatId)
				: channel.chatId;

		const prefService = this.chatPreferenceService || chatPreferenceService;
		return prefService.shouldDeliverAlert({
			chatId: chatId ? String(chatId) : '',
			channel: channel.name,
			alert,
			options,
		});
	}

	_recordDeliveryMetrics(formattedResults, fallbackDurationMs) {
		if (!Array.isArray(formattedResults) || formattedResults.length === 0) {
			return;
		}
		for (const result of formattedResults) {
			if (!result || typeof result !== 'object' || result.skipped) {
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
