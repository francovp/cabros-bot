'use strict';

const { v4: uuidv4 } = require('uuid');
const alertStorageService = require('../storage/AlertStorageService');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const {
	normalizeTradingViewTimeframe,
	SUPPORTED_MCP_TIMEFRAMES,
} = require('../tradingview/parseTradingViewSignal');
const { SUPPORTED_SCAN_TYPES } = require('../tradingview/marketScannerReport');

const COLLECTION_NAME = 'chatSubscriptions';
const DEFAULT_MIN_INTERVAL_MS = 3600000;
const MAX_SUBSCRIPTIONS_PER_CHAT = 10;
const MAX_LIST_ENTRIES = 50;
const MAX_RESULT_SUMMARY_LENGTH = 100;

const SUPPORTED_TYPES = new Set(['scanner', 'analysis']);
const SUPPORTED_TIMEFRAME_ALIASES = new Set([
	'5', '5M', '15', '15M', '60', '1H', '240', '4H',
	'1440', 'D', '1D', '10080', 'W', '1W', '43200', 'M', '1M',
]);

class ChatSubscriptionValidationError extends Error {
	constructor(message, code = 'INVALID_REQUEST') {
		super(message);
		this.name = 'ChatSubscriptionValidationError';
		this.code = code;
		this.statusCode = 400;
	}
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

function getMinIntervalMs() {
	const raw = process.env.CHAT_SUBSCRIPTION_MIN_INTERVAL_MS;
	return parseEnvInt(raw, DEFAULT_MIN_INTERVAL_MS, 60000, 24 * 3600 * 1000);
}

function normalizeTimeframe(raw) {
	if (raw === undefined || raw === null || raw === '') {
		return '1D';
	}
	if (typeof raw !== 'string') {
		throw new ChatSubscriptionValidationError('timeframe must be a string');
	}
	const trimmed = raw.trim();
	if (!trimmed) {
		return '1D';
	}
	const upper = trimmed.toUpperCase();
	if (!SUPPORTED_TIMEFRAME_ALIASES.has(upper)) {
		throw new ChatSubscriptionValidationError(
			`Unsupported timeframe '${trimmed}'. Supported: ${Array.from(SUPPORTED_MCP_TIMEFRAMES).join(', ')}`,
		);
	}
	return normalizeTradingViewTimeframe(trimmed) || '1D';
}

function normalizeScans(scans) {
	if (scans === undefined || scans === null) {
		return ['top_gainers', 'top_losers', 'volume_breakout_scanner'];
	}
	let list;
	if (Array.isArray(scans)) {
		list = scans;
	} else if (typeof scans === 'string') {
		list = scans.split(',').map((s) => s.trim()).filter(Boolean);
	} else {
		throw new ChatSubscriptionValidationError('scans must be an array or comma-separated string');
	}
	if (list.length === 0) {
		throw new ChatSubscriptionValidationError('scans must contain at least one entry');
	}
	const normalized = [];
	for (const scan of list) {
		if (typeof scan !== 'string') {
			throw new ChatSubscriptionValidationError('scans entries must be strings');
		}
		if (!SUPPORTED_SCAN_TYPES.has(scan)) {
			throw new ChatSubscriptionValidationError(
				`Unsupported scan type '${scan}'. Supported: ${Array.from(SUPPORTED_SCAN_TYPES).join(', ')}`,
			);
		}
		normalized.push(scan);
	}
	return Array.from(new Set(normalized));
}

function normalizeSymbols(symbols) {
	if (symbols === undefined || symbols === null) {
		throw new ChatSubscriptionValidationError('analysis subscriptions require symbols');
	}
	let list;
	if (Array.isArray(symbols)) {
		list = symbols;
	} else if (typeof symbols === 'string') {
		list = symbols.split(',').map((s) => s.trim()).filter(Boolean);
	} else {
		throw new ChatSubscriptionValidationError('symbols must be an array or comma-separated string');
	}
	if (list.length === 0) {
		throw new ChatSubscriptionValidationError('symbols must contain at least one entry');
	}
	const normalized = [];
	for (const sym of list) {
		if (typeof sym !== 'string') {
			throw new ChatSubscriptionValidationError('symbols entries must be strings');
		}
		const upper = sym.toUpperCase().trim();
		if (!upper) {
			throw new ChatSubscriptionValidationError('symbols entries must be non-empty');
		}
		if (!/^[A-Z0-9._:-]{2,40}$/.test(upper)) {
			throw new ChatSubscriptionValidationError(
				`Invalid symbol '${sym}'. Use exchange-qualified tickers such as BINANCE:BTCUSDT`,
			);
		}
		normalized.push(upper);
	}
	return Array.from(new Set(normalized));
}

function parseIntervalMs(raw) {
	if (raw === undefined || raw === null || raw === '') {
		return null;
	}
	if (typeof raw === 'number') {
		if (!Number.isFinite(raw) || !Number.isInteger(raw)) {
			throw new ChatSubscriptionValidationError('interval must be an integer number of ms');
		}
		return raw;
	}
	if (typeof raw !== 'string') {
		throw new ChatSubscriptionValidationError('interval must be a string like "4h" or a number');
	}
	const trimmed = raw.trim().toLowerCase();
	if (!trimmed) {
		return null;
	}
	const match = trimmed.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks)$/);
	if (!match) {
		if (/^\d+$/.test(trimmed)) {
			return parseInt(trimmed, 10);
		}
		throw new ChatSubscriptionValidationError(
			'interval must match "<n>m|<n>h|<n>d|<n>w" (e.g. 4h, 24h) or be a millisecond integer',
		);
	}
	const val = parseInt(match[1], 10);
	const unit = match[2];
	if (unit.startsWith('m')) {
		return val * 60 * 1000;
	}
	if (unit.startsWith('h')) {
		return val * 3600 * 1000;
	}
	if (unit.startsWith('d')) {
		return val * 86400 * 1000;
	}
	if (unit.startsWith('w')) {
		return val * 7 * 86400 * 1000;
	}
	throw new ChatSubscriptionValidationError('unsupported interval unit');
}

function clampIntervalMs(requested) {
	const min = getMinIntervalMs();
	if (requested < min) {
		return { value: min, clamped: true };
	}
	return { value: requested, clamped: false };
}

function normalizeExchange(raw) {
	if (raw === undefined || raw === null || raw === '') {
		return 'BINANCE';
	}
	if (typeof raw !== 'string') {
		throw new ChatSubscriptionValidationError('exchange must be a string');
	}
	const trimmed = raw.trim().toUpperCase();
	if (!/^[A-Z0-9._:-]{2,30}$/.test(trimmed)) {
		throw new ChatSubscriptionValidationError(`Invalid exchange '${raw}'`);
	}
	return trimmed;
}

function buildSubscriptionKey(chatId, type, params, intervalMs) {
	return JSON.stringify({
		chatId: String(chatId),
		type,
		params: stripUndefinedFieldsDeep(params),
		intervalMs,
	});
}

function retentionDays() {
	return parseEnvInt(process.env.ALERT_STORAGE_RETENTION_DAYS, 90, 1, 3650);
}

function computeExpiresAt(createdAt) {
	const days = retentionDays();
	const ms = days * 86400 * 1000;
	return new Date(createdAt.getTime() + ms);
}

function serializeSubscription(record) {
	if (!record) {
		return null;
	}
	const createdAt = record.createdAt instanceof Date ? record.createdAt : new Date(record.createdAt);
	const nextRunAt = record.nextRunAt instanceof Date ? record.nextRunAt : (record.nextRunAt ? new Date(record.nextRunAt) : null);
	const updatedAt = record.updatedAt instanceof Date ? record.updatedAt : (record.updatedAt ? new Date(record.updatedAt) : null);
	const expiresAt = record.expiresAt instanceof Date ? record.expiresAt : (record.expiresAt ? new Date(record.expiresAt) : null);
	return {
		subscriptionId: record.subscriptionId,
		chatId: record.chatId,
		type: record.type,
		params: record.params || {},
		intervalMs: record.intervalMs,
		nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
		lastJobId: record.lastJobId || null,
		lastResultSummary: record.lastResultSummary || null,
		createdAt: createdAt.toISOString(),
		updatedAt: updatedAt ? updatedAt.toISOString() : null,
		expiresAt: expiresAt ? expiresAt.toISOString() : null,
	};
}

class ChatSubscriptionService {
	constructor(options = {}) {
		this.minIntervalMs = options.minIntervalMs !== undefined ? options.minIntervalMs : getMinIntervalMs();
		this._memory = new Map();
		this._inFlight = new Map();
	}

	validateParams(type, params) {
		if (!SUPPORTED_TYPES.has(type)) {
			throw new ChatSubscriptionValidationError(
				`type must be one of: ${Array.from(SUPPORTED_TYPES).join(', ')}`,
			);
		}
		const safeParams = params && typeof params === 'object' ? params : {};
		const out = {};
		if (type === 'scanner') {
			out.exchange = normalizeExchange(safeParams.exchange);
			out.timeframe = normalizeTimeframe(safeParams.timeframe);
			out.scans = normalizeScans(safeParams.scans);
		} else {
			out.exchange = normalizeExchange(safeParams.exchange);
			out.timeframe = normalizeTimeframe(safeParams.timeframe);
			out.symbols = normalizeSymbols(safeParams.symbols);
		}
		return out;
	}

	validateInterval(rawInterval) {
		const parsed = parseIntervalMs(rawInterval);
		if (parsed === null) {
			throw new ChatSubscriptionValidationError(
				`interval is required. Use "<n>h" or "<n>m" with a minimum of ${this.minIntervalMs / 60000} minutes`,
			);
		}
		const { value, clamped } = clampIntervalMs(parsed);
		return { intervalMs: value, clamped };
	}

	buildRequestPayload(chatId, type, params, intervalMs) {
		const safeChatId = String(chatId || '').trim();
		if (!safeChatId) {
			throw new ChatSubscriptionValidationError('chatId is required');
		}
		const cleanParams = this.validateParams(type, params);
		const { intervalMs: cleanInterval, clamped } = this.validateInterval(intervalMs);
		return {
			chatId: safeChatId,
			type,
			params: cleanParams,
			intervalMs: cleanInterval,
			clamped,
		};
	}

	async createSubscription({ chatId, type, params, intervalMs }) {
		const payload = this.buildRequestPayload(chatId, type, params, intervalMs);
		const key = buildSubscriptionKey(payload.chatId, payload.type, payload.params, payload.intervalMs);

		const existing = this._memory.get(key);
		if (existing) {
			return { subscription: serializeSubscription(existing), created: false, clamped: payload.clamped };
		}

		const firestoreReady = isFirestoreConfigured();
		if (firestoreReady) {
			try {
				const collection = alertStorageService.getFirestore().collection(COLLECTION_NAME);
				const existingSnap = await collection.where('chatId', '==', payload.chatId)
					.where('type', '==', payload.type)
					.where('intervalMs', '==', payload.intervalMs)
					.get();
				let reused = null;
				existingSnap.forEach((doc) => {
					const data = doc.data() || {};
					if (!reused && buildSubscriptionKey(payload.chatId, payload.type, data.params || {}, data.intervalMs) === key) {
						reused = { id: doc.id, data };
					}
				});
				if (reused) {
					const restored = {
						subscriptionId: reused.id,
						chatId: reused.data.chatId,
						type: reused.data.type,
						params: reused.data.params || {},
						intervalMs: reused.data.intervalMs,
						nextRunAt: reused.data.nextRunAt,
						lastJobId: reused.data.lastJobId || null,
						lastResultSummary: reused.data.lastResultSummary || null,
						createdAt: reused.data.createdAt,
						updatedAt: reused.data.updatedAt,
						expiresAt: reused.data.expiresAt,
					};
					this._memory.set(key, restored);
					this._memory.set(`${restored.chatId}::${restored.subscriptionId}`, restored);
					return {
						subscription: serializeSubscription(restored),
						created: false,
						clamped: payload.clamped,
					};
				}
			} catch (error) {
				console.warn('[ChatSubscriptionService] Firestore dedupe lookup failed; using memory:', error.message);
			}
		}

		const existingForChat = await this.listSubscriptions({ chatId: payload.chatId, limit: 1000 });
		if (existingForChat.length >= MAX_SUBSCRIPTIONS_PER_CHAT) {
			throw new ChatSubscriptionValidationError(
				`Chat already has ${MAX_SUBSCRIPTIONS_PER_CHAT} subscriptions; unsubscribe before adding more.`,
			);
		}

		const now = new Date();
		const record = {
			subscriptionId: uuidv4(),
			chatId: payload.chatId,
			type: payload.type,
			params: payload.params,
			intervalMs: payload.intervalMs,
			nextRunAt: new Date(now.getTime() + payload.intervalMs),
			lastJobId: null,
			lastResultSummary: null,
			createdAt: now,
			updatedAt: now,
			expiresAt: computeExpiresAt(now),
		};

		this._memory.set(key, record);
		this._memory.set(`${record.chatId}::${record.subscriptionId}`, record);

		if (firestoreReady) {
			try {
				const collection = alertStorageService.getFirestore().collection(COLLECTION_NAME);
				await collection.doc(record.subscriptionId).set(stripUndefinedFieldsDeep({
					chatId: record.chatId,
					type: record.type,
					params: record.params,
					intervalMs: record.intervalMs,
					nextRunAt: record.nextRunAt,
					lastJobId: null,
					lastResultSummary: null,
					createdAt: record.createdAt,
					updatedAt: record.updatedAt,
					expiresAt: record.expiresAt,
				}));
			} catch (error) {
				console.warn('[ChatSubscriptionService] Firestore write failed; keeping memory-only record:', error.message);
			}
		}

		return { subscription: serializeSubscription(record), created: true, clamped: payload.clamped };
	}

	async listSubscriptions({ chatId, limit = MAX_LIST_ENTRIES } = {}) {
		const records = [];
		const seen = new Set();
		for (const [, rec] of this._memory) {
			if (chatId && rec.chatId !== String(chatId)) {
				continue;
			}
			if (seen.has(rec.subscriptionId)) {
				continue;
			}
			seen.add(rec.subscriptionId);
			records.push(rec);
		}

		if (isFirestoreConfigured()) {
			try {
				const collection = alertStorageService.getFirestore().collection(COLLECTION_NAME);
				let query = collection;
				if (chatId) {
					query = query.where('chatId', '==', String(chatId));
				}
				const snap = await query.get();
				snap.forEach((doc) => {
					const data = doc.data() || {};
					if (!seen.has(doc.id)) {
						records.push({ subscriptionId: doc.id, ...data });
						seen.add(doc.id);
					}
				});
			} catch (error) {
				console.warn('[ChatSubscriptionService] Firestore list failed; using memory only:', error.message);
			}
		}

		records.sort((a, b) => {
			const aNext = a.nextRunAt instanceof Date ? a.nextRunAt.getTime() : (a.nextRunAt ? new Date(a.nextRunAt).getTime() : 0);
			const bNext = b.nextRunAt instanceof Date ? b.nextRunAt.getTime() : (b.nextRunAt ? new Date(b.nextRunAt).getTime() : 0);
			return aNext - bNext;
		});

		return records.slice(0, limit).map(serializeSubscription);
	}

	async deleteSubscription({ chatId, subscriptionId, all = false }) {
		const safeChatId = String(chatId || '').trim();
		if (!safeChatId) {
			throw new ChatSubscriptionValidationError('chatId is required');
		}
		let deleted = 0;

		const memoryKeys = Array.from(this._memory.keys());
		for (const k of memoryKeys) {
			const rec = this._memory.get(k);
			if (!rec) continue;
			if (rec.chatId !== safeChatId) continue;
			if (all || rec.subscriptionId === subscriptionId) {
				this._memory.delete(k);
				this._memory.delete(`${rec.chatId}::${rec.subscriptionId}`);
				deleted += 1;
				if (!all) break;
			}
		}

		if (isFirestoreConfigured()) {
			try {
				const collection = alertStorageService.getFirestore().collection(COLLECTION_NAME);
				let query = collection.where('chatId', '==', safeChatId);
				if (!all && subscriptionId) {
					query = query.where('__name__', '==', subscriptionId);
				}
				const snap = await query.get();
				const deletes = [];
				snap.forEach((doc) => {
					deletes.push(doc.ref.delete());
					deleted += 1;
				});
				await Promise.all(deletes);
			} catch (error) {
				console.warn('[ChatSubscriptionService] Firestore delete failed:', error.message);
			}
		}

		return { deleted, requested: all ? 'all' : subscriptionId };
	}

	async markRunResult({ chatId, subscriptionId, jobId, summary }) {
		if (!chatId || !subscriptionId) {
			return false;
		}
		const intervalMs = await this.getIntervalFor(chatId, subscriptionId);
		const nextRunAt = new Date(Date.now() + (intervalMs || this.minIntervalMs));
		const truncatedSummary = typeof summary === 'string'
			? summary.slice(0, MAX_RESULT_SUMMARY_LENGTH)
			: null;
		const update = {
			lastJobId: jobId || null,
			lastResultSummary: truncatedSummary,
			nextRunAt,
			updatedAt: new Date(),
		};
		const memoryRec = this._memory.get(`${chatId}::${subscriptionId}`);
		if (memoryRec) {
			Object.assign(memoryRec, update);
		}
		if (isFirestoreConfigured()) {
			try {
				const collection = alertStorageService.getFirestore().collection(COLLECTION_NAME);
				await collection.doc(subscriptionId).update(stripUndefinedFieldsDeep(update));
			} catch (error) {
				console.warn('[ChatSubscriptionService] Firestore update failed:', error.message);
			}
		}
		return true;
	}

	async getIntervalFor(chatId, subscriptionId) {
		const rec = this._memory.get(`${chatId}::${subscriptionId}`);
		if (rec) {
			return rec.intervalMs;
		}
		if (isFirestoreConfigured()) {
			try {
				const collection = alertStorageService.getFirestore().collection(COLLECTION_NAME);
				const doc = await collection.doc(subscriptionId).get();
				if (doc.exists) {
					const data = doc.data() || {};
					return data.intervalMs;
				}
			} catch (error) {
				console.warn('[ChatSubscriptionService] Firestore interval read failed:', error.message);
			}
		}
		return this.minIntervalMs;
	}

	resetForTests() {
		this._memory.clear();
		this._inFlight.clear();
	}
}

const chatSubscriptionService = new ChatSubscriptionService();

module.exports = {
	ChatSubscriptionService,
	chatSubscriptionService,
	ChatSubscriptionValidationError,
	COLLECTION_NAME,
	MAX_SUBSCRIPTIONS_PER_CHAT,
	MAX_LIST_ENTRIES,
	SUPPORTED_TYPES,
	getMinIntervalMs,
};
