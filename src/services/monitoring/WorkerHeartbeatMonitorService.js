'use strict';

const AlertStorageService = require('../storage/AlertStorageService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_STALE_MULTIPLIER = 3;
const MIN_STALE_MULTIPLIER = 1;
const MAX_STALE_MULTIPLIER = 20;

const DEFAULT_ALERT_COOLDOWN_MS = 1800000; // 30 minutes
const MIN_ALERT_COOLDOWN_MS = 1000;
const MAX_ALERT_COOLDOWN_MS = 86400000;

const DEFAULT_CHECK_INTERVAL_MS = 60000; // 1 minute
const MIN_CHECK_INTERVAL_MS = 1000;
const MAX_CHECK_INTERVAL_MS = 3600000;

const DEFAULT_GRACE_PERIOD_MS = 300000; // 5 minutes
const FIRESTORE_READ_TIMEOUT_MS = 5000;

function parseBoundedInteger(value, fallback, min, max) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) {
		return fallback;
	}
	return Math.max(min, Math.min(parsed, max));
}

function formatDuration(ms) {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	if (totalSeconds < 60) {
		return `${totalSeconds}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) {
		return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	}
	const hours = Math.floor(minutes / 60);
	const remainingMinutes = minutes % 60;
	return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function awaitWithTimeout(promise, timeoutMs, message) {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timerId = setTimeout(() => {
			settled = true;
			reject(new Error(message));
		}, timeoutMs);

		Promise.resolve(promise).then((value) => {
			if (settled) return;
			settled = true;
			globalThis.clearTimeout?.(timerId);
			resolve(value);
		}, (error) => {
			if (settled) return;
			settled = true;
			globalThis.clearTimeout?.(timerId);
			reject(error);
		});
	});
}

function extractTimestampMs(value) {
	if (!value) return null;
	if (typeof value.toDate === 'function') {
		return value.toDate().getTime();
	}
	if (value instanceof Date) {
		return value.getTime();
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const parsed = new Date(value).getTime();
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

class WorkerHeartbeatMonitorService {
	constructor(options = {}) {
		this.getFirestore = options.getFirestore || (() => AlertStorageService.getFirestore());
		this.getNotificationManager = options.getNotificationManager || (() => this._resolveNotificationManager());
		this.notifyAdmin = options.notifyAdmin || null;
		this.logger = options.logger || console;
		this.workers = options.workers || this._getDefaultWorkers();

		this.running = false;
		this.timer = null;
		this.activeCheckPromise = null;
		this.startedAt = Date.now();
		this.lastCheckedAt = null;

		this.workerStates = new Map();
	}

	_getDefaultWorkers() {
		return [
			{
				id: 'signal-outcome',
				name: 'Signal Outcome Worker',
				collection: 'workerHeartbeats',
				docId: 'signal-outcome',
				isEnabled: () => process.env.ENABLE_SIGNAL_OUTCOME_TRACKING === 'true',
				getRole: () => (process.env.SIGNAL_OUTCOME_WORKER_ROLE || 'web').trim().toLowerCase(),
				getIntervalMs: () => {
					const val = process.env.SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS || process.env.SIGNAL_OUTCOME_EVALUATION_CADENCE_MS;
					const parsed = Number(val);
					return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
				},
			},
			{
				id: 'scanner-preset-scheduler',
				name: 'Scanner Preset Scheduler',
				collection: 'workerHeartbeats',
				docId: 'scanner-preset-scheduler',
				isEnabled: () => process.env.ENABLE_SCANNER_PRESET_SCHEDULER === 'true',
				getRole: () => (process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE || 'web').trim().toLowerCase(),
				getIntervalMs: () => {
					const runtime = getRuntimeConfig();
					const val = runtime.SCANNER_PRESET_SCHEDULER_INTERVAL_MS !== undefined
						? runtime.SCANNER_PRESET_SCHEDULER_INTERVAL_MS
						: process.env.SCANNER_PRESET_SCHEDULER_INTERVAL_MS;
					const parsed = Number(val);
					return Number.isFinite(parsed) && parsed > 0 ? parsed : 60000;
				},
			},
		];
	}

	_resolveNotificationManager() {
		try {
			const { getNotificationManager } = require('../../controllers/webhooks/handlers/alert/alert');
			return typeof getNotificationManager === 'function' ? getNotificationManager() : null;
		} catch {
			return null;
		}
	}

	getStaleMultiplier() {
		const runtime = getRuntimeConfig();
		const raw = runtime.WORKER_HEARTBEAT_STALE_MULTIPLIER !== undefined
			? runtime.WORKER_HEARTBEAT_STALE_MULTIPLIER
			: process.env.WORKER_HEARTBEAT_STALE_MULTIPLIER;
		return parseBoundedInteger(raw, DEFAULT_STALE_MULTIPLIER, MIN_STALE_MULTIPLIER, MAX_STALE_MULTIPLIER);
	}

	getAlertCooldownMs() {
		const runtime = getRuntimeConfig();
		const raw = runtime.WORKER_HEARTBEAT_ALERT_COOLDOWN_MS !== undefined
			? runtime.WORKER_HEARTBEAT_ALERT_COOLDOWN_MS
			: process.env.WORKER_HEARTBEAT_ALERT_COOLDOWN_MS;
		return parseBoundedInteger(raw, DEFAULT_ALERT_COOLDOWN_MS, MIN_ALERT_COOLDOWN_MS, MAX_ALERT_COOLDOWN_MS);
	}

	getCheckIntervalMs() {
		const runtime = getRuntimeConfig();
		const raw = runtime.WORKER_HEARTBEAT_CHECK_INTERVAL_MS !== undefined
			? runtime.WORKER_HEARTBEAT_CHECK_INTERVAL_MS
			: process.env.WORKER_HEARTBEAT_CHECK_INTERVAL_MS;
		return parseBoundedInteger(raw, DEFAULT_CHECK_INTERVAL_MS, MIN_CHECK_INTERVAL_MS, MAX_CHECK_INTERVAL_MS);
	}

	getGracePeriodMs() {
		const raw = process.env.WORKER_HEARTBEAT_GRACE_PERIOD_MS;
		return parseBoundedInteger(raw, DEFAULT_GRACE_PERIOD_MS, 0, 3600000);
	}

	_getWorkerState(workerId) {
		if (!this.workerStates.has(workerId)) {
			this.workerStates.set(workerId, {
				isAlerting: false,
				lastPageSentAt: null,
				lastSeenAt: null,
				lastStatus: null,
				lastReason: null,
			});
		}
		return this.workerStates.get(workerId);
	}

	async checkHeartbeats(options = {}) {
		if (this.activeCheckPromise) {
			return this.activeCheckPromise;
		}

		this.activeCheckPromise = this._executeCheckHeartbeats(options).finally(() => {
			this.activeCheckPromise = null;
		});

		return this.activeCheckPromise;
	}

	async _executeCheckHeartbeats(options = {}) {
		const nowMs = options.now !== undefined ? Number(options.now) : Date.now();
		const staleMultiplier = options.staleMultiplier || this.getStaleMultiplier();
		const alertCooldownMs = options.alertCooldownMs || this.getAlertCooldownMs();
		const gracePeriodMs = options.gracePeriodMs !== undefined ? options.gracePeriodMs : this.getGracePeriodMs();
		const uptimeMs = Math.max(0, nowMs - this.startedAt);

		const results = {};

		for (const worker of this.workers) {
			const state = this._getWorkerState(worker.id);
			const enabled = typeof worker.isEnabled === 'function' ? worker.isEnabled() : true;
			const role = typeof worker.getRole === 'function' ? worker.getRole() : 'web';

			if (!enabled || role !== 'worker') {
				if (state.isAlerting) {
					state.isAlerting = false;
					state.lastPageSentAt = null;
				}
				state.lastStatus = !enabled ? 'disabled' : 'skipped_non_worker';
				results[worker.id] = {
					status: state.lastStatus,
					enabled,
					role,
				};
				continue;
			}

			const firestore = this.getFirestore();
			if (!firestore) {
				results[worker.id] = {
					status: 'skipped_no_firestore',
					enabled,
					role,
				};
				continue;
			}

			let docSnapshot;
			try {
				docSnapshot = await awaitWithTimeout(
					firestore.collection(worker.collection).doc(worker.docId).get(),
					FIRESTORE_READ_TIMEOUT_MS,
					`Firestore read timed out after ${FIRESTORE_READ_TIMEOUT_MS}ms`,
				);
			} catch (err) {
				this.logger?.warn?.(`[WorkerHeartbeatMonitor] Failed to read heartbeat for ${worker.id}: ${err.message}`);
				results[worker.id] = {
					status: 'error',
					error: err.message,
					enabled,
					role,
				};
				continue;
			}

			const exists = docSnapshot && docSnapshot.exists;
			const intervalMs = typeof worker.getIntervalMs === 'function' ? worker.getIntervalMs() : 60000;
			const thresholdMs = intervalMs * staleMultiplier;

			if (!exists) {
				if (uptimeMs < gracePeriodMs) {
					state.lastStatus = 'grace_period';
					results[worker.id] = {
						status: 'grace_period',
						uptimeMs,
						gracePeriodMs,
						enabled,
						role,
					};
					continue;
				}

				// Missing heartbeat past grace period -> STALE
				const shouldPage = !state.isAlerting || (state.lastPageSentAt && (nowMs - state.lastPageSentAt >= alertCooldownMs));
				state.lastStatus = 'stale';
				state.lastReason = 'missing_heartbeat';

				if (shouldPage) {
					state.isAlerting = true;
					state.lastPageSentAt = nowMs;
					await this._sendAdminPage({
						type: 'stale',
						worker,
						role,
						status: 'MISSING',
						details: `No heartbeat document found in Firestore (uptime: ${formatDuration(uptimeMs)}, grace period: ${formatDuration(gracePeriodMs)})`,
						intervalMs,
						thresholdMs,
						staleMultiplier,
						data: null,
					});
				}

				results[worker.id] = {
					status: 'stale',
					reason: 'missing_heartbeat',
					uptimeMs,
					enabled,
					role,
				};
				continue;
			}

			const data = docSnapshot.data() || {};
			const updatedAtMs = extractTimestampMs(data.updatedAt) || extractTimestampMs(data.lastRunAt);

			if (!updatedAtMs) {
				// Document exists but has no readable timestamp -> evaluate as missing timestamp
				if (uptimeMs < gracePeriodMs) {
					state.lastStatus = 'grace_period';
					results[worker.id] = {
						status: 'grace_period',
						uptimeMs,
						gracePeriodMs,
						enabled,
						role,
					};
					continue;
				}

				const shouldPage = !state.isAlerting || (state.lastPageSentAt && (nowMs - state.lastPageSentAt >= alertCooldownMs));
				state.lastStatus = 'stale';
				state.lastReason = 'invalid_timestamp';

				if (shouldPage) {
					state.isAlerting = true;
					state.lastPageSentAt = nowMs;
					await this._sendAdminPage({
						type: 'stale',
						worker,
						role,
						status: 'INVALID_TIMESTAMP',
						details: 'Heartbeat document exists but has no valid updatedAt timestamp',
						intervalMs,
						thresholdMs,
						staleMultiplier,
						data,
					});
				}

				results[worker.id] = {
					status: 'stale',
					reason: 'invalid_timestamp',
					enabled,
					role,
				};
				continue;
			}

			const ageMs = Math.max(0, nowMs - updatedAtMs);
			const isStale = ageMs > thresholdMs;

			if (isStale) {
				const shouldPage = !state.isAlerting || (state.lastPageSentAt && (nowMs - state.lastPageSentAt >= alertCooldownMs));
				state.lastStatus = 'stale';
				state.lastReason = 'stale_heartbeat';

				if (shouldPage) {
					state.isAlerting = true;
					state.lastPageSentAt = nowMs;
					await this._sendAdminPage({
						type: 'stale',
						worker,
						role,
						status: 'STALE',
						lastSeenAt: new Date(updatedAtMs).toISOString(),
						ageMs,
						thresholdMs,
						intervalMs,
						staleMultiplier,
						data,
					});
				}

				results[worker.id] = {
					status: 'stale',
					reason: 'stale_heartbeat',
					ageMs,
					thresholdMs,
					lastSeenAt: new Date(updatedAtMs).toISOString(),
					data,
					enabled,
					role,
				};
			} else {
				// Healthy
				const wasAlerting = state.isAlerting;
				state.isAlerting = false;
				state.lastPageSentAt = null;
				state.lastSeenAt = new Date(updatedAtMs).toISOString();
				state.lastStatus = 'healthy';
				state.lastReason = null;

				if (wasAlerting) {
					await this._sendAdminPage({
						type: 'recovery',
						worker,
						role,
						status: 'HEALTHY',
						lastSeenAt: state.lastSeenAt,
						data,
					});
				}

				results[worker.id] = {
					status: 'healthy',
					ageMs,
					thresholdMs,
					lastSeenAt: state.lastSeenAt,
					data,
					enabled,
					role,
				};
			}
		}

		this.lastCheckedAt = new Date(nowMs).toISOString();
		return results;
	}

	async _sendAdminPage(payload) {
		if (typeof this.notifyAdmin === 'function') {
			try {
				await this.notifyAdmin(payload);
			} catch (err) {
				this.logger?.warn?.(`[WorkerHeartbeatMonitor] notifyAdmin callback failed: ${err.message}`);
			}
			return;
		}

		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		if (!adminChatId) {
			return;
		}

		let message;
		if (payload.type === 'recovery') {
			message = [
				'✅ Worker Heartbeat Recovered',
				`Worker: ${payload.worker.name} (${payload.worker.id})`,
				'Status: HEALTHY',
				`Heartbeat Resumed: ${payload.lastSeenAt || 'recently'}`,
				'Worker is beating normally.',
			].join('\n');
		} else {
			const lines = [
				'🚨 Worker Heartbeat Stale Alert',
				`Worker: ${payload.worker.name} (${payload.worker.id})`,
				`Status: ${payload.status}`,
				`Role: ${payload.role}`,
			];

			if (payload.lastSeenAt && payload.ageMs !== undefined) {
				lines.push(`Last Heartbeat: ${payload.lastSeenAt} (${formatDuration(payload.ageMs)} ago)`);
			}
			if (payload.thresholdMs !== undefined && payload.intervalMs !== undefined) {
				lines.push(`Threshold: ${formatDuration(payload.thresholdMs)} (${payload.staleMultiplier}x interval: ${formatDuration(payload.intervalMs)})`);
			}
			if (payload.details) {
				lines.push(`Details: ${payload.details}`);
			}
			if (payload.data) {
				const counters = [];
				if (payload.data.lastRunScannedCount !== undefined) counters.push(`scanned=${payload.data.lastRunScannedCount}`);
				if (payload.data.lastRunEvaluatedCount !== undefined) counters.push(`evaluated=${payload.data.lastRunEvaluatedCount}`);
				if (payload.data.lastRunExecutedCount !== undefined) counters.push(`executed=${payload.data.lastRunExecutedCount}`);
				if (payload.data.lastRunPendingCount !== undefined) counters.push(`pending=${payload.data.lastRunPendingCount}`);
				if (payload.data.lastRunErrorCount !== undefined) counters.push(`errors=${payload.data.lastRunErrorCount}`);
				if (counters.length > 0) {
					lines.push(`Operational Counters: ${counters.join(', ')}`);
				}
			}

			message = lines.join('\n');
		}

		try {
			const manager = this.getNotificationManager();
			const telegramService = manager?.channels?.get?.('telegram');
			if (telegramService && telegramService.isEnabled()) {
				await telegramService.send({
					text: message,
					telegramChatId: adminChatId,
				});
			}
		} catch (err) {
			this.logger?.warn?.(`[WorkerHeartbeatMonitor] Failed to send admin notification: ${err.message}`);
		}
	}

	start() {
		if (this.running) {
			return;
		}

		this.running = true;
		this.startedAt = Date.now();

		// Schedule recurring check
		const checkInterval = this.getCheckIntervalMs();
		this.timer = setInterval(() => {
			void this.checkHeartbeats().catch((err) => {
				this.logger?.warn?.(`[WorkerHeartbeatMonitor] Periodic check error: ${err.message}`);
			});
		}, checkInterval);

		if (this.timer && typeof this.timer.unref === 'function') {
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

	getStatus() {
		const workerStatusMap = {};
		for (const worker of this.workers) {
			const state = this._getWorkerState(worker.id);
			workerStatusMap[worker.id] = {
				name: worker.name,
				enabled: typeof worker.isEnabled === 'function' ? worker.isEnabled() : true,
				role: typeof worker.getRole === 'function' ? worker.getRole() : 'web',
				isAlerting: state.isAlerting,
				lastPageSentAt: state.lastPageSentAt ? new Date(state.lastPageSentAt).toISOString() : null,
				lastSeenAt: state.lastSeenAt,
				lastStatus: state.lastStatus,
				lastReason: state.lastReason,
			};
		}

		return {
			running: this.running,
			checkIntervalMs: this.getCheckIntervalMs(),
			staleMultiplier: this.getStaleMultiplier(),
			alertCooldownMs: this.getAlertCooldownMs(),
			gracePeriodMs: this.getGracePeriodMs(),
			lastCheckedAt: this.lastCheckedAt,
			workers: workerStatusMap,
		};
	}

	_resetForTesting() {
		this.stop();
		this.startedAt = Date.now();
		this.lastCheckedAt = null;
		this.workerStates.clear();
	}
}

const workerHeartbeatMonitorService = new WorkerHeartbeatMonitorService();

module.exports = {
	WorkerHeartbeatMonitorService,
	workerHeartbeatMonitorService,
	formatDuration,
	DEFAULT_STALE_MULTIPLIER,
	DEFAULT_ALERT_COOLDOWN_MS,
	DEFAULT_CHECK_INTERVAL_MS,
	DEFAULT_GRACE_PERIOD_MS,
};
