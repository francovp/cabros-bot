'use strict';

const { v4: uuidv4 } = require('uuid');
const {
	MarketScannerRequestError,
	SUPPORTED_SCAN_TYPES,
} = require('../tradingview/marketScannerReport');

const DEFAULT_SCAN_LIMIT = 5;
const MAX_SCAN_LIMIT = 20;
const DEFAULT_EXCHANGE = 'BINANCE';
const SUPPORTED_TIMEFRAME_ALIASES = new Set([
	'5', '5M', '15', '15M', '60', '1H', '240', '4H',
	'1440', 'D', '1D', '10080', 'W', '1W', '43200', 'M', '1M',
]);

class ScannerPresetService {
	constructor() {
		this.presets = new Map();
	}

	/**
	 * Validates and creates a scanner preset.
	 * @param {Object} params
	 * @param {string} [params.name] - Optional human label
	 * @param {string} params.exchange - Exchange identifier
	 * @param {string} params.timeframe - Timeframe string
	 * @param {string[]} params.scans - Array of scan types
	 * @param {number} params.limit - Results limit per scan
	 * @param {number} params.bbwThreshold - Bollinger Band Width threshold
	 * @returns {Object} The created preset
	 * @throws {MarketScannerRequestError} On validation failure
	 */
	createPreset(params = {}) {
		const name = this._parseName(params.name);
		const exchange = this._parseExchange(params.exchange);
		const timeframe = this._parseTimeframe(params.timeframe);
		const scans = this._parseScans(params.scans);
		const limit = this._parseLimit(params.limit);
		const bbwThreshold = this._parseBbwThreshold(params.bbwThreshold);

		const id = uuidv4();
		const now = new Date().toISOString();
		const preset = {
			id,
			name,
			exchange,
			timeframe,
			scans,
			limit,
			bbwThreshold,
			createdAt: now,
			updatedAt: now,
		};

		this.presets.set(id, preset);
		return { ...preset };
	}

	/**
	 * Lists all stored presets, newest first.
	 * @returns {Object[]}
	 */
	listPresets() {
		const entries = [...this.presets.values()];
		return entries.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
	}

	/**
	 * Retrieves a single preset by ID.
	 * @param {string} id
	 * @returns {Object|null}
	 */
	getPreset(id) {
		if (!id) return null;
		const preset = this.presets.get(id);
		if (!preset) return null;
		return { ...preset };
	}

	/**
	 * Deletes a preset by ID.
	 * @param {string} id
	 * @returns {boolean} Whether the preset was found and deleted
	 */
	deletePreset(id) {
		if (!id) return false;
		return this.presets.delete(id);
	}

	/**
	 * Validates and updates an existing preset.
	 * @param {string} id
	 * @param {Object} params - Partial fields to update
	 * @returns {Object|null} Updated preset, or null if not found
	 * @throws {MarketScannerRequestError} On validation failure
	 */
	updatePreset(id, params = {}) {
		const existing = this.presets.get(id);
		if (!existing) return null;

		const name = params.name !== undefined ? this._parseName(params.name) : existing.name;
		const exchange = params.exchange !== undefined ? this._parseExchange(params.exchange) : existing.exchange;
		const timeframe = params.timeframe !== undefined ? this._parseTimeframe(params.timeframe) : existing.timeframe;
		const scans = params.scans !== undefined ? this._parseScans(params.scans) : existing.scans;
		const limit = params.limit !== undefined ? this._parseLimit(params.limit) : existing.limit;
		const bbwThreshold = params.bbwThreshold !== undefined ? this._parseBbwThreshold(params.bbwThreshold) : existing.bbwThreshold;

		const updated = {
			...existing,
			name,
			exchange,
			timeframe,
			scans,
			limit,
			bbwThreshold,
			updatedAt: new Date().toISOString(),
		};

		this.presets.set(id, updated);
		return { ...updated };
	}

	// --- Private validation helpers ---

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
			return process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '4h';
		}
		if (typeof timeframe !== 'string') {
			throw new MarketScannerRequestError('timeframe must be a string');
		}
		const raw = timeframe.trim();
		if (!raw) {
			return process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '4h';
		}
		const normalizedToken = raw.toUpperCase();
		if (!SUPPORTED_TIMEFRAME_ALIASES.has(normalizedToken)) {
			throw new MarketScannerRequestError(`Unsupported timeframe: ${raw}`);
		}
		// Normalize using existing mapping
		return this._normalizeTimeframe(raw);
	}

	_parseScans(scans) {
		if (scans === undefined || scans === null) {
			return ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
		}
		if (!Array.isArray(scans)) {
			throw new MarketScannerRequestError('scans must be an array of scan type strings');
		}
		const filtered = scans
			.map((s) => (typeof s === 'string' ? s.trim() : ''))
			.filter(Boolean);
		if (filtered.length === 0) {
			return ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
		}
		const invalid = filtered.filter((s) => !SUPPORTED_SCAN_TYPES.has(s));
		if (invalid.length > 0) {
			throw new MarketScannerRequestError(
				`Unsupported scan types: ${invalid.join(', ')}. Supported: ${[...SUPPORTED_SCAN_TYPES].join(', ')}`,
			);
		}
		return filtered;
	}

	_parseLimit(limit) {
		if (limit === undefined || limit === null) {
			return DEFAULT_SCAN_LIMIT;
		}
		const num = Number(limit);
		if (!Number.isFinite(num) || !Number.isInteger(num)) {
			throw new MarketScannerRequestError('limit must be an integer');
		}
		return Math.max(1, Math.min(num, MAX_SCAN_LIMIT));
	}

	_parseBbwThreshold(bbwThreshold) {
		if (bbwThreshold === undefined || bbwThreshold === null) {
			return 0.05;
		}
		const num = Number(bbwThreshold);
		if (!Number.isFinite(num)) {
			throw new MarketScannerRequestError('bbw_threshold must be a number');
		}
		return num;
	}

	_normalizeTimeframe(raw) {
		const map = {
			'5': '5m', '5M': '5m',
			'15': '15m', '15M': '15m',
			'60': '1h', '1H': '1h',
			'240': '4h', '4H': '4h',
			'1440': '1D', 'D': '1D', '1D': '1D',
			'10080': '1W', 'W': '1W', '1W': '1W',
			'43200': '1M', 'M': '1M', '1M': '1M',
		};
		return map[raw.toUpperCase()] || raw;
	}
}

// Singleton
const scannerPresetService = new ScannerPresetService();

module.exports = {
	ScannerPresetService,
	scannerPresetService,
};
