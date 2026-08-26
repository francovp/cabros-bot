'use strict';

const admin = require('firebase-admin');
const crypto = require('crypto');
const AlertStorageService = require('../storage/AlertStorageService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');
const { signalRepeatCooldown } = require('../alerts/signalRepeatCooldown');

const COLLECTION_NAME = 'notificationDeadLetters';
const DEFAULT_REDRIVE_INTERVAL_MS = 60000;
const DEFAULT_BATCH_LIMIT = 50;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_MAX_AGE_MS = 3600000; // 1 hour
const BASE_BACKOFF_MS = 30000; // 30s
const MAX_BACKOFF_MS = 600000; // 10 minutes
const DEFAULT_LEASE_MS = 60000; // 60s
const MAX_DRAIN_TIMEOUT_MS = 10000;
const WORKER_ROLES = new Set(['web', 'worker', 'disabled']);

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
		const child = stripUndefinedFieldsDeep(v);
		if (child !== undefined) {
			cleaned[k] = child;
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
	const exponential = BASE_BACKOFF_MS * Math.pow(2, count);
	const capped = Math.min(exponential, MAX_BACKOFF_MS);
	const jitter = Math.floor(Math.random() * 2000);
	return capped + jitter;
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
	return new Date(timestampOrDate).getTime() || 0;
}

function releaseRepeatCooldown(record) {
	const repeatCooldown = record && record.repeatCooldown;
	if (!repeatCooldown || !repeatCooldown.key || !repeatCooldown.channel) {
		return;
	}
	signalRepeatCooldown.release(repeatCooldown.key, [repeatCooldown.channel]);
}

class NotificationRedriveService {
	constructor(options = {}) {
		this.inMemoryStore = new Map();
		this.workerTimer = null;
		this.activeSweepPromise = null;
		this.running = false;
		this.notificationManagerGetter = options.notificationManagerGetter || null;
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunRedrivenCount = 0;
		this.lastRunErrorCount = 0;
		this.totalDeliveredCount = 0;
		this.totalExhaustedCount = 0;
		this.totalZeroChannelBroadcasts = 0;
	}

	incrementZeroChannelBroadcasts() {
		this.totalZeroChannelBroadcasts += 1;
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
		if (!this.isEnabled() || !Array.isArray(deliveryResults)) {
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
					telegramChatId: alert?.telegramChatId || null,
					whatsappChatId: alert?.whatsappChatId || null,
					discordWebhookUrl: alert?.discordWebhookUrl || null,
					enriched: Boolean(alert?.enriched),
					enrichmentData: alert?.enriched && typeof alert.enriched === 'object' ? alert.enriched : null,
					requestId: String(alertId),
				},
				destinationOverride: options.routing || null,
				attemptCount: 0,
				lastError: failure.error ? String(failure.error) : 'Unknown delivery failure',
				lastStatusCode: typeof failure.statusCode === 'number' ? failure.statusCode : null,
				repeatCooldown: options.repeatCooldown && options.repeatCooldown.key
					? {
						key: String(options.repeatCooldown.key),
						channel: options.repeatCooldown.channelsByName?.[channel] || null,
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

			// Persist in-memory store
			this.inMemoryStore.set(recordId, { ...sanitizedRecord });

			// Try persisting to Firestore if available
			const firestore = this.getFirestore();
			if (firestore) {
				try {
					await firestore.collection(COLLECTION_NAME).doc(recordId).set(sanitizedRecord, { merge: true });
					console.debug(`[NotificationRedriveService] Recorded dead-letter ${recordId} in Firestore`);
				} catch (error) {
					console.warn(`[NotificationRedriveService] Failed to persist dead-letter ${recordId} in Firestore, kept in-memory:`, error.message);
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

	async markTerminal(recordId, status, metadata = {}) {
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
		if (memCurrent) {
			this.inMemoryStore.set(recordId, { ...memCurrent, ...sanitized });
		}

		const firestore = this.getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(recordId).set(sanitized, { merge: true });
			} catch (error) {
				console.warn(`[NotificationRedriveService] Failed to mark dead-letter ${recordId} terminal (${status}):`, error.message);
			}
		}
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
		if (memCurrent) {
			this.inMemoryStore.set(recordId, { ...memCurrent, ...sanitized });
		}

		const firestore = this.getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(recordId).set(sanitized, { merge: true });
			} catch (error) {
				console.warn(`[NotificationRedriveService] Failed to update retry for ${recordId}:`, error.message);
			}
		}
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

		this.activeSweepPromise = this._executeSweep(options).finally(() => {
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
					await this.markTerminal(candidate.id, terminalStatus, {
						terminalAt: toTimestamp(new Date()),
					});
					this.totalExhaustedCount += 1;
					trackBackgroundTask(this.notifyAdminPermanentFailure(candidate, `Terminal status: ${terminalStatus}`)).catch(() => {});
					continue;
				}

				// Claim record with lease
				const claimed = await this.claimRecord(candidate, leaseMs);
				if (!claimed) {
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
					const alertPayload = {
						...(claimed.alert || {}),
						...(claimed.destinationOverride || {}),
					};

					const results = await notificationManager.sendToChannels(
						alertPayload,
						[claimed.channel],
						{
							...options,
							isRedrive: true,
							parentSpan: options.parentSpan,
						},
					);

					const channelResult = Array.isArray(results) && results[0] ? results[0] : null;

					if (channelResult && channelResult.success) {
						// Delivery succeeded
						await this.markTerminal(claimed.id, 'delivered', {
							deliveredAt: toTimestamp(new Date()),
						});
						this.totalDeliveredCount += 1;
						redrivenCount += 1;
						console.info(`[NotificationRedriveService] Successfully redelivered dead-letter ${claimed.id}`);
					} else {
						// Delivery failed again
						const nextAttempts = (claimed.attemptCount || 0) + 1;
						const lastErr = channelResult?.error || 'Redrive attempt failed';
						const lastCode = channelResult?.statusCode || null;

						if (nextAttempts >= maxAttempts) {
							releaseRepeatCooldown(claimed);
							await this.markTerminal(claimed.id, 'exhausted', {
								lastError: String(lastErr),
								lastStatusCode: lastCode,
								attemptCount: nextAttempts,
							});
							this.totalExhaustedCount += 1;
							trackBackgroundTask(this.notifyAdminPermanentFailure({
								...claimed,
								attemptCount: nextAttempts,
								lastError: lastErr,
							}, 'Exhausted maximum retry attempts')).catch(() => {});
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
						await this.markTerminal(claimed.id, 'exhausted', {
							lastError: error.message,
							attemptCount: nextAttempts,
						});
						this.totalExhaustedCount += 1;
						trackBackgroundTask(this.notifyAdminPermanentFailure({
							...claimed,
							attemptCount: nextAttempts,
							lastError: error.message,
						}, 'Exhausted maximum retry attempts')).catch(() => {});
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
			this.lastRunDurationMs = Math.max(0, Date.now() - startTime);
			this.lastRunScannedCount = scannedCount;
			this.lastRunRedrivenCount = redrivenCount;
			this.lastRunErrorCount = errorCount;
		}

		return {
			scanned: scannedCount,
			redriven: redrivenCount,
			errors: errorCount,
		};
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
		if (configuredRole === 'worker' && source !== 'worker') {
			return false;
		}
		if (configuredRole === 'web' && source !== 'web') {
			return false;
		}

		if (this.workerTimer) {
			return true;
		}

		const runtimeConfig = getRuntimeConfig();
		const intervalMs = parsePositiveInteger(
			options.intervalMs ?? runtimeConfig.NOTIFICATION_REDRIVE_INTERVAL_MS ?? process.env.NOTIFICATION_REDRIVE_INTERVAL_MS,
			DEFAULT_REDRIVE_INTERVAL_MS,
		);

		this.running = true;
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
		this.running = false;

		if (options.drain && this.activeSweepPromise) {
			const timeoutMs = parsePositiveInteger(options.timeoutMs, MAX_DRAIN_TIMEOUT_MS);
			let timer = null;
			try {
				await Promise.race([
					this.activeSweepPromise,
					new Promise((_, reject) => {
						timer = setTimeout(() => reject(new Error('Drain timeout exceeded')), timeoutMs);
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
	}

	getPendingCount() {
		let count = 0;
		const nowMs = Date.now();

		for (const data of this.inMemoryStore.values()) {
			if (data.status === 'pending' || data.status === 'in_flight') {
				const expiresAtMs = toMillis(data.expiresAt);
				if (!expiresAtMs || expiresAtMs > nowMs) {
					count += 1;
				}
			}
		}
		return count;
	}

	getStatus() {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		const runtimeConfig = getRuntimeConfig();

		return {
			enabled,
			configured: true,
			ready: enabled && role !== 'disabled',
			status: !enabled ? 'disabled' : (role === 'disabled' ? 'disabled' : 'ready'),
			role,
			running: Boolean(this.running),
			intervalMs: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_INTERVAL_MS ?? process.env.NOTIFICATION_REDRIVE_INTERVAL_MS, DEFAULT_REDRIVE_INTERVAL_MS),
			batchLimit: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_BATCH_LIMIT ?? process.env.NOTIFICATION_REDRIVE_BATCH_LIMIT, DEFAULT_BATCH_LIMIT),
			maxAttempts: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_MAX_ATTEMPTS ?? process.env.NOTIFICATION_REDRIVE_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS),
			maxAgeMs: parsePositiveInteger(runtimeConfig.NOTIFICATION_REDRIVE_MAX_AGE_MS ?? process.env.NOTIFICATION_REDRIVE_MAX_AGE_MS, DEFAULT_MAX_AGE_MS),
			pendingCount: this.getPendingCount(),
			deliveredCount: this.totalDeliveredCount,
			exhaustedCount: this.totalExhaustedCount,
			zeroChannelBroadcasts: this.totalZeroChannelBroadcasts,
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunRedrivenCount: this.lastRunRedrivenCount,
			lastRunErrorCount: this.lastRunErrorCount,
		};
	}

	resetForTesting() {
		if (this.workerTimer) {
			clearInterval(this.workerTimer);
			this.workerTimer = null;
		}
		this.inMemoryStore.clear();
		this.activeSweepPromise = null;
		this.running = false;
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunRedrivenCount = 0;
		this.lastRunErrorCount = 0;
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
