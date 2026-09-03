'use strict';

const crypto = require('crypto');
const alertStorageService = require('../storage/AlertStorageService');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const {
	chatSubscriptionService,
	COLLECTION_NAME,
} = require('./ChatSubscriptionService');
const { jobService } = require('../jobs/JobService');
const sentryService = require('../monitoring/SentryService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_SCHEDULER_INTERVAL_MS = 60000;
const MIN_SCHEDULER_INTERVAL_MS = 1000;
const MAX_SCHEDULER_INTERVAL_MS = 3600000;
const DEFAULT_BATCH_LIMIT = 25;
const MIN_BATCH_LIMIT = 1;
const MAX_BATCH_LIMIT = 100;
const DEFAULT_LEASE_MS = 120000;
const HEARTBEAT_DOC = 'workerHeartbeats/chat-subscription';
const HEARTBEAT_KEYS = [
	'lastRunAt', 'lastRunDurationMs', 'lastRunScannedCount',
	'lastRunExecutedCount', 'lastRunErrorCount', 'ready', 'status', 'role',
];

function parseEnvInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		return fallback;
	}
	return Math.max(min, Math.min(parsed, max));
}

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}
	return botOrGetter || null;
}

class ChatSubscriptionSchedulerService {
	constructor(options = {}) {
		this.subscriptionService = options.subscriptionService || chatSubscriptionService;
		this.jobService = options.jobService || jobService;
		this.workerId = options.workerId || `${process.pid}-${crypto.randomUUID()}`;
		this.botGetter = options.botGetter || null;
		this.running = false;
		this.timer = null;
		this.activeSweepPromise = null;
		this.shutdownRequested = false;

		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunExecutedCount = 0;
		this.lastRunErrorCount = 0;
	}

	isEnabled() {
		return process.env.ENABLE_CHAT_SUBSCRIPTION_SCHEDULER === 'true';
	}

	getWorkerRole() {
		const rawRole = (process.env.CHAT_SUBSCRIPTION_SCHEDULER_ROLE || 'web').toLowerCase().trim();
		if (rawRole === 'worker' || rawRole === 'disabled') {
			return rawRole;
		}
		return 'web';
	}

	getIntervalMs() {
		const runtime = getRuntimeConfig();
		const raw = runtime.CHAT_SUBSCRIPTION_SCHEDULER_INTERVAL_MS !== undefined
			? runtime.CHAT_SUBSCRIPTION_SCHEDULER_INTERVAL_MS
			: process.env.CHAT_SUBSCRIPTION_SCHEDULER_INTERVAL_MS;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS, MAX_SCHEDULER_INTERVAL_MS);
	}

	getBatchLimit() {
		const runtime = getRuntimeConfig();
		const raw = runtime.CHAT_SUBSCRIPTION_SCHEDULER_BATCH_LIMIT !== undefined
			? runtime.CHAT_SUBSCRIPTION_SCHEDULER_BATCH_LIMIT
			: process.env.CHAT_SUBSCRIPTION_SCHEDULER_BATCH_LIMIT;
		return parseEnvInt(raw, DEFAULT_BATCH_LIMIT, MIN_BATCH_LIMIT, MAX_BATCH_LIMIT);
	}

	getLeaseMs() {
		return parseEnvInt(process.env.CHAT_SUBSCRIPTION_SCHEDULER_LEASE_MS, DEFAULT_LEASE_MS, 10000, 600000);
	}

	getStatus() {
		const role = this.getWorkerRole();
		if (role === 'disabled' || !this.isEnabled()) {
			return {
				enabled: this.isEnabled(),
				ready: false,
				status: this.isEnabled() ? 'disabled' : 'misconfigured',
				role,
			};
		}
		if (!this.running) {
			return {
				enabled: true,
				ready: false,
				status: 'idle',
				role,
			};
		}
		return {
			enabled: true,
			ready: true,
			status: this.activeSweepPromise ? 'sweeping' : 'running',
			role,
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunExecutedCount: this.lastRunExecutedCount,
			lastRunErrorCount: this.lastRunErrorCount,
			nextSweepAt: this.nextSweepAt ? this.nextSweepAt.toISOString() : null,
		};
	}

	async startWorker() {
		if (this.running) {
			return false;
		}
		if (!this.isEnabled() || this.getWorkerRole() === 'disabled') {
			return false;
		}
		this.running = true;
		this.shutdownRequested = false;
		this._scheduleNextSweep();
		await this._persistHeartbeat();
		return true;
	}

	async stopWorker() {
		if (!this.running) {
			return;
		}
		this.shutdownRequested = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.activeSweepPromise) {
			try {
				await this.activeSweepPromise;
			} catch (_) {
				// ignore — the active sweep already logged its own error
			}
		}
		this.running = false;
		await this._persistHeartbeat();
	}

	_scheduleNextSweep() {
		if (this.shutdownRequested || !this.running) {
			return;
		}
		const interval = this.getIntervalMs();
		this.nextSweepAt = new Date(Date.now() + interval);
		this.timer = setTimeout(() => {
			this._runSweep().catch((error) => {
				console.error('[ChatSubscriptionScheduler] sweep failed:', error.message);
			});
		}, interval);
		// Allow the process to exit even if a sweep is pending.
		if (typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	async _runSweep() {
		if (this.shutdownRequested) {
			return;
		}
		const startedAt = Date.now();
		let scanned = 0;
		let executed = 0;
		let errors = 0;

		const promise = (async () => {
			const candidates = await this._collectDueCandidates();
			scanned = candidates.length;
			for (const sub of candidates) {
				if (this.shutdownRequested) {
					break;
				}
				try {
					await this._executeSubscription(sub);
					executed += 1;
				} catch (error) {
					errors += 1;
					console.warn('[ChatSubscriptionScheduler] subscription execution failed:', error.message);
				}
			}
		})();

		this.activeSweepPromise = promise;
		try {
			await promise;
		} finally {
			this.activeSweepPromise = null;
			this.lastRunAt = new Date();
			this.lastRunDurationMs = Date.now() - startedAt;
			this.lastRunScannedCount = scanned;
			this.lastRunExecutedCount = executed;
			this.lastRunErrorCount = errors;
			try {
				await this._persistHeartbeat();
			} catch (error) {
				console.warn('[ChatSubscriptionScheduler] heartbeat persist failed:', error.message);
			}
			this._scheduleNextSweep();
		}
	}

	async _collectDueCandidates() {
		const all = await this.subscriptionService.listSubscriptions({ limit: 1000 });
		const now = Date.now();
		const limit = this.getBatchLimit();
		return all
			.filter((sub) => {
				if (!sub || !sub.nextRunAt) return false;
				const next = new Date(sub.nextRunAt).getTime();
				return next <= now;
			})
			.slice(0, limit);
	}

	async _executeSubscription(sub) {
		const bot = resolveBot(this.botGetter);
		const params = sub.params || {};
		const basePayload = {
			...(params.exchange ? { exchange: params.exchange } : {}),
			...(params.timeframe ? { timeframe: params.timeframe } : {}),
		};
		let jobType;
		if (sub.type === 'scanner') {
			jobType = 'market-scanner';
			Object.assign(basePayload, {
				scans: params.scans || ['top_gainers', 'top_losers', 'volume_breakout_scanner'],
			});
		} else if (sub.type === 'analysis') {
			jobType = 'expanded-analysis';
			Object.assign(basePayload, {
				symbols: params.symbols || [],
			});
		} else {
			throw new Error(`unsupported subscription type: ${sub.type}`);
		}

		const result = await this.jobService.createJob(jobType, {
			...basePayload,
			telegramChatId: sub.chatId,
			requestedBy: 'chat-subscription',
			subscriptionId: sub.subscriptionId,
		}, bot);

		const summary = `Job ${result.jobId} (${jobType}) for chat ${sub.chatId} via subscription ${sub.subscriptionId}`;
		await this.subscriptionService.markRunResult({
			chatId: sub.chatId,
			subscriptionId: sub.subscriptionId,
			jobId: result.jobId,
			summary,
		});
	}

	async _persistHeartbeat() {
		if (!isFirestoreConfigured()) {
			return;
		}
		const role = this.getWorkerRole();
		const status = this.getStatus();
		const payload = {
			lastRunAt: this.lastRunAt || null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunExecutedCount: this.lastRunExecutedCount,
			lastRunErrorCount: this.lastRunErrorCount,
			ready: status.ready,
			status: status.status,
			role,
			workerId: this.workerId,
			updatedAt: new Date(),
		};
		try {
			const doc = alertStorageService.getFirestore().doc(HEARTBEAT_DOC);
			const sanitized = JSON.parse(JSON.stringify(payload, (k, v) => (v === undefined ? null : v)));
			await doc.set(sanitized, { merge: true });
		} catch (error) {
			console.warn('[ChatSubscriptionScheduler] heartbeat persist failed:', error.message);
		}
	}
}

const chatSubscriptionSchedulerService = new ChatSubscriptionSchedulerService();

module.exports = {
	ChatSubscriptionSchedulerService,
	chatSubscriptionSchedulerService,
	HEARTBEAT_DOC,
	HEARTBEAT_KEYS,
};
