'use strict';

/**
 * WorkerHeartbeatMonitor
 *
 * Reads durable worker heartbeat documents (`workerHeartbeats/<worker>`)
 * and computes a bounded freshness snapshot used by `/api/status` and
 * `/api/capabilities`. The monitor never blocks the status response:
 *   - Firestore reads use the existing `AlertStorageService.getFirestore()`
 *     singleton and fail open (returns the cached snapshot) on errors.
 *   - The snapshot is memoized in-process for a bounded TTL so we don't
 *     hit Firestore on every status poll.
 *   - When the read fails repeatedly, the snapshot is reported as
 *     `missing` (no heartbeat observed) without surfacing credentials.
 *
 * Two heartbeats are tracked today:
 *   - `signal-outcome` (written by `SignalOutcomeService.persistWorkerHeartbeat`).
 *   - `scanner-preset-scheduler` (derived from the most recent preset
 *     `updatedAt`/`lastRunAt` because the scheduler does not write a
 *     dedicated heartbeat yet — issue #771 umbrella scope).
 *
 * The freshness threshold is a multiple of the worker's evaluation
 * interval to avoid false-positive "stale" reports when the worker is
 * simply waiting for its next sweep.
 */

const AlertStorageService = require('../storage/AlertStorageService');
const SignalOutcomeService = require('../storage/SignalOutcomeService');
const {
	scannerPresetSchedulerService,
} = require('../scannerPresets');

const HEARTBEAT_COLLECTION_NAME = 'workerHeartbeats';
const SIGNAL_OUTCOME_DOC_ID = 'signal-outcome';
const SCANNER_PRESET_COLLECTION_NAME = 'scannerPresets';

const HEALTH_HEALTHY = 'healthy';
const HEALTH_STALE = 'stale';
const HEALTH_MISSING = 'missing';
const HEALTH_DISABLED = 'disabled';
const HEALTH_UNKNOWN = 'unknown';

const DEFAULT_CACHE_TTL_MS = 15000;
const DEFAULT_STALENESS_MULTIPLIER = 4;
const MIN_STALENESS_MULTIPLIER = 2;
const MAX_STALENESS_MULTIPLIER = 20;
const DEFAULT_READ_TIMEOUT_MS = 3000;

const STALE_ALERT_COOLDOWN_MS = 10 * 60 * 1000;

function clamp(value, min, max) {
	if (!Number.isFinite(value)) return min;
	if (value < min) return min;
	if (value > max) return max;
	return value;
}

function getCacheTtlMs() {
	const raw = Number(process.env.WORKER_HEARTBEAT_CACHE_TTL_MS);
	if (Number.isFinite(raw) && raw >= 1000 && raw <= 60000) {
		return raw;
	}
	return DEFAULT_CACHE_TTL_MS;
}

function getStalenessMultiplier() {
	const raw = Number(process.env.WORKER_HEARTBEAT_STALENESS_MULTIPLIER);
	if (Number.isFinite(raw) && raw >= MIN_STALENESS_MULTIPLIER && raw <= MAX_STALENESS_MULTIPLIER) {
		return raw;
	}
	return DEFAULT_STALENESS_MULTIPLIER;
}

function getReadTimeoutMs() {
	const raw = Number(process.env.WORKER_HEARTBEAT_READ_TIMEOUT_MS);
	if (Number.isFinite(raw) && raw >= 500 && raw <= 15000) {
		return raw;
	}
	return DEFAULT_READ_TIMEOUT_MS;
}

function isOptInAlertingEnabled() {
	return process.env.WORKER_HEARTBEAT_ALERTING_ENABLED === 'true';
}

function getWorkerIntervalMs(value) {
	const candidate = Number(value);
	return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
}

function toMillis(value) {
	if (!value) return null;
	if (typeof value.toMillis === 'function') {
		const millis = value.toMillis();
		return Number.isFinite(millis) ? millis : null;
	}
	if (typeof value.toDate === 'function') {
		const date = value.toDate();
		if (date instanceof Date && !Number.isNaN(date.getTime())) {
			return date.getTime();
		}
	}
	if (value instanceof Date) {
		return Number.isFinite(value.getTime()) ? value.getTime() : null;
	}
	if (typeof value === 'string') {
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return null;
}

function classifyHealth({ hasHeartbeat, ageMs, thresholdMs, role, enabled, lastAlertAt }) {
	if (!enabled) {
		return { health: HEALTH_DISABLED, ageMs: null };
	}
	if (role === 'disabled') {
		return { health: HEALTH_DISABLED, ageMs: null };
	}
	if (!hasHeartbeat) {
		return { health: HEALTH_MISSING, ageMs: null };
	}
	if (ageMs === null || ageMs === undefined) {
		return { health: HEALTH_UNKNOWN, ageMs: null };
	}
	if (ageMs > thresholdMs) {
		const cooldownActive = typeof lastAlertAt === 'number' && (Date.now() - lastAlertAt) < STALE_ALERT_COOLDOWN_MS;
		return { health: HEALTH_STALE, ageMs, cooldownActive };
	}
	return { health: HEALTH_HEALTHY, ageMs };
}

function buildEmptySnapshot(workerName, reason) {
	return {
		worker: workerName,
		health: HEALTH_UNKNOWN,
		hasHeartbeat: false,
		heartbeatAgeMs: null,
		lastHeartbeatAt: null,
		lastRunAt: null,
		role: null,
		thresholdMs: null,
		stalenessMultiplier: getStalenessMultiplier(),
		enabled: false,
		error: reason || null,
		checkedAt: Date.now(),
	};
}

class WorkerHeartbeatMonitor {
	constructor(options = {}) {
		this.getFirestore = options.getFirestore || (() => AlertStorageService.getFirestore());
		this.getSignalOutcomeWorkerStatus = options.getSignalOutcomeWorkerStatus
			|| (() => {
				try {
					return SignalOutcomeService.getWorkerStatus();
				} catch (error) {
					this.logger.warn?.(`[WorkerHeartbeatMonitor] signal-outcome worker status read failed: ${error.message}`);
					return null;
				}
			});
		this.getScannerPresetSchedulerWorkerStatus = options.getScannerPresetSchedulerWorkerStatus
			|| (() => {
				try {
					return scannerPresetSchedulerService.getStatus();
				} catch (error) {
					this.logger.warn?.(`[WorkerHeartbeatMonitor] scanner-preset status read failed: ${error.message}`);
					return null;
				}
			});
		this.logger = options.logger || console;
		this.now = options.now || (() => Date.now());
		this.onStaleDetected = typeof options.onStaleDetected === 'function' ? options.onStaleDetected : null;
		this._cache = new Map();
		this._staleAlertedAt = new Map();
	}

	_resetForTesting() {
		this._cache.clear();
		this._staleAlertedAt.clear();
	}

	_getCached(workerName) {
		const entry = this._cache.get(workerName);
		if (!entry) return null;
		if (entry.expiresAt <= this.now()) {
			return null;
		}
		return entry.value;
	}

	_setCached(workerName, value) {
		this._cache.set(workerName, {
			value,
			expiresAt: this.now() + getCacheTtlMs(),
		});
	}

	_readWithTimeout(promise, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) return;
				settled = true;
				reject(new Error(`${label} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			Promise.resolve(promise).then((value) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(value);
			}, (error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(error);
			});
		});
	}

	async _readSignalOutcomeHeartbeat({ enabled, role, intervalMs, roleStatus }) {
		if (!enabled) {
			return {
				...buildEmptySnapshot('signal-outcome', null),
				role,
				enabled: false,
				intervalMs,
			};
		}
		if (role === 'disabled') {
			return {
				worker: 'signal-outcome',
				health: HEALTH_DISABLED,
				hasHeartbeat: false,
				heartbeatAgeMs: null,
				lastHeartbeatAt: null,
				lastRunAt: null,
				role,
				thresholdMs: null,
				stalenessMultiplier: getStalenessMultiplier(),
				enabled: true,
				intervalMs,
				error: null,
				checkedAt: this.now(),
			};
		}

		const firestore = this.getFirestore();
		if (!firestore) {
			return buildEmptySnapshot('signal-outcome', 'firestore_unavailable');
		}

		const thresholdMs = intervalMs
			? Math.max(intervalMs * getStalenessMultiplier(), intervalMs)
			: 5 * 60 * 1000;

		try {
			const docRef = firestore.collection(HEARTBEAT_COLLECTION_NAME).doc(SIGNAL_OUTCOME_DOC_ID);
			const snapshot = await this._readWithTimeout(docRef.get(), getReadTimeoutMs(), 'signal-outcome heartbeat');
			if (!snapshot || !snapshot.exists) {
				return {
					worker: 'signal-outcome',
					health: HEALTH_MISSING,
					hasHeartbeat: false,
					heartbeatAgeMs: null,
					lastHeartbeatAt: null,
					lastRunAt: null,
					role,
					thresholdMs,
					stalenessMultiplier: getStalenessMultiplier(),
					enabled: true,
					intervalMs,
					error: null,
					checkedAt: this.now(),
				};
			}

			const data = snapshot.data() || {};
			const heartbeatRole = data.role || role;
			const heartbeatEnabled = typeof data.enabled === 'boolean' ? data.enabled : true;
			if (heartbeatRole === 'disabled' || heartbeatEnabled === false) {
				return {
					worker: 'signal-outcome',
					health: HEALTH_DISABLED,
					hasHeartbeat: true,
					heartbeatAgeMs: null,
					lastHeartbeatAt: toMillis(data.updatedAt),
					lastRunAt: toMillis(data.lastRunAt),
					role,
					thresholdMs,
					stalenessMultiplier: getStalenessMultiplier(),
					enabled: true,
					intervalMs,
					error: null,
					checkedAt: this.now(),
				};
			}

			const heartbeatMillis = toMillis(data.updatedAt);
			const lastRunMillis = toMillis(data.lastRunAt);
			const ageMs = heartbeatMillis === null ? null : this.now() - heartbeatMillis;
			const lastAlertAt = this._staleAlertedAt.get('signal-outcome') || null;
			const { health } = classifyHealth({
				hasHeartbeat: heartbeatMillis !== null,
				ageMs,
				thresholdMs,
				role,
				enabled: true,
				lastAlertAt,
			});

			return {
				worker: 'signal-outcome',
				health,
				hasHeartbeat: heartbeatMillis !== null,
				heartbeatAgeMs: ageMs,
				lastHeartbeatAt: heartbeatMillis,
				lastRunAt: lastRunMillis,
				role,
				thresholdMs,
				stalenessMultiplier: getStalenessMultiplier(),
				enabled: true,
				intervalMs,
				error: null,
				checkedAt: this.now(),
			};
		} catch (error) {
			this.logger.warn?.(`[WorkerHeartbeatMonitor] signal-outcome heartbeat read failed: ${error.message}`);
			return buildEmptySnapshot('signal-outcome', 'read_failed');
		}
	}

	async _readScannerPresetSchedulerHeartbeat({ enabled, role, intervalMs }) {
		if (!enabled || role === 'disabled') {
			return {
				...buildEmptySnapshot('scanner-preset-scheduler', null),
				role,
				enabled,
				intervalMs,
			};
		}

		const firestore = this.getFirestore();
		if (!firestore || typeof firestore.collection !== 'function') {
			// Memory-only mode: there is no cross-process durable heartbeat.
			return {
				worker: 'scanner-preset-scheduler',
				health: HEALTH_UNKNOWN,
				hasHeartbeat: false,
				heartbeatAgeMs: null,
				lastHeartbeatAt: null,
				lastRunAt: null,
				role,
				thresholdMs: intervalMs
					? Math.max(intervalMs * getStalenessMultiplier(), intervalMs)
					: null,
				stalenessMultiplier: getStalenessMultiplier(),
				enabled: true,
				intervalMs,
				error: 'ephemeral_storage',
				checkedAt: this.now(),
			};
		}

		const thresholdMs = intervalMs
			? Math.max(intervalMs * getStalenessMultiplier(), intervalMs)
			: 5 * 60 * 1000;

		try {
			const query = firestore.collection(SCANNER_PRESET_COLLECTION_NAME)
				.orderBy('updatedAt', 'desc')
				.limit(1);
			const snapshot = await this._readWithTimeout(query.get(), getReadTimeoutMs(), 'scanner-preset heartbeat');
			const docs = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : [];
			if (docs.length === 0) {
				return {
					worker: 'scanner-preset-scheduler',
					health: HEALTH_MISSING,
					hasHeartbeat: false,
					heartbeatAgeMs: null,
					lastHeartbeatAt: null,
					lastRunAt: null,
					role,
					thresholdMs,
					stalenessMultiplier: getStalenessMultiplier(),
					enabled: true,
					intervalMs,
					error: null,
					checkedAt: this.now(),
				};
			}

			const latest = docs[0].data() || {};
			const heartbeatMillis = toMillis(latest.updatedAt) || toMillis(latest.lastRunAt);
			const lastRunMillis = toMillis(latest.lastRunAt);
			const ageMs = heartbeatMillis === null ? null : this.now() - heartbeatMillis;
			const lastAlertAt = this._staleAlertedAt.get('scanner-preset-scheduler') || null;
			const { health } = classifyHealth({
				hasHeartbeat: heartbeatMillis !== null,
				ageMs,
				thresholdMs,
				role,
				enabled: true,
				lastAlertAt,
			});

			return {
				worker: 'scanner-preset-scheduler',
				health,
				hasHeartbeat: heartbeatMillis !== null,
				heartbeatAgeMs: ageMs,
				lastHeartbeatAt: heartbeatMillis,
				lastRunAt: lastRunMillis,
				role,
				thresholdMs,
				stalenessMultiplier: getStalenessMultiplier(),
				enabled: true,
				intervalMs,
				error: null,
				checkedAt: this.now(),
			};
		} catch (error) {
			this.logger.warn?.(`[WorkerHeartbeatMonitor] scanner-preset-scheduler heartbeat read failed: ${error.message}`);
			return {
				worker: 'scanner-preset-scheduler',
				health: HEALTH_UNKNOWN,
				hasHeartbeat: false,
				heartbeatAgeMs: null,
				lastHeartbeatAt: null,
				lastRunAt: null,
				role,
				thresholdMs,
				stalenessMultiplier: getStalenessMultiplier(),
				enabled: true,
				intervalMs,
				error: 'read_failed',
				checkedAt: this.now(),
			};
		}
	}

	async getSignalOutcomeStatus(forceRefresh = false) {
		if (!forceRefresh) {
			const cached = this._getCached('signal-outcome');
			if (cached) return cached;
		}

		let enabled = true;
		let role = 'web';
		let intervalMs = 5 * 60 * 1000;
		try {
			if (typeof this.getSignalOutcomeWorkerStatus === 'function') {
				const status = this.getSignalOutcomeWorkerStatus() || {};
				enabled = status.enabled !== false;
				role = status.role || 'web';
				intervalMs = getWorkerIntervalMs(status.intervalMs) || intervalMs;
			}
		} catch (error) {
			this.logger.warn?.(`[WorkerHeartbeatMonitor] signal-outcome worker status read failed: ${error.message}`);
		}

		const snapshot = await this._readSignalOutcomeHeartbeat({
			enabled,
			role,
			intervalMs,
		});
		this._setCached('signal-outcome', snapshot);
		this._maybeEmitStaleAlert('signal-outcome', snapshot);
		return snapshot;
	}

	async getScannerPresetSchedulerStatus(forceRefresh = false) {
		if (!forceRefresh) {
			const cached = this._getCached('scanner-preset-scheduler');
			if (cached) return cached;
		}

		let enabled = true;
		let role = 'web';
		let intervalMs = 60 * 1000;
		try {
			if (typeof this.getScannerPresetSchedulerWorkerStatus === 'function') {
				const status = this.getScannerPresetSchedulerWorkerStatus() || {};
				enabled = status.enabled !== false;
				role = status.role || 'web';
				intervalMs = getWorkerIntervalMs(status.intervalMs) || intervalMs;
			}
		} catch (error) {
			this.logger.warn?.(`[WorkerHeartbeatMonitor] scanner-preset status read failed: ${error.message}`);
		}

		const snapshot = await this._readScannerPresetSchedulerHeartbeat({
			enabled,
			role,
			intervalMs,
		});
		this._setCached('scanner-preset-scheduler', snapshot);
		this._maybeEmitStaleAlert('scanner-preset-scheduler', snapshot);
		return snapshot;
	}

	_maybeEmitStaleAlert(workerName, snapshot) {
		if (!isOptInAlertingEnabled()) return;
		if (!snapshot || snapshot.health !== HEALTH_STALE) return;
		const lastAlertAt = this._staleAlertedAt.get(workerName) || 0;
		if (this.now() - lastAlertAt < STALE_ALERT_COOLDOWN_MS) return;
		this._staleAlertedAt.set(workerName, this.now());

		this.logger.warn?.(
			`[WorkerHeartbeatMonitor] ${workerName} heartbeat stale: ageMs=${snapshot.heartbeatAgeMs} thresholdMs=${snapshot.thresholdMs}`,
		);

		if (typeof this.onStaleDetected === 'function') {
			try {
				this.onStaleDetected({ workerName, snapshot });
			} catch (error) {
				this.logger.warn?.(`[WorkerHeartbeatMonitor] onStaleDetected hook failed: ${error.message}`);
			}
		}
	}
}

const workerHeartbeatMonitor = new WorkerHeartbeatMonitor();

module.exports = {
	WorkerHeartbeatMonitor,
	workerHeartbeatMonitor,
	HEALTH_HEALTHY,
	HEALTH_STALE,
	HEALTH_MISSING,
	HEALTH_DISABLED,
	HEALTH_UNKNOWN,
};