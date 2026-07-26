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
const firestoreWriteQueues = new Map();

function clonePreset(preset) {
	if (!preset) return null;
	return {
		...preset,
		scans: Array.isArray(preset.scans) ? [...preset.scans] : [...DEFAULT_SCANS],
	};
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

	async updatePreset(id, params = {}) {
		const existing = await this.getPreset(id);
		if (!existing) {
			return null;
		}

		const preset = this._buildPreset({
			...existing,
			...params,
			id: existing.id,
			createdAt: existing.createdAt,
		});
		preset.updatedAt = new Date().toISOString();
		preset.createdAt = existing.createdAt;

		await this._persistPreset(preset);
		return clonePreset(preset);
	}

	async deletePreset(id) {
		if (!id) {
			return false;
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
		const id = typeof params.id === 'string' && params.id.trim() ? params.id.trim() : uuidv4();
		const createdAt = typeof params.createdAt === 'string' && params.createdAt.trim()
			? params.createdAt.trim()
			: new Date().toISOString();
		const updatedAt = typeof params.updatedAt === 'string' && params.updatedAt.trim()
			? params.updatedAt.trim()
			: createdAt;

		return {
			id,
			name,
			exchange,
			timeframe,
			scans,
			limit,
			bbwThreshold,
			createdAt,
			updatedAt,
		};
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

	async _persistPreset(preset) {
		memoryPresets.set(preset.id, clonePreset(preset));
		const deleteGenerationAtStart = firestoreDeleteGenerations.get(preset.id) || 0;
		pendingFirestoreDeletes.delete(preset.id);

		const firestore = this._getFirestore();
		if (!firestore) {
			if (isFirestoreEnabled()) {
				pendingFirestorePresets.set(preset.id, clonePreset(preset));
			}
			return;
		}

		pendingFirestorePresets.delete(preset.id);
		const inFlightWrite = { preset: clonePreset(preset) };
		inFlightFirestorePresets.set(preset.id, inFlightWrite);
		try {
			await this._writeFirestorePreset(firestore, preset);
			pendingFirestorePresets.delete(preset.id);
			if ((firestoreDeleteGenerations.get(preset.id) || 0) === deleteGenerationAtStart) {
				pendingFirestoreDeletes.delete(preset.id);
			}
			await this._flushPendingDeletes(firestore);
			await this._flushPendingPresets(firestore);
			this.firestoreUnavailable = pendingFirestorePresets.size > 0 || pendingFirestoreDeletes.size > 0;
		} catch (error) {
			if ((firestoreDeleteGenerations.get(preset.id) || 0) === deleteGenerationAtStart) {
				pendingFirestorePresets.set(preset.id, clonePreset(preset));
			} else {
				pendingFirestorePresets.delete(preset.id);
			}
			this.firestoreUnavailable = true;
			console.warn('[ScannerPresetService] Failed to persist preset to Firestore:', error.message);
		} finally {
			if (inFlightFirestorePresets.get(preset.id) === inFlightWrite) {
				inFlightFirestorePresets.delete(preset.id);
			}
		}
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
			pendingFirestorePresets.delete(id);
			const inFlightWrite = { preset: clonePreset(preset) };
			inFlightFirestorePresets.set(id, inFlightWrite);
			try {
				await this._writeFirestorePreset(firestore, preset);
			} catch (error) {
				if ((firestoreDeleteGenerations.get(id) || 0) === deleteGenerationAtStart
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

	async _writeFirestorePreset(firestore, preset) {
		const previousWrite = firestoreWriteQueues.get(preset.id) || Promise.resolve();
		const currentWrite = previousWrite
			.catch(() => undefined)
			.then(() => firestore.collection(COLLECTION_NAME).doc(preset.id).set({
				...clonePreset(preset),
			}));
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
			createdAt: typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString(),
			updatedAt: typeof data.updatedAt === 'string'
				? data.updatedAt
				: (typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString()),
		};

		return clonePreset(preset);
	}
}

const scannerPresetService = new ScannerPresetService();

module.exports = {
	ScannerPresetService,
	scannerPresetService,
	COLLECTION_NAME,
	// Test helper
	_resetForTesting() {
		memoryPresets.clear();
		pendingFirestorePresets.clear();
		inFlightFirestorePresets.clear();
		pendingFirestoreDeletes.clear();
		firestoreDeleteGenerations.clear();
		firestoreWriteQueues.clear();
		scannerPresetService.firestoreUnavailable = false;
	},
};
