'use strict';

const { jobRepository } = require('./JobRepository');
const { getRuntimeConfig, addChangeListener } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_ALERT_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_PAGE_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes
const DEFAULT_PROBE_INTERVAL_MS = 60 * 1000; // 1 minute
const DEFAULT_PROBE_OPERATION_TIMEOUT_MS = 10 * 1000; // 10 seconds per external probe

function parsePositiveInteger(value, fallback, min = 1000, max = 86400000) {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		return fallback;
	}
	return parsed;
}

// Bound each external probe so a half-open broker connection or a stalled
// Firestore read cannot pin probe() open forever. probe() only reschedules once
// it settles, so one hung dependency would otherwise silently disable backlog
// reporting and operator pages for the whole process lifetime.
//
// The race abandons the underlying request rather than cancelling it, so a
// timed-out operation may still be outstanding. Callers register the operation
// with trackOutstanding() and skip starting another call while one is
// unresolved, so repeated sweeps cannot leak one orphaned request per interval.
function withTimeout(promise, timeoutMs, label) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
		if (typeof timer.unref === 'function') timer.unref();
	});
	return Promise.race([promise, timeout])
		.finally(() => clearTimeout(timer));
}

// Register a probe operation as outstanding until it genuinely settles, so a
// timed-out call blocks the next sweep instead of stacking on top of it.
function trackOutstanding(promise, outstanding) {
	if (!outstanding) return promise;
	outstanding.add(promise);
	Promise.resolve(promise)
		.catch(() => undefined)
		.finally(() => outstanding.delete(promise));
	return promise;
}

// A durable result is conclusive only when the scan actually observed the state
// it reports. Two cases are indeterminate, not evidence of recovery:
//   - probeFailed: the Firestore read failed and fell back to memory.
//   - truncated with nothing observed: the scan hit its page cap, so queued
//     jobs may exist beyond it. Reporting that as an empty backlog would clear a
//     real alert while an aged backlog sits in the unscanned suffix.
//   - scanRotated with nothing observed: the sweep resumed from a rotation
//     cursor, so it covered only a window of the collection. Queued jobs can sit
//     in the unscanned prefix, and a sweep that reached the end from a cursor
//     reports truncated:false, so the cap check above does not catch it. An empty
//     rotated sweep is a gap in coverage, not an empty queue.
function isDurableResultConclusive(durable) {
	if (!durable) return false;
	if (durable.probeFailed === true) return false;
	if (durable.scanRotated === true && !(durable.durableQueuedCount > 0)) return false;
	if (durable.truncated === true && !(durable.durableQueuedCount > 0)) return false;
	return true;
}

// Whether this sweep can prove the backlog is gone.
//
// A partial sweep — truncated, or resumed from a rotation cursor — observed only
// a window of the collection. It can still be trusted to page (a job it saw is
// real), but it cannot clear an active alert: an older stalled job may sit in
// the region it never read, and a partial sweep that finds only young queued
// jobs is exactly that case. Only a complete sweep establishes recovery.
function isRecoveryProven(durable) {
	if (!durable) return false;
	if (durable.probeFailed === true) return false;
	if (durable.scanRotated === true || durable.truncated === true) return false;
	return true;
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
		this.unrefTimers = true;
		// Interval the currently armed timer was scheduled with, and the
		// unsubscribe for the Remote Config listener that re-arms it when the
		// effective cadence changes.
		this._scheduledIntervalMs = null;
		this._unsubscribeRemoteConfig = null;
		// Operations started by a probe that has not settled, tracked per
		// dependency. A timed-out probe is abandoned rather than cancelled, so
		// this keeps the next sweep from stacking another call on unfinished work.
		// The slots are separate on purpose: a half-open broker connection must not
		// blind the Firestore read, or backlog reporting would stay dark for as long
		// as the broker promise never settles.
		this.outstandingProbes = { broker: new Set(), durable: new Set() };
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
		const probeOperationTimeoutMs = parsePositiveInteger(
			process.env.JOB_BACKLOG_PROBE_TIMEOUT_MS,
			DEFAULT_PROBE_OPERATION_TIMEOUT_MS,
			1000,
			300000,
		);

		return {
			alertThresholdMs,
			pageCooldownMs,
			probeIntervalMs,
			probeOperationTimeoutMs,
		};
	}

	async probe(options = {}) {
		const now = typeof options === 'number' ? options : (options?.now ?? Date.now());
		const { probeOperationTimeoutMs: timeoutMs } = this.getConfig();
		let brokerCounts = { waiting: 0, delayed: 0, failed: 0, active: 0, paused: 0 };
		try {
			if (this.jobQueue && typeof this.jobQueue.getJobCounts === 'function') {
				if (this.outstandingProbes.broker.size === 0) {
					const pending = trackOutstanding(this.jobQueue.getJobCounts(), this.outstandingProbes.broker);
					brokerCounts = await withTimeout(pending, timeoutMs, 'Broker count probe');
				} else {
					this.logger.warn?.('[JobBacklogService] Skipping broker probe: a previous probe is still outstanding');
				}
			}
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Broker count probe failed:', error.message);
		}

		let durable = { durableQueuedCount: 0, oldestQueuedAgeMs: null, oldestCreatedAt: null };
		let durableProbeSucceeded = false;
		let recoveryProven = false;
		try {
			if (this.repository) {
				if (typeof this.repository.isConfigured === 'function') {
					if (this.repository.isConfigured()) {
						if (this.outstandingProbes.durable.size === 0) {
							const pending = trackOutstanding(
								this.repository.getBacklogDepth({ maxScan: 100, now }),
								this.outstandingProbes.durable,
							);
							durable = await withTimeout(pending, timeoutMs, 'Durable backlog probe');
							durableProbeSucceeded = isDurableResultConclusive(durable);
							recoveryProven = isRecoveryProven(durable);
						} else {
							this.logger.warn?.('[JobBacklogService] Skipping durable probe: a previous probe is still outstanding');
						}
					} else if (typeof this.repository.getMemoryBacklogDepth === 'function') {
						durable = this.repository.getMemoryBacklogDepth(now);
						durableProbeSucceeded = true;
						recoveryProven = true;
					}
				} else if (typeof this.repository.getBacklogDepth === 'function') {
					// This is the branch the real JobRepository takes: it has no
					// isConfigured() method, so the guard must live here too.
					if (this.outstandingProbes.durable.size === 0) {
						const pending = trackOutstanding(
							this.repository.getBacklogDepth({ maxScan: 100, now }),
							this.outstandingProbes.durable,
						);
						durable = await withTimeout(pending, timeoutMs, 'Durable backlog probe');
						durableProbeSucceeded = isDurableResultConclusive(durable);
						recoveryProven = isRecoveryProven(durable);
					} else {
						// No result was produced, so this sweep stays indeterminate.
						// Falling through here would mark the untouched default as a
						// success and let a null age read as "backlog drained".
						this.logger.warn?.('[JobBacklogService] Skipping durable probe: a previous probe is still outstanding');
					}
				} else if (typeof this.repository.getMemoryBacklogDepth === 'function') {
					durable = this.repository.getMemoryBacklogDepth(now);
					durableProbeSucceeded = true;
					recoveryProven = true;
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
			// An indeterminate durable probe reports a null count. Coercing it to 0
			// would publish the same zero-depth payload for an unreadable backlog as
			// for a genuinely empty one, so the unknown is preserved as null.
			durableQueuedCount: durable?.durableQueuedCount ?? null,
			oldestQueuedAgeMs: durable?.oldestQueuedAgeMs ?? null,
			oldestCreatedAt: durable?.oldestCreatedAt ?? null,
			// True when the bounded scan hit maxPages, so durableQueuedCount is a
			// lower bound rather than a complete depth. Stored under the same name
			// getStatus() reads back, so the flag is not silently lost in projection.
			durableQueuedTruncated: durable?.truncated === true,
			// True when the durable scan resumed from a rotation cursor, so this
			// sweep covered only part of the collection and the reported depth and
			// age are lower bounds rather than a complete view.
			durableScanRotated: durable?.scanRotated === true,
			probedAt: new Date(now).toISOString(),
		};

		// A failed durable probe leaves oldestQueuedAgeMs null, which is
		// indistinguishable from a drained backlog. Suppress alert evaluation for
		// this sweep so a transient storage error cannot emit a false all-clear
		// and then re-page on the next successful probe.
		probeResult.durableProbeSucceeded = durableProbeSucceeded;
		probeResult.durableRecoveryProven = recoveryProven;

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
		// Paging is a fail-safe action: a sweep that observes an aged job is
		// sufficient evidence even when it only covered part of the collection, so
		// a rotated or truncated sweep may still page. Clearing the latch is the
		// opposite: a partial sweep cannot prove the unscanned region is empty, so
		// it is never evidence of recovery. Without this split, a rotated sweep that
		// saw only young queued jobs sent a false "Backlog Cleared" page while a
		// stalled job remained in the unscanned prefix.
		if (oldestAge !== null && oldestAge >= alertThresholdMs) {
			const shouldPage = !this.hasActiveAlert || (now - (this.lastPagedAt || 0) >= pageCooldownMs);
			if (shouldPage) {
				const delivered = await this._notifyAdminAlert(probeResult, alertThresholdMs);
				if (delivered) {
					this.hasActiveAlert = true;
					this.lastPagedAt = now;
				}
			}
			return;
		}

		if (!this.hasActiveAlert) {
			return;
		}

		// Below the threshold (or nothing observed) is not enough on its own, and a
		// partial sweep cannot prove the unscanned region is empty. A probe that
		// failed, hit its page cap, or resumed from a rotation cursor therefore holds
		// the latch until a complete sweep confirms the backlog is gone.
		if (probeResult.durableProbeSucceeded === false || probeResult.durableRecoveryProven === false) {
			return;
		}

		// Reaching here means the latch is set, the sweep is below the threshold or
		// saw nothing, and the sweep was conclusive. A conclusive sweep is the only
		// thing that proves the unscanned region is clear, so the incident is over.
		// Only clear the latch once the all-clear is actually delivered. If the send
		// fails, keep the alert active so a later probe retries instead of leaving
		// the operator with a stale incident and no notification.
		const recovered = await this._notifyAdminRecovery(probeResult);
		if (recovered) {
			this.hasActiveAlert = false;
			this.lastRecoveryAt = now;
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
				const result = await this.notifyAdmin({
					type: 'backlog_alert',
					message,
					probeResult,
					alertThresholdMs,
				});
				return result?.success !== false;
			} catch (err) {
				this.logger?.warn?.(`[JobBacklogService] notifyAdmin callback failed: ${err.message}`);
				return false;
			}
		}

		if (!adminChatId) {
			return false;
		}

		const telegramService = this._getTelegramService();
		// Backlog pages are admin notifications, not user broadcasts. A deployment
		// that sets only TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID (no default
		// TELEGRAM_CHAT_ID) legitimately has the broadcast channel disabled, so gate
		// on admin-delivery eligibility rather than broadcast enablement.
		if (!telegramService || !this._isAdminDeliveryEligible(telegramService)) {
			return false;
		}

		try {
			const result = await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			if (result?.success === false) return false;
			this.logger.info?.('[JobBacklogService] Sent admin alert for async job backlog breach');
			return true;
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Failed to send Telegram backlog alert (fail-open)', { error: error.message });
			return false;
		}
	}

	_isAdminDeliveryEligible(telegramService) {
		if (typeof telegramService.isAdminDeliveryEligible === 'function') {
			return telegramService.isAdminDeliveryEligible() !== false;
		}
		return telegramService.isEnabled?.() !== false;
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
				const result = await this.notifyAdmin({
					type: 'backlog_recovery',
					message,
					probeResult,
				});
				// A callback can resolve with { success: false } just like the direct
				// Telegram path. Honour it, or the latch clears on an all-clear that
				// was never delivered and the operator keeps a stale incident.
				if (result?.success === false) {
					this.logger.warn?.('[JobBacklogService] Admin recovery callback reported an unsuccessful delivery (fail-open)');
					return false;
				}
			} catch (err) {
				this.logger?.warn?.(`[JobBacklogService] notifyAdmin callback failed: ${err.message}`);
				return false;
			}
			return true;
		}

		if (!adminChatId) {
			return false;
		}

		const telegramService = this._getTelegramService();
		if (!telegramService || !this._isAdminDeliveryEligible(telegramService)) {
			return false;
		}

		try {
			const result = await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			if (result?.success === false) {
				this.logger.warn?.('[JobBacklogService] Admin recovery notification was not delivered (fail-open)');
				return false;
			}
			this.logger.info?.('[JobBacklogService] Sent admin recovery notification for async job backlog');
			return true;
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Failed to send Telegram backlog recovery notification (fail-open)', { error: error.message });
			return false;
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
		// True when the bounded durable scan hit maxPages, so durableQueuedCount is
		// a lower bound rather than a complete depth.
		const durableQueuedTruncated = this.lastProbe?.durableQueuedTruncated
			?? durable?.truncated
			?? false;
		const lastProbedAt = this.lastProbe?.probedAt ?? null;
		// Null before the first probe, otherwise whether the last sweep actually
		// observed durable state. False means the durable depth is unknown, not
		// zero, so a reader can tell an unreadable backlog from an empty one.
		const durableProbeSucceeded = this.lastProbe
			? this.lastProbe.durableProbeSucceeded !== false
			: null;

		return {
			// Without this, a monitor disabled via ENABLE_JOB_BACKLOG_MONITOR is
			// indistinguishable from a running monitor observing an empty queue.
			enabled: this.isEnabled(),
			running: this.running,
			waitingCount,
			delayedCount,
			failedCount,
			activeCount,
			// Read from the same resolved source as the other durable fields, so a
			// getStatus() before the first probe still reports the memory depth
			// rather than a 0 that contradicts oldestQueuedAgeMs.
			durableQueuedCount: this.lastProbe ? durableQueuedCount : (durableQueuedCount || 0),
			durableQueuedTruncated: durableQueuedTruncated === true,
			durableScanRotated: this.lastProbe?.durableScanRotated === true,
			durableProbeSucceeded,
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
		this.unrefTimers = unref;
		this._subscribeRemoteConfigChanges();
		this._scheduleProbe();
	}

	// A pending timer keeps the interval it was scheduled with until it fires, so
	// lowering JOB_BACKLOG_PROBE_INTERVAL_MS in Remote Config would otherwise take
	// effect only after the old, longer wait elapsed. Re-arm the pending timer when
	// the effective interval actually changes so an operator lowering the cadence
	// sees it take effect on the next sweep.
	_subscribeRemoteConfigChanges() {
		if (this._unsubscribeRemoteConfig) {
			return;
		}
		this._unsubscribeRemoteConfig = addChangeListener(() => {
			if (!this.running) return;
			const { probeIntervalMs } = this.getConfig();
			if (probeIntervalMs === this._scheduledIntervalMs) return;
			if (this.timer) {
				clearTimeout(this.timer);
				this.timer = null;
				this._scheduleProbe();
			} else if (this.inFlightProbe) {
				// A probe is running, so there is no timer to re-arm. It schedules
				// the next sweep from the current config once it settles, so simply
				// record the new interval; arming a timer now would race that
				// reschedule and could fire two sweeps back to back.
				this._scheduledIntervalMs = probeIntervalMs;
			}
		});
	}

	_scheduleProbe() {
		if (!this.running) return;
		const { probeIntervalMs } = this.getConfig();
		this._scheduledIntervalMs = probeIntervalMs;
		this.timer = setTimeout(() => {
			this.timer = null;
			// Track the in-flight probe so stop() can await it during shutdown
			// instead of abandoning a half-finished Firestore read or page.
			this.inFlightProbe = this.probe()
				.catch((error) => this.logger.warn?.('[JobBacklogService] Probe failed (fail-open):', error.message))
				.finally(() => {
					this.inFlightProbe = null;
					this._scheduleProbe();
				});
		}, probeIntervalMs);
		// Unref here, not only on the first timer: every self-rescheduled timer must
		// inherit the flag or a rescheduled probe holds the process open.
		if (this.unrefTimers && this.timer && typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	async stop({ drain = false, timeoutMs = 5000 } = {}) {
		this.running = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this._unsubscribeRemoteConfig) {
			this._unsubscribeRemoteConfig();
			this._unsubscribeRemoteConfig = null;
		}
		// Only drain on the explicit shutdown path. Callers that just want to stop
		// the timer (tests, restarts) must not have to await an external probe.
		if (drain && this.inFlightProbe) {
			await Promise.race([
				this.inFlightProbe,
				new Promise((resolve) => {
					const timer = setTimeout(resolve, timeoutMs);
					if (typeof timer.unref === 'function') timer.unref();
				}),
			]);
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
