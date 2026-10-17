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
//
// A sweep that closed a rotation cycle is the exception: it resumed from the
// cursor left by the front sweep and then reached the end, so the two windows
// tile the whole collection. It is a real observation, so the empty case above
// does not apply.
function isDurableResultConclusive(durable) {
	if (!durable) return false;
	if (durable.probeFailed === true) return false;
	// Queued work was observed but none of it could be dated, so the sweep cannot
	// say whether it is above the threshold. Treating the null age as "below
	// threshold" would let _evaluateAlert read it as drained and clear the latch
	// while real queued work is still waiting.
	if (durable.durableQueuedCount > 0 && !Number.isFinite(durable.oldestQueuedAgeMs)) return false;
	if (durable.cycleComplete === true) return true;
	if (durable.scanRotated === true && !(durable.durableQueuedCount > 0)) return false;
	if (durable.truncated === true && !(durable.durableQueuedCount > 0)) return false;
	return true;
}

// Whether a sweep can vouch for the region it read.
//
// A sweep that did not resume from a cursor and did not hit the page cap covered
// the entire collection on its own, so it alone can prove the backlog is gone.
//
// A sweep that did hit the page cap (truncated) is different: it read the head of
// the collection completely, and left a cursor marking where it stopped. A later
// sweep that resumes from that cursor and reaches the end reads the remainder, so
// the two together tile the whole collection. A truncated sweep is therefore
// sound evidence of its own prefix — but only for a later sweep that resumes
// from the cursor it left, never on its own.
//
// A sweep that resumed from a cursor reads a middle or tail window. It can still
// be trusted to page (a job it saw is real), but it cannot clear an active alert
// on its own: an older stalled job may sit in the region it never read, and a
// partial sweep that finds only young queued jobs is exactly that case.
function isSweepComplete(durable) {
	if (!durable) return false;
	if (durable.probeFailed === true) return false;
	// Same undated-queued-work guard: covering the whole collection is not proof of
	// a drained backlog when the observed queued jobs cannot be aged.
	if (durable.durableQueuedCount > 0 && !Number.isFinite(durable.oldestQueuedAgeMs)) return false;
	if (durable.scanRotated === true || durable.truncated === true) return false;
	return true;
}

// Parse a Firestore/Timestamp/ISO creation time into epoch milliseconds, so a
// buffered cycle window can have its age re-evaluated later against a fresh clock.
// Anything unparseable yields null rather than a number that would silently
// compare as fresh.
function parseTimestampMs(value) {
	if (value === null || value === undefined) return null;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	// Firestore Timestamp and Date both expose toMillis()/getTime(); an ISO string
	// is covered by Date.parse below.
	if (typeof value.toMillis === 'function') {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : null;
	}
	if (value instanceof Date) {
		const millis = value.getTime();
		return Number.isFinite(millis) ? millis : null;
	}
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

// Whether the rotation cycle that has just closed proves the backlog is drained.
//
// A collection larger than one page cap is tiled by consecutive windows, and the
// cycle closes on whichever sweep first reaches the end from a cursor. Recovery
// therefore has to account for every window since the cycle opened, not only the
// one immediately before the closing sweep: with three windows (aged front, quiet
// middle, closing tail), considering only the last forgets the aged front and
// reads as recovered while a stall is still queued in the unscanned head.
//
// The cycle's evidence is therefore the OLDEST queued job observed anywhere in it,
// plus the fact that the cycle opened at all. That single value is equivalent to
// checking every window, because "below threshold" is monotone in creation time:
// the windows that observed no queued work at all proved their own prefixes empty
// and contribute nothing, and among the rest only the oldest can be over the
// threshold. Accumulating a minimum is order-independent, needs no per-window
// storage, and cannot grow.
//
// cycleOldestQueuedCreatedAtMs is null until a capped sweep opens a cycle,
// +Infinity for an open cycle that has seen no queued work, -Infinity for one that
// saw queued work it could not date (unprovable, and it stays that way), and
// otherwise a creation time in epoch milliseconds.
//
// The age is recomputed from that creation time against the CLOSING sweep's clock
// and the current threshold, never frozen at read time: a window just under the
// threshold keeps ageing, and a frozen verdict is how a 14m30s job gets declared
// recovered at 15m30s and pages again one sweep later.
function isCycleProven(durable, cycleOldestQueuedCreatedAtMs, thresholdMs, now) {
	if (!durable) return false;
	if (durable.probeFailed === true) return false;
	if (durable.cycleComplete !== true) return false;
	// A cycle only exists once a capped front sweep opened it. Without evidence
	// from one, nothing tiled the collection with the closing sweep, so
	// complementary coverage never happened.
	if (cycleOldestQueuedCreatedAtMs === null) return false;
	// A cycle that saw no queued work anywhere proves the collection drained.
	if (cycleOldestQueuedCreatedAtMs === Infinity) return true;
	if (!Number.isFinite(thresholdMs) || !Number.isFinite(now)) return false;
	// -Infinity (queued work of unknown age) yields Infinity here and never clears,
	// so an undatable window holds the latch instead of being assumed quiet.
	return Math.max(0, now - cycleOldestQueuedCreatedAtMs) < thresholdMs;
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
		// The oldest queued job observed anywhere in the current rotation cycle, in
		// epoch milliseconds. null until a capped sweep opens a cycle, and
		// -Infinity when a window observed queued work it could not date. Reset
		// whenever the rotation cursor resets, so evidence from a finished cycle
		// never pairs with an unrelated one.
		this._cycleOldestQueuedCreatedAtMs = null;
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
		// Whether a durable read actually COMPLETED, which is what rotation evidence
		// needs. Distinct from durableProbeSucceeded, which additionally asks whether
		// the result can report a TOTAL depth: a capped sweep reads its window fully
		// but cannot describe the collection, so it is not conclusive as a total and
		// still is conclusive about the region it read.
		let durableObserved = false;
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
							durableObserved = true;
							durableProbeSucceeded = isDurableResultConclusive(durable);
							recoveryProven = isSweepComplete(durable);
						} else {
							this.logger.warn?.('[JobBacklogService] Skipping durable probe: a previous probe is still outstanding');
						}
					} else if (typeof this.repository.getMemoryBacklogDepth === 'function') {
						durable = this.repository.getMemoryBacklogDepth(now);
						durableObserved = true;
						// A memory read is total: nothing is truncated and no cursor is
						// carried, so it is conclusive about the whole collection. It
						// must set the conclusive flag too, or a drained local-mode
						// backlog would report an unknown depth next to a real count and
						// the latch could never clear — re-paging the operator every
						// cooldown for a queue that already drained.
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
						durableObserved = true;
						durableProbeSucceeded = isDurableResultConclusive(durable);
						recoveryProven = isSweepComplete(durable);
					} else {
						// No result was produced, so this sweep stays indeterminate.
						// Falling through here would mark the untouched default as a
						// success and let a null age read as "backlog drained".
						this.logger.warn?.('[JobBacklogService] Skipping durable probe: a previous probe is still outstanding');
					}
				} else if (typeof this.repository.getMemoryBacklogDepth === 'function') {
					durable = this.repository.getMemoryBacklogDepth(now);
					durableObserved = true;
					// Total by construction — see the mirror branch above.
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
		probeResult.durableCycleComplete = durable?.cycleComplete === true;
		const { alertThresholdMs } = this.getConfig();

		// Update the cycle evidence. A capped sweep that did not close the cycle is a
		// mid-cycle window and extends it; a sweep that closed the cycle consumed it,
		// and an uncapped sweep reset the rotation cursor, so both clear it. A sweep
		// that observed no queued work still opened (and extended) the cycle, because
		// it proved its own prefix empty.
		//
		// This keys on whether the durable read COMPLETED (durableObserved), not on
		// durableProbeSucceeded. A capped sweep cannot report a TOTAL depth, so
		// durableProbeSucceeded is false for it, yet it read its window completely and
		// is conclusive about the region it read. Keying on the stricter flag would
		// discard that evidence and leave a drained collection larger than the page
		// cap permanently unprovable. A storage error leaves durableObserved false, so
		// the evidence survives rather than being discarded at the moment a blip makes
		// it most valuable — hence also excluding probeFailed from the reset branch.
		let cycleProven = false;
		if (durableObserved && durable?.truncated === true && durable?.cycleComplete !== true) {
			const observedQueued = (durable?.durableQueuedCount ?? 0) > 0;
			// -Infinity marks queued work whose age cannot be determined, which must
			// hold the latch rather than be treated as quiet. +Infinity marks an open
			// cycle that has seen no queued work at all, so it blocks nothing.
			const createdAtMs = parseTimestampMs(durable?.oldestCreatedAt) ?? -Infinity;
			const opened = this._cycleOldestQueuedCreatedAtMs;
			if (opened === null) {
				// The first capped sweep opens the cycle. A sweep that saw no queued
				// work still opened it — it proved its own prefix empty — so the
				// cycle exists and is recorded as +Infinity rather than left unset.
				this._cycleOldestQueuedCreatedAtMs = observedQueued ? createdAtMs : Infinity;
			} else if (observedQueued) {
				this._cycleOldestQueuedCreatedAtMs = Math.min(opened, createdAtMs);
			}
		} else if (durableObserved && durable?.cycleComplete === true) {
			// A sweep that closed the cycle is not partial after all — it resumed from
			// a cursor left earlier in the cycle and reached the end, so together with
			// the windows read since it tiles the whole collection. All of them must be
			// below the threshold when the cycle closes.
			//
			// Reaching the end is not on its own a consistent view, so the front is
			// revalidated first — see _revalidateCycleFront() for why, and the
			// decision is taken here only after it has had its say.
			const frontUnproven = await this._revalidateCycleFront();
			cycleProven = !frontUnproven && isCycleProven(
				durable,
				this._cycleOldestQueuedCreatedAtMs,
				alertThresholdMs,
				now,
			);
			this._cycleOldestQueuedCreatedAtMs = null;
		} else if (durableObserved && durable?.probeFailed !== true) {
			// An uncapped sweep read the entire collection, so the rotation cursor
			// reset and the next cycle starts from the front again. A failed sweep
			// also reports truncated:false, but it observed nothing, so it is not
			// evidence that the cursor was reset.
			this._cycleOldestQueuedCreatedAtMs = null;
		}
		probeResult.durableRecoveryProven = recoveryProven || cycleProven;
		// This result is accepted, so the repository may advance its rotation
		// cursor. A sweep abandoned at the probe deadline never reaches here, which
		// is what stops its late resolution from skipping a window this service
		// never folded into the cycle evidence.
		if (typeof this.repository?.commitBacklogScan === 'function') {
			this.repository.commitBacklogScan();
		}

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

	// Re-read the front of the collection when a rotation cycle closes.
	//
	// A cycle that spans more than one probe interval is not a consistent snapshot.
	// The scan treats a `claimed`/`running` job whose lease has expired as queued, so
	// a job in the already-scanned prefix can become queued while the later windows
	// are still being read — and by the time the tail reaches the end, that prefix is
	// believed drained. The cursor is cleared on completion, so nothing re-reads it.
	//
	// Returns true when the prefix could NOT be confirmed drained, which the caller
	// treats as "not proven" rather than "empty". This is fail-safe by construction:
	// any failure, timeout, skip, or absent capability holds the latch instead of
	// clearing it, because the only cost of an unnecessary hold is a later recovery
	// whereas the cost of clearing is a false all-clear.
	async _revalidateCycleFront() {
		if (typeof this.repository?.getFrontBacklogDepth !== 'function') {
			// Nothing to re-read against. A repository that never supported rotation
			// also never opens a cycle, so this is not reachable in practice; treat it
			// as unproven rather than silently trusting the earlier windows.
			return true;
		}
		// The outstanding-probe guard keeps a revalidation from stacking on top of
		// the sweep that just finished, which may still be settling at the probe
		// deadline.
		if (this.outstandingProbes.durable.size > 0) {
			return true;
		}
		let front;
		try {
			const pending = trackOutstanding(
				// The same probe clock, so a lease that expires is evaluated against
				// the instant the decision is being taken rather than a second,
				// slightly different reading of "now".
				this.repository.getFrontBacklogDepth({ now: Date.now() }),
				this.outstandingProbes.durable,
			);
			front = await withTimeout(pending, this.getConfig().probeOperationTimeoutMs, 'Cycle front revalidation');
		} catch (error) {
			this.logger.warn?.('[JobBacklogService] Cycle front revalidation failed (holding the latch):', error.message);
			return true;
		}
		if (!front || front.probeFailed === true) {
			return true;
		}
		// A truncated re-read stopped at a row that is still a live claim, so a row
		// just past it can expire into newly-queued work — the hazard this re-read
		// exists to catch. It proves nothing and holds the latch. Note this is about
		// the boundary row's state, not the page filling: an ordinary running or
		// finished tail row is conclusive, so a large collection is not vetoed
		// forever just for being large.
		if (front.truncated === true) {
			return true;
		}
		if ((front.durableQueuedCount ?? 0) > 0) {
			// Something is queued in the prefix the cycle believed drained. It has to
			// keep being aged, so it becomes the cycle's evidence rather than being
			// compared once and discarded.
			this._cycleOldestQueuedCreatedAtMs = parseTimestampMs(front.oldestCreatedAt) ?? -Infinity;
		}
		return false;
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
		// the latch until a complete sweep confirms the backlog is gone. A sweep
		// that completed a rotation cycle counts as complete coverage, but only
		// together with the cycle's accumulated evidence being quiet, since the
		// closing sweep and the windows it tiled with cover the whole collection.
		// Both are folded into durableRecoveryProven above.
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
		// A failed durable probe records durableQueuedCount:null, and ?? is needed
		// rather than || so that explicit unknown survives. It is the mirror only
		// when no probe has run yet, so a null from a failed probe is not replaced
		// with 0 and the payload does not claim an unreadable backlog is empty.
		const durableQueuedCount = this.lastProbe
			? this.lastProbe.durableQueuedCount
			: (durable?.durableQueuedCount || 0);
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
			// Documented in the status contract alongside durableScanRotated, so it
			// has to survive projection here or /api/status never returns it.
			durableCycleComplete: this.lastProbe?.durableCycleComplete === true,
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
		// Cycle evidence is per-rotation state, so it has to be dropped with the
		// rest of the monitor state. Left behind, a reset service would carry an
		// observation from a cycle the repository cursor no longer points at, and
		// the next closing sweep could credit it with unrelated coverage.
		this._cycleOldestQueuedCreatedAtMs = null;
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
