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
	return cloned;
}

function normalizeVersion(value, fallback = 1) {
	const num = Number(value);
	if (!Number.isInteger(num) || num < 1) {
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

	getStorageStatus() {
		const firestoreEnabled = isFirestoreEnabled();
		const firestore = this._getFirestore();
		const durable = Boolean(firestore)
			&& !this.firestoreUnavailable
			&& pendingFirestorePresets.size === 0
			&& inFlightFirestorePresets.size === 0
			&& pendingFirestoreDeletes.size === 0
			&& isFirestoreConfigured();

		return {
			enabled: firestoreEnabled,
			configured: durable,
			ready: durable,
			status: durable ? 'ready' : firestoreEnabled ? 'misconfigured' : 'disabled',
			mode: durable ? 'durable' : 'ephemeral',
			backend: durable ? 'firestore' : 'memory',
		};
	}

	async createPreset(params = {}) {
		const preset = this._buildPreset({ ...params, id: undefined });
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

				if (pendingFirestorePresets.size > 0
					|| inFlightFirestorePresets.size > 0
					|| pendingFirestoreDeletes.size > 0) {
					this.firestoreUnavailable = true;
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

				this.firestoreUnavailable = false;
				return firestorePresets;
			} catch (error) {
				this.firestoreUnavailable = true;
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
				this.firestoreUnavailable = pendingFirestorePresets.size > 0
					|| inFlightFirestorePresets.size > 0
					|| pendingFirestoreDeletes.size > 0;
				if (snapshot && snapshot.exists) {
					return this._formatFirestoreDoc(snapshot);
				}
				return null;
			} catch (error) {
				this.firestoreUnavailable = true;
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
				this.firestoreUnavailable = pendingFirestorePresets.size > 0 || pendingFirestoreDeletes.size > 0;
			} catch (error) {
				this.firestoreUnavailable = true;
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
		inMemoryWriteLocks.set(preset.id, previousLock.then(() => nextLock));
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
			if (inMemoryWriteLocks.get(preset.id) === previousLock.then(() => nextLock)) {
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
			this.firestoreUnavailable = pendingFirestorePresets.size > 0 || pendingFirestoreDeletes.size > 0;
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
			} catch (error) {
				if (pendingFirestoreWriteTokens.get(id) === pendingWriteToken
					&& (firestoreDeleteGenerations.get(id) || 0) === deleteGenerationAtStart
					&& !pendingFirestorePresets.has(id)) {
					pendingFirestorePresets.set(id, preset);
				}
				this.firestoreUnavailable = true;
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
	// Test helper
	_resetForTesting() {
		scannerPresetService._resetForTesting();
	},
	_memoryPresets: memoryPresets,
};
