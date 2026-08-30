'use strict';

const { jobRepository } = require('./JobRepository');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_ALERT_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_PAGE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_PROBE_INTERVAL_MS = 60 * 1000; // 1 minute

function parsePositiveInteger(value, fallback, min = 1000, max = 86400000) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		return fallback;
	}
	return parsed;
}

class JobBacklogService {
	constructor({
		jobQueue = null,
		queue = null,
		repository = jobRepository,
		botGetter = null,
		notificationManagerGetter = null,
		telegramServiceGetter = null,
		notifyAdmin = null,
		logger = console,
	} = {}) {
		this._jobQueue = queue || jobQueue;
		this.repository = repository;
		this.botGetter = botGetter;
		this.notificationManagerGetter = notificationManagerGetter;
		this.telegramServiceGetter = telegramServiceGetter;
		this.notifyAdmin = notifyAdmin;
		this.logger = logger;
		this.timer = null;
		this.running = false;
		this.hasActiveAlert = false;
		this.lastPagedAt = null;
		this.lastRecoveryAt = null;
		this.lastProbe = null;
	}

	get jobQueue() {
		if (this._jobQueue) {
			return this._jobQueue;
		}
		try {
			const { jobQueue } = require('./JobQueue');
			return jobQueue;
		} catch (error) {
			return null;
		}
	}

	set jobQueue(queue) {
		this._jobQueue = queue;
	}

	isEnabled() {
		return process.env.ENABLE_JOB_BACKLOG_MONITOR !== 'false';
	}

	getConfig() {
		const runtimeConfig = getRuntimeConfig();
		const alertThresholdMs = parsePositiveInteger(
			runtimeConfig.JOB_BACKLOG_ALERT_THRESHOLD_MS ?? process.env.JOB_BACKLOG_ALERT_THRESHOLD_MS,
			DEFAULT_ALERT_THRESHOLD_MS,
			1000,
			86400000,
		);
		const pageCooldownMs = parsePositiveInteger(
			runtimeConfig.JOB_BACKLOG_PAGE_COOLDOWN_MS ?? process.env.JOB_BACKLOG_PAGE_COOLDOWN_MS,
			DEFAULT_PAGE_COOLDOWN_MS,
			1000,
			86400000,
		);
		const probeIntervalMs = parsePositiveInteger(
			runtimeConfig.JOB_BACKLOG_PROBE_INTERVAL_MS ?? process.env.JOB_BACKLOG_PROBE_INTERVAL_MS,
			DEFAULT_PROBE_INTERVAL_MS,
			1000,
			3600000,
		);

		return {
			alertThresholdMs,
			pageCooldownMs,
			probeIntervalMs,
		};
	}

	async probe(options = {}) {
		const now = typeof options === 'number' ? options : (options?.now ?? Date.now());
		let brokerCounts = { waiting: 0, delayed: 0, failed: 0, active: 0, paused: 0 };
		try {
			if (this.jobQueue && typeof this.jobQueue.getJobCounts === 'function') {
				brokerCounts = await this.jobQueue.getJobCounts();
			}
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Broker count probe failed:', error.message);
		}

		let durable = { durableQueuedCount: 0, oldestQueuedAgeMs: null, oldestCreatedAt: null };
		try {
			if (this.repository) {
				if (typeof this.repository.isConfigured === 'function') {
					if (this.repository.isConfigured()) {
						durable = await this.repository.getBacklogDepth({ maxScan: 100, now });
					} else if (typeof this.repository.getMemoryBacklogDepth === 'function') {
						durable = this.repository.getMemoryBacklogDepth(now);
					}
				} else if (typeof this.repository.getBacklogDepth === 'function') {
					durable = await this.repository.getBacklogDepth({ maxScan: 100, now });
				} else if (typeof this.repository.getMemoryBacklogDepth === 'function') {
					durable = this.repository.getMemoryBacklogDepth(now);
				}
			}
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Durable backlog probe failed:', error.message);
		}

		const probeResult = {
			waitingCount: brokerCounts?.waiting || 0,
			delayedCount: brokerCounts?.delayed || 0,
			failedCount: brokerCounts?.failed || 0,
			activeCount: brokerCounts?.active || 0,
			durableQueuedCount: durable?.durableQueuedCount || 0,
			oldestQueuedAgeMs: durable?.oldestQueuedAgeMs ?? null,
			oldestCreatedAt: durable?.oldestCreatedAt ?? null,
			probedAt: new Date(now).toISOString(),
		};

		await this._evaluateAlert(probeResult, now);
		this.lastProbe = probeResult;
		return {
			...probeResult,
			backlogAlert: {
				active: this.hasActiveAlert,
				thresholdMs: this.getConfig().alertThresholdMs,
				pagedAt: this.lastPagedAt ? new Date(this.lastPagedAt).toISOString() : null,
				lastRecoveryAt: this.lastRecoveryAt ? new Date(this.lastRecoveryAt).toISOString() : null,
			},
		};
	}

	async _evaluateAlert(probeResult, now = Date.now()) {
		const { alertThresholdMs, pageCooldownMs } = this.getConfig();
		const oldestAge = probeResult.oldestQueuedAgeMs;
		const totalQueued = (probeResult.durableQueuedCount || 0) + (probeResult.waitingCount || 0);

		if (oldestAge !== null && oldestAge >= alertThresholdMs) {
			const shouldPage = !this.hasActiveAlert || (now - (this.lastPagedAt || 0) >= pageCooldownMs);
			if (shouldPage) {
				this.hasActiveAlert = true;
				this.lastPagedAt = now;
				await this._notifyAdminAlert(probeResult, alertThresholdMs);
			}
		} else if (this.hasActiveAlert && (oldestAge === null || oldestAge < alertThresholdMs || totalQueued === 0)) {
			this.hasActiveAlert = false;
			this.lastRecoveryAt = now;
			await this._notifyAdminRecovery(probeResult);
		}
	}

	async _notifyAdminAlert(probeResult, alertThresholdMs) {
		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const oldestMins = Math.round((probeResult.oldestQueuedAgeMs || 0) / 60000);
		const thresholdMins = Math.round(alertThresholdMs / 60000);
		const mode = process.env.JOB_EXECUTION_MODE || 'local';
		const message = [
			'⚠️ *Job Backlog Alert*',
			`Durable queued jobs: ${probeResult.durableQueuedCount}`,
			`Broker waiting jobs: ${probeResult.waitingCount}`,
			`Oldest queued job age: ${oldestMins}m (threshold: ${thresholdMins}m)`,
			`Execution mode: ${mode}`,
			'Workers may be offline, crashed, or overwhelmed.',
		].join('\n');

		if (typeof this.notifyAdmin === 'function') {
			try {
				await this.notifyAdmin({
					type: 'backlog_alert',
					message,
					probeResult,
					alertThresholdMs,
				});
			} catch (err) {
				this.logger?.warn?.(`[JobBacklogService] notifyAdmin callback failed: ${err.message}`);
			}
			return;
		}

		if (!adminChatId) {
			return;
		}

		const telegramService = this._getTelegramService();
		if (!telegramService || !telegramService.isEnabled()) {
			return;
		}

		try {
			await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			this.logger.info?.('[JobBacklogService] Sent admin alert for async job backlog breach');
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Failed to send Telegram backlog alert (fail-open)', { error: error.message });
		}
	}

	async _notifyAdminRecovery(probeResult) {
		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const oldestText = probeResult.oldestQueuedAgeMs !== null
			? `${Math.round(probeResult.oldestQueuedAgeMs / 1000)}s`
			: '0s';
		const message = [
			'✅ *Job Backlog Cleared*',
			'Backlog has drained below alert threshold.',
			`Durable queued jobs: ${probeResult.durableQueuedCount}`,
			`Broker waiting jobs: ${probeResult.waitingCount}`,
			`Oldest queued job age: ${oldestText}`,
		].join('\n');

		if (typeof this.notifyAdmin === 'function') {
			try {
				await this.notifyAdmin({
					type: 'backlog_recovery',
					message,
					probeResult,
				});
			} catch (err) {
				this.logger?.warn?.(`[JobBacklogService] notifyAdmin callback failed: ${err.message}`);
			}
			return;
		}

		if (!adminChatId) {
			return;
		}

		const telegramService = this._getTelegramService();
		if (!telegramService || !telegramService.isEnabled()) {
			return;
		}

		try {
			await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			this.logger.info?.('[JobBacklogService] Sent admin recovery notification for async job backlog');
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Failed to send Telegram backlog recovery notification (fail-open)', { error: error.message });
		}
	}

	_getTelegramService() {
		if (typeof this.telegramServiceGetter === 'function') {
			return this.telegramServiceGetter();
		}
		if (typeof this.botGetter === 'function') {
			const bot = this.botGetter();
			if (bot && bot.telegram) {
				return {
					isEnabled: () => true,
					send: async ({ text, telegramChatId }) => {
						return bot.telegram.sendMessage(telegramChatId, text, { parse_mode: 'MarkdownV2' });
					},
				};
			}
		}
		try {
			let manager = null;
			if (typeof this.notificationManagerGetter === 'function') {
				manager = this.notificationManagerGetter();
			} else {
				const { getNotificationManager } = require('../../controllers/webhooks/handlers/alert/alert');
				manager = getNotificationManager();
			}
			return manager?.channels?.get?.('telegram') || null;
		} catch (error) {
			return null;
		}
	}

	getStatus() {
		const config = this.getConfig();
		let durable = null;
		if (!this.lastProbe && this.repository && typeof this.repository.getMemoryBacklogDepth === 'function') {
			durable = this.repository.getMemoryBacklogDepth();
		}

		const waitingCount = this.lastProbe?.waitingCount ?? 0;
		const delayedCount = this.lastProbe?.delayedCount ?? 0;
		const failedCount = this.lastProbe?.failedCount ?? 0;
		const activeCount = this.lastProbe?.activeCount ?? 0;
		const durableQueuedCount = this.lastProbe?.durableQueuedCount ?? (durable?.durableQueuedCount || 0);
		const oldestQueuedAgeMs = this.lastProbe?.oldestQueuedAgeMs ?? (durable?.oldestQueuedAgeMs ?? null);
		const oldestCreatedAt = this.lastProbe?.oldestCreatedAt ?? (durable?.oldestCreatedAt ?? null);
		const lastProbedAt = this.lastProbe?.probedAt ?? null;

		return {
			waitingCount,
			delayedCount,
			failedCount,
			activeCount,
			durableQueuedCount,
			oldestQueuedAgeMs,
			oldestCreatedAt,
			lastProbedAt,
			backlogAlert: {
				active: this.hasActiveAlert,
				thresholdMs: config.alertThresholdMs,
				pagedAt: this.lastPagedAt ? new Date(this.lastPagedAt).toISOString() : null,
				lastRecoveryAt: this.lastRecoveryAt ? new Date(this.lastRecoveryAt).toISOString() : null,
			},
		};
	}

	startMonitor({ unref = true } = {}) {
		if (!this.isEnabled() || this.running) {
			return;
		}

		this.running = true;
		const { probeIntervalMs } = this.getConfig();
		this.timer = setInterval(() => {
			void this.probe();
		}, probeIntervalMs);

		if (unref && this.timer && typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	stop() {
		this.running = false;
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	_resetForTesting() {
		this.stop();
		this.hasActiveAlert = false;
		this.lastPagedAt = null;
		this.lastRecoveryAt = null;
		this.lastProbe = null;
	}
}

const jobBacklogService = new JobBacklogService();

module.exports = {
	JobBacklogService,
	jobBacklogService,
	DEFAULT_ALERT_THRESHOLD_MS,
	DEFAULT_PAGE_COOLDOWN_MS,
	DEFAULT_PROBE_INTERVAL_MS,
};
