'use strict';

/* global AbortController */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { getAnalyzer, setNotificationManager } = require('../../controllers/webhooks/handlers/newsMonitor/analyzer');
const { getNotificationManager } = require('../../controllers/webhooks/handlers/alert/alert');
const { isNewsMonitorPaused } = require('../../controllers/webhooks/handlers/newsMonitor/pauseState');
const alertStorageService = require('../storage/AlertStorageService');
const sentryService = require('../monitoring/SentryService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const COLLECTION_NAME = 'newsMonitorSchedulerLocks';

const DEFAULT_SCHEDULER_INTERVAL_MS = 300000; // 5 minutes — bounded sweep cadence
const MIN_SCHEDULER_INTERVAL_MS = 10000; // 10 seconds — never run tighter than this
const MAX_SCHEDULER_INTERVAL_MS = 3600000; // 1 hour — generous upper bound

const DEFAULT_SCHEDULER_BATCH_LIMIT = 50;
const MIN_SCHEDULER_BATCH_LIMIT = 1;
const MAX_SCHEDULER_BATCH_LIMIT = 500;

const DEFAULT_LEASE_MS = 120000; // 2 minutes — covers sweep + a buffer
const MIN_LEASE_MS = 10000;
const MAX_LEASE_MS = 600000;

const DEFAULT_TIMEOUT_MS = 90000; // 90 seconds — same ceiling as scanner preset

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

function parseEnvBool(value, fallback = false) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const normalized = String(value).trim().toLowerCase();
	if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
		return true;
	}
	if (normalized === 'false' || normalized === '0' || normalized === 'no') {
		return false;
	}
	return fallback;
}

function getSymbolsFromEnv(name) {
	return (process.env[name] || '')
		.split(',')
		.map((s) => String(s).trim())
		.filter(Boolean);
}

function validateSymbol(symbol) {
	if (typeof symbol !== 'string') return false;
	if (symbol.length === 0 || symbol.length > 20) return false;
	return /^[A-Z0-9_]+$/i.test(symbol);
}

class NewsMonitorSchedulerService {
	constructor(options = {}) {
		this.getAnalyzerFn = options.getAnalyzer || getAnalyzer;
		this.getNotificationManagerFn = options.getNotificationManager || getNotificationManager;
		this.setNotificationManagerFn = options.setNotificationManager || setNotificationManager;
		this.alertStorage = options.alertStorageService || alertStorageService;
		this.workerId = options.workerId || `${process.pid}-${crypto.randomUUID()}`;
		this.running = false;
		this.timer = null;
		this.activeSweepPromise = null;
		this.activeSweepController = null;
		this.shutdownRequested = false;

		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunSymbolCount = 0;
		this.lastRunExecutedCount = 0;
		this.lastRunErrorCount = 0;
		this.lastError = null;
		this.isPausedFn = options.isPaused || isNewsMonitorPaused;
	}

	isEnabled() {
		return parseEnvBool(process.env.ENABLE_NEWS_MONITOR_SCHEDULER, false);
	}

	isPaused() {
		try {
			return Boolean(this.isPausedFn && this.isPausedFn());
		} catch {
			return false;
		}
	}

	getWorkerRole() {
		const rawRole = String(process.env.NEWS_MONITOR_SCHEDULER_WORKER_ROLE || 'web')
			.trim()
			.toLowerCase();
		if (rawRole === 'worker' || rawRole === 'disabled') {
			return rawRole;
		}
		return 'web';
	}

	getIntervalMs() {
		const runtime = getRuntimeConfig();
		const raw = runtime.NEWS_MONITOR_SCHEDULER_INTERVAL_MS !== undefined
			? runtime.NEWS_MONITOR_SCHEDULER_INTERVAL_MS
			: process.env.NEWS_MONITOR_SCHEDULER_INTERVAL_MS;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS, MAX_SCHEDULER_INTERVAL_MS);
	}

	getBatchLimit() {
		const runtime = getRuntimeConfig();
		const raw = runtime.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT !== undefined
			? runtime.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT
			: process.env.NEWS_MONITOR_SCHEDULER_BATCH_LIMIT;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_BATCH_LIMIT, MIN_SCHEDULER_BATCH_LIMIT, MAX_SCHEDULER_BATCH_LIMIT);
	}

	getLeaseMs() {
		return parseEnvInt(
			process.env.NEWS_MONITOR_SCHEDULER_LEASE_MS,
			DEFAULT_LEASE_MS,
			MIN_LEASE_MS,
			MAX_LEASE_MS,
		);
	}

	getTimeoutMs() {
		return parseEnvInt(
			process.env.NEWS_MONITOR_SCHEDULER_TIMEOUT_MS,
			DEFAULT_TIMEOUT_MS,
			1000,
			600000,
		);
	}

	getStatus() {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		const paused = this.isPaused();
		const ready = enabled && role !== 'disabled' && !paused;

		return {
			enabled,
			configured: true,
			ready,
			status: !enabled ? 'disabled' : (role === 'disabled' ? 'disabled' : (paused ? 'paused' : 'ready')),
			paused,
			role,
			running: this.running,
			intervalMs: this.getIntervalMs(),
			batchLimit: this.getBatchLimit(),
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunSymbolCount: this.lastRunSymbolCount,
			lastRunExecutedCount: this.lastRunExecutedCount,
			lastRunErrorCount: this.lastRunErrorCount,
			lastError: this.lastError,
		};
	}

	startWorker(options = {}) {
		if (!this.isEnabled() || this.getWorkerRole() === 'disabled') {
			return false;
		}

		const source = options.source === 'worker' ? 'worker' : 'web';
		if (this.getWorkerRole() !== source) {
			return false;
		}

		if (this.running) {
			return true;
		}

		this.running = true;
		this.shutdownRequested = false;
		this._scheduleNextSweep(this.getIntervalMs());
		return true;
	}

	async stopWorker(options = {}) {
		const { drain = true, timeoutMs = 10000 } = options;
		this.running = false;
		this.shutdownRequested = true;

		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}

		if (!drain && this.activeSweepController) {
			this.activeSweepController.abort();
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
				if (this.activeSweepController) {
					this.activeSweepController.abort();
				}
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
				console.error('[NewsMonitorScheduler] Sweep failed unexpectedly:', err.message);
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
		const nowMs = sweepStartTime;
		const batchLimit = options.batchLimit || this.getBatchLimit();
		const leaseMs = options.leaseMs || this.getLeaseMs();
		const timeoutMs = options.timeoutMs || this.getTimeoutMs();

		let symbolCount = 0;
		let executedCount = 0;
		let errorCount = 0;
		let lastErrorMessage = null;

		if (!parseEnvBool(process.env.ENABLE_NEWS_MONITOR, false)) {
			// News monitor is disabled — skip sweep entirely.
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunSymbolCount = 0;
			this.lastRunExecutedCount = 0;
			this.lastRunErrorCount = 0;
			this.lastError = null;
			return {
				symbolCount: 0,
				executedCount: 0,
				errorCount: 0,
				durationMs: this.lastRunDurationMs,
				skipped: 'news-monitor-disabled',
			};
		}

		if (this.isPaused()) {
			// News monitor is paused — skip sweep entirely.
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunSymbolCount = 0;
			this.lastRunExecutedCount = 0;
			this.lastRunErrorCount = 0;
			this.lastError = null;
			return {
				symbolCount: 0,
				executedCount: 0,
				errorCount: 0,
				durationMs: this.lastRunDurationMs,
				skipped: 'news-monitor-paused',
			};
		}

		const symbols = this._resolveSymbols(batchLimit);
		symbolCount = symbols.length;

		if (symbols.length === 0) {
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunSymbolCount = 0;
			this.lastRunExecutedCount = 0;
			this.lastRunErrorCount = 0;
			this.lastError = null;
			return {
				symbolCount: 0,
				executedCount: 0,
				errorCount: 0,
				durationMs: this.lastRunDurationMs,
				skipped: 'no-symbols',
			};
		}

		const leaseAcquired = await this._acquireLease(symbols, nowMs, leaseMs, options);
		if (!leaseAcquired) {
			// Another worker owns the lease — skip this sweep.
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunSymbolCount = symbolCount;
			this.lastRunExecutedCount = 0;
			this.lastRunErrorCount = 0;
			this.lastError = null;
			return {
				symbolCount,
				executedCount: 0,
				errorCount: 0,
				durationMs: this.lastRunDurationMs,
				skipped: 'lease-held',
			};
		}

		try {
			const result = await this._executeAnalysis(symbols, timeoutMs, {
				...options,
				renewLease: (nextUntilMs) => this._renewLease(nextUntilMs, leaseMs),
				leaseMs,
			});
			executedCount = result.executedCount;
			errorCount = result.errorCount;
			lastErrorMessage = result.lastError;
		} catch (err) {
			errorCount += 1;
			lastErrorMessage = err.message;
			console.error('[NewsMonitorScheduler] Sweep error:', err.message);
			sentryService.captureRuntimeError({
				channel: 'news-monitor-scheduler',
				error: err,
			});
		} finally {
			const intervalMs = options.intervalMs || this.getIntervalMs();
			await this._releaseLease(Date.now(), intervalMs);
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunSymbolCount = symbolCount;
			this.lastRunExecutedCount = executedCount;
			this.lastRunErrorCount = errorCount;
			this.lastError = lastErrorMessage;
		}

		return {
			symbolCount,
			executedCount,
			errorCount,
			durationMs: this.lastRunDurationMs,
		};
	}

	_resolveSymbols(batchLimit) {
		const cryptoSymbols = getSymbolsFromEnv('NEWS_SYMBOLS_CRYPTO');
		const stockSymbols = getSymbolsFromEnv('NEWS_SYMBOLS_STOCKS');
		const merged = [...cryptoSymbols, ...stockSymbols]
			.map((s) => String(s).trim().toUpperCase())
			.filter((s, idx, arr) => arr.indexOf(s) === idx)
			.filter((s) => validateSymbol(s));

		if (merged.length <= batchLimit) {
			this._cursorIndex = 0;
			return merged;
		}

		// Rotate a sliding window across sweeps so symbols past the batch limit
		// are never starved. The cursor persists in-memory only — multi-replica
		// fairness is provided by the Firestore lease, not by symbol rotation.
		const start = this._cursorIndex || 0;
		const slice = [];
		for (let i = 0; i < batchLimit && i < merged.length; i += 1) {
			slice.push(merged[(start + i) % merged.length]);
		}
		this._cursorIndex = (start + batchLimit) % merged.length;
		return slice;
	}

	_getFirestore() {
		if (this.alertStorage && typeof this.alertStorage.getFirestore === 'function') {
			return this.alertStorage.getFirestore();
		}
		return null;
	}

	async _acquireLease(symbols, nowMs, leaseMs, options = {}) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			// Without Firestore, the scheduler still runs but with at-most-once semantics per process.
			// Multi-replica arbitration is best-effort when Firestore is unavailable.
			return true;
		}

		const bypassCadenceGuard = Boolean(options.force || options.bypassCadenceGuard);

		try {
			const docRef = firestore.collection(COLLECTION_NAME).doc('singleton');
			const acquired = await firestore.runTransaction(async (tx) => {
				const doc = await tx.get(docRef);
				const data = doc.exists ? (doc.data() || {}) : {};
				const lockedUntilMs = data.lockedUntil ? new Date(data.lockedUntil).getTime() : 0;
				const lockedBy = data.lockedBy || null;
				const nextAllowedSweepAtMs = data.nextAllowedSweepAt ? new Date(data.nextAllowedSweepAt).getTime() : 0;

				if (lockedUntilMs > nowMs && lockedBy && lockedBy !== this.workerId) {
					return false;
				}

				if (!bypassCadenceGuard && nextAllowedSweepAtMs > nowMs && lockedBy !== this.workerId) {
					return false;
				}

				tx.set(docRef, {
					lockedUntil: new Date(nowMs + leaseMs).toISOString(),
					lockedBy: this.workerId,
					symbolFingerprint: this._fingerprintSymbols(symbols),
					updatedAt: new Date(nowMs).toISOString(),
				}, { merge: true });
				return true;
			});
			return Boolean(acquired);
		} catch (err) {
			console.warn('[NewsMonitorScheduler] Lease acquire failed:', err.message);
			// Fail-open: still execute the sweep locally.
			return true;
		}
	}

	async _renewLease(nowMs, leaseMs) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			return false;
		}

		try {
			const docRef = firestore.collection(COLLECTION_NAME).doc('singleton');
			return await firestore.runTransaction(async (tx) => {
				const doc = await tx.get(docRef);
				if (!doc.exists) return false;
				const data = doc.data() || {};
				if (data.lockedBy && data.lockedBy !== this.workerId) {
					return false;
				}
				tx.set(docRef, {
					lockedUntil: new Date(nowMs + leaseMs).toISOString(),
					updatedAt: new Date(nowMs).toISOString(),
				}, { merge: true });
				return true;
			});
		} catch (err) {
			console.warn('[NewsMonitorScheduler] Lease renew failed:', err.message);
			return false;
		}
	}

	async _releaseLease(completedAtMs, intervalMs) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			return;
		}

		const interval = intervalMs || this.getIntervalMs();
		const nextAllowedSweepAt = new Date(completedAtMs + interval).toISOString();

		try {
			const docRef = firestore.collection(COLLECTION_NAME).doc('singleton');
			await firestore.runTransaction(async (tx) => {
				const doc = await tx.get(docRef);
				if (!doc.exists) return;
				const data = doc.data() || {};
				if (data.lockedBy && data.lockedBy !== this.workerId) {
					return;
				}
				tx.set(docRef, {
					lockedUntil: null,
					lockedBy: null,
					lastCompletedAt: new Date(completedAtMs).toISOString(),
					nextAllowedSweepAt,
					updatedAt: new Date().toISOString(),
				}, { merge: true });
			});
		} catch (err) {
			console.warn('[NewsMonitorScheduler] Lease release failed:', err.message);
		}
	}

	_fingerprintSymbols(symbols) {
		const sorted = [...symbols].sort();
		return crypto.createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 16);
	}

	async _executeAnalysis(symbols, timeoutMs, options = {}) {
		const analyzer = this.getAnalyzerFn();
		const controller = new AbortController();
		this.activeSweepController = controller;
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const startedAt = Date.now();

		// Periodically renew the lease throughout the sweep execution so the lock
		// covers long sweeps without letting the initial lease window expire.
		const renewLease = typeof options.renewLease === 'function' ? options.renewLease : null;
		const leaseMs = options.leaseMs || this.getLeaseMs();
		const renewIntervalMs = Math.max(1000, Math.floor(leaseMs / 2));
		const renewHandle = renewLease
			? setInterval(() => {
				renewLease(Date.now() + leaseMs).catch((err) => {
					console.warn('[NewsMonitorScheduler] Lease renew tick failed:', err.message);
				});
			}, renewIntervalMs)
			: null;

		let executedCount = 0;
		let errorCount = 0;
		let lastError = null;

		try {
			if (this.shutdownRequested || options.signal?.aborted || controller.signal.aborted) {
				return { executedCount, errorCount, lastError };
			}

			const notificationManager = this.getNotificationManagerFn();
			if (notificationManager) {
				try {
					if (typeof this.setNotificationManagerFn === 'function') {
						this.setNotificationManagerFn(notificationManager);
					} else {
						const setNotificationManager = analyzer.setNotificationManager
							|| analyzer.constructor.setNotificationManager;
						if (typeof setNotificationManager === 'function') {
							setNotificationManager.call(analyzer, notificationManager);
						}
					}
				} catch (err) {
					console.warn('[NewsMonitorScheduler] Could not inject notification manager:', err.message);
				}
			}

			const requestId = uuidv4();
			const tokenUsage = null;

			executedCount = symbols.length;
			const assetClassBySymbol = this._buildAssetClassBySymbol(symbols);
			const results = await analyzer.analyzeSymbols(
				symbols,
				requestId,
				tokenUsage,
				{},
				{
					deadline: startedAt + timeoutMs,
					signal: controller.signal,
					scheduledSweep: true,
					assetClassBySymbol,
				},
			);

			if (Array.isArray(results)) {
				for (const result of results) {
					if (!result) continue;
					if (result.status === 'error' || result.status === 'timeout') {
						errorCount += 1;
						if (result.error && result.error.message) {
							lastError = result.error.message;
						}
					}
				}
			}
		} catch (err) {
			errorCount += 1;
			lastError = err.message;
			sentryService.captureRuntimeError({
				channel: 'news-monitor-scheduler',
				error: err,
				metadata: { symbols: symbols.length },
			});
		} finally {
			clearTimeout(timer);
			if (renewHandle) clearInterval(renewHandle);
			this.activeSweepController = null;
		}

		return { executedCount, errorCount, lastError };
	}

	_buildAssetClassBySymbol(symbols) {
		const cryptoSymbols = new Set(
			getSymbolsFromEnv('NEWS_SYMBOLS_CRYPTO')
				.map((s) => String(s).trim().toUpperCase())
				.filter(Boolean),
		);
		const stockSymbols = new Set(
			getSymbolsFromEnv('NEWS_SYMBOLS_STOCKS')
				.map((s) => String(s).trim().toUpperCase())
				.filter(Boolean),
		);

		const mapping = {};
		for (const symbol of symbols) {
			const upper = String(symbol).trim().toUpperCase();
			if (cryptoSymbols.has(upper)) {
				mapping[upper] = 'crypto';
			} else if (stockSymbols.has(upper)) {
				mapping[upper] = 'stock';
			}
		}
		return mapping;
	}
}

const newsMonitorSchedulerService = new NewsMonitorSchedulerService();

module.exports = {
	NewsMonitorSchedulerService,
	newsMonitorSchedulerService,
	COLLECTION_NAME,
};