'use strict';

/* global AbortController */

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const marketScannerModule = require('../../controllers/webhooks/handlers/marketScanner/marketScanner');
const marketScannerReportModule = require('../tradingview/marketScannerReport');
const alertModule = require('../../controllers/webhooks/handlers/alert/alert');
const requestRoutingModule = require('../notification/requestRouting');
const sentryService = require('../monitoring/SentryService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { getAnalyzer, setNotificationManager } = require('../../controllers/webhooks/handlers/newsMonitor/analyzer');
const { isNewsMonitorPaused } = require('../../controllers/webhooks/handlers/newsMonitor/pauseState');
const { alertStorageService } = require('../storage/AlertStorageService');

const COLLECTION_NAME = 'alertSchedulerLocks';

const DEFAULT_SCHEDULER_INTERVAL_MS = 60000;
const MIN_SCHEDULER_INTERVAL_MS = 1000;
const MAX_SCHEDULER_INTERVAL_MS = 3600000;

const DEFAULT_SCHEDULER_BATCH_LIMIT = 10;
const MIN_SCHEDULER_BATCH_LIMIT = 1;
const MAX_SCHEDULER_BATCH_LIMIT = 100;

const DEFAULT_LEASE_MS = 120000;
const MIN_LEASE_MS = 10000;
const MAX_LEASE_MS = 600000;

const DEFAULT_TIMEOUT_MS = 90000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 600000;

const DEFAULT_NEWS_CADENCE_MS = 21600000; // 6 hours
const DEFAULT_SCANNER_CADENCE_MS = 14400000; // 4 hours
const MIN_CADENCE_MS = 60000; // 1 minute
const MAX_CADENCE_MS = 604800000; // 7 days

const VALID_NEWS_CHANNELS = new Set(['telegram', 'whatsapp', 'discord']);
const VALID_SCANNER_SCANS = new Set([
	'top_gainers',
	'top_losers',
	'volume_breakout_scanner',
	'smart_volume_scanner',
	'bollinger_scan',
]);

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

function isPlainObject(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseIntervalToMs(value, fallback) {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return Math.round(value);
	}
	if (typeof value !== 'string' || value.trim() === '') {
		return fallback;
	}
	const trimmed = value.trim().toLowerCase();
	const match = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)?$/);
	if (!match) {
		return fallback;
	}
	const amount = Number(match[1]);
	const unit = match[2] || 'ms';
	if (!Number.isFinite(amount) || amount <= 0) {
		return fallback;
	}
	switch (unit) {
	case 'ms':
		return amount;
	case 's':
		return amount * 1000;
	case 'm':
		return amount * 60 * 1000;
	case 'h':
		return amount * 60 * 60 * 1000;
	case 'd':
		return amount * 24 * 60 * 60 * 1000;
	default:
		return fallback;
	}
}

function validateSymbol(symbol) {
	if (typeof symbol !== 'string') return false;
	if (symbol.length === 0 || symbol.length > 20) return false;
	return /^[A-Z0-9_]+$/i.test(symbol);
}

function normalizeRoutingChannels(channels) {
	if (channels === undefined || channels === null) {
		return undefined;
	}
	if (!Array.isArray(channels)) {
		return undefined;
	}
	const normalized = [];
	for (const channel of channels) {
		if (typeof channel !== 'string') continue;
		const trimmed = channel.trim().toLowerCase();
		if (!VALID_NEWS_CHANNELS.has(trimmed)) continue;
		if (!normalized.includes(trimmed)) {
			normalized.push(trimmed);
		}
	}
	return normalized.length > 0 ? normalized : undefined;
}

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}
	return botOrGetter || null;
}

function buildScheduleId(schedule, index) {
	const label = typeof schedule.name === 'string' && schedule.name.trim().length > 0
		? schedule.name.trim()
		: `schedule-${index}`;
	return `${schedule.type || 'unknown'}-${index}-${label}`;
}

function parseNewsSchedule(entry, index) {
	if (!isPlainObject(entry)) {
		return null;
	}
	const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
	if (type !== 'news-monitor') {
		return null;
	}

	const symbols = isPlainObject(entry.symbols)
		? {
			crypto: Array.isArray(entry.symbols.crypto)
				? entry.symbols.crypto.filter((s) => validateSymbol(s))
				: [],
			stocks: Array.isArray(entry.symbols.stocks)
				? entry.symbols.stocks.filter((s) => validateSymbol(s))
				: [],
		}
		: { crypto: [], stocks: [] };

	if (symbols.crypto.length === 0 && symbols.stocks.length === 0) {
		return null;
	}

	const cadenceMs = Math.max(
		MIN_CADENCE_MS,
		Math.min(
			MAX_CADENCE_MS,
			parseIntervalToMs(entry.interval, DEFAULT_NEWS_CADENCE_MS),
		),
	);

	return {
		id: buildScheduleId(entry, index),
		type: 'news-monitor',
		name: typeof entry.name === 'string' ? entry.name.trim() : null,
		symbols,
		cadenceMs,
		channels: normalizeRoutingChannels(entry.channels),
		createdAt: new Date().toISOString(),
	};
}

function parseScannerSchedule(entry, index) {
	if (!isPlainObject(entry)) {
		return null;
	}
	const type = typeof entry.type === 'string' ? entry.type.trim().toLowerCase() : '';
	if (type !== 'scanner') {
		return null;
	}

	const scans = Array.isArray(entry.scans)
		? entry.scans.filter((s) => typeof s === 'string' && VALID_SCANNER_SCANS.has(s))
		: [];
	if (scans.length === 0) {
		return null;
	}

	const exchange = typeof entry.exchange === 'string' && entry.exchange.trim().length > 0
		? entry.exchange.trim()
		: 'BINANCE';

	const timeframe = typeof entry.timeframe === 'string' && entry.timeframe.trim().length > 0
		? entry.timeframe.trim()
		: '4h';

	const cadenceMs = Math.max(
		MIN_CADENCE_MS,
		Math.min(
			MAX_CADENCE_MS,
			parseIntervalToMs(entry.interval, DEFAULT_SCANNER_CADENCE_MS),
		),
	);

	return {
		id: buildScheduleId(entry, index),
		type: 'scanner',
		name: typeof entry.name === 'string' ? entry.name.trim() : null,
		exchange,
		timeframe,
		scans,
		limit: parseEnvInt(entry.limit, 5, 1, 20),
		ranked: parseEnvBool(entry.ranked, false),
		includeMultiTimeframe: parseEnvBool(entry.includeMultiTimeframe || entry.include_multi_timeframe, false),
		cadenceMs,
		channels: normalizeRoutingChannels(entry.channels),
		createdAt: new Date().toISOString(),
	};
}

function parseSchedules(raw) {
	if (typeof raw !== 'string' || raw.trim().length === 0) {
		return [];
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.warn('[AlertScheduler] ALERT_SCHEDULER_SCHEDULES is not valid JSON, ignoring:', err.message);
		return [];
	}

	if (!Array.isArray(parsed)) {
		console.warn('[AlertScheduler] ALERT_SCHEDULER_SCHEDULES must be a JSON array, ignoring');
		return [];
	}

	const schedules = [];
	for (let i = 0; i < parsed.length; i += 1) {
		const entry = parsed[i];
		const schedule = parseNewsSchedule(entry, i) || parseScannerSchedule(entry, i);
		if (schedule) {
			schedules.push(schedule);
		}
	}
	return schedules;
}

class AlertSchedulerService {
	constructor(options = {}) {
		this.alertStorage = options.alertStorageService || alertStorageService;
		this.getNotificationManagerFn = options.getNotificationManager || (() => alertModule.getNotificationManager());
		this.setNotificationManagerFn = options.setNotificationManager || setNotificationManager;
		this.getAnalyzerFn = options.getAnalyzer || getAnalyzer;
		this.botGetter = options.botGetter || null;
		this.workerId = options.workerId || `${process.pid}-${crypto.randomUUID()}`;
		this.running = false;
		this.timer = null;
		this.activeSweepPromise = null;
		this.activeSweepController = null;
		this.shutdownRequested = false;

		this.schedules = [];
		this.scheduleState = new Map();
		this._scheduleCursor = 0;
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunExecutedCount = 0;
		this.lastRunErrorCount = 0;
		this.lastError = null;
	}

	isEnabled() {
		return parseEnvBool(process.env.ENABLE_ALERT_SCHEDULER, false);
	}

	getWorkerRole() {
		const rawRole = String(process.env.ALERT_SCHEDULER_WORKER_ROLE || 'web')
			.trim()
			.toLowerCase();
		if (rawRole === 'worker' || rawRole === 'disabled') {
			return rawRole;
		}
		return 'web';
	}

	getIntervalMs() {
		const runtime = getRuntimeConfig();
		const raw = runtime.ALERT_SCHEDULER_INTERVAL_MS !== undefined
			? runtime.ALERT_SCHEDULER_INTERVAL_MS
			: process.env.ALERT_SCHEDULER_INTERVAL_MS;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_INTERVAL_MS, MIN_SCHEDULER_INTERVAL_MS, MAX_SCHEDULER_INTERVAL_MS);
	}

	getBatchLimit() {
		const runtime = getRuntimeConfig();
		const raw = runtime.ALERT_SCHEDULER_BATCH_LIMIT !== undefined
			? runtime.ALERT_SCHEDULER_BATCH_LIMIT
			: process.env.ALERT_SCHEDULER_BATCH_LIMIT;
		return parseEnvInt(raw, DEFAULT_SCHEDULER_BATCH_LIMIT, MIN_SCHEDULER_BATCH_LIMIT, MAX_SCHEDULER_BATCH_LIMIT);
	}

	getLeaseMs() {
		return parseEnvInt(process.env.ALERT_SCHEDULER_LEASE_MS, DEFAULT_LEASE_MS, MIN_LEASE_MS, MAX_LEASE_MS);
	}

	getTimeoutMs() {
		return parseEnvInt(process.env.ALERT_SCHEDULER_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
	}

	_loadSchedules() {
		const raw = process.env.ALERT_SCHEDULER_SCHEDULES;
		this.schedules = parseSchedules(raw);

		// Initialize state for new schedules, retain state for existing ones
		const nextState = new Map();
		for (const schedule of this.schedules) {
			const previous = this.scheduleState.get(schedule.id);
			if (previous) {
				nextState.set(schedule.id, previous);
			} else {
				nextState.set(schedule.id, {
					id: schedule.id,
					nextRunAt: null,
					lastRunAt: null,
					lastStatus: null,
					lastError: null,
					lastDurationMs: null,
					consecutiveErrors: 0,
				});
			}
		}
		this.scheduleState = nextState;
	}

	getSchedules() {
		return this.schedules.map((schedule) => {
			const state = this.scheduleState.get(schedule.id) || {};
			return {
				id: schedule.id,
				type: schedule.type,
				name: schedule.name,
				cadenceMs: schedule.cadenceMs,
				nextRunAt: state.nextRunAt || null,
				lastRunAt: state.lastRunAt || null,
				lastStatus: state.lastStatus || null,
				lastError: state.lastError || null,
				lastDurationMs: state.lastDurationMs != null ? state.lastDurationMs : null,
			};
		});
	}

	getStatus() {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		const ready = enabled && role !== 'disabled' && this.schedules.length > 0;

		let status = 'disabled';
		if (enabled) {
			if (role === 'disabled') {
				status = 'disabled';
			} else if (this.schedules.length === 0) {
				status = 'misconfigured';
			} else {
				status = 'ready';
			}
		}

		return {
			enabled,
			configured: this.schedules.length > 0,
			ready,
			status,
			role,
			running: this.running,
			intervalMs: this.getIntervalMs(),
			batchLimit: this.getBatchLimit(),
			scheduleCount: this.schedules.length,
			activeCount: this.schedules.length,
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunExecutedCount: this.lastRunExecutedCount,
			lastRunErrorCount: this.lastRunErrorCount,
			lastError: this.lastError,
			schedules: this.getSchedules(),
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

		this._loadSchedules();

		if (this.schedules.length === 0) {
			console.warn('[AlertScheduler] No valid schedules defined, scheduler will not start.');
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
				console.error('[AlertScheduler] Sweep failed unexpectedly:', err.message);
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

	_isScheduleDue(schedule, nowMs) {
		const state = this.scheduleState.get(schedule.id);
		if (!state) return true;
		if (!state.nextRunAt) return true;
		const nextRunAtMs = new Date(state.nextRunAt).getTime();
		return !Number.isFinite(nextRunAtMs) || nextRunAtMs <= nowMs;
	}

	_getFirestore() {
		if (this.alertStorage && typeof this.alertStorage.getFirestore === 'function') {
			return this.alertStorage.getFirestore();
		}
		return null;
	}

	async _acquireLease(nowMs, leaseMs, options = {}) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
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
					updatedAt: new Date(nowMs).toISOString(),
				}, { merge: true });
				return true;
			});
			return Boolean(acquired);
		} catch (err) {
			console.warn('[AlertScheduler] Lease acquire failed:', err.message);
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
			console.warn('[AlertScheduler] Lease renew failed:', err.message);
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
			console.warn('[AlertScheduler] Lease release failed:', err.message);
		}
	}

	async _executeSweep(options = {}) {
		const sweepStartTime = Date.now();
		const nowMs = sweepStartTime;
		const batchLimit = options.batchLimit || this.getBatchLimit();
		const leaseMs = options.leaseMs || this.getLeaseMs();
		const timeoutMs = options.timeoutMs || this.getTimeoutMs();

		let executedCount = 0;
		let errorCount = 0;
		let lastErrorMessage = null;

		if (this.schedules.length === 0) {
			this._loadSchedules();
		}

		const leaseAcquired = await this._acquireLease(nowMs, leaseMs, options);
		if (!leaseAcquired) {
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunExecutedCount = 0;
			this.lastRunErrorCount = 0;
			this.lastError = null;
			return {
				executedCount: 0,
				errorCount: 0,
				durationMs: this.lastRunDurationMs,
				skipped: 'lease-held',
			};
		}

		const controller = new AbortController();
		this.activeSweepController = controller;
		const sweepTimer = setTimeout(() => controller.abort(), timeoutMs);

		const renewIntervalMs = Math.max(1000, Math.floor(leaseMs / 2));
		const renewHandle = setInterval(() => {
			this._renewLease(Date.now(), leaseMs).catch((err) => {
				console.warn('[AlertScheduler] Lease renew tick failed:', err.message);
			});
		}, renewIntervalMs);

		try {
			const allDue = this.schedules.filter((s) => this._isScheduleDue(s, nowMs));
			let dueSchedules = allDue;
			if (allDue.length > batchLimit) {
				const start = this._scheduleCursor % allDue.length;
				dueSchedules = [];
				for (let i = 0; i < batchLimit; i += 1) {
					dueSchedules.push(allDue[(start + i) % allDue.length]);
				}
				this._scheduleCursor = (start + batchLimit) % allDue.length;
			} else {
				this._scheduleCursor = 0;
			}

			for (const schedule of dueSchedules) {
				if (this.shutdownRequested || controller.signal.aborted) {
					break;
				}

				const startTime = Date.now();
				const state = this.scheduleState.get(schedule.id);
				state.consecutiveErrors = state.consecutiveErrors || 0;

				try {
					const result = await this._executeSchedule(schedule, controller.signal);
					executedCount += 1;
					state.lastRunAt = new Date().toISOString();
					state.lastDurationMs = Date.now() - startTime;
					state.lastStatus = result.status;
					state.lastError = result.error || null;
					state.consecutiveErrors = result.status === 'success' ? 0 : (state.consecutiveErrors + 1);
					state.nextRunAt = new Date(nowMs + schedule.cadenceMs).toISOString();

					if (result.status !== 'success') {
						errorCount += 1;
						if (result.error) {
							lastErrorMessage = result.error;
						}
					}
				} catch (err) {
					errorCount += 1;
					executedCount += 1;
					state.lastRunAt = new Date().toISOString();
					state.lastDurationMs = Date.now() - startTime;
					state.lastStatus = 'error';
					state.lastError = err.message;
					state.consecutiveErrors += 1;
					state.nextRunAt = new Date(nowMs + schedule.cadenceMs).toISOString();
					lastErrorMessage = err.message;
					console.error(`[AlertScheduler] Schedule ${schedule.id} failed:`, err.message);
					sentryService.captureRuntimeError({
						channel: 'alert-scheduler',
						error: err,
						extra: { scheduleId: schedule.id, scheduleType: schedule.type },
					});
				}
			}
		} catch (err) {
			lastErrorMessage = err.message;
			console.error('[AlertScheduler] Sweep error:', err.message);
			sentryService.captureRuntimeError({
				channel: 'alert-scheduler',
				error: err,
			});
		} finally {
			clearInterval(renewHandle);
			clearTimeout(sweepTimer);
			this.activeSweepController = null;
			const intervalMs = options.intervalMs || this.getIntervalMs();
			await this._releaseLease(Date.now(), intervalMs);
			this.lastRunAt = new Date(sweepStartTime);
			this.lastRunDurationMs = Date.now() - sweepStartTime;
			this.lastRunExecutedCount = executedCount;
			this.lastRunErrorCount = errorCount;
			this.lastError = lastErrorMessage;
		}

		return {
			executedCount,
			errorCount,
			durationMs: this.lastRunDurationMs,
		};
	}

	async _executeSchedule(schedule, parentSignal) {
		if (schedule.type === 'news-monitor') {
			return this._executeNewsSchedule(schedule, parentSignal);
		}
		if (schedule.type === 'scanner') {
			return this._executeScannerSchedule(schedule, parentSignal);
		}
		return { status: 'error', error: `Unknown schedule type: ${schedule.type}` };
	}

	async _executeNewsSchedule(schedule, parentSignal) {
		if (!parseEnvBool(process.env.ENABLE_NEWS_MONITOR, false)) {
			return { status: 'skipped', error: 'news-monitor-disabled' };
		}
		if (isNewsMonitorPaused()) {
			return { status: 'skipped', error: 'news-monitor-paused' };
		}

		const symbols = [...schedule.symbols.crypto, ...schedule.symbols.stocks]
			.map((s) => String(s).trim().toUpperCase())
			.filter(Boolean);

		if (symbols.length === 0) {
			return { status: 'skipped', error: 'no-symbols' };
		}

		try {
			const analyzer = this.getAnalyzerFn();
			let notificationManager = this.getNotificationManagerFn();
			if (!notificationManager && this.botGetter) {
				try {
					notificationManager = await alertModule.initializeNotificationServices(resolveBot(this.botGetter));
				} catch (err) {
					console.warn('[AlertScheduler] Could not initialize notification manager via botGetter:', err.message);
				}
			}
			if (notificationManager) {
				try {
					if (typeof this.setNotificationManagerFn === 'function') {
						this.setNotificationManagerFn(notificationManager);
					} else if (typeof analyzer.setNotificationManager === 'function') {
						analyzer.setNotificationManager(notificationManager);
					}
				} catch (err) {
					console.warn('[AlertScheduler] Could not inject notification manager:', err.message);
				}
			}

			const requestId = uuidv4();
			const cryptoSet = new Set(schedule.symbols.crypto.map((s) => String(s).trim().toUpperCase()));
			const assetClassBySymbol = {};
			for (const symbol of symbols) {
				assetClassBySymbol[symbol] = cryptoSet.has(symbol) ? 'crypto' : 'stock';
			}

			const routing = schedule.channels && schedule.channels.length > 0
				? { channels: schedule.channels }
				: {};

			const results = await analyzer.analyzeSymbols(
				symbols,
				requestId,
				null,
				routing,
				{
					deadline: Date.now() + this.getTimeoutMs(),
					signal: parentSignal,
					scheduledSweep: true,
					assetClassBySymbol,
				},
			);

			if (Array.isArray(results)) {
				if (results.length === 0) {
					return { status: 'success' };
				}
				const errored = results.filter((r) => r && (r.status === 'error' || r.status === 'timeout'));
				if (errored.length === results.length) {
					return { status: 'error', error: `All ${results.length} symbol(s) failed` };
				}
				return { status: 'success' };
			}
			return { status: 'success' };
		} catch (err) {
			return { status: 'error', error: err.message };
		}
	}

	async _executeScannerSchedule(schedule, parentSignal) {
		try {
			if (!parseEnvBool(process.env.ENABLE_MARKET_SCANNER, false)) {
				return { status: 'skipped', error: 'market-scanner-disabled' };
			}

			const preset = {
				exchange: schedule.exchange,
				timeframe: schedule.timeframe,
				scans: schedule.scans,
				limit: schedule.limit,
				bbwThreshold: 0.05,
				bbw_threshold: 0.05,
				ranked: schedule.ranked,
				includeMultiTimeframe: schedule.includeMultiTimeframe,
			};

			const runOptions = { signal: parentSignal };
			const scanResults = await marketScannerModule.runScans(preset, runOptions);

			if (!Array.isArray(scanResults) || scanResults.length === 0) {
				return { status: 'error', error: 'No scan results returned' };
			}

			const successful = scanResults.filter((r) => r.status === 'success');
			if (successful.length === 0) {
				return { status: 'error', error: 'All scans failed' };
			}

			const alertText = marketScannerReportModule.buildMarketScannerReport(scanResults, {
				exchange: schedule.exchange,
				timeframe: schedule.timeframe,
				ranked: schedule.ranked,
				now: new Date(),
			});

			let notificationManager = this.getNotificationManagerFn();
			if (!notificationManager && this.botGetter) {
				try {
					notificationManager = await alertModule.initializeNotificationServices(resolveBot(this.botGetter));
				} catch (err) {
					console.warn('[AlertScheduler] Could not initialize notification manager via botGetter:', err.message);
				}
			}

			if (notificationManager) {
				const routing = schedule.channels && schedule.channels.length > 0
					? { channels: schedule.channels }
					: {};
				await requestRoutingModule.sendWithNotificationRouting(
					notificationManager,
					{ text: alertText, source: 'alert-scheduler' },
					routing,
					{ parentSpan: sentryService.getActiveSpan() },
				);
			}

			return { status: 'success' };
		} catch (err) {
			return { status: 'error', error: err.message };
		}
	}
}

const alertSchedulerService = new AlertSchedulerService();

module.exports = {
	AlertSchedulerService,
	alertSchedulerService,
	parseSchedules,
	parseIntervalToMs,
};
