'use strict';

const { v4: uuidv4 } = require('uuid');
const alertStorageService = require('../storage/AlertStorageService');
const {
	MarketScannerRequestError,
	SUPPORTED_SCAN_TYPES,
} = require('../tradingview/marketScannerReport');
const {
	normalizeTradingViewTimeframe,
	SUPPORTED_MCP_TIMEFRAMES,
} = require('../tradingview/parseTradingViewSignal');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const { resolveRemoteOverride } = require('../remoteConfig/resolveRemoteOverride');

const COLLECTION_NAME = 'scannerPresets';
const DEFAULT_SCAN_LIMIT = 5;
const MAX_SCAN_LIMIT = 20;
const DEFAULT_EXCHANGE = 'BINANCE';
const DEFAULT_TIMEFRAME = process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '4h';
const DEFAULT_SCANS = ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
const DEFAULT_BBW_THRESHOLD = 0.05;
const SUPPORTED_TIMEFRAME_ALIASES = new Set([
	'5', '5M', '15', '15M', '60', '1H', '240', '4H',
	'1440', 'D', '1D', '10080', 'W', '1W', '43200', 'M', '1M',
]);

// In-memory fallback used when Firestore is unavailable.
const memoryPresets = new Map();
const pendingFirestorePresets = new Map();
const inFlightFirestorePresets = new Map();
const pendingFirestoreDeletes = new Set();
const firestoreDeleteGenerations = new Map();
const pendingFirestoreWriteTokens = new Map();
const firestoreWriteQueues = new Map();
const inMemoryWriteLocks = new Map();

/**
 * Closed enum for `lastErrorReason`. Every Firestore failure on the scanner-preset
 * paths is swallowed so the caller can fall back to the in-memory mirror, which means
 * an operator has no other way to learn that durability stopped working. The reason is
 * constrained to this enum because a Firestore error message embeds the fully-qualified
 * project/database path and the index definition — it is logged, never returned.
 */
const REASONS = Object.freeze({
	NOT_INITIALIZED: 'firestore_not_initialized',
	UNAVAILABLE: 'firestore_unavailable',
	PROBE_TIMEOUT: 'firestore_probe_timeout',
});

const KNOWN_REASONS = new Set(Object.values(REASONS));

const PROBE_TIMEOUT_MESSAGE = 'scanner preset readiness probe timed out';

/**
 * Durable-readiness states. `unverified` is deliberately distinct from `ready` (and from
 * `degraded`): before an operation has actually answered, there is no evidence that presets
 * persist, and reporting that as `ready` is what made the #1114 production enablement
 * unverifiable. `/api/status` closes the gap by running a bounded read probe.
 */
const READINESS = Object.freeze({
	UNVERIFIED: 'unverified',
	VERIFIED: 'verified',
	DEGRADED: 'degraded',
});

/**
 * Status-path probe bounds. The probe is single-flight and rate-limited so an operator
 * polling `/api/status` cannot turn the status read into a Firestore read amplifier. Both
 * bounds are fixed application safety deadlines, not operator tuning.
 */
const PROBE_TIMEOUT_MS = 5000;
const PROBE_MIN_INTERVAL_MS = 5000;

/**
 * Process-local window of observed durable outcomes. Readiness is derived from real
 * Firestore work rather than credential shape, so a deployment whose credentials look
 * valid but cannot reach Firestore reports `degraded` instead of `ready`. Counters reset
 * on restart and every recorder is fail-open: telemetry must never reject a request.
 */
const storageReadiness = {
	operationsAttempted: 0,
	operationsSucceeded: 0,
	operationsFailed: 0,
	consecutiveFailures: 0,
	lastSuccessAt: null,
	lastFailureAt: null,
	lastErrorReason: null,
};

let probeInFlight = null;
let lastProbeStartedAtMs = 0;

function resetStorageReadiness() {
	storageReadiness.operationsAttempted = 0;
	storageReadiness.operationsSucceeded = 0;
	storageReadiness.operationsFailed = 0;
	storageReadiness.consecutiveFailures = 0;
	storageReadiness.lastSuccessAt = null;
	storageReadiness.lastFailureAt = null;
	storageReadiness.lastErrorReason = null;
	probeInFlight = null;
	lastProbeStartedAtMs = 0;
}

// Telemetry must never be able to fail a request: every readiness mutation runs through
// this guard so a counter error cannot reject the caller.
function recordReadinessSafely(record) {
	try {
		record();
	} catch (error) {
		console.warn('[ScannerPresetService] storage readiness recording failed:', error && error.message);
	}
}

// A durable use attempt is counted even when Firebase initialization is rejected, because
// asking for durable storage and not getting it is exactly the event an operator needs to
// see. `operationsFailed` therefore never exceeds `operationsAttempted`.
function recordDurableAttempt() {
	storageReadiness.operationsAttempted += 1;
}

function recordDurableSuccess() {
	storageReadiness.operationsSucceeded += 1;
	storageReadiness.consecutiveFailures = 0;
	storageReadiness.lastSuccessAt = new Date().toISOString();
}

function recordDurableFailure(reason) {
	storageReadiness.operationsFailed += 1;
	storageReadiness.consecutiveFailures += 1;
	storageReadiness.lastFailureAt = new Date().toISOString();
	storageReadiness.lastErrorReason = typeof reason === 'string' && KNOWN_REASONS.has(reason)
		? reason
		: REASONS.UNAVAILABLE;
}

function recordDurableOutcomeSucceeded() {
	recordReadinessSafely(() => {
		recordDurableAttempt();
		recordDurableSuccess();
	});
}

function recordDurableOutcomeFailed(reason) {
	recordReadinessSafely(() => {
		recordDurableAttempt();
		recordDurableFailure(reason);
	});
}

/**
 * Readiness is self-healing: `consecutiveFailures` clears on the next success, so one
 * transient read error never permanently downgrades the reported verdict and no restart is
 * needed to recover. It deliberately never latches `degraded` — only a failure that is
 * still the most recent observation may report it.
 */
function resolveStorageReadiness() {
	if (storageReadiness.consecutiveFailures > 0) {
		return READINESS.DEGRADED;
	}
	if (storageReadiness.operationsSucceeded > 0) {
		return READINESS.VERIFIED;
	}
	return READINESS.UNVERIFIED;
}

/**
 * Whether a local overlay is in effect. These buckets are a *workload* fact (an unsynced
 * or tombstoned local record changes what a read returns), never evidence that the durable
 * store is unavailable — so they are reported as counts and kept out of the durability
 * verdict, which is what previously let a single wedged entry pin the process to `ephemeral`
 * forever.
 */
function hasPendingOverlay() {
	return pendingFirestorePresets.size > 0
		|| inFlightFirestorePresets.size > 0
		|| pendingFirestoreDeletes.size > 0;
}

/**
 * Oldest local overlay write, used to show how long an unsynced record has been stuck.
 * Derived from data the buckets already carry (`preset.updatedAt`) rather than from a new
 * side map, which would be its own unbounded state to wedge.
 */
function resolveOldestPendingWriteAt() {
	let oldest = null;
	const consider = (value) => {
		const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
		if (!Number.isFinite(parsed)) {
			return;
		}
		if (oldest === null || parsed < oldest) {
			oldest = parsed;
		}
	};
	for (const preset of pendingFirestorePresets.values()) {
		consider(preset && preset.updatedAt);
	}
	for (const operation of inFlightFirestorePresets.values()) {
		consider(operation && operation.preset && operation.preset.updatedAt);
	}
	return oldest === null ? null : new Date(oldest).toISOString();
}

function stripUndefinedFieldsDeep(value) {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => stripUndefinedFieldsDeep(item))
			.filter((item) => item !== undefined);
	}
	const result = {};
	for (const [key, val] of Object.entries(value)) {
		if (val !== undefined) {
			result[key] = stripUndefinedFieldsDeep(val);
		}
	}
	return result;
}

function parseCadenceToMs(cadence) {
	if (cadence === undefined || cadence === null || cadence === '') {
		return 3600000;
	}

	if (typeof cadence === 'number') {
		if (!Number.isFinite(cadence) || !Number.isInteger(cadence)) {
			throw new MarketScannerRequestError('schedule cadenceMs must be an integer');
		}
		if (cadence < 60000) {
			throw new MarketScannerRequestError('schedule cadence must be at least 1 minute (60000 ms)');
		}
		return cadence;
	}

	if (typeof cadence !== 'string') {
		throw new MarketScannerRequestError('schedule cadence must be a string or number');
	}

	const trimmed = cadence.trim();
	if (!trimmed) {
		return 3600000;
	}

	const match = trimmed.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/i);
	if (match) {
		const val = parseInt(match[1], 10);
		const unit = match[2].toLowerCase();
		let ms;
		if (unit.startsWith('m')) {
			ms = val * 60 * 1000;
		} else if (unit.startsWith('h')) {
			ms = val * 3600 * 1000;
		} else if (unit.startsWith('d')) {
			ms = val * 86400 * 1000;
		} else if (unit.startsWith('w')) {
			ms = val * 7 * 86400 * 1000;
		}
		if (ms < 60000) {
			throw new MarketScannerRequestError('schedule cadence must be at least 1 minute (60000 ms)');
		}
		return ms;
	}

	if (/^\d+$/.test(trimmed)) {
		const ms = parseInt(trimmed, 10);
		if (ms < 60000) {
			throw new MarketScannerRequestError('schedule cadence must be at least 1 minute (60000 ms)');
		}
		return ms;
	}

	throw new MarketScannerRequestError(`Invalid schedule cadence "${cadence}". Use format like "5m", "1h", "1d" or milliseconds`);
}

function normalizeSchedule(schedule) {
	if (schedule === undefined || schedule === null) {
		return {
			enabled: false,
			cadence: '1h',
			cadenceMs: 3600000,
		};
	}

	if (typeof schedule !== 'object' || Array.isArray(schedule)) {
		throw new MarketScannerRequestError('schedule must be an object');
	}

	const enabled = Boolean(schedule.enabled);
	const rawCadence = schedule.cadence !== undefined ? schedule.cadence : schedule.cadenceMs;
	const cadenceMs = parseCadenceToMs(rawCadence);
	const cadence = typeof schedule.cadence === 'string' && schedule.cadence.trim()
		? schedule.cadence.trim()
		: `${cadenceMs}ms`;

	return {
		enabled,
		cadence,
		cadenceMs,
	};
}

function clonePreset(preset) {
	if (!preset) return null;
	const cloned = {
		...preset,
		scans: Array.isArray(preset.scans) ? [...preset.scans] : [...DEFAULT_SCANS],
		schedule: preset.schedule
			? { ...preset.schedule }
			: { enabled: false, cadence: '1h', cadenceMs: 3600000 },
	};
	if (Array.isArray(preset.channels)) {
		cloned.channels = [...preset.channels];
	}
	if (Number.isInteger(cloned.version) && cloned.version < 1) {
		cloned.version = 1;
	}
	if (preset.ranked !== undefined) cloned.ranked = preset.ranked;
	if (preset.includeMultiTimeframe !== undefined) cloned.includeMultiTimeframe = preset.includeMultiTimeframe;
	return cloned;
}

function normalizeVersion(value, fallback = 1) {
	const num = Number(value);
	if (!Number.isSafeInteger(num) || num < 1) {
		return fallback;
	}
	return num;
}

function formatEtag(version) {
	const safe = normalizeVersion(version, 1);
	return `"${safe}"`;
}

function parseIfMatchHeader(headerValue) {
	if (typeof headerValue !== 'string') {
		return { present: false, version: null, malformed: false };
	}
	const trimmed = headerValue.trim();
	if (!trimmed) {
		return { present: true, version: null, malformed: true };
	}
	const match = trimmed.match(/^"(-?\d+)"$/);
	if (match) {
		return { present: true, version: normalizeVersion(match[1], null), malformed: false };
	}
	const weakMatch = trimmed.match(/^W\/"(-?\d+)"$/);
	if (weakMatch) {
		return { present: true, version: normalizeVersion(weakMatch[1], null), malformed: false };
	}
	const bare = trimmed.match(/^(-?\d+)$/);
	if (bare) {
		return { present: true, version: normalizeVersion(bare[1], null), malformed: false };
	}
	return { present: true, version: null, malformed: true };
}

function buildPreconditionFailed(preset) {
	const error = new MarketScannerRequestError(
		`If-Match version does not match current preset version (${preset.version})`,
		'PRECONDITION_FAILED',
		{ statusCode: 412, details: { preset } },
	);
	error.preset = clonePreset(preset);
	error.currentVersion = preset.version;
	return error;
}

function buildPresetLocked(preset, lockedUntil) {
	const error = new MarketScannerRequestError(
		`Preset is locked by an in-flight sweep until ${lockedUntil}`,
		'PRESET_LOCKED',
		{ statusCode: 409, details: { preset, lockedUntil } },
	);
	error.preset = clonePreset(preset);
	error.lockedUntil = lockedUntil;
	return error;
}

function buildNameConflict(conflictingPreset) {
	const error = new MarketScannerRequestError(
		`A scanner preset with this name already exists`,
		'NAME_CONFLICT',
		{ statusCode: 409, details: { preset: conflictingPreset } },
	);
	error.preset = clonePreset(conflictingPreset);
	return error;
}

function normalizeNameKey(name) {
	if (typeof name !== 'string') {
		return '';
	}
	return name.trim().toLowerCase();
}

function isPresetLocked(preset, now = Date.now()) {
	if (!preset || typeof preset.lockedUntil !== 'string' || !preset.lockedUntil) {
		return null;
	}
	const lockedUntilMs = Date.parse(preset.lockedUntil);
	if (!Number.isFinite(lockedUntilMs)) {
		return null;
	}
	if (lockedUntilMs > now) {
		return preset.lockedUntil;
	}
	return null;
}

function compareByCreatedAtDesc(a, b) {
	return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

function isFirestoreEnabled() {
	// Issue #721: a published remote value wins over the deployment value, so a
	// remote `false` disables durable presets even though `render.yaml` pins the
	// gate to `true` on the web service. `undefined` means no published value,
	// which is not evidence, so the environment decides.
	const remote = resolveRemoteOverride('ENABLE_FIRESTORE_SCANNER_PRESETS');
	if (typeof remote === 'boolean') {
		return remote;
	}
	return process.env.ENABLE_FIRESTORE_SCANNER_PRESETS === 'true';
}

function markPendingFirestoreDelete(id) {
	pendingFirestoreDeletes.add(id);
	firestoreDeleteGenerations.set(id, (firestoreDeleteGenerations.get(id) || 0) + 1);
}

function normalizeScanList(scans) {
	if (scans === undefined || scans === null) {
		return [...DEFAULT_SCANS];
	}

	if (!Array.isArray(scans)) {
		throw new MarketScannerRequestError('scans must be an array of scan type strings');
	}

	const filtered = scans
		.map((scan) => (typeof scan === 'string' ? scan.trim() : ''))
		.filter(Boolean);

	if (filtered.length === 0) {
		return [...DEFAULT_SCANS];
	}

	const invalid = filtered.filter((scan) => !SUPPORTED_SCAN_TYPES.has(scan));
	if (invalid.length > 0) {
		throw new MarketScannerRequestError(
			`Unsupported scan types: ${invalid.join(', ')}. Supported: ${[...SUPPORTED_SCAN_TYPES].join(', ')}`,
		);
	}

	return filtered;
}

function normalizeLimit(limit) {
	if (limit === undefined || limit === null) {
		return DEFAULT_SCAN_LIMIT;
	}

	const num = Number(limit);
	if (!Number.isFinite(num) || !Number.isInteger(num)) {
		throw new MarketScannerRequestError('limit must be an integer');
	}

	return Math.max(1, Math.min(num, MAX_SCAN_LIMIT));
}

function normalizeBbwThreshold(bbwThreshold) {
	if (bbwThreshold === undefined || bbwThreshold === null) {
		return DEFAULT_BBW_THRESHOLD;
	}

	const num = Number(bbwThreshold);
	if (!Number.isFinite(num)) {
		throw new MarketScannerRequestError('bbw_threshold must be a number');
	}

	return num;
}

class ScannerPresetService {
	constructor() {
		this.firestoreUnavailable = false;
	}

	/**
	 * Reported storage state for `/api/status`, `/api/capabilities`, and every
	 * scanner-preset CRUD response.
	 *
	 * `mode`/`backend` describe configured **intent** — what the service will use once it
	 * can — and must never flip to `memory` while the gate and credentials are in place.
	 * An operator who reads `memory` concludes the flag is off, which is the opposite of
	 * the truth and made a transient read failure indistinguishable from a disabled
	 * feature (#1342).
	 *
	 * `status` separates the three real causes an operator must act on differently:
	 * `disabled` (gate off), `misconfigured` (credentials genuinely absent or rejected —
	 * the only case that means "check your credentials"), and `degraded` (a durable
	 * operation failed and nothing has answered since). `unverified` means no evidence
	 * yet, which is neither healthy nor broken.
	 */
	getStorageStatus() {
		const enabled = isFirestoreEnabled();
		const configured = enabled && isFirestoreConfigured() && Boolean(this._getFirestore());
		const durableIntent = enabled && configured;
		const readiness = resolveStorageReadiness();

		let status;
		if (!enabled) {
			status = 'disabled';
		} else if (!configured) {
			status = 'misconfigured';
		} else if (readiness === READINESS.DEGRADED) {
			status = 'degraded';
		} else if (readiness === READINESS.VERIFIED) {
			status = 'ready';
		} else {
			status = READINESS.UNVERIFIED;
		}

		return {
			enabled,
			configured,
			ready: status === 'ready',
			status,
			mode: durableIntent ? 'durable' : 'ephemeral',
			backend: durableIntent ? 'firestore' : 'memory',
			failOpen: true,
			readiness,
			collection: COLLECTION_NAME,
			operationsAttempted: storageReadiness.operationsAttempted,
			operationsSucceeded: storageReadiness.operationsSucceeded,
			operationsFailed: storageReadiness.operationsFailed,
			consecutiveFailures: storageReadiness.consecutiveFailures,
			lastSuccessAt: storageReadiness.lastSuccessAt,
			lastFailureAt: storageReadiness.lastFailureAt,
			lastErrorReason: storageReadiness.lastErrorReason,
			// Local overlay workload, reported separately because an unsynced or tombstoned
			// record is a pending-sync fact, not a store fault: it must not decide whether
			// the configured durable store is reported as usable.
			pendingWrites: pendingFirestorePresets.size,
			inFlightWrites: inFlightFirestorePresets.size,
			pendingDeletes: pendingFirestoreDeletes.size,
			oldestPendingWriteAt: resolveOldestPendingWriteAt(),
			lastReadFellBack: this.firestoreUnavailable,
		};
	}

	/**
	 * Bounded, single-flight proof that the durable store can actually answer the read
	 * `/api/status` asserts, so `ready` is proven rather than inferred from credential
	 * shape. A readiness probe must issue the operation whose availability it claims: this
	 * is the same indexed query `listPresets()` runs, bounded to one document, and it needs
	 * no composite index beyond the single-field sort `listPresets()` already needs.
	 *
	 * Never throws, so `/api/status` can call it beside its other fail-open telemetry
	 * syncs. A probe that cannot run reports its own gate verdict rather than inventing
	 * readiness.
	 */
	async probeStorageReadiness(options = {}) {
		if (!isFirestoreEnabled() || !isFirestoreConfigured()) {
			return this.getStorageStatus();
		}
		if (probeInFlight) {
			return probeInFlight;
		}
		if (lastProbeStartedAtMs > 0 && (Date.now() - lastProbeStartedAtMs) < PROBE_MIN_INTERVAL_MS) {
			return this.getStorageStatus();
		}

		const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
			? options.timeoutMs
			: PROBE_TIMEOUT_MS;
		lastProbeStartedAtMs = Date.now();
		probeInFlight = this._runStorageReadinessProbe(timeoutMs)
			.catch(() => this.getStorageStatus())
			.finally(() => {
				probeInFlight = null;
			});
		return probeInFlight;
	}

	async _runStorageReadinessProbe(timeoutMs) {
		const firestore = this._getFirestore();
		if (!firestore) {
			recordDurableOutcomeFailed(REASONS.NOT_INITIALIZED);
			return this.getStorageStatus();
		}

		let timer = null;
		try {
			await Promise.race([
				firestore.collection(COLLECTION_NAME).orderBy('createdAt', 'desc').limit(1).get(),
				new Promise((_, reject) => {
					timer = setTimeout(() => reject(new Error(PROBE_TIMEOUT_MESSAGE)), timeoutMs);
					if (timer && typeof timer.unref === 'function') {
						timer.unref();
					}
				}),
			]);
		} catch (error) {
			const timedOut = Boolean(error) && error.message === PROBE_TIMEOUT_MESSAGE;
			this.firestoreUnavailable = true;
			recordDurableOutcomeFailed(timedOut ? REASONS.PROBE_TIMEOUT : REASONS.UNAVAILABLE);
			console.warn('[ScannerPresetService] Durable readiness probe failed:', error && error.message);
			return this.getStorageStatus();
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}

		this.firestoreUnavailable = false;
		recordDurableOutcomeSucceeded();
		return this.getStorageStatus();
	}

	async createPreset(params = {}) {
		const sanitizedParams = { ...params, id: undefined, version: undefined };
		const preset = this._buildPreset(sanitizedParams);
		const conflict = await this._findPresetByName(preset.name);
		if (conflict) {
			throw buildNameConflict(conflict);
		}
		await this._persistPreset(preset);
		return clonePreset(preset);
	}

	async listPresets() {
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore
					.collection(COLLECTION_NAME)
					.orderBy('createdAt', 'desc')
					.get();
				const firestorePresets = snapshot && Array.isArray(snapshot.docs)
					? snapshot.docs.map((doc) => this._formatFirestoreDoc(doc))
					: [];

				this.firestoreUnavailable = false;
				recordDurableOutcomeSucceeded();

				if (hasPendingOverlay()) {
					const mergedPresets = new Map(
						firestorePresets
							.filter((preset) => !pendingFirestoreDeletes.has(preset.id))
							.map((preset) => [preset.id, preset]),
					);
					for (const [id, operation] of inFlightFirestorePresets.entries()) {
						if (!pendingFirestoreDeletes.has(id)) {
							mergedPresets.set(id, clonePreset(operation.preset));
						}
					}
					for (const preset of pendingFirestorePresets.values()) {
						mergedPresets.set(preset.id, clonePreset(preset));
					}
					return [...mergedPresets.values()].sort(compareByCreatedAtDesc);
				}

				return firestorePresets;
			} catch (error) {
				this.firestoreUnavailable = true;
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
				console.warn('[ScannerPresetService] Failed to list presets from Firestore:', error.message);
			}
		}

		return [...memoryPresets.values()].sort(compareByCreatedAtDesc).map(clonePreset);
	}

	async getPreset(id) {
		if (!id) {
			return null;
		}

		const firestore = this._getFirestore();
		if (pendingFirestorePresets.has(id)) {
			return clonePreset(pendingFirestorePresets.get(id));
		}
		if (pendingFirestoreDeletes.has(id)) {
			return null;
		}
		if (inFlightFirestorePresets.has(id)) {
			return clonePreset(inFlightFirestorePresets.get(id).preset);
		}

		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME).doc(id).get();
				this.firestoreUnavailable = false;
				recordDurableOutcomeSucceeded();
				if (snapshot && snapshot.exists) {
					return this._formatFirestoreDoc(snapshot);
				}
				return null;
			} catch (error) {
				this.firestoreUnavailable = true;
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
				console.warn('[ScannerPresetService] Failed to read preset from Firestore:', error.message);
			}
		}

		return clonePreset(memoryPresets.get(id));
	}

	async updatePreset(id, params = {}, options = {}) {
		const deleteGenerationAtReadStart = firestoreDeleteGenerations.get(id) || 0;
		const existing = await this.getPreset(id);
		if (!existing
			|| (firestoreDeleteGenerations.get(id) || 0) !== deleteGenerationAtReadStart
			|| pendingFirestoreDeletes.has(id)) {
			if (options && options.ifMatchVersion !== undefined && options.ifMatchVersion !== null) {
				throw new MarketScannerRequestError(
					'Preset not found',
					'PRESET_NOT_FOUND',
					{ statusCode: 404 },
				);
			}
			return null;
		}

		const ifMatchVersion = options && options.ifMatchVersion !== undefined && options.ifMatchVersion !== null
			? normalizeVersion(options.ifMatchVersion, null)
			: null;
		if (ifMatchVersion !== null && ifMatchVersion !== existing.version) {
			console.debug('[ScannerPresetService] Stale If-Match on updatePreset', {
				presetId: id,
				clientVersion: ifMatchVersion,
				currentVersion: existing.version,
			});
			throw buildPreconditionFailed(existing);
		}

		const lockedUntil = isPresetLocked(existing);
		if (lockedUntil) {
			console.debug('[ScannerPresetService] Preset locked during updatePreset', {
				presetId: id,
				lockedUntil,
				currentVersion: existing.version,
			});
			throw buildPresetLocked(existing, lockedUntil);
		}

		const preset = this._buildPreset({
			...existing,
			...params,
			id: existing.id,
			createdAt: existing.createdAt,
			version: existing.version + 1,
		});
		preset.updatedAt = new Date().toISOString();
		preset.createdAt = existing.createdAt;

		// Enforce case-insensitive unique name across presets. Skipping when
		// the new name normalizes to the existing preset's own name lets the
		// preset rename itself with a case-only change without tripping the
		// uniqueness check (an explicit acceptance criterion in #875).
		const desiredKey = normalizeNameKey(preset.name);
		const existingKey = normalizeNameKey(existing.name);
		if (desiredKey !== existingKey) {
			const conflict = await this._findPresetByName(preset.name);
			if (conflict && conflict.id !== existing.id) {
				throw buildNameConflict(conflict);
			}
		}

		const persisted = await this._persistPreset(preset, deleteGenerationAtReadStart, {
			expectedVersion: existing.version,
		});
		if (!persisted) {
			const latest = await this.getPreset(id);
			if (latest && ifMatchVersion !== null && latest.version !== existing.version) {
				throw buildPreconditionFailed(latest);
			}
			return null;
		}
		return clonePreset(preset);
	}

	async deletePreset(id, options = {}) {
		if (!id) {
			return false;
		}

		const ifMatchVersion = options && options.ifMatchVersion !== undefined && options.ifMatchVersion !== null
			? normalizeVersion(options.ifMatchVersion, null)
			: null;
		if (ifMatchVersion !== null) {
			const existing = await this.getPreset(id);
			if (!existing) {
				throw new MarketScannerRequestError('Preset not found', 'PRESET_NOT_FOUND', { statusCode: 404 });
			}
			if (ifMatchVersion !== existing.version) {
				console.debug('[ScannerPresetService] Stale If-Match on deletePreset', {
					presetId: id,
					clientVersion: ifMatchVersion,
					currentVersion: existing.version,
				});
				throw buildPreconditionFailed(existing);
			}
		}

		let deleted = false;
		const firestore = this._getFirestore();
		const hadLocalPreset = memoryPresets.has(id) || pendingFirestorePresets.has(id);
		pendingFirestorePresets.delete(id);
		if (isFirestoreEnabled() && hadLocalPreset) {
			markPendingFirestoreDelete(id);
		}
		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME).doc(id).get();
				if ((snapshot && snapshot.exists) || hadLocalPreset) {
					deleted = Boolean(snapshot && snapshot.exists) || hadLocalPreset;
					if (snapshot && snapshot.exists && isFirestoreEnabled() && !pendingFirestoreDeletes.has(id)) {
						markPendingFirestoreDelete(id);
					}
					await this._deleteFirestorePreset(firestore, id);
					pendingFirestoreDeletes.delete(id);
				}
				this.firestoreUnavailable = false;
				recordDurableOutcomeSucceeded();
			} catch (error) {
				this.firestoreUnavailable = true;
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
				console.warn('[ScannerPresetService] Failed to delete preset from Firestore:', error.message);
			}
		}

		if (memoryPresets.delete(id)) {
			deleted = true;
		}

		return deleted;
	}

	_buildPreset(params = {}) {
		const name = this._parseName(params.name);
		const exchange = this._parseExchange(params.exchange);
		const timeframe = this._parseTimeframe(params.timeframe);
		const scans = normalizeScanList(params.scans);
		const limit = normalizeLimit(params.limit);
		const bbwThreshold = normalizeBbwThreshold(params.bbwThreshold);
		const schedule = normalizeSchedule(params.schedule);
		const routing = this._parseRouting(params);
		const id = typeof params.id === 'string' && params.id.trim() ? params.id.trim() : uuidv4();
		const createdAt = typeof params.createdAt === 'string' && params.createdAt.trim()
			? params.createdAt.trim()
			: new Date().toISOString();
		const updatedAt = typeof params.updatedAt === 'string' && params.updatedAt.trim()
			? params.updatedAt.trim()
			: createdAt;

		let nextRunAt = typeof params.nextRunAt === 'string' && params.nextRunAt.trim()
			? params.nextRunAt.trim()
			: null;
		if (schedule.enabled) {
			if (!nextRunAt) {
				nextRunAt = new Date(Date.now() + schedule.cadenceMs).toISOString();
			}
		} else {
			nextRunAt = null;
		}

		const lastRunAt = typeof params.lastRunAt === 'string' && params.lastRunAt.trim()
			? params.lastRunAt.trim()
			: null;
		const lastStatus = typeof params.lastStatus === 'string' && params.lastStatus.trim()
			? params.lastStatus.trim()
			: null;
		const lastError = typeof params.lastError === 'string'
			? params.lastError
			: null;
		const lastDurationMs = Number.isFinite(Number(params.lastDurationMs))
			? Number(params.lastDurationMs)
			: null;
		const lockedUntil = typeof params.lockedUntil === 'string' && params.lockedUntil.trim()
			? params.lockedUntil.trim()
			: null;
		const lockedBy = typeof params.lockedBy === 'string' && params.lockedBy.trim()
			? params.lockedBy.trim()
			: null;
		const version = normalizeVersion(params.version, 1);

		const preset = {
			id,
			name,
			nameKey: normalizeNameKey(name),
			exchange,
			timeframe,
			scans,
			limit,
			bbwThreshold,
			schedule,
			createdAt,
			updatedAt,
			lastRunAt,
			nextRunAt,
			lastStatus,
			lastError,
			lastDurationMs,
			lockedUntil,
			lockedBy,
			version,
		};

		if (params.ranked !== undefined) preset.ranked = Boolean(params.ranked);
		if (params.includeMultiTimeframe !== undefined) {
			preset.includeMultiTimeframe = Boolean(params.includeMultiTimeframe);
		} else if (params.include_multi_timeframe !== undefined) {
			preset.includeMultiTimeframe = Boolean(params.include_multi_timeframe);
		}

		if (routing.channels !== undefined) preset.channels = routing.channels;
		if (routing.telegramChatId !== undefined) preset.telegramChatId = routing.telegramChatId;
		if (routing.telegramThreadId !== undefined) preset.telegramThreadId = routing.telegramThreadId;
		if (routing.whatsappChatId !== undefined) preset.whatsappChatId = routing.whatsappChatId;
		if (routing.discordWebhookUrl !== undefined) preset.discordWebhookUrl = routing.discordWebhookUrl;

		return preset;
	}

	_parseRouting(params = {}) {
		const routing = {};
		if (params.channels !== undefined) {
			if (params.channels === null) {
				// unset
			} else if (Array.isArray(params.channels)) {
				const validChannels = ['telegram', 'whatsapp', 'discord'];
				const unique = Array.from(new Set(params.channels.map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : '')))).filter(Boolean);
				if (unique.length === 0) {
					throw new MarketScannerRequestError('"channels" must be a non-empty array if provided');
				}
				const invalid = unique.filter((c) => !validChannels.includes(c));
				if (invalid.length > 0) {
					throw new MarketScannerRequestError(`Unknown channel(s): ${invalid.join(', ')}. Valid channels: ${validChannels.join(', ')}`);
				}
				routing.channels = unique;
			} else {
				throw new MarketScannerRequestError('"channels" must be an array if provided');
			}
		}

		if (params.telegramChatId !== undefined) {
			if (params.telegramChatId === null || params.telegramChatId === '') {
				// unset
			} else if (typeof params.telegramChatId === 'string' && params.telegramChatId.trim()) {
				routing.telegramChatId = params.telegramChatId.trim();
			} else {
				throw new MarketScannerRequestError('"telegramChatId" must be a non-empty string if provided');
			}
		}

		if (params.telegramThreadId !== undefined) {
			if (params.telegramThreadId === null || params.telegramThreadId === '') {
				// unset
			} else {
				const raw = typeof params.telegramThreadId === 'string' ? params.telegramThreadId.trim() : params.telegramThreadId;
				const num = Number(raw);
				if (!Number.isSafeInteger(num) || num < 0) {
					throw new MarketScannerRequestError('"telegramThreadId" must be a non-negative integer if provided');
				}
				routing.telegramThreadId = num;
			}
		}

		if (params.whatsappChatId !== undefined) {
			if (params.whatsappChatId === null || params.whatsappChatId === '') {
				// unset
			} else if (typeof params.whatsappChatId === 'string' && params.whatsappChatId.trim()) {
				routing.whatsappChatId = params.whatsappChatId.trim();
			} else {
				throw new MarketScannerRequestError('"whatsappChatId" must be a non-empty string if provided');
			}
		}

		if (params.discordWebhookUrl !== undefined) {
			if (params.discordWebhookUrl === null || params.discordWebhookUrl === '') {
				// unset
			} else if (typeof params.discordWebhookUrl === 'string' && params.discordWebhookUrl.trim()) {
				try {
					const url = new URL(params.discordWebhookUrl.trim());
					if (url.protocol !== 'https:') {
						throw new Error('must be https');
					}
					routing.discordWebhookUrl = params.discordWebhookUrl.trim();
				} catch {
					throw new MarketScannerRequestError('"discordWebhookUrl" must be a valid https URL if provided');
				}
			} else {
				throw new MarketScannerRequestError('"discordWebhookUrl" must be a valid https URL if provided');
			}
		}

		return routing;
	}

	_parseName(name) {
		if (name === undefined || name === null || name === '') {
			return '';
		}

		if (typeof name !== 'string') {
			throw new MarketScannerRequestError('name must be a string');
		}

		return name.trim();
	}

	_parseExchange(exchange) {
		if (exchange === undefined || exchange === null) {
			return (process.env.MARKET_SCANNER_DEFAULT_EXCHANGE || DEFAULT_EXCHANGE).toUpperCase();
		}

		if (typeof exchange !== 'string' || !exchange.trim()) {
			throw new MarketScannerRequestError('exchange must be a non-empty string');
		}

		return exchange.trim().toUpperCase();
	}

	_parseTimeframe(timeframe) {
		if (timeframe === undefined || timeframe === null) {
			return normalizeTradingViewTimeframe(DEFAULT_TIMEFRAME, '4h');
		}

		if (typeof timeframe !== 'string') {
			throw new MarketScannerRequestError('timeframe must be a string');
		}

		const raw = timeframe.trim();
		if (!raw) {
			return normalizeTradingViewTimeframe(DEFAULT_TIMEFRAME, '4h');
		}

		const normalizedToken = raw.toUpperCase();
		if (!SUPPORTED_MCP_TIMEFRAMES.has(raw) && !SUPPORTED_TIMEFRAME_ALIASES.has(normalizedToken)) {
			throw new MarketScannerRequestError(`Unsupported timeframe: ${raw}`);
		}

		return normalizeTradingViewTimeframe(raw, '4h');
	}

	async _persistPreset(preset, expectedDeleteGeneration = null, options = {}) {
		const expectedVersion = options && Number.isInteger(options.expectedVersion)
			? options.expectedVersion
			: null;
		const firestore = this._getFirestore();
		if (!firestore) {
			return this._persistInMemoryPreset(preset, expectedDeleteGeneration, expectedVersion);
		}
		return this._persistFirestorePreset(preset, expectedDeleteGeneration, expectedVersion);
	}

	async _persistInMemoryPreset(preset, expectedDeleteGeneration, expectedVersion) {
		const previousLock = inMemoryWriteLocks.get(preset.id) || Promise.resolve();
		let release;
		const nextLock = new Promise((resolve) => {
			release = resolve;
		});
		const chainedLock = previousLock.then(() => nextLock);
		inMemoryWriteLocks.set(preset.id, chainedLock);
		try {
			await previousLock;
			const currentDeleteGeneration = firestoreDeleteGenerations.get(preset.id) || 0;
			if (expectedDeleteGeneration !== null
				&& (currentDeleteGeneration !== expectedDeleteGeneration || pendingFirestoreDeletes.has(preset.id))) {
				return false;
			}
			if (expectedVersion !== null) {
				const current = memoryPresets.get(preset.id);
				const currentVersion = current ? normalizeVersion(current.version, null) : null;
				if (currentVersion === null || currentVersion !== expectedVersion) {
					return false;
				}
			}
			memoryPresets.set(preset.id, clonePreset(preset));
			pendingFirestoreDeletes.delete(preset.id);
			if (isFirestoreEnabled()) {
				pendingFirestoreWriteTokens.set(preset.id, {});
				pendingFirestorePresets.set(preset.id, clonePreset(preset));
			} else {
				pendingFirestoreWriteTokens.delete(preset.id);
			}
			return true;
		} finally {
			release();
			if (inMemoryWriteLocks.get(preset.id) === chainedLock) {
				inMemoryWriteLocks.delete(preset.id);
			}
		}
	}

	async _persistFirestorePreset(preset, expectedDeleteGeneration, expectedVersion) {
		const currentDeleteGeneration = firestoreDeleteGenerations.get(preset.id) || 0;
		if (expectedDeleteGeneration !== null
			&& (currentDeleteGeneration !== expectedDeleteGeneration || pendingFirestoreDeletes.has(preset.id))) {
			return false;
		}

		const firestore = this._getFirestore();
		if (!firestore) {
			return this._persistInMemoryPreset(preset, expectedDeleteGeneration, expectedVersion);
		}

		memoryPresets.set(preset.id, clonePreset(preset));
		const deleteGenerationAtStart = expectedDeleteGeneration === null
			? currentDeleteGeneration
			: expectedDeleteGeneration;
		pendingFirestoreDeletes.delete(preset.id);

		const pendingWriteToken = {};
		pendingFirestoreWriteTokens.set(preset.id, pendingWriteToken);
		pendingFirestorePresets.delete(preset.id);
		const inFlightWrite = { preset: clonePreset(preset) };
		inFlightFirestorePresets.set(preset.id, inFlightWrite);
		let versionMismatch = false;
		try {
			await this._writeFirestorePreset(firestore, preset, expectedVersion);
			if (pendingFirestoreWriteTokens.get(preset.id) === pendingWriteToken) {
				pendingFirestorePresets.delete(preset.id);
				pendingFirestoreWriteTokens.delete(preset.id);
			}
			if ((firestoreDeleteGenerations.get(preset.id) || 0) === deleteGenerationAtStart) {
				pendingFirestoreDeletes.delete(preset.id);
			}
			await this._flushPendingDeletes(firestore);
			await this._flushPendingPresets(firestore);
			this.firestoreUnavailable = false;
			recordDurableOutcomeSucceeded();
		} catch (error) {
			if (error && error.code === 'version-mismatch') {
				versionMismatch = true;
			}
			if (pendingFirestoreWriteTokens.get(preset.id) === pendingWriteToken) {
				if (versionMismatch) {
					pendingFirestoreWriteTokens.delete(preset.id);
					pendingFirestorePresets.delete(preset.id);
					memoryPresets.delete(preset.id);
				} else if ((firestoreDeleteGenerations.get(preset.id) || 0) === deleteGenerationAtStart) {
					pendingFirestorePresets.set(preset.id, clonePreset(preset));
				} else {
					pendingFirestorePresets.delete(preset.id);
					pendingFirestoreWriteTokens.delete(preset.id);
				}
			}
			this.firestoreUnavailable = !versionMismatch;
			if (!versionMismatch) {
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
				console.warn('[ScannerPresetService] Failed to persist preset to Firestore:', error.message);
			}
		} finally {
			if (inFlightFirestorePresets.get(preset.id) === inFlightWrite) {
				inFlightFirestorePresets.delete(preset.id);
			}
		}

		if (versionMismatch) {
			return false;
		}
		return true;
	}

	async _flushPendingDeletes(firestore) {
		for (const id of [...pendingFirestoreDeletes]) {
			try {
				await this._deleteFirestorePreset(firestore, id);
				pendingFirestoreDeletes.delete(id);
			} catch (error) {
				this.firestoreUnavailable = true;
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
				console.warn('[ScannerPresetService] Failed to flush pending preset deletion to Firestore:', error.message);
			}
		}
	}

	async _flushPendingPresets(firestore) {
		for (const id of [...pendingFirestorePresets.keys()]) {
			const preset = pendingFirestorePresets.get(id);
			if (!preset) {
				continue;
			}
			const deleteGenerationAtStart = firestoreDeleteGenerations.get(id) || 0;
			const pendingWriteToken = pendingFirestoreWriteTokens.get(id);
			pendingFirestorePresets.delete(id);
			const inFlightWrite = { preset: clonePreset(preset) };
			inFlightFirestorePresets.set(id, inFlightWrite);
			try {
				await this._writeFirestorePreset(firestore, preset);
				if (pendingFirestoreWriteTokens.get(id) === pendingWriteToken) {
					pendingFirestoreWriteTokens.delete(id);
				}
				recordDurableOutcomeSucceeded();
			} catch (error) {
				if (pendingFirestoreWriteTokens.get(id) === pendingWriteToken
					&& (firestoreDeleteGenerations.get(id) || 0) === deleteGenerationAtStart
					&& !pendingFirestorePresets.has(id)) {
					pendingFirestorePresets.set(id, preset);
				}
				this.firestoreUnavailable = true;
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
				console.warn('[ScannerPresetService] Failed to flush pending preset to Firestore:', error.message);
			} finally {
				if (inFlightFirestorePresets.get(id) === inFlightWrite) {
					inFlightFirestorePresets.delete(id);
				}
			}
		}
	}

	async _writeFirestorePreset(firestore, preset, expectedVersion = null) {
		const previousWrite = firestoreWriteQueues.get(preset.id) || Promise.resolve();
		const currentWrite = previousWrite
			.catch(() => undefined)
			.then(async () => {
				if (expectedVersion !== null) {
					const snapshot = await firestore.collection(COLLECTION_NAME).doc(preset.id).get();
					if (!snapshot || !snapshot.exists) {
						const err = new Error('preset missing during compare-and-set');
						err.code = 'version-mismatch';
						throw err;
					}
					const data = snapshot.data() || {};
					const remoteVersion = normalizeVersion(data.version, null);
					if (remoteVersion !== expectedVersion) {
						const err = new Error(`stale version during compare-and-set (expected ${expectedVersion}, got ${remoteVersion})`);
						err.code = 'version-mismatch';
						throw err;
					}
				}
				await firestore.collection(COLLECTION_NAME).doc(preset.id).set(stripUndefinedFieldsDeep({
					...clonePreset(preset),
				}));
			});
		firestoreWriteQueues.set(preset.id, currentWrite);

		try {
			await currentWrite;
		} finally {
			if (firestoreWriteQueues.get(preset.id) === currentWrite) {
				firestoreWriteQueues.delete(preset.id);
			}
		}
	}

	async _deleteFirestorePreset(firestore, id) {
		const previousWrite = firestoreWriteQueues.get(id) || Promise.resolve();
		const currentWrite = previousWrite
			.catch(() => undefined)
			.then(() => firestore.collection(COLLECTION_NAME).doc(id).delete());
		firestoreWriteQueues.set(id, currentWrite);

		try {
			await currentWrite;
		} finally {
			if (firestoreWriteQueues.get(id) === currentWrite) {
				firestoreWriteQueues.delete(id);
			}
		}
	}

	_getFirestore() {
		return isFirestoreEnabled() ? alertStorageService.getFirestore() : null;
	}

	async _findPresetByName(name) {
		const key = normalizeNameKey(name);
		if (!key) {
			return null;
		}

		// In-memory presets (canonical source for ephemeral mode and for
		// pending writes against durable Firestore storage).
		for (const preset of memoryPresets.values()) {
			if (!preset || pendingFirestoreDeletes.has(preset.id)) {
				continue;
			}
			if (normalizeNameKey(preset.name) === key) {
				return preset;
			}
		}

		for (const operation of inFlightFirestorePresets.values()) {
			const preset = operation && operation.preset;
			if (!preset || pendingFirestoreDeletes.has(preset.id)) {
				continue;
			}
			if (normalizeNameKey(preset.name) === key) {
				return preset;
			}
		}

		for (const preset of pendingFirestorePresets.values()) {
			if (!preset || pendingFirestoreDeletes.has(preset.id)) {
				continue;
			}
			if (normalizeNameKey(preset.name) === key) {
				return preset;
			}
		}

		// Durable Firestore store: query by normalized lowercase name when the
		// caller has opted into Firestore scanner storage. When the query
		// fails, log + fall through so the write can succeed (fail-open).
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore
					.collection(COLLECTION_NAME)
					.where('nameKey', '==', key)
					.limit(1)
					.get();
				if (snapshot && Array.isArray(snapshot.docs) && snapshot.docs.length > 0) {
					recordDurableOutcomeSucceeded();
					return this._formatFirestoreDoc(snapshot.docs[0]);
				}
				recordDurableOutcomeSucceeded();
			} catch (error) {
				console.warn('[ScannerPresetService] Failed to query presets by name from Firestore:', error.message);
				this.firestoreUnavailable = true;
				recordDurableOutcomeFailed(REASONS.UNAVAILABLE);
			}
		}

		return null;
	}

	_formatFirestoreDoc(doc) {
		const data = doc.data() || {};
		const schedule = data.schedule && typeof data.schedule === 'object'
			? {
				enabled: Boolean(data.schedule.enabled),
				cadence: typeof data.schedule.cadence === 'string' ? data.schedule.cadence : '1h',
				cadenceMs: Number.isInteger(data.schedule.cadenceMs) ? data.schedule.cadenceMs : parseCadenceToMs(data.schedule.cadence || '1h'),
			}
			: { enabled: false, cadence: '1h', cadenceMs: 3600000 };

		const preset = {
			id: doc.id,
			name: typeof data.name === 'string' ? data.name : '',
			exchange: typeof data.exchange === 'string' ? data.exchange : DEFAULT_EXCHANGE,
			timeframe: typeof data.timeframe === 'string'
				? data.timeframe
				: normalizeTradingViewTimeframe(DEFAULT_TIMEFRAME, '4h'),
			scans: Array.isArray(data.scans) ? data.scans.filter((scan) => typeof scan === 'string') : [...DEFAULT_SCANS],
			limit: Number.isInteger(data.limit) ? data.limit : DEFAULT_SCAN_LIMIT,
			bbwThreshold: Number.isFinite(Number(data.bbwThreshold)) ? Number(data.bbwThreshold) : DEFAULT_BBW_THRESHOLD,
			schedule,
			createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
			updatedAt: typeof data.updatedAt === 'string'
				? data.updatedAt
				: (typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString()),
			lastRunAt: typeof data.lastRunAt === 'string' ? data.lastRunAt : null,
			nextRunAt: typeof data.nextRunAt === 'string' ? data.nextRunAt : null,
			lastStatus: typeof data.lastStatus === 'string' ? data.lastStatus : null,
			lastError: typeof data.lastError === 'string' ? data.lastError : null,
			lastDurationMs: Number.isFinite(Number(data.lastDurationMs)) ? Number(data.lastDurationMs) : null,
			lockedUntil: typeof data.lockedUntil === 'string' ? data.lockedUntil : null,
			lockedBy: typeof data.lockedBy === 'string' ? data.lockedBy : null,
			version: normalizeVersion(data.version, 1),
		};

		if (typeof data.ranked === 'boolean') preset.ranked = data.ranked;
		if (typeof data.includeMultiTimeframe === 'boolean') {
			preset.includeMultiTimeframe = data.includeMultiTimeframe;
		} else if (typeof data.include_multi_timeframe === 'boolean') {
			preset.includeMultiTimeframe = data.include_multi_timeframe;
		}

		if (Array.isArray(data.channels)) preset.channels = data.channels.filter((c) => typeof c === 'string');
		if (typeof data.telegramChatId === 'string') preset.telegramChatId = data.telegramChatId;
		if (typeof data.telegramThreadId === 'number' && Number.isSafeInteger(data.telegramThreadId) && data.telegramThreadId >= 0) preset.telegramThreadId = data.telegramThreadId;
		if (typeof data.whatsappChatId === 'string') preset.whatsappChatId = data.whatsappChatId;
		if (typeof data.discordWebhookUrl === 'string') preset.discordWebhookUrl = data.discordWebhookUrl;

		return clonePreset(preset);
	}

	_resetForTesting() {
		memoryPresets.clear();
		pendingFirestorePresets.clear();
		inFlightFirestorePresets.clear();
		pendingFirestoreDeletes.clear();
		firestoreDeleteGenerations.clear();
		pendingFirestoreWriteTokens.clear();
		firestoreWriteQueues.clear();
		inMemoryWriteLocks.clear();
		resetStorageReadiness();
		this.firestoreUnavailable = false;
	}
}

const scannerPresetService = new ScannerPresetService();

module.exports = {
	ScannerPresetService,
	scannerPresetService,
	COLLECTION_NAME,
	parseCadenceToMs,
	normalizeSchedule,
	stripUndefinedFieldsDeep,
	normalizeVersion,
	formatEtag,
	parseIfMatchHeader,
	REASONS,
	READINESS,
	// Test helper
	_resetForTesting() {
		scannerPresetService._resetForTesting();
	},
	_memoryPresets: memoryPresets,
	inMemoryWriteLocks,
	pendingFirestorePresets,
	inFlightFirestorePresets,
	pendingFirestoreDeletes,
};
