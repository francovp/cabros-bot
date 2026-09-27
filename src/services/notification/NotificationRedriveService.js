'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const AlertStorageService = require('../storage/AlertStorageService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { signalRepeatCooldown, nextMonotonicGeneration } = require('../alerts/signalRepeatCooldown');

const COLLECTION_NAME = 'notificationDeadLetters';
const DEFAULT_REDRIVE_INTERVAL_MS = 60000;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_AGE_MS = 3600000; // 1 hour
const BASE_BACKOFF_MS = 30000; // 30s
const MAX_BACKOFF_MS = 600000; // 10 minutes
const DEFAULT_LEASE_MS = 60000; // 60s
const MAX_DRAIN_TIMEOUT_MS = 10000;
const RECONCILIATION_TIMEOUT_MS = 500;
const DURABLE_ENQUEUE_TIMEOUT_MS = 500;
const HEARTBEAT_COLLECTION_NAME = 'workerHeartbeats';
const HEARTBEAT_DOCUMENT_ID = 'notification-redrive';
const HEARTBEAT_WRITE_TIMEOUT_MS = 5000;
const ZERO_CHANNEL_RETRY_DELAY_MS = HEARTBEAT_WRITE_TIMEOUT_MS;
const MAX_ZERO_CHANNEL_RETRY_ATTEMPTS = 3;
const ZERO_CHANNEL_NON_COMMIT_ERROR_CODES = new Set([
	'aborted',
	'already-exists',
	'failed-precondition',
	'invalid-argument',
	'not-found',
	'permission-denied',
	'resource-exhausted',
	'unauthenticated',
	'3',
	'5',
	'6',
	'7',
	'8',
	'9',
	'10',
	'16',
]);
const PENDING_COUNT_FALLBACK_LIMIT = 1000;
const WORKER_ROLES = new Set(['web', 'worker', 'disabled']);
const ROUTING_FIELDS = Object.freeze({
	telegram: 'telegramChatId',
	whatsapp: 'whatsappChatId',
	discord: 'discordWebhookUrl',
});

function stripUndefinedFieldsDeep(value) {
	if (value === undefined) {
		return undefined;
	}
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => stripUndefinedFieldsDeep(item))
			.filter((item) => item !== undefined);
	}
	if (value instanceof Date || (value && typeof value.toDate === 'function')) {
		return value;
	}

	const cleaned = {};
	for (const [k, v] of Object.entries(value)) {
		const val = stripUndefinedFieldsDeep(v);
		if (val !== undefined) {
			cleaned[k] = val;
		}
	}
	return cleaned;
}

function parsePositiveInteger(val, defaultVal) {
	if (val === undefined || val === null || val === '') {
		return defaultVal;
	}
	const parsed = typeof val === 'number' ? val : Number(String(val).trim());
	if (Number.isSafeInteger(parsed) && parsed > 0) {
		return parsed;
	}
	return defaultVal;
}

function calculateBackoffMs(attemptCount) {
	const count = Math.max(0, attemptCount);
	const exp = Math.min(count, 10);
	const base = BASE_BACKOFF_MS * Math.pow(2, exp);
	const bounded = Math.min(base, MAX_BACKOFF_MS);
	// Add jitter up to 5s
	const jitter = Math.floor(Math.random() * 5000);
	return bounded + jitter;
}

function toTimestamp(date) {
	if (!date) return null;
	if (typeof date.toDate === 'function') return date;
	return admin.firestore?.Timestamp?.fromDate ? admin.firestore.Timestamp.fromDate(date) : date;
}

function toMillis(timestampOrDate) {
	if (!timestampOrDate) return 0;
	if (typeof timestampOrDate.toMillis === 'function') {
		return timestampOrDate.toMillis();
	}
	if (typeof timestampOrDate.toDate === 'function') {
		return timestampOrDate.toDate().getTime();
	}
	if (timestampOrDate instanceof Date) {
		return timestampOrDate.getTime();
	}
	if (typeof timestampOrDate === 'number') {
		return timestampOrDate;
	}
	if (typeof timestampOrDate === 'object' && timestampOrDate.supersededAt) {
		return toMillis(timestampOrDate.supersededAt);
	}
	return new Date(timestampOrDate).getTime() || 0;
}

function normalizeTimestampToDate(val) {
	if (!val) return null;
	if (val instanceof Date) {
		return Number.isFinite(val.getTime()) ? val : null;
	}
	if (typeof val.toDate === 'function') {
		try {
			const d = val.toDate();
			return (d instanceof Date && Number.isFinite(d.getTime())) ? d : null;
		} catch (_) {
			return null;
		}
	}
	if (typeof val.toMillis === 'function') {
		try {
			const ms = val.toMillis();
			return Number.isFinite(ms) ? new Date(ms) : null;
		} catch (_) {
			return null;
		}
	}
	if (typeof val === 'number' && Number.isFinite(val)) {
		return new Date(val);
	}
	if (typeof val === 'string') {
		const parsed = new Date(val);
		return Number.isFinite(parsed.getTime()) ? parsed : null;
	}
	if (typeof val._seconds === 'number') {
		const ms = val._seconds * 1000 + Math.round((val._nanoseconds || 0) / 1e6);
		return Number.isFinite(ms) ? new Date(ms) : null;
	}
	return null;
}

function isZeroChannelNonCommitError(error) {
	return ZERO_CHANNEL_NON_COMMIT_ERROR_CODES.has(String(error?.code || '').trim().toLowerCase());
}

function compareGenerations(supersessionGen, recordGen) {
	if (Number.isFinite(supersessionGen) && Number.isFinite(recordGen)) {
		return supersessionGen - recordGen;
	}
	return null;
}

function isSupersededByMarker(supersession, record) {
	if (!supersession || supersession.status !== 'superseded') {
		return false;
	}
	const supersessionGen = supersession.generation;
	const recordGen = record?.repeatCooldown?.generation;
	const genComparison = compareGenerations(supersessionGen, recordGen);
	if (genComparison !== null) {
		return genComparison > 0;
	}
	const recordCreatedAt = toMillis(record?.repeatCooldown?.reservedAt) || toMillis(record?.createdAt);
	const supersessionAt = toMillis(supersession.supersededAt);
	return !recordCreatedAt || supersessionAt >= recordCreatedAt;
}

function releaseRepeatCooldown(record) {
	const repeatCooldown = record && record.repeatCooldown;
	if (!repeatCooldown || !repeatCooldown.key || !repeatCooldown.channel) {
		return;
	}
	if (Number.isFinite(repeatCooldown.generation)) {
		signalRepeatCooldown.release(
			repeatCooldown.key,
			[repeatCooldown.channel],
			repeatCooldown.generation,
		);
	} else {
		signalRepeatCooldown.release(repeatCooldown.key, [repeatCooldown.channel]);
	}
}

async function resolveBeforeDeadline(promise, deadline) {
	const remainingMs = Math.max(0, deadline - Date.now());
	if (remainingMs === 0) {
		return null;
	}
	let timer = null;
	try {
		return await Promise.race([
			promise,
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(null), remainingMs);
			}),
		]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

function getRedriveRouting(channel, routing, repeatCooldown) {
	const destination = repeatCooldown?.destinationsByName?.[channel];
	const field = ROUTING_FIELDS[channel];
	if (!field || destination === undefined || destination === 'default') {
		return routing || null;
	}
	return { ...(routing || {}), [field]: destination };
}

function isPendingRedriveStatus(status) {
	return status === 'pending' || status === 'in_flight';
}

class NotificationRedriveService {
	constructor(options = {}) {
		this.inMemoryStore = new Map();
		this.supersessionStore = new Map();
		this.reconciliationPromises = new Map();
		this.workerTimer = null;
		this.activeSweepPromise = null;
		this.running = false;
		this.notificationManagerGetter = options.notificationManagerGetter || null;
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunRedrivenCount = 0;
		this.lastRunErrorCount = 0;
		this.lastRunExhaustedCount = 0;
		this.lastSweepAt = null;
		this.lastSweepResult = null;
		this.telemetrySyncTimer = null;
		this.persistedLastRunAt = null;
		this.persistedLastSweepAt = null;
		this.persistedLastSweepResult = null;
		this.persistedLastRunDurationMs = null;
		this.persistedLastRunScannedCount = 0;
		this.persistedLastRunRedrivenCount = 0;
		this.persistedLastRunErrorCount = 0;
		this.persistedLastRunExhaustedCount = 0;
		this.persistedDeliveredCount = 0;
		this.persistedExhaustedCount = 0;
		this.persistedZeroChannelBroadcasts = 0;
		this.persistedPendingCount = null;
		this._pendingCountLocalDelta = 0;
		this._pendingCountLocalMutationAt = 0;
		this._pendingCountLocalMutations = [];
		this._pendingCountLocalMutationSequence = 0;
		this._pendingCountObservedAt = null;
		this.totalDeliveredCount = 0;
		this.totalExhaustedCount = 0;
		this.totalZeroChannelBroadcasts = 0;
		this._telemetryWriteSequence = 0;
		this._activeTelemetryWritePromise = null;
		this._activeTelemetryWriteOperation = null;
		this._activeTelemetryReadPromise = null;
		this._activePendingCountPromise = null;
		this._activeZeroChannelWritePromise = null;
		this._activeZeroChannelWriteResultPromise = null;
		this._pendingZeroChannelWriteDelta = 0;
		this._zeroChannelRetryTimer = null;
		this._zeroChannelRetryAttempts = 0;
		this._isDraining = false;
		this._initialSeedPromise = null;
		this._sessionDeliveredDelta = 0;
		this._sessionExhaustedDelta = 0;
	}

	incrementZeroChannelBroadcasts() {
		this.totalZeroChannelBroadcasts += 1;
		if (!this.hasDurableStore()) return Promise.resolve();

		this._pendingZeroChannelWriteDelta += 1;
		return this._flushZeroChannelWrites();
	}

	_scheduleZeroChannelRetry() {
		if (
			this._zeroChannelRetryTimer
			|| this._pendingZeroChannelWriteDelta <= 0
			|| !this.hasDurableStore()
			|| this._isDraining
			|| this._zeroChannelRetryAttempts >= MAX_ZERO_CHANNEL_RETRY_ATTEMPTS
		) {
			return;
		}

		this._zeroChannelRetryAttempts += 1;
		this._zeroChannelRetryTimer = setTimeout(() => {
			this._zeroChannelRetryTimer = null;
			if (this._pendingZeroChannelWriteDelta > 0) {
				trackBackgroundTask(this._flushZeroChannelWrites()).catch(() => {});
			}
		}, ZERO_CHANNEL_RETRY_DELAY_MS);
		if (typeof this._zeroChannelRetryTimer.unref === 'function') {
			this._zeroChannelRetryTimer.unref();
		}
	}

	_flushZeroChannelWrites() {
		if (this._activeZeroChannelWritePromise) {
			return this._activeZeroChannelWriteResultPromise || this._activeZeroChannelWritePromise;
		}
		if (this._pendingZeroChannelWriteDelta <= 0 || !this.hasDurableStore()) {
			return Promise.resolve(true);
		}
		if (this._zeroChannelRetryTimer) {
			clearTimeout(this._zeroChannelRetryTimer);
			this._zeroChannelRetryTimer = null;
		}

		const delta = this._pendingZeroChannelWriteDelta;
		this._pendingZeroChannelWriteDelta = 0;
		let persisted = false;
		let retryable = false;
		let followUpWriteStarted = false;
		let trackedWrite;
		const writePromise = Promise.resolve()
			.then(() => this._persistZeroChannelIncrement(delta))
			.then((result) => {
				persisted = result?.persisted === true;
				retryable = result?.retryable === true;
				if (!persisted && retryable) {
					this._pendingZeroChannelWriteDelta += delta;
				}
				return persisted;
			})
			.catch((error) => {
				console.warn('[NotificationRedriveService] Zero-channel write failed:', error.message);
				return false;
			})
			.finally(() => {
				if (this._activeZeroChannelWritePromise !== trackedWrite) return;
				this._activeZeroChannelWritePromise = null;
				this._activeZeroChannelWriteResultPromise = null;
				if (persisted) {
					this._zeroChannelRetryAttempts = 0;
					if (this._pendingZeroChannelWriteDelta > 0) {
						followUpWriteStarted = true;
						this._flushZeroChannelWrites();
					}
				} else if (retryable && !this._isDraining) {
					this._scheduleZeroChannelRetry();
				}
			});
		trackedWrite = writePromise;
		this._activeZeroChannelWritePromise = trackedWrite;

		const boundedResult = resolveBeforeDeadline(
			trackedWrite,
			Date.now() + HEARTBEAT_WRITE_TIMEOUT_MS,
		).then((result) => {
			if (result === null) {
				console.warn(`[NotificationRedriveService] Zero-channel write timed out after ${HEARTBEAT_WRITE_TIMEOUT_MS}ms`);
				return false;
			}
			if (result === true && followUpWriteStarted) {
				return this._activeZeroChannelWriteResultPromise || Promise.resolve(true);
			}
			return result === true;
		}).catch(() => false);
		this._activeZeroChannelWriteResultPromise = boundedResult;
		trackBackgroundTask(trackedWrite).catch(() => {});
		return boundedResult;
	}

	_persistZeroChannelIncrement(delta = 1) {
		const firestore = this.getFirestore();
		if (!firestore) {
			return Promise.resolve({ persisted: false, retryable: false });
		}
		try {
			const docRef = firestore.collection(HEARTBEAT_COLLECTION_NAME).doc(HEARTBEAT_DOCUMENT_ID);
			let writePromise = null;
			if (admin?.firestore?.FieldValue?.increment) {
				writePromise = docRef.set({
					zeroChannelBroadcasts: admin.firestore.FieldValue.increment(delta),
				}, { merge: true });
			} else if (typeof firestore.runTransaction === 'function') {
				writePromise = firestore.runTransaction(async (tx) => {
					const snapshot = await tx.get(docRef);
					const data = snapshot && snapshot.exists ? (typeof snapshot.data === 'function' ? snapshot.data() : snapshot) : null;
					const current = Number(data?.zeroChannelBroadcasts) || 0;
					tx.set(docRef, { zeroChannelBroadcasts: current + delta }, { merge: true });
				});
			} else if (typeof docRef.set === 'function') {
				writePromise = docRef.set({ zeroChannelBroadcasts: this.totalZeroChannelBroadcasts }, { merge: true });
			} else {
				return Promise.resolve({ persisted: false, retryable: false });
			}
			return Promise.resolve(writePromise).then(() => ({ persisted: true, retryable: false })).catch((error) => {
				console.warn('[NotificationRedriveService] Failed to persist zero-channel increment:', error.message);
				return { persisted: false, retryable: isZeroChannelNonCommitError(error) };
			});
		} catch (error) {
			console.warn('[NotificationRedriveService] Failed to persist zero-channel increment:', error.message);
			return Promise.resolve({ persisted: false, retryable: true });
		}
	}

	getZeroChannelBroadcastsCount() {
		return this.totalZeroChannelBroadcasts;
	}

	isEnabled() {
		return process.env.ENABLE_NOTIFICATION_REDRIVE === 'true';
	}

	getWorkerRole() {
		const configuredRole = String(process.env.NOTIFICATION_REDRIVE_WORKER_ROLE || 'web').trim().toLowerCase();
		return WORKER_ROLES.has(configuredRole) ? configuredRole : 'web';
	}

	getFirestore() {
		if (!this.isEnabled()) {
			return null;
		}
		return AlertStorageService.getFirestore();
	}

	hasDurableStore() {
		return Boolean(this.getFirestore());
	}

	setNotificationManagerGetter(getter) {
		this.notificationManagerGetter = getter;
	}

	getNotificationManager() {
		if (typeof this.notificationManagerGetter === 'function') {
			return this.notificationManagerGetter();
		}
		return this.notificationManagerGetter;
	}

	async recordDeliveryResults(alert, deliveryResults = [], options = {}) {
		if (
			!this.isEnabled() ||
			!Array.isArray(deliveryResults) ||
			Boolean(options.isProbe) ||
			options.redriveEligible === false ||
			Boolean(alert?.isProbe) ||
			alert?.redriveEligible === false
		) {
			return [];
		}

		const failures = deliveryResults.filter((r) => r && !r.success && r.channel);
		if (failures.length === 0) {
			return [];
		}

		const alertId = alert?.requestId || alert?.correlationId || alert?.alertId || alert?.id || crypto.randomUUID();
		const runtimeConfig = getRuntimeConfig();
		const maxAgeMs = parsePositiveInteger(
			options.maxAgeMs ?? runtimeConfig.NOTIFICATION_REDRIVE_MAX_AGE_MS ?? process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS,
			DEFAULT_MAX_AGE_MS,
		);

		const nowMs = Date.now();
		const nowDate = new Date(nowMs);
		const expiresAtDate = new Date(nowMs + maxAgeMs);
		const nextAttemptAtDate = new Date(nowMs + calculateBackoffMs(0));

		const recordedIds = [];

		for (const failure of failures) {
			const channel = failure.channel;
			const recordId = `${alertId}_${channel}`;
			const record = {
				id: recordId,
				alertId: String(alertId),
				channel: String(channel),
				status: 'pending',
				alert: {
					text: typeof alert?.text === 'string' ? alert.text : '',
					source: alert?.source || null,
					telegramChatId: alert?.telegramChatId || null,
					telegramThreadId: alert?.telegramThreadId !== undefined ? alert.telegramThreadId : null,
					whatsappChatId: alert?.whatsappChatId || null,
					discordWebhookUrl: alert?.discordWebhookUrl || null,
					enriched: Boolean(alert?.enriched),
					enrichmentData: alert?.enriched && typeof alert.enriched === 'object' ? alert.enriched : null,
					requestId: String(alertId),
				},
				destinationOverride: getRedriveRouting(channel, options.routing, options.repeatCooldown),
				attemptCount: 0,
				lastError: failure.error ? String(failure.error) : 'Unknown delivery failure',
				lastStatusCode: typeof failure.statusCode === 'number' ? failure.statusCode : null,
					repeatCooldown: options.repeatCooldown && options.repeatCooldown.key
						? {
							key: String(options.repeatCooldown.key),
							channel: options.repeatCooldown.channelsByName?.[channel] || null,
							reservedAt: options.repeatCooldown.reservedAt,
							generation: options.repeatCooldown.generation ?? null,
						}
					: null,
				createdAt: toTimestamp(nowDate),
				updatedAt: toTimestamp(nowDate),
				nextAttemptAt: toTimestamp(nextAttemptAtDate),
				expiresAt: toTimestamp(expiresAtDate),
				claimedAt: null,
				leaseUntil: null,
				workerId: null,
				terminalAt: null,
				deliveredAt: null,
			};

			const sanitizedRecord = stripUndefinedFieldsDeep(record);
			if (record.repeatCooldown?.key && await this.isRepeatCooldownSuperseded(record)) {
				sanitizedRecord.status = 'cancelled';
				sanitizedRecord.lastError = 'Superseded by an opposite-side signal';
				sanitizedRecord.terminalAt = toTimestamp(nowDate);
			}

			// Persist in-memory store
			const previousRecord = this.inMemoryStore.get(recordId);
			this.inMemoryStore.set(recordId, { ...sanitizedRecord });
			this._adjustPendingCount(previousRecord?.status, sanitizedRecord.status);

			// Try persisting to Firestore if available
			const firestore = this.getFirestore();
			if (firestore) {
				try {
					let timer = null;
					const write = firestore.collection(COLLECTION_NAME).doc(recordId)
						.set(sanitizedRecord, { merge: true });
					const writeOutcome = write.then(() => 'persisted', (error) => {
							console.warn(`[NotificationRedriveService] Failed to persist dead-letter ${recordId} in Firestore, kept in-memory:`, error.message);
							return 'failed';
						});
					const persisted = await Promise.race([
						writeOutcome,
						new Promise((resolve) => {
							timer = setTimeout(() => resolve('timed_out'), DURABLE_ENQUEUE_TIMEOUT_MS);
						}),
					]);
					if (timer) {
						clearTimeout(timer);
					}
					if (persisted === 'persisted') {
						console.debug(`[NotificationRedriveService] Recorded dead-letter ${recordId} in Firestore`);
					} else if (persisted === 'failed' && this.getWorkerRole() !== 'web') {
						releaseRepeatCooldown(record);
					} else if (persisted === 'timed_out') {
						trackBackgroundTask(writeOutcome.then(async (outcome) => {
							if (outcome === 'persisted') {
								const terminalized = await this.markTerminal(recordId, 'cancelled', {
									lastError: 'Durable enqueue timed out before ownership was established',
								});
								if (!terminalized) {
									return;
								}
							}
							if (this.getWorkerRole() !== 'web') {
								releaseRepeatCooldown(record);
							}
						})).catch((error) => {
							console.warn(`[NotificationRedriveService] Failed to terminalize late dead-letter ${recordId}:`, error.message);
						});
					}
				} catch (error) {
					console.warn(`[NotificationRedriveService] Failed to persist dead-letter ${recordId} in Firestore, kept in-memory:`, error.message);
					if (this.getWorkerRole() !== 'web') {
						releaseRepeatCooldown(record);
					}
				}
			} else {
				console.debug(`[NotificationRedriveService] Recorded dead-letter ${recordId} in memory`);
			}

			recordedIds.push(recordId);
		}

		return recordedIds;
	}

	async getEligibleRecords(batchLimit, maxAgeMs) {
		const nowMs = Date.now();
		const records = [];
		const firestore = this.getFirestore();

		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME)
					.where('status', 'in', ['pending', 'in_flight'])
					.limit(batchLimit * 2)
					.get();

				if (snapshot && !snapshot.empty) {
					for (const doc of snapshot.docs) {
						const data = doc.data();
						const nextAttemptMs = toMillis(data.nextAttemptAt);
						const expiresAtMs = toMillis(data.expiresAt);
						const leaseUntilMs = toMillis(data.leaseUntil);

						if (expiresAtMs && nowMs >= expiresAtMs) {
							// Record has expired window
							records.push({ ...data, id: doc.id, expired: true });
						} else if (data.status === 'in_flight' && leaseUntilMs && leaseUntilMs > nowMs) {
							// Active unexpired claim, skip
							continue;
						} else if (nextAttemptMs <= nowMs) {
							records.push({ ...data, id: doc.id, expired: false });
						}

						if (records.length >= batchLimit) {
							break;
						}
					}
					return records;
				}
			} catch (error) {
				console.warn('[NotificationRedriveService] Failed to query Firestore dead-letters; falling back to memory:', error.message);
			}
		}

		// Fallback to inMemoryStore
		for (const [id, data] of this.inMemoryStore.entries()) {
			if (data.status !== 'pending' && data.status !== 'in_flight') {
				continue;
			}

			const nextAttemptMs = toMillis(data.nextAttemptAt);
			const expiresAtMs = toMillis(data.expiresAt);
			const leaseUntilMs = toMillis(data.leaseUntil);

			if (expiresAtMs && nowMs >= expiresAtMs) {
				records.push({ ...data, id, expired: true });
			} else if (data.status === 'in_flight' && leaseUntilMs && leaseUntilMs > nowMs) {
				continue;
			} else if (nextAttemptMs <= nowMs) {
				records.push({ ...data, id, expired: false });
			}

			if (records.length >= batchLimit) {
				break;
			}
		}

		return records;
	}

	async claimRecord(record, leaseMs) {
		const nowMs = Date.now();
		const nowDate = new Date(nowMs);
		const leaseUntilDate = new Date(nowMs + leaseMs);
		const workerId = `${process.pid}-${crypto.randomUUID()}`;
		const firestore = this.getFirestore();

		if (firestore) {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(record.id);
				const claimed = await firestore.runTransaction(async (tx) => {
					const doc = await tx.get(docRef);
					if (!doc.exists) {
						return false;
					}
					const current = doc.data();
					if (current.status !== 'pending' && current.status !== 'in_flight') {
						return false;
					}
					const currentLeaseUntilMs = toMillis(current.leaseUntil);
					if (current.status === 'in_flight' && currentLeaseUntilMs > nowMs) {
						return false;
					}

					tx.update(docRef, {
						status: 'in_flight',
						workerId,
						claimedAt: toTimestamp(nowDate),
						leaseUntil: toTimestamp(leaseUntilDate),
						updatedAt: toTimestamp(nowDate),
					});
					return true;
				});

				if (claimed) {
					const updated = {
						...record,
						status: 'in_flight',
						workerId,
						claimedAt: nowDate,
						leaseUntil: leaseUntilDate,
					};
					this.inMemoryStore.set(record.id, updated);
					return updated;
				}
				return null;
			} catch (error) {
				console.warn(`[NotificationRedriveService] Transaction claim failed for ${record.id}:`, error.message);
			}
		}

		// In-memory atomic claim
		const current = this.inMemoryStore.get(record.id);
		if (!current || (current.status !== 'pending' && current.status !== 'in_flight')) {
			return null;
		}
		const currentLeaseUntilMs = toMillis(current.leaseUntil);
		if (current.status === 'in_flight' && currentLeaseUntilMs > nowMs) {
			return null;
		}

		const updated = {
			...current,
			status: 'in_flight',
			workerId,
			claimedAt: nowDate,
			leaseUntil: leaseUntilDate,
			updatedAt: nowDate,
		};
		this.inMemoryStore.set(record.id, updated);
		return updated;
	}

	async markTerminal(recordId, status, metadata = {}, deadline = Infinity) {
		const nowMs = Date.now();
		const nowDate = new Date(nowMs);
		const updateData = {
			status,
			terminalAt: toTimestamp(nowDate),
			updatedAt: toTimestamp(nowDate),
			workerId: null,
			leaseUntil: null,
			...metadata,
		};

		const sanitized = stripUndefinedFieldsDeep(updateData);
		const memCurrent = this.inMemoryStore.get(recordId);
		const previousStatus = memCurrent?.status;
		if (memCurrent) {
			this.inMemoryStore.set(recordId, { ...memCurrent, ...sanitized });
		}

		const firestore = this.getFirestore();
		if (firestore) {
			try {
				const writePromise = firestore.collection(COLLECTION_NAME).doc(recordId).set(sanitized, { merge: true }).then(() => true, (error) => {
					console.warn(`[NotificationRedriveService] Failed to mark dead-letter ${recordId} terminal (${status}):`, error.message);
					return false;
				});
				if (Number.isFinite(deadline)) {
					const persisted = await resolveBeforeDeadline(writePromise, deadline);
					if (persisted === true) {
						this._adjustPendingCount(previousStatus, sanitized.status);
					}
					return persisted === true;
				}
				const persisted = await writePromise;
				if (persisted === true) {
					this._adjustPendingCount(previousStatus, sanitized.status);
				}
				return persisted;
			} catch (error) {
				console.warn(`[NotificationRedriveService] Failed to mark dead-letter ${recordId} terminal (${status}):`, error.message);
				return false;
			}
		}
		this._adjustPendingCount(previousStatus, sanitized.status);
		return true;
	}

	async markRetry(recordId, attemptCount, lastError, lastStatusCode) {
		const nowMs = Date.now();
		const nowDate = new Date(nowMs);
		const backoffMs = calculateBackoffMs(attemptCount);
		const nextAttemptAtDate = new Date(nowMs + backoffMs);

		const updateData = {
			status: 'pending',
			attemptCount,
			lastError: lastError ? String(lastError) : 'Delivery retry failed',
			lastStatusCode: typeof lastStatusCode === 'number' ? lastStatusCode : null,
			nextAttemptAt: toTimestamp(nextAttemptAtDate),
			updatedAt: toTimestamp(nowDate),
			workerId: null,
			leaseUntil: null,
		};

		const sanitized = stripUndefinedFieldsDeep(updateData);
		const memCurrent = this.inMemoryStore.get(recordId);
		const previousStatus = memCurrent?.status;
		if (memCurrent) {
			this.inMemoryStore.set(recordId, { ...memCurrent, ...sanitized });
		}

		const firestore = this.getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(recordId).set(sanitized, { merge: true });
				this._adjustPendingCount(previousStatus, sanitized.status);
			} catch (error) {
				console.warn(`[NotificationRedriveService] Failed to update retry for ${recordId}:`, error.message);
			}
			return;
		}
		this._adjustPendingCount(previousStatus, sanitized.status);
	}

	async reconcileRepeatCooldown(key, channels = []) {
		const identity = `${key}|${[...channels].sort().join(',')}`;
		if (!this.reconciliationPromises.has(identity)) {
			let reconciliationPromise;
			reconciliationPromise = Promise.resolve()
					.then(() => this._reconcileRepeatCooldown(key, channels, Date.now() + RECONCILIATION_TIMEOUT_MS))
				.catch((error) => {
					console.warn('[NotificationRedriveService] Cooldown reconciliation failed:', error.message);
					return 0;
				})
					.finally(() => {
						if (this.reconciliationPromises.get(identity) === reconciliationPromise) {
							this.reconciliationPromises.delete(identity);
						}
					});
			this.reconciliationPromises.set(identity, reconciliationPromise);
		}
		let timer = null;
		try {
			const reconciliationPromise = this.reconciliationPromises.get(identity);
			return await Promise.race([
				reconciliationPromise,
				new Promise((resolve) => {
					timer = setTimeout(() => {
						resolve(0);
					}, RECONCILIATION_TIMEOUT_MS);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	async _reconcileRepeatCooldown(key, channels = [], deadline = Infinity) {
		if (!key || !Array.isArray(channels) || channels.length === 0) {
			return 0;
		}

		const channelSet = new Set(channels);
		const candidates = new Map();
		const matches = (record) => (
			record
			&& record.repeatCooldown?.key === key
			&& channelSet.has(record.repeatCooldown.channel)
			&& ['delivered', 'expired', 'exhausted', 'cancelled'].includes(record.status)
		);

		for (const record of this.inMemoryStore.values()) {
			if (matches(record)) {
				candidates.set(record.id, record);
			}
		}

		const firestore = this.getFirestore();
		if (firestore) {
			try {
				let query = firestore.collection(COLLECTION_NAME)
					.where('repeatCooldown.key', '==', key)
					.limit(200);
				do {
					if (Date.now() >= deadline) {
						break;
					}
					const snapshot = await query.get().catch((error) => {
						console.warn('[NotificationRedriveService] Failed to get query snapshot in reconciliation:', error.message);
						return null;
					});
					if (!snapshot) {
						break;
					}
					const docs = snapshot?.docs || [];
					for (const doc of docs) {
						const record = { ...doc.data(), id: doc.id };
						if (matches(record)) {
							candidates.set(record.id, record);
						}
					}
					if (docs.length < 200 || typeof query.startAfter !== 'function') {
						break;
					}
					const nextQuery = query.startAfter(docs[docs.length - 1]);
					if (!nextQuery || nextQuery === query) {
						break;
					}
					query = nextQuery;
				} while (true);
			} catch (error) {
				console.warn('[NotificationRedriveService] Failed to reconcile cooldown state:', error.message);
			}
		}

		const newestCandidates = new Map();
		for (const record of candidates.values()) {
			const channel = record.repeatCooldown.channel;
			const localTimestamp = signalRepeatCooldown.getChannelTimestamp(key, channel);
			const localGen = signalRepeatCooldown.getChannelGeneration(key, channel);
			const recordGen = record.repeatCooldown?.generation;
			if (Number.isFinite(localGen) && Number.isFinite(recordGen) && localGen > recordGen) {
				continue;
			}
			const reservedAt = toMillis(record.repeatCooldown.reservedAt);
			if (reservedAt && Number.isFinite(localTimestamp) && localTimestamp > reservedAt) {
				continue;
			}
			const transitionAt = toMillis(record.deliveredAt || record.terminalAt || record.updatedAt);
			const current = newestCandidates.get(channel);
			if (!current || transitionAt > toMillis(current.deliveredAt || current.terminalAt || current.updatedAt)) {
				newestCandidates.set(channel, record);
			}
		}

		for (const record of newestCandidates.values()) {
			if (Date.now() >= deadline) {
				return 0;
			}
			const channel = record.repeatCooldown.channel;
			const localTimestamp = signalRepeatCooldown.getChannelTimestamp(key, channel);
			const localGen = signalRepeatCooldown.getChannelGeneration(key, channel);
			const recordGen = record.repeatCooldown?.generation;
			if (Number.isFinite(localGen) && Number.isFinite(recordGen) && localGen > recordGen) {
				continue;
			}
			const reservedAt = toMillis(record.repeatCooldown.reservedAt);
			const terminalAt = toMillis(record.deliveredAt || record.terminalAt || record.updatedAt);
			if (reservedAt && Number.isFinite(localTimestamp) && localTimestamp > reservedAt) {
				continue;
			}
			if (!Number.isFinite(localTimestamp) || !terminalAt || terminalAt <= localTimestamp) {
				continue;
			}
			if (record.status === 'delivered') {
				signalRepeatCooldown.refresh(key, [channel], terminalAt);
			} else {
				releaseRepeatCooldown(record);
			}
		}
		return candidates.size;
	}

	async isRepeatCooldownSuperseded(record, deadline = Date.now() + RECONCILIATION_TIMEOUT_MS) {
		if (!record?.id || !record.repeatCooldown?.key || !record.repeatCooldown.channel) {
			return false;
		}

		const supersessionId = this.getSupersessionId(record.repeatCooldown.key, record.repeatCooldown.channel);
		const localSupersession = this.supersessionStore.get(supersessionId);
		if ((localSupersession && isSupersededByMarker(localSupersession, record))
			|| this.inMemoryStore.get(record.id)?.status === 'cancelled') {
			return true;
		}

		const firestore = this.getFirestore();
		if (!firestore) {
			return false;
		}
		const remainingMs = Math.max(0, deadline - Date.now());
		if (remainingMs === 0) {
			return false;
		}
		let timer = null;
		try {
			const snapshots = await Promise.race([
				Promise.all([
					firestore.collection(COLLECTION_NAME).doc(record.id).get(),
					firestore.collection(COLLECTION_NAME).doc(supersessionId).get(),
				]),
				new Promise((resolve) => {
					timer = setTimeout(() => resolve(null), remainingMs);
				}),
			]);
			if (!snapshots) {
				return false;
			}
			const [recordSnapshot, supersessionSnapshot] = snapshots;
			const supersession = supersessionSnapshot?.exists ? supersessionSnapshot.data() : null;
			if (recordSnapshot?.exists && recordSnapshot.data()?.status === 'cancelled') {
				return true;
			}
			if (supersessionSnapshot?.exists && supersession?.status === 'superseded') {
				const supersessionUpdateTime = supersessionSnapshot.updateTime || supersessionSnapshot.createTime;
				const recordCreateTime = recordSnapshot?.createTime || recordSnapshot?.updateTime;
				if (supersessionUpdateTime && recordCreateTime) {
					const supersessionNanos = (BigInt(supersessionUpdateTime.seconds || 0) * 1_000_000_000n) + BigInt(supersessionUpdateTime.nanoseconds || 0);
					const recordNanos = (BigInt(recordCreateTime.seconds || 0) * 1_000_000_000n) + BigInt(recordCreateTime.nanoseconds || 0);
					if (supersessionNanos > recordNanos) {
						return true;
					}
					if (recordNanos >= supersessionNanos) {
						return false;
					}
				}
			}
			return isSupersededByMarker(supersession, record);
		} catch (error) {
			console.warn('[NotificationRedriveService] Failed to check superseded redrive:', error.message);
			return false;
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	async watchRepeatCooldownSupersession(record, controller, isActive) {
		while (isActive() && !controller.signal.aborted) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			if (isActive() && await this.isRepeatCooldownSuperseded(record)) {
				controller.abort();
				break;
			}
		}
	}

	getSupersessionId(key, channel) {
		return `_repeat_supersession_${crypto.createHash('sha256').update(`${key}|${channel}`).digest('hex')}`;
	}

	async markRepeatSupersession(key, channels = []) {
		if (!key || !Array.isArray(channels) || channels.length === 0) {
			return null;
		}
		const now = new Date();
		const generation = nextMonotonicGeneration(now.getTime());
		const firestore = this.getFirestore();
		const supersessions = channels.map((channel) => ({
			channel,
			id: this.getSupersessionId(key, channel),
		}));
		for (const { channel, id } of supersessions) {
			this.supersessionStore.set(id, { key, channel, status: 'superseded', supersededAt: now, generation });
		}
		if (firestore) {
			const deadline = Date.now() + RECONCILIATION_TIMEOUT_MS;
			await Promise.all(supersessions.map(async ({ channel, id }) => {
				const write = firestore.collection(COLLECTION_NAME).doc(id).set({
					key,
					channel,
					status: 'superseded',
					supersededAt: toTimestamp(now),
					generation,
				}, { merge: true }).then(() => true, (error) => {
					console.warn('[NotificationRedriveService] Failed to persist repeat supersession:', error.message);
					return false;
				});
				const persisted = await resolveBeforeDeadline(write, deadline);
				if (persisted === null) {
					console.warn(`[NotificationRedriveService] Timed out persisting repeat supersession for ${channel}`);
				}
			}));
		}
		return { supersededAt: now, generation };
	}

	async cancelPendingRepeatCooldowns(key, channels = [], deadline = Date.now() + RECONCILIATION_TIMEOUT_MS) {
		if (!key || !Array.isArray(channels) || channels.length === 0) {
			return 0;
		}
		const supersessionResult = await this.markRepeatSupersession(key, channels);
		const supersededAtMs = toMillis(supersessionResult?.supersededAt || supersessionResult);
		const supersessionGen = supersessionResult?.generation;

		const channelSet = new Set(channels);
		const candidates = new Map();
		const matches = (record) => {
			if (!record || !['pending', 'in_flight'].includes(record.status)) {
				return false;
			}
			if (record.repeatCooldown?.key !== key || !channelSet.has(record.repeatCooldown?.channel)) {
				return false;
			}
			const recordGen = record.repeatCooldown?.generation;
			const genComparison = compareGenerations(supersessionGen, recordGen);
			if (genComparison !== null) {
				return genComparison >= 0;
			}
			const reservedAt = toMillis(record.repeatCooldown?.reservedAt);
			return !supersededAtMs || !reservedAt || reservedAt <= supersededAtMs;
		};

		for (const record of this.inMemoryStore.values()) {
			if (matches(record)) {
				candidates.set(record.id, record);
			}
		}

		const firestore = this.getFirestore();
		if (firestore) {
			try {
				const queryDeadline = Number.isFinite(deadline) ? deadline : Date.now() + RECONCILIATION_TIMEOUT_MS;
				const queryPromise = firestore.collection(COLLECTION_NAME)
					.where('repeatCooldown.key', '==', key)
					.where('status', 'in', ['pending', 'in_flight'])
					.get()
					.then((snapshot) => snapshot?.docs || [])
					.catch((error) => {
						console.warn('[NotificationRedriveService] Failed to query pending redrives for cancellation:', error.message);
						return [];
					});
				const docs = await resolveBeforeDeadline(queryPromise, queryDeadline);
				for (const doc of docs || []) {
					const record = { ...doc.data(), id: doc.id };
					if (matches(record)) {
						candidates.set(record.id, record);
					}
				}
			} catch (error) {
				console.warn('[NotificationRedriveService] Failed to query pending redrives for cancellation:', error.message);
			}
		}

		for (const record of candidates.values()) {
			await this.markTerminal(record.id, 'cancelled', {
				lastError: 'Superseded by an opposite-side signal',
			}, deadline);
		}
		return candidates.size;
	}

	async notifyAdminPermanentFailure(record, reason) {
		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		if (!adminChatId) {
			return;
		}

		const notificationManager = this.getNotificationManager();
		if (!notificationManager) {
			return;
		}

		const telegramService = notificationManager.channels?.get?.('telegram');
		if (!telegramService || !telegramService.isEnabled()) {
			return;
		}

		const message = [
			'🚨 Notification Redrive Exhausted',
			`Alert ID: ${record.alertId}`,
			`Channel: ${record.channel}`,
			`Attempts: ${record.attemptCount || 0}`,
			`Reason: ${reason || 'Max attempts reached'}`,
			`Last error: ${record.lastError || 'Unknown'}`,
		].join('\n');

		try {
			await telegramService.send({
				text: message,
				telegramChatId: adminChatId,
			});
			console.info(`[NotificationRedriveService] Sent admin alert for exhausted dead-letter ${record.id}`);
		} catch (error) {
			console.warn('[NotificationRedriveService] Failed to send admin exhaustion alert:', error.message);
		}
	}

	async sweep(options = {}) {
		if (!this.isEnabled()) {
			return { scanned: 0, redriven: 0, errors: 0 };
		}

		const role = this.getWorkerRole();
		if (role === 'disabled') {
			return { scanned: 0, redriven: 0, errors: 0 };
		}

		if (this.activeSweepPromise) {
			return this.activeSweepPromise;
		}

		this.activeSweepPromise = (async () => {
			if (this._initialSeedPromise) {
				try {
					await this._initialSeedPromise;
				} catch (_) {}
				this._initialSeedPromise = null;
			}
			return this._executeSweep(options);
		})().finally(() => {
			this.activeSweepPromise = null;
		});

		return this.activeSweepPromise;
	}

	async _executeSweep(options = {}) {
		const startTime = Date.now();
		this.lastRunAt = new Date(startTime);

		const runtimeConfig = getRuntimeConfig();
		const batchLimit = parsePositiveInteger(
			options.batchLimit ?? runtimeConfig.NOTIFICATION_REDRIVE_BATCH_LIMIT ?? process.env.NOTIFICATION_REDRIVE_BATCH_LIMIT,
			DEFAULT_BATCH_LIMIT,
		);
		const maxAttempts = parsePositiveInteger(
			options.maxAttempts ?? runtimeConfig.NOTIFICATION_REDRIVE_MAX_ATTEMPTS ?? process.env.NOTIFICATION_REDRIVE_MAX_ATTEMPTS,
			DEFAULT_MAX_ATTEMPTS,
		);
		const maxAgeMs = parsePositiveInteger(
			options.maxAgeMs ?? runtimeConfig.NOTIFICATION_REDRIVE_MAX_AGE_MS ?? process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS,
			DEFAULT_MAX_AGE_MS,
		);
		const leaseMs = parsePositiveInteger(options.leaseMs, DEFAULT_LEASE_MS);

		let scannedCount = 0;
		let redrivenCount = 0;
		let errorCount = 0;
		let exhaustedCount = 0;

		try {
			const candidates = await this.getEligibleRecords(batchLimit, maxAgeMs);
			scannedCount = candidates.length;

			const notificationManager = options.notificationManager || this.getNotificationManager();

			for (const candidate of candidates) {
				if (options.signal?.aborted) {
					break;
				}

				// Check budget expiration
				if (candidate.expired || candidate.attemptCount >= maxAttempts) {
					const terminalStatus = candidate.expired ? 'expired' : 'exhausted';
					releaseRepeatCooldown(candidate);
					const marked = await this.markTerminal(candidate.id, terminalStatus, {
						terminalAt: toTimestamp(new Date()),
					});
					if (marked) {
						this.totalExhaustedCount += 1;
						exhaustedCount += 1;
						this._sessionExhaustedDelta = (this._sessionExhaustedDelta || 0) + 1;
						trackBackgroundTask(this.notifyAdminPermanentFailure(candidate, `Terminal status: ${terminalStatus}`)).catch(() => {});
					} else {
						errorCount += 1;
					}
					continue;
				}

				// Claim record with lease
				const claimed = await this.claimRecord(candidate, leaseMs);
			if (!claimed) {
					continue;
				}

				if (await this.isRepeatCooldownSuperseded(claimed, Date.now() + RECONCILIATION_TIMEOUT_MS)) {
					await this.markTerminal(claimed.id, 'cancelled', {
						lastError: 'Superseded by an opposite-side signal',
					});
					continue;
				}

				if (!notificationManager) {
					console.warn('[NotificationRedriveService] No NotificationManager available for redrive dispatch');
					await this.markRetry(claimed.id, claimed.attemptCount, 'NotificationManager unavailable', null);
					errorCount += 1;
					continue;
				}

				// Dispatch redrive ONLY to the failed channel
				try {
					const dispatchController = new AbortController();
					const dispatchSignal = options.signal && typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function'
						? AbortSignal.any([options.signal, dispatchController.signal])
						: dispatchController.signal;
					let dispatchComplete = false;
					const supersessionWatcher = claimed.repeatCooldown?.key && claimed.repeatCooldown?.channel
						? this.watchRepeatCooldownSupersession(claimed, dispatchController, () => !dispatchComplete)
						: Promise.resolve();
					const alertPayload = {
						...(claimed.alert || {}),
						...(claimed.destinationOverride || {}),
					};

					let results;
					try {
						results = await notificationManager.sendToChannels(
							alertPayload,
							[claimed.channel],
							{
								...options,
								isRedrive: true,
								parentSpan: options.parentSpan,
								signal: dispatchSignal,
							},
						);
					} finally {
						dispatchComplete = true;
						await supersessionWatcher;
					}

					const channelResult = Array.isArray(results) && results[0] ? results[0] : null;
					if (await this.isRepeatCooldownSuperseded(claimed, Date.now() + RECONCILIATION_TIMEOUT_MS)) {
						await this.markTerminal(claimed.id, 'cancelled', {
							lastError: 'Superseded by an opposite-side signal',
						});
						continue;
					}

					if (channelResult && channelResult.success) {
						if (claimed.repeatCooldown?.key && claimed.repeatCooldown.channel) {
							signalRepeatCooldown.refresh(claimed.repeatCooldown.key, [claimed.repeatCooldown.channel]);
						}
						// Delivery succeeded
						const marked = await this.markTerminal(claimed.id, 'delivered', {
							deliveredAt: toTimestamp(new Date()),
						});
						if (marked) {
							this.totalDeliveredCount += 1;
							this._sessionDeliveredDelta = (this._sessionDeliveredDelta || 0) + 1;
							redrivenCount += 1;
							console.info(`[NotificationRedriveService] Successfully redelivered dead-letter ${claimed.id}`);
						} else {
							errorCount += 1;
						}
					} else {
						// Delivery failed again
						const nextAttempts = (claimed.attemptCount || 0) + 1;
						const lastErr = channelResult?.error || 'Redrive attempt failed';
						const lastCode = channelResult?.statusCode || null;

						if (nextAttempts >= maxAttempts) {
							releaseRepeatCooldown(claimed);
							const marked = await this.markTerminal(claimed.id, 'exhausted', {
								lastError: String(lastErr),
								lastStatusCode: lastCode,
								attemptCount: nextAttempts,
							});
							if (marked) {
								this.totalExhaustedCount += 1;
								exhaustedCount += 1;
								this._sessionExhaustedDelta = (this._sessionExhaustedDelta || 0) + 1;
								trackBackgroundTask(this.notifyAdminPermanentFailure({
									...claimed,
									attemptCount: nextAttempts,
									lastError: lastErr,
								}, 'Exhausted maximum retry attempts')).catch(() => {});
							}
							errorCount += 1;
						} else {
							await this.markRetry(claimed.id, nextAttempts, lastErr, lastCode);
							errorCount += 1;
						}
					}
				} catch (error) {
					console.error(`[NotificationRedriveService] Unexpected redrive dispatch error for ${claimed.id}:`, error.message);
					const nextAttempts = (claimed.attemptCount || 0) + 1;
					if (nextAttempts >= maxAttempts) {
						releaseRepeatCooldown(claimed);
						const marked = await this.markTerminal(claimed.id, 'exhausted', {
							lastError: error.message,
							attemptCount: nextAttempts,
						});
						if (marked) {
							this.totalExhaustedCount += 1;
							exhaustedCount += 1;
							this._sessionExhaustedDelta = (this._sessionExhaustedDelta || 0) + 1;
							trackBackgroundTask(this.notifyAdminPermanentFailure({
								...claimed,
								attemptCount: nextAttempts,
								lastError: error.message,
							}, 'Exhausted maximum retry attempts')).catch(() => {});
						}
					} else {
						await this.markRetry(claimed.id, nextAttempts, error.message, null);
					}
					errorCount += 1;
				}
			}
		} catch (error) {
			console.error('[NotificationRedriveService] Sweep execution failed:', error.message);
			errorCount += 1;
		} finally {
			const sweepEndTime = Date.now();
			this.lastRunDurationMs = Math.max(0, sweepEndTime - startTime);
			this.lastRunScannedCount = scannedCount;
			this.lastRunRedrivenCount = redrivenCount;
			this.lastRunErrorCount = errorCount;
			this.lastRunExhaustedCount = exhaustedCount;
			this.lastSweepAt = new Date(sweepEndTime);
			this.lastSweepResult = {
				processed: scannedCount,
				succeeded: redrivenCount,
				exhausted: exhaustedCount,
				errors: errorCount,
			};
			try {
				await this.persistWorkerTelemetry();
			} catch (error) {
				console.warn('[NotificationRedriveService] Sweep telemetry persistence failed:', error.message);
			}
		}

		return {
			scanned: scannedCount,
			redriven: redrivenCount,
			errors: errorCount,
		};
	}

	_getPendingFallbackCount() {
		if (Number.isFinite(this.persistedPendingCount)) {
			return this.persistedPendingCount;
		}
		return this.getPendingCount();
	}

	async countDurablePendingRecords() {
		const firestore = this.getFirestore();
		if (!firestore) {
			return this._getPendingFallbackCount();
		}
		try {
			if (!this._activePendingCountPromise) {
				const collection = firestore.collection(COLLECTION_NAME);
				if (typeof collection?.where !== 'function') {
					return this._getPendingFallbackCount();
				}
				const query = collection.where('status', 'in', ['pending', 'in_flight']);
				if (!query) {
					return this._getPendingFallbackCount();
				}
				const expiryAwareQuery = typeof query.where === 'function'
					? query.where('expiresAt', '>', toTimestamp(new Date()))
					: query;
				const aggregateQuery = typeof expiryAwareQuery.count === 'function' ? expiryAwareQuery.count() : null;
				const queryToRead = aggregateQuery || (
					typeof expiryAwareQuery.limit === 'function'
						? expiryAwareQuery.limit(PENDING_COUNT_FALLBACK_LIMIT)
						: expiryAwareQuery
				);
				if (!queryToRead || typeof queryToRead.get !== 'function') {
					return this._getPendingFallbackCount();
				}
				const pendingCountQueryStartedAtMs = Date.now();
				const localPendingCountMutationSequenceAtQueryStart = this._pendingCountLocalMutationSequence;
				const applyDurablePendingCount = (count, snapshot = null) => {
					const snapshotObservedAt = normalizeTimestampToDate(snapshot?.readTime);
					const observedAtMs = snapshotObservedAt?.getTime() || pendingCountQueryStartedAtMs;
					const localDeltaAfterSnapshot = this._pendingCountLocalMutations.reduce((delta, mutation) => {
						if (mutation.sequence <= localPendingCountMutationSequenceAtQueryStart) {
							return delta;
						}
						if (snapshotObservedAt && mutation.at <= observedAtMs) {
							return delta;
						}
						return delta + mutation.delta;
					}, 0);
					this.persistedPendingCount = Math.max(0, Math.floor(count + localDeltaAfterSnapshot));
					this._pendingCountObservedAt = new Date(observedAtMs);
					return Math.floor(count);
				};

				const countPromise = Promise.resolve()
					.then(() => queryToRead.get())
					.then((snapshot) => {
						if (aggregateQuery) {
							const data = typeof snapshot?.data === 'function' ? snapshot.data() : snapshot?.data;
							const count = Number(data?.count);
							if (!Number.isFinite(count) || count < 0) return null;
							return applyDurablePendingCount(count, snapshot);
						}
						if (!snapshot || snapshot.empty) {
							return applyDurablePendingCount(0, snapshot);
						}
						let count = 0;
						const nowMs = Date.now();
						const docs = Array.isArray(snapshot.docs) ? snapshot.docs : [];
						for (const doc of docs) {
							const data = typeof doc.data === 'function' ? doc.data() : doc;
							const expiresAtMs = toMillis(data?.expiresAt);
							if (!expiresAtMs || expiresAtMs > nowMs) {
								count += 1;
							}
						}
						return applyDurablePendingCount(count, snapshot);
					})
					.catch((error) => {
						console.warn('[NotificationRedriveService] Failed to count durable pending records:', error.message);
						return null;
					})
					.finally(() => {
						if (this._activePendingCountPromise === countPromise) {
							this._activePendingCountPromise = null;
						}
					});

				this._activePendingCountPromise = countPromise;
			}

			const result = await resolveBeforeDeadline(this._activePendingCountPromise, Date.now() + 3000);
			if (result === null || !Number.isFinite(result)) {
				return this._getPendingFallbackCount();
			}
			return result;
		} catch (error) {
			console.warn('[NotificationRedriveService] Failed to count durable pending records:', error.message);
			return this._getPendingFallbackCount();
		}
	}

	async seedCountersFromHeartbeat(retries = 1) {
		const firestore = this.getFirestore();
		if (!firestore) return;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				const collection = firestore.collection(HEARTBEAT_COLLECTION_NAME);
				if (typeof collection?.doc !== 'function') return;
				const docRef = collection.doc(HEARTBEAT_DOCUMENT_ID);
				if (!docRef || typeof docRef.get !== 'function') return;
				const doc = await resolveBeforeDeadline(docRef.get(), Date.now() + 3000);
				if (doc && doc.exists) {
					const data = typeof doc.data === 'function' ? doc.data() : doc;
					if (data) {
						if (Number.isFinite(data.deliveredCount) && data.deliveredCount > this.totalDeliveredCount) {
							this.totalDeliveredCount = data.deliveredCount;
						}
						if (Number.isFinite(data.exhaustedCount) && data.exhaustedCount > this.totalExhaustedCount) {
							this.totalExhaustedCount = data.exhaustedCount;
						}
						if (Number.isFinite(data.zeroChannelBroadcasts) && data.zeroChannelBroadcasts > this.totalZeroChannelBroadcasts) {
							this.totalZeroChannelBroadcasts = data.zeroChannelBroadcasts;
						}
					}
					return;
				}
				return;
			} catch (error) {
				if (attempt === retries) {
					console.warn('[NotificationRedriveService] Failed to seed counters from heartbeat:', error.message);
				}
			}
		}
	}

	async persistWorkerTelemetry(options = {}) {
		const firestore = this.getFirestore();
		if (!firestore) {
			return false;
		}

		const timeoutMs = options.timeoutMs || this._heartbeatWriteTimeoutMs || HEARTBEAT_WRITE_TIMEOUT_MS;
		const sequence = ++this._telemetryWriteSequence;
		const completedAt = normalizeTimestampToDate(this.lastSweepAt) || new Date();
		const currentSweepAtMs = completedAt.getTime();
		const pendingCount = await this.countDurablePendingRecords();
		const pendingCountObservedAt = normalizeTimestampToDate(this._pendingCountObservedAt) || new Date();
		const payload = {
			worker: 'notification-redrive',
			role: this.getWorkerRole(),
			workerRole: this.getWorkerRole(),
			sequence,
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastSweepAt: completedAt ? completedAt.toISOString() : null,
			lastSweepResult: this.lastSweepResult ? { ...this.lastSweepResult } : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunRedrivenCount: this.lastRunRedrivenCount,
			lastRunErrorCount: this.lastRunErrorCount,
			lastRunExhaustedCount: this.lastRunExhaustedCount,
			pendingCount,
			pendingCountObservedAt: pendingCountObservedAt.toISOString(),
			deliveredCount: this.totalDeliveredCount,
			exhaustedCount: this.totalExhaustedCount,
			updatedAt: admin.firestore?.Timestamp?.fromDate
				? admin.firestore.Timestamp.fromDate(new Date())
				: new Date().toISOString(),
		};

		const parseSweepTimestampMs = (val) => {
			if (!val) return 0;
			if (typeof val.toMillis === 'function') return val.toMillis();
			if (typeof val.toDate === 'function') return val.toDate().getTime();
			const parsed = new Date(val).getTime();
			return Number.isFinite(parsed) ? parsed : 0;
		};

		const performWrite = async () => {
			// Skip stale write if a newer sweep write has already been scheduled in this process
			if (sequence < this._telemetryWriteSequence) {
				return false;
			}

			const docRef = firestore.collection(HEARTBEAT_COLLECTION_NAME).doc(HEARTBEAT_DOCUMENT_ID);

			if (typeof firestore.runTransaction === 'function') {
				let txCompleted = false;
				let deliveredDelta = 0;
				let exhaustedDelta = 0;
				let finalWritePayload = null;
				const txPromise = firestore.runTransaction(async (transaction) => {
					const doc = await transaction.get(docRef);
					let writePayload = { ...payload };
					deliveredDelta = this._sessionDeliveredDelta || 0;
					exhaustedDelta = this._sessionExhaustedDelta || 0;

					if (doc && doc.exists) {
						const data = typeof doc.data === 'function' ? doc.data() : doc;
						const existingDelivered = Number(data?.deliveredCount) || 0;
						const existingExhausted = Number(data?.exhaustedCount) || 0;
						const existingSweepAtMs = parseSweepTimestampMs(data?.lastSweepAt);
						const currentSweepAtMs = parseSweepTimestampMs(payload.lastSweepAt);

						// If persisted heartbeat has a newer sweep completion time, do not overwrite sweep metadata
						if (existingSweepAtMs > currentSweepAtMs) {
							if (deliveredDelta > 0 || exhaustedDelta > 0) {
								const deltaPayload = {
									deliveredCount: existingDelivered + deliveredDelta,
									exhaustedCount: existingExhausted + exhaustedDelta,
								};
								finalWritePayload = deltaPayload;
								transaction.set(docRef, deltaPayload, { merge: true });
							}
							return;
						}
						// If exact same completion millisecond, use process sequence as tie-breaker
						if (existingSweepAtMs === currentSweepAtMs) {
							const existingSequence = Number(data?.sequence) || 0;
							if (existingSequence > sequence) {
								if (deliveredDelta > 0 || exhaustedDelta > 0) {
									const deltaPayload = {
										deliveredCount: existingDelivered + deliveredDelta,
										exhaustedCount: existingExhausted + exhaustedDelta,
									};
									finalWritePayload = deltaPayload;
									transaction.set(docRef, deltaPayload, { merge: true });
								}
								return;
							}
						}
						writePayload.deliveredCount = Math.max(existingDelivered + deliveredDelta, payload.deliveredCount);
						writePayload.exhaustedCount = Math.max(existingExhausted + exhaustedDelta, payload.exhaustedCount);
					}
					finalWritePayload = writePayload;
					transaction.set(docRef, writePayload, { merge: true });
				}).then(() => {
					txCompleted = true;
					if (finalWritePayload) {
						this._sessionDeliveredDelta = Math.max(0, (this._sessionDeliveredDelta || 0) - deliveredDelta);
						this._sessionExhaustedDelta = Math.max(0, (this._sessionExhaustedDelta || 0) - exhaustedDelta);
						if (typeof finalWritePayload.deliveredCount === 'number') {
							this.totalDeliveredCount = Math.max(this.totalDeliveredCount, finalWritePayload.deliveredCount);
						}
						if (typeof finalWritePayload.exhaustedCount === 'number') {
							this.totalExhaustedCount = Math.max(this.totalExhaustedCount, finalWritePayload.exhaustedCount);
						}
					}
				});

				const trackedOp = txPromise
					.catch(() => null)
					.finally(() => {
						if (this._activeTelemetryWriteOperation === trackedOp) {
							this._activeTelemetryWriteOperation = null;
						}
					});
				this._activeTelemetryWriteOperation = trackedOp;

				const deadlineResult = await resolveBeforeDeadline(txPromise.catch(() => null), Date.now() + timeoutMs);
				if (deadlineResult === null && !txCompleted) {
					return false;
				}
				return txCompleted;
			}

			let setCompleted = false;
			const setPromise = docRef.set(payload, { merge: true }).then(() => {
				setCompleted = true;
			});
			const trackedOp = setPromise
				.catch(() => null)
				.finally(() => {
					if (this._activeTelemetryWriteOperation === trackedOp) {
						this._activeTelemetryWriteOperation = null;
					}
				});
			this._activeTelemetryWriteOperation = trackedOp;
			const deadlineResult = await resolveBeforeDeadline(setPromise.catch(() => null), Date.now() + timeoutMs);
			if (deadlineResult === null && !setCompleted) {
				return false;
			}
			return setCompleted;
		};

		// If a previous telemetry write operation is still active in Firestore, keep writes single-flight
		if (this._activeTelemetryWriteOperation) {
			const waitBudgetMs = Number.isFinite(options.waitTimeoutMs)
				? options.waitTimeoutMs
				: Math.min(timeoutMs, 2000);
			let waitTimer = null;
			try {
				await Promise.race([
					this._activeTelemetryWriteOperation,
					new Promise((resolve) => {
						waitTimer = setTimeout(resolve, waitBudgetMs);
					}),
				]);
			} finally {
				if (waitTimer) {
					clearTimeout(waitTimer);
				}
			}
			// If previous Firestore operation has not settled, prevent starting a concurrent write
			if (this._activeTelemetryWriteOperation) {
				return false;
			}
		} else if (this._activeTelemetryWritePromise) {
			const waitBudgetMs = Number.isFinite(options.waitTimeoutMs)
				? options.waitTimeoutMs
				: Math.min(timeoutMs, 2000);
			let waitTimer = null;
			try {
				await Promise.race([
					this._activeTelemetryWritePromise.catch(() => {}),
					new Promise((resolve) => {
						waitTimer = setTimeout(resolve, waitBudgetMs);
					}),
				]);
			} finally {
				if (waitTimer) {
					clearTimeout(waitTimer);
				}
			}
		}

		// Skip stale write if a newer sweep write has already been scheduled in this process
		if (sequence < this._telemetryWriteSequence) {
			return false;
		}

		let timedOut = false;
		let timeoutTimer = null;
		const writePromise = performWrite();
		this._activeTelemetryWritePromise = writePromise;

		try {
			const timeoutPromise = new Promise((_, reject) => {
				timeoutTimer = setTimeout(() => {
					timedOut = true;
					reject(new Error(`Telemetry write timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			});

			const result = await Promise.race([writePromise, timeoutPromise]);
			return result === true;
		} catch (error) {
			console.warn('[NotificationRedriveService] Failed to persist worker telemetry:', error.message);
			return false;
		} finally {
			if (timeoutTimer) {
				clearTimeout(timeoutTimer);
			}
			if (timedOut || this._activeTelemetryWritePromise === writePromise) {
				this._activeTelemetryWritePromise = null;
			}
		}
	}

	async syncWorkerTelemetry(options = {}) {
		const firestore = this.getFirestore();
		if (!firestore) {
			return false;
		}

		// Keep underlying read promise single-flight until it settles
		if (!this._activeTelemetryReadPromise) {
			let readPromise;
			readPromise = Promise.resolve()
				.then(() => this._performSyncWorkerTelemetry(firestore))
				.catch((error) => {
					console.warn('[NotificationRedriveService] Telemetry read error:', error.message);
					return false;
				})
				.finally(() => {
					if (this._activeTelemetryReadPromise === readPromise) {
						this._activeTelemetryReadPromise = null;
					}
				});
			this._activeTelemetryReadPromise = readPromise;
		}

		const timeoutMs = options.timeoutMs || HEARTBEAT_WRITE_TIMEOUT_MS;
		let timer = null;
		try {
			return await Promise.race([
				this._activeTelemetryReadPromise,
				new Promise((resolve) => {
					timer = setTimeout(() => resolve(false), timeoutMs);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	async _performSyncWorkerTelemetry(firestore) {
		try {
			const docRef = firestore.collection(HEARTBEAT_COLLECTION_NAME).doc(HEARTBEAT_DOCUMENT_ID);
			const snapshot = await docRef.get();
			if (!snapshot || !snapshot.exists) {
				return false;
			}
			const data = typeof snapshot.data === 'function' ? snapshot.data() : snapshot;
			if (!data) {
				return false;
			}
			const normalizedSweepAt = normalizeTimestampToDate(data.lastSweepAt);
			const normalizedRunAt = normalizeTimestampToDate(data.lastRunAt);
			const snapshotSweepAtMs = normalizedSweepAt ? normalizedSweepAt.getTime() : 0;
			const normalizedPendingCountObservedAt = normalizeTimestampToDate(data.pendingCountObservedAt);
			const pendingCountObservedAtMs = normalizedPendingCountObservedAt
				? normalizedPendingCountObservedAt.getTime()
				: snapshotSweepAtMs;
			const currentCachedSweepAtMs = this.persistedLastSweepAt ? (normalizeTimestampToDate(this.persistedLastSweepAt)?.getTime() || 0) : 0;
			if (currentCachedSweepAtMs > 0 && Number.isFinite(snapshotSweepAtMs) && snapshotSweepAtMs < currentCachedSweepAtMs) {
				return false;
			}
			if (normalizedRunAt) {
				this.persistedLastRunAt = normalizedRunAt;
			}
			if (normalizedSweepAt) {
				this.persistedLastSweepAt = normalizedSweepAt;
			}
			if (data.lastSweepResult && typeof data.lastSweepResult === 'object') {
				this.persistedLastSweepResult = {
					processed: Number(data.lastSweepResult.processed) || 0,
					succeeded: Number(data.lastSweepResult.succeeded) || 0,
					exhausted: Number(data.lastSweepResult.exhausted) || 0,
					errors: Number(data.lastSweepResult.errors) || 0,
				};
			}
			if (typeof data.lastRunDurationMs === 'number') {
				this.persistedLastRunDurationMs = data.lastRunDurationMs;
			}
			if (typeof data.lastRunScannedCount === 'number') {
				this.persistedLastRunScannedCount = data.lastRunScannedCount;
			}
			if (typeof data.lastRunRedrivenCount === 'number') {
				this.persistedLastRunRedrivenCount = data.lastRunRedrivenCount;
			}
			if (typeof data.lastRunErrorCount === 'number') {
				this.persistedLastRunErrorCount = data.lastRunErrorCount;
			}
			if (typeof data.lastRunExhaustedCount === 'number') {
				this.persistedLastRunExhaustedCount = data.lastRunExhaustedCount;
			}
			if (typeof data.pendingCount === 'number') {
				const localDeltaAfterSnapshot = this._getPendingCountLocalDeltaAfter(pendingCountObservedAtMs);
				this.persistedPendingCount = Math.max(0, Math.floor(data.pendingCount + (
					localDeltaAfterSnapshot
				)));
				this._retainPendingCountLocalMutationsAfter(pendingCountObservedAtMs);
			}
			if (typeof data.deliveredCount === 'number') {
				this.persistedDeliveredCount = data.deliveredCount;
			}
			if (typeof data.exhaustedCount === 'number') {
				this.persistedExhaustedCount = data.exhaustedCount;
			}
			if (typeof data.zeroChannelBroadcasts === 'number') {
				this.persistedZeroChannelBroadcasts = data.zeroChannelBroadcasts;
			}
			return true;
		} catch (error) {
			console.warn('[NotificationRedriveService] Failed to sync worker telemetry:', error.message);
			return false;
		}
	}

	_startTelemetrySync(intervalMs) {
		if (this.telemetrySyncTimer) {
			return;
		}
		void this.syncWorkerTelemetry();
		this.telemetrySyncTimer = setInterval(() => {
			trackBackgroundTask(this.syncWorkerTelemetry()).catch(() => {});
		}, intervalMs);
		if (typeof this.telemetrySyncTimer.unref === 'function') {
			this.telemetrySyncTimer.unref();
		}
	}

	startWorker(options = {}) {
		if (!this.isEnabled()) {
			return false;
		}

		const configuredRole = this.getWorkerRole();
		const source = options.source || 'web';

		if (configuredRole === 'disabled') {
			return false;
		}

		const runtimeConfig = getRuntimeConfig();
		const intervalMs = parsePositiveInteger(
			options.intervalMs ?? runtimeConfig.NOTIFICATION_REDRIVE_INTERVAL_MS ?? process.env.NOTIFICATION_REDRIVE_INTERVAL_MS,
			DEFAULT_REDRIVE_INTERVAL_MS,
		);

		if (configuredRole === 'worker' && source !== 'worker') {
			this._startTelemetrySync(intervalMs);
			return false;
		}
		if (configuredRole === 'web' && source !== 'web') {
			return false;
		}

		if (this.workerTimer) {
			return true;
		}

		this._isDraining = false;
		this.running = true;
		if (configuredRole === 'worker') {
			this._initialSeedPromise = this.seedCountersFromHeartbeat();
		}
		this.workerTimer = setInterval(() => {
			trackBackgroundTask(this.sweep()).catch((err) => {
				console.warn('[NotificationRedriveService] Worker sweep error:', err.message);
			});
		}, intervalMs);

		if (options.unref !== false && typeof this.workerTimer.unref === 'function') {
			this.workerTimer.unref();
		}

		console.info(`[NotificationRedriveService] Worker started in ${configuredRole} role (interval: ${intervalMs}ms)`);
		return true;
	}

	async stopWorker(options = {}) {
		if (this.workerTimer) {
			clearInterval(this.workerTimer);
			this.workerTimer = null;
		}
		if (this.telemetrySyncTimer) {
			clearInterval(this.telemetrySyncTimer);
			this.telemetrySyncTimer = null;
		}
		this.running = false;

		if (options.drain) {
			this._isDraining = true;
			const timeoutMs = parsePositiveInteger(options.timeoutMs, MAX_DRAIN_TIMEOUT_MS);
			const drainDeadline = Date.now() + timeoutMs;
			if (this.activeSweepPromise) {
				let timer = null;
				try {
					await Promise.race([
						this.activeSweepPromise,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error('Drain timeout exceeded')), Math.max(0, drainDeadline - Date.now()));
						}),
					]);
				} catch (error) {
					console.warn('[NotificationRedriveService] Worker drain timeout/error:', error.message);
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
				}
			}

			const activeWrite = this._activeTelemetryWritePromise || this._activeTelemetryWriteOperation;
			if (activeWrite) {
				let timer = null;
				try {
					await Promise.race([
						activeWrite,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error('Telemetry drain timeout exceeded')), Math.max(0, drainDeadline - Date.now()));
						}),
					]);
				} catch (error) {
					console.warn('[NotificationRedriveService] Worker telemetry drain timeout/error:', error.message);
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
				}
			}

			if (this._activeTelemetryReadPromise) {
				let timer = null;
				try {
					await Promise.race([
						this._activeTelemetryReadPromise,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error('Telemetry read drain timeout exceeded')), Math.max(0, drainDeadline - Date.now()));
						}),
					]);
				} catch (error) {
					console.warn('[NotificationRedriveService] Worker telemetry read drain timeout/error:', error.message);
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
				}
			}

			if (this._activePendingCountPromise) {
				let timer = null;
				try {
					await Promise.race([
						this._activePendingCountPromise,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error('Pending count drain timeout exceeded')), Math.max(0, drainDeadline - Date.now()));
						}),
					]);
				} catch (error) {
					console.warn('[NotificationRedriveService] Worker pending count drain timeout/error:', error.message);
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
				}
			}

			if (this._zeroChannelRetryTimer) {
				clearTimeout(this._zeroChannelRetryTimer);
				this._zeroChannelRetryTimer = null;
			}

			let zeroChannelFlushStarted = false;
			while (Date.now() < drainDeadline) {
				if (!this._activeZeroChannelWritePromise && this._pendingZeroChannelWriteDelta > 0) {
					if (zeroChannelFlushStarted) {
						break;
					}
					zeroChannelFlushStarted = true;
					this._flushZeroChannelWrites();
				}

				const activeZeroChannelWrite = this._activeZeroChannelWritePromise;
				if (!activeZeroChannelWrite) {
					break;
				}

				let timer = null;
				try {
					await Promise.race([
						activeZeroChannelWrite,
						new Promise((_, reject) => {
							timer = setTimeout(() => reject(new Error('Zero-channel write drain timeout exceeded')), Math.max(0, drainDeadline - Date.now()));
						}),
					]);
				} catch (error) {
					console.warn('[NotificationRedriveService] Worker zero-channel write drain timeout/error:', error.message);
				} finally {
					if (timer) {
						clearTimeout(timer);
					}
				}
			}

			if (this._zeroChannelRetryTimer) {
				clearTimeout(this._zeroChannelRetryTimer);
				this._zeroChannelRetryTimer = null;
			}
		}
	}

	getPendingCount() {
		let count = 0;
		const nowMs = Date.now();

		for (const data of this.inMemoryStore.values()) {
			if (isPendingRedriveStatus(data.status)) {
				const expiresAtMs = toMillis(data.expiresAt);
				if (!expiresAtMs || expiresAtMs > nowMs) {
					count += 1;
				}
			}
		}
		return count;
	}

	_getPendingCountLocalDeltaAfter(observedAtMs) {
		if (this._pendingCountLocalMutations.length > 0) {
			return this._pendingCountLocalMutations.reduce((delta, mutation) => (
				mutation.at > observedAtMs ? delta + mutation.delta : delta
			), 0);
		}
		return this._pendingCountLocalMutationAt > observedAtMs ? this._pendingCountLocalDelta : 0;
	}

	_retainPendingCountLocalMutationsAfter(observedAtMs) {
		if (this._pendingCountLocalMutations.length > 0) {
			this._pendingCountLocalMutations = this._pendingCountLocalMutations.filter(
				(mutation) => mutation.at > observedAtMs,
			);
			this._pendingCountLocalDelta = this._pendingCountLocalMutations.reduce(
				(delta, mutation) => delta + mutation.delta,
				0,
			);
			this._pendingCountLocalMutationAt = this._pendingCountLocalMutations.at(-1)?.at || 0;
			return;
		}
		if (this._pendingCountLocalMutationAt <= observedAtMs) {
			this._pendingCountLocalDelta = 0;
			this._pendingCountLocalMutationAt = 0;
		}
	}

	_adjustPendingCount(previousStatus, nextStatus) {
		const wasPending = isPendingRedriveStatus(previousStatus);
		const isPending = isPendingRedriveStatus(nextStatus);
		if (wasPending === isPending) return;

		const delta = isPending ? 1 : -1;
		const mutationAt = Date.now();
		this._pendingCountLocalDelta += delta;
		this._pendingCountLocalMutationAt = this._pendingCountLocalDelta === 0 ? 0 : mutationAt;
		this._pendingCountLocalMutations.push({
			sequence: ++this._pendingCountLocalMutationSequence,
			delta,
			at: mutationAt,
		});
		if (Number.isFinite(this.persistedPendingCount)) {
			this.persistedPendingCount = Math.max(0, this.persistedPendingCount + delta);
		}
	}

	getStatus({ skipTelemetrySync = false } = {}) {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		const runtimeConfig = getRuntimeConfig();

		if (!skipTelemetrySync && role !== 'disabled' && this.getFirestore()) {
			void this.syncWorkerTelemetry();
		}

		const localSweepAt = normalizeTimestampToDate(this.lastSweepAt);
		const persistedSweepAt = normalizeTimestampToDate(this.persistedLastSweepAt);
		const usePersistedSnapshot = Boolean(
			persistedSweepAt && (!localSweepAt || persistedSweepAt.getTime() >= localSweepAt.getTime()),
		);
		const selectSnapshotValue = (localValue, persistedValue) => usePersistedSnapshot
			? (persistedValue ?? localValue)
			: (localValue ?? persistedValue);
		const effectiveLastRunAt = selectSnapshotValue(this.lastRunAt, this.persistedLastRunAt);
		const effectiveLastSweepAt = selectSnapshotValue(this.lastSweepAt, this.persistedLastSweepAt);
		const effectiveLastSweepResult = selectSnapshotValue(this.lastSweepResult, this.persistedLastSweepResult);
		const effectiveLastRunDurationMs = selectSnapshotValue(this.lastRunDurationMs, this.persistedLastRunDurationMs);
		const effectiveLastRunScannedCount = selectSnapshotValue(this.lastRunScannedCount, this.persistedLastRunScannedCount) ?? 0;
		const effectiveLastRunRedrivenCount = selectSnapshotValue(this.lastRunRedrivenCount, this.persistedLastRunRedrivenCount) ?? 0;
		const effectiveLastRunErrorCount = selectSnapshotValue(this.lastRunErrorCount, this.persistedLastRunErrorCount) ?? 0;
		const effectiveLastRunExhaustedCount = selectSnapshotValue(this.lastRunExhaustedCount, this.persistedLastRunExhaustedCount) ?? 0;
		const effectivePendingCount = Number.isFinite(this.persistedPendingCount)
			? this.persistedPendingCount
			: this.getPendingCount();
		const effectiveDeliveredCount = Math.max(this.totalDeliveredCount, this.persistedDeliveredCount || 0);
		const effectiveExhaustedCount = Math.max(this.totalExhaustedCount, this.persistedExhaustedCount || 0);
		const effectiveZeroChannelBroadcasts = Math.max(this.totalZeroChannelBroadcasts, this.persistedZeroChannelBroadcasts || 0);

		const formatSafeIso = (dateVal) => {
			const normalized = normalizeTimestampToDate(dateVal);
			return normalized ? normalized.toISOString() : null;
		};

		const lastRunAtIso = formatSafeIso(effectiveLastRunAt);
		const lastSweepAtIso = formatSafeIso(effectiveLastSweepAt);

		return {
			enabled,
			configured: true,
			ready: enabled && role !== 'disabled',
			status: !enabled ? 'disabled' : (role === 'disabled' ? 'disabled' : 'ready'),
			role,
			workerRole: role,
			running: Boolean(this.running),
			intervalMs: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_INTERVAL_MS ?? process.env.NOTIFICATION_REDRIVE_INTERVAL_MS, DEFAULT_REDRIVE_INTERVAL_MS),
			batchLimit: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_BATCH_LIMIT ?? process.env.NOTIFICATION_REDRIVE_BATCH_LIMIT, DEFAULT_BATCH_LIMIT),
			maxAttempts: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_MAX_ATTEMPTS ?? process.env.NOTIFICATION_REDRIVE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
			maxAgeMs: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_MAX_AGE_MS ?? process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
			pendingCount: effectivePendingCount,
			deliveredCount: effectiveDeliveredCount,
			exhaustedCount: effectiveExhaustedCount,
			zeroChannelBroadcasts: effectiveZeroChannelBroadcasts,
			lastRunAt: lastRunAtIso,
			lastSweepAt: lastSweepAtIso,
			lastRunDurationMs: effectiveLastRunDurationMs,
			lastRunScannedCount: effectiveLastRunScannedCount,
			lastRunRedrivenCount: effectiveLastRunRedrivenCount,
			lastRunErrorCount: effectiveLastRunErrorCount,
			lastRunExhaustedCount: effectiveLastRunExhaustedCount,
			lastSweepResult: effectiveLastSweepResult
				? { ...effectiveLastSweepResult }
				: null,
		};
	}

	resetForTesting() {
		if (this.workerTimer) {
			clearInterval(this.workerTimer);
			this.workerTimer = null;
		}
		if (this.telemetrySyncTimer) {
			clearInterval(this.telemetrySyncTimer);
			this.telemetrySyncTimer = null;
		}
		this.inMemoryStore.clear();
		this.supersessionStore.clear();
		this.reconciliationPromises.clear();
		this.activeSweepPromise = null;
		this._telemetryWriteSequence = 0;
		this._activeTelemetryWritePromise = null;
		this._activeTelemetryWriteOperation = null;
		this._activeTelemetryReadPromise = null;
		this._activePendingCountPromise = null;
		this._activeZeroChannelWritePromise = null;
		this._activeZeroChannelWriteResultPromise = null;
		this._pendingZeroChannelWriteDelta = 0;
		this._isDraining = false;
		if (this._zeroChannelRetryTimer) {
			clearTimeout(this._zeroChannelRetryTimer);
		}
		this._zeroChannelRetryTimer = null;
		this._zeroChannelRetryAttempts = 0;
		this._initialSeedPromise = null;
		this._sessionDeliveredDelta = 0;
		this._sessionExhaustedDelta = 0;
		this.running = false;
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunRedrivenCount = 0;
		this.lastRunErrorCount = 0;
		this.lastRunExhaustedCount = 0;
		this.lastSweepAt = null;
		this.lastSweepResult = null;
		this.persistedLastRunAt = null;
		this.persistedLastSweepAt = null;
		this.persistedLastSweepResult = null;
		this.persistedLastRunDurationMs = null;
		this.persistedLastRunScannedCount = 0;
		this.persistedLastRunRedrivenCount = 0;
		this.persistedLastRunErrorCount = 0;
		this.persistedLastRunExhaustedCount = 0;
		this.persistedPendingCount = null;
		this._pendingCountLocalDelta = 0;
		this._pendingCountLocalMutationAt = 0;
		this._pendingCountLocalMutations = [];
		this._pendingCountLocalMutationSequence = 0;
		this._pendingCountObservedAt = null;
		this.persistedDeliveredCount = 0;
		this.persistedExhaustedCount = 0;
		this.persistedZeroChannelBroadcasts = 0;
		this.totalDeliveredCount = 0;
		this.totalExhaustedCount = 0;
		this.totalZeroChannelBroadcasts = 0;
	}

	_resetForTesting() {
		this.resetForTesting();
	}
}

const notificationRedriveService = new NotificationRedriveService();

module.exports = {
	NotificationRedriveService,
	notificationRedriveService,
	stripUndefinedFieldsDeep,
	calculateBackoffMs,
};
