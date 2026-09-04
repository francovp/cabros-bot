'use strict';

/* global AbortController */

const crypto = require('crypto');
const {
	scannerPresetService,
	COLLECTION_NAME,
	stripUndefinedFieldsDeep,
	_memoryPresets,
	normalizeVersion,
} = require('./ScannerPresetService');
const marketScannerModule = require('../../controllers/webhooks/handlers/marketScanner/marketScanner');
const marketScannerReportModule = require('../tradingview/marketScannerReport');
const alertModule = require('../../controllers/webhooks/handlers/alert/alert');
const requestRoutingModule = require('../notification/requestRouting');
const sentryService = require('../monitoring/SentryService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { applyStartupJitter, resolveStartupJitterMs } = require('../../lib/startupJitter');

const DEFAULT_SCHEDULER_INTERVAL_MS = 60000;
const MIN_SCHEDULER_INTERVAL_MS = 1000;
const MAX_SCHEDULER_INTERVAL_MS = 3600000;

const DEFAULT_SCHEDULER_BATCH_LIMIT = 50;
const MIN_SCHEDULER_BATCH_LIMIT = 1;
const MAX_SCHEDULER_BATCH_LIMIT = 500;

const DEFAULT_LEASE_MS = 120000;
const DEFAULT_SCANNER_TIMEOUT_MS = 90000;

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

function createScannerDeadline(timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	return {
		signal: controller.signal,
		clear: () => clearTimeout(timer),
	};
}

function hasTimedOut(results) {
	return results.some((r) => r.status === 'timeout');
}

class ScannerPresetSchedulerService {
	constructor(options = {}) {
		this.presetService = options.presetService || scannerPresetService;
		this.getNotificationManager = options.getNotificationManager || (() => alertModule.getNotificationManager());
		this.botGetter = options.botGetter || null;
		this.workerId = options.workerId || `${process.pid}-${crypto.randomUUID()}`;
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
		return process.env.ENABLE_SCANNER_PRESET_SCHEDULER === 'true';
	}

	getWorkerRole() {
		const rawRole = (process.env.SCANNER_PRESET_SCHEDULER_WORKER_ROLE || 'web').toLowerCase().trim();
		if (rawRole === 'worker' || rawRole === 'disabled') {
			return rawRole;
		}
		return 'web';
	}

	getIntervalMs() {
		const runtime = getRuntimeConfig();
		const raw = runtime.SCANNER_PRESET_SCHEDULER_INTERVAL_MS !== undefined
			? runtime.SCANNER_PRESET_SCHEDULER_INTERVAL_MS
			: process.env.SCANNER_PRESET_SCHEDULER_INTERVAL_MS;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS, MAX_SCHEDULER_INTERVAL_MS);
	}

	getBatchLimit() {
		const runtime = getRuntimeConfig();
		const raw = runtime.SCANNER_PRESET_SCHEDULER_BATCH_LIMIT !== undefined
			? runtime.SCANNER_PRESET_SCHEDULER_BATCH_LIMIT
			: process.env.SCANNER_PRESET_SCHEDULER_BATCH_LIMIT;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_BATCH_LIMIT, MIN_SCHEDULER_BATCH_LIMIT, MAX_SCHEDULER_BATCH_LIMIT);
	}

	getLeaseMs() {
		return parseEnvInt(process.env.SCANNER_PRESET_SCHEDULER_LEASE_MS, DEFAULT_LEASE_MS, 10000, 600000);
	}

	getStatus() {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		const configured = true;
		const ready = enabled && role !== 'disabled';

		return {
			enabled,
			configured,
			ready,
			status: !enabled ? 'disabled' : (role === 'disabled' ? 'disabled' : 'ready'),
			role,
			running: this.running,
			intervalMs: this.getIntervalMs(),
			batchLimit: this.getBatchLimit(),
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunExecutedCount: this.lastRunExecutedCount,
			lastRunErrorCount: this.lastRunErrorCount,
		};
	}

	startWorker() {
		if (!this.isEnabled() || this.getWorkerRole() === 'disabled') {
			return;
		}

		if (this.running) {
			return;
		}

		this.running = true;
		this.shutdownRequested = false;

		const globalStartupJitter = process.env.WORKER_STARTUP_JITTER_MS !== undefined && process.env.WORKER_STARTUP_JITTER_MS.trim() !== ''
			? Number.parseInt(process.env.WORKER_STARTUP_JITTER_MS, 10)
			: null;
		const startupJitterMs = resolveStartupJitterMs({
			envVar: 'SCANNER_PRESET_SCHEDULER_STARTUP_JITTER_MS',
			runtimeKey: 'SCANNER_PRESET_SCHEDULER_STARTUP_JITTER_MS',
			defaultValue: Number.isFinite(globalStartupJitter) ? globalStartupJitter : 5000,
		});
		if (startupJitterMs > 0) {
			console.info(`[ScannerPresetScheduler] Applying startup jitter (${startupJitterMs}ms max)`);
			applyStartupJitter(startupJitterMs)
				.then(() => {
					if (!this.running || this.shutdownRequested) {
						return;
					}
					this._scheduleNextSweep(this.getIntervalMs());
				})
				.catch((err) => {
					console.warn('[ScannerPresetScheduler] Startup jitter failed:', err.message);
				});
		} else {
			this._scheduleNextSweep(this.getIntervalMs());
		}
	}

	async stopWorker(options = {}) {
		const { drain = true, timeoutMs = 10000 } = options;
		this.running = false;
		this.shutdownRequested = true;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		if (drain && this.activeSweepPromise) {
			let timeoutHandle;
			const timeoutPromise = new Promise((resolve) => {
				timeoutHandle = setTimeout(resolve, timeoutMs);
			});

			try {
				await Promise.race([this.activeSweepPromise, timeoutPromise]);
			} finally {
				clearTimeout(timeoutHandle);
			}
		}
	}

	_scheduleNextSweep(delayMs) {
		if (!this.running || this.shutdownRequested) {
			return;
		}

		if (this.timer) {
			clearTimeout(this.timer);
		}

		this.timer = setTimeout(async () => {
			if (!this.running || this.shutdownRequested) {
				return;
			}
			try {
				await this.sweep();
			} catch (err) {
				console.error('[ScannerPresetScheduler] Sweep failed unexpectedly:', err.message);
			} finally {
				if (this.running && !this.shutdownRequested) {
					this._scheduleNextSweep(this.getIntervalMs());
				}
			}
		}, delayMs);
	}

	async sweep(options = {}) {
		if (this.activeSweepPromise) {
			return this.activeSweepPromise;
		}

		this.activeSweepPromise = this._executeSweep(options).finally(() => {
			this.activeSweepPromise = null;
		});

		return this.activeSweepPromise;
	}

	async _executeSweep(options = {}) {
		const sweepStartTime = Date.now();
		const nowMs = Date.now();
		const batchLimit = options.batchLimit || this.getBatchLimit();
		const leaseMs = options.leaseMs || this.getLeaseMs();

		let scannedCount = 0;
		let executedCount = 0;
		let errorCount = 0;

		try {
			const candidates = await this._fetchDuePresets(nowMs, batchLimit);
			scannedCount = candidates.length;

			for (const candidate of candidates) {
				if (this.shutdownRequested) {
					break;
				}

				const claimed = await this._claimPreset(candidate, nowMs, leaseMs);
				if (!claimed) {
					continue;
				}

				executedCount += 1;
				try {
					const result = await this._executePreset(candidate, options);
					if (result.status === 'error' || result.status === 'timeout') {
						errorCount += 1;
					}
				} catch (err) {
					errorCount += 1;
					console.error(`[ScannerPresetScheduler] Preset execution failed for ${candidate.id}:`, err.message);
				}
			}
		} catch (error) {
			console.error('[ScannerPresetScheduler] Sweep error:', error.message);
			sentryService.captureRuntimeError({
				channel: 'scanner-preset-scheduler',
				error,
			});
		} finally {
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunScannedCount = scannedCount;
			this.lastRunExecutedCount = executedCount;
			this.lastRunErrorCount = errorCount;
		}

		return {
			scannedCount,
			executedCount,
			errorCount,
			durationMs: this.lastRunDurationMs,
		};
	}

	async _fetchDuePresets(nowMs, batchLimit) {
		const firestore = this.presetService._getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore
					.collection(COLLECTION_NAME)
					.where('schedule.enabled', '==', true)
					.get();

				const due = [];
				if (snapshot && Array.isArray(snapshot.docs)) {
					for (const doc of snapshot.docs) {
						const preset = this.presetService._formatFirestoreDoc(doc);
						if (this._isDue(preset, nowMs)) {
							due.push(preset);
							if (due.length >= batchLimit) break;
						}
					}
				}
				return due;
			} catch (err) {
				console.warn('[ScannerPresetScheduler] Firestore fetch due presets failed, falling back:', err.message);
			}
		}

		const allPresets = await this.presetService.listPresets();
		const due = [];
		for (const preset of allPresets) {
			if (preset.schedule && preset.schedule.enabled && this._isDue(preset, nowMs)) {
				due.push(preset);
				if (due.length >= batchLimit) break;
			}
		}
		return due;
	}

	_isDue(preset, nowMs) {
		if (!preset.schedule || !preset.schedule.enabled) {
			return false;
		}

		if (preset.lockedUntil) {
			const lockedUntilMs = new Date(preset.lockedUntil).getTime();
			if (Number.isFinite(lockedUntilMs) && lockedUntilMs > nowMs) {
				return false;
			}
		}

		if (!preset.nextRunAt) {
			return true;
		}

		const nextRunAtMs = new Date(preset.nextRunAt).getTime();
		return !Number.isFinite(nextRunAtMs) || nextRunAtMs <= nowMs;
	}

	async _claimPreset(preset, nowMs, leaseMs) {
		const firestore = this.presetService._getFirestore();
		if (firestore && typeof firestore.runTransaction === 'function') {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(preset.id);
				const claimed = await firestore.runTransaction(async (tx) => {
					const doc = await tx.get(docRef);
					if (!doc.exists) return false;
					const data = doc.data() || {};
					if (!data.schedule || !data.schedule.enabled) return false;

					const nextRunAtMs = data.nextRunAt ? new Date(data.nextRunAt).getTime() : 0;
					if (nextRunAtMs > nowMs) return false;

					const lockedUntilMs = data.lockedUntil ? new Date(data.lockedUntil).getTime() : 0;
					if (lockedUntilMs > nowMs) return false;

					const lockedUntilDate = new Date(nowMs + leaseMs).toISOString();
					const currentVersion = normalizeVersion(data.version, 1);
					tx.update(docRef, {
						lockedUntil: lockedUntilDate,
						lockedBy: this.workerId,
						updatedAt: new Date(nowMs).toISOString(),
						version: currentVersion + 1,
					});
					return true;
				});

				return Boolean(claimed);
			} catch (err) {
				console.warn(`[ScannerPresetScheduler] Claim transaction failed for ${preset.id}:`, err.message);
				return false;
			}
		}

		if (firestore && typeof firestore.runTransaction !== 'function') {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(preset.id);
				const doc = await docRef.get();
				if (!doc || !doc.exists) return false;
				const data = doc.data() || {};
				if (!data.schedule || !data.schedule.enabled) return false;

				const nextRunAtMs = data.nextRunAt ? new Date(data.nextRunAt).getTime() : 0;
				if (nextRunAtMs > nowMs) return false;

				const lockedUntilMs = data.lockedUntil ? new Date(data.lockedUntil).getTime() : 0;
				if (lockedUntilMs > nowMs) return false;

				const lockedUntilDate = new Date(nowMs + leaseMs).toISOString();
				const currentVersion = normalizeVersion(data.version, 1);
				await docRef.update({
					lockedUntil: lockedUntilDate,
					lockedBy: this.workerId,
					updatedAt: new Date(nowMs).toISOString(),
					version: currentVersion + 1,
				});
				return true;
			} catch (err) {
				console.warn(`[ScannerPresetScheduler] Claim update failed for ${preset.id}:`, err.message);
				return false;
			}
		}

		// In-memory fallback
		const mem = _memoryPresets.get(preset.id);
		if (!mem || !mem.schedule || !mem.schedule.enabled) return false;

		const nextRunAtMs = mem.nextRunAt ? new Date(mem.nextRunAt).getTime() : 0;
		if (nextRunAtMs > nowMs) return false;

		const lockedUntilMs = mem.lockedUntil ? new Date(mem.lockedUntil).getTime() : 0;
		if (lockedUntilMs > nowMs) return false;

		mem.lockedUntil = new Date(nowMs + leaseMs).toISOString();
		mem.lockedBy = this.workerId;
		mem.version = normalizeVersion(mem.version, 1) + 1;
		mem.updatedAt = new Date(nowMs).toISOString();
		return true;
	}

	async _executePreset(preset, options = {}) {
		const startTime = Date.now();
		let status = 'success';
		let error = null;
		let scanResults = [];

		try {
			if (this.shutdownRequested || options.signal?.aborted) {
				return { status: 'aborted', durationMs: 0 };
			}

			const timeoutMs = DEFAULT_SCANNER_TIMEOUT_MS;
			const deadline = createScannerDeadline(timeoutMs);

			try {
				scanResults = await (options.runScans || marketScannerModule.runScans)(preset, { signal: deadline.signal });
			} finally {
				deadline.clear();
			}

			const timedOut = hasTimedOut(scanResults);
			const successfulScans = scanResults.filter((r) => r.status === 'success');

			if (successfulScans.length === 0) {
				status = timedOut ? 'timeout' : 'error';
				error = timedOut
					? `Preset timed out after ${timeoutMs}ms`
					: 'All requested scans failed';
			} else {
				const alertText = marketScannerReportModule.buildMarketScannerReport(scanResults, {
					exchange: preset.exchange,
					timeframe: preset.timeframe,
					now: new Date(),
				});

				let notificationManager = this.getNotificationManager();
				if (!notificationManager && this.botGetter) {
					notificationManager = await alertModule.initializeNotificationServices(resolveBot(this.botGetter));
				}

				if (notificationManager) {
					const routing = {
						channels: preset.channels,
						telegramChatId: preset.telegramChatId,
						telegramThreadId: preset.telegramThreadId,
						whatsappChatId: preset.whatsappChatId,
						discordWebhookUrl: preset.discordWebhookUrl,
					};
					await requestRoutingModule.sendWithNotificationRouting(notificationManager, { text: alertText, source: 'scanner-preset' }, routing, {
						parentSpan: sentryService.getActiveSpan(),
					});
				}
			}
		} catch (err) {
			status = 'error';
			error = err.message;
			console.error(`[ScannerPresetScheduler] Execution failed for preset ${preset.id} (${preset.name}):`, err.message);
			sentryService.captureRuntimeError({
				channel: 'scanner-preset-scheduler',
				error: err,
				metadata: { presetId: preset.id, presetName: preset.name },
			});
		} finally {
			const durationMs = Date.now() - startTime;
			const now = new Date();
			const cadenceMs = preset.schedule?.cadenceMs || 3600000;
			const nextRunAt = new Date(now.getTime() + cadenceMs).toISOString();

			await this._finalizePresetRun(preset, {
				lastRunAt: now.toISOString(),
				nextRunAt,
				lastStatus: status,
				lastError: error,
				lastDurationMs: durationMs,
			});
		}

		return { status, error, durationMs: Date.now() - startTime, scanResults };
	}

	async _finalizePresetRun(preset, updateData) {
		const firestore = this.presetService._getFirestore();
		if (firestore) {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(preset.id);
				const snapshot = await docRef.get();
				const currentVersion = snapshot && snapshot.exists
					? normalizeVersion(snapshot.data().version, 1)
					: normalizeVersion(preset.version, 1);
				const updateDoc = stripUndefinedFieldsDeep({
					lastRunAt: updateData.lastRunAt,
					nextRunAt: updateData.nextRunAt,
					lastStatus: updateData.lastStatus,
					lastError: updateData.lastError,
					lastDurationMs: updateData.lastDurationMs,
					lockedUntil: null,
					lockedBy: null,
					updatedAt: new Date().toISOString(),
					version: currentVersion + 1,
				});
				await docRef.update(updateDoc);
			} catch (err) {
				console.warn(`[ScannerPresetScheduler] Failed to finalize preset ${preset.id} in Firestore:`, err.message);
			}
		}

		const mem = _memoryPresets.get(preset.id);
		if (mem) {
			Object.assign(mem, {
				lastRunAt: updateData.lastRunAt,
				nextRunAt: updateData.nextRunAt,
				lastStatus: updateData.lastStatus,
				lastError: updateData.lastError,
				lastDurationMs: updateData.lastDurationMs,
				lockedUntil: null,
				lockedBy: null,
				updatedAt: new Date().toISOString(),
				version: normalizeVersion(mem.version, 1) + 1,
			});
		}
	}
}

const scannerPresetSchedulerService = new ScannerPresetSchedulerService();

module.exports = {
	ScannerPresetSchedulerService,
	scannerPresetSchedulerService,
};
