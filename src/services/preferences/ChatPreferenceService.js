'use strict';

const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const { loadFirebaseAdminCredentialsOrNull } = require('../storage/firebaseAdminCredentials');
const remoteConfigService = require('../remoteConfig/RemoteConfigService');

const VALID_CATEGORIES = Object.freeze(['scanner', 'news', 'expanded', 'core', 'volume']);
const DEFAULT_TIMEZONE = 'America/Santiago';
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_CACHE_TTL_MS = 60000;

function stripUndefinedFields(obj) {
	if (!obj || typeof obj !== 'object') {
		return obj;
	}
	const clean = {};
	for (const [key, value] of Object.entries(obj)) {
		if (value !== undefined) {
			clean[key] = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value.constructor && value.constructor.name === 'FieldValue') && !(value.constructor && value.constructor.name === 'Timestamp')
				? stripUndefinedFields(value)
				: value;
		}
	}
	return clean;
}

function isValidTimezone(tz) {
	if (!tz || typeof tz !== 'string') return false;
	try {
		Intl.DateTimeFormat(undefined, { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

function normalizeSymbol(symbol) {
	if (!symbol || typeof symbol !== 'string') return '';
	let clean = symbol.trim().toUpperCase();
	// Remove common exchange prefixes like BINANCE: or COINBASE:
	if (clean.includes(':')) {
		clean = clean.split(':')[1];
	}
	// Remove separators like / or -
	clean = clean.replace(/[/_-]/g, '');
	// Remove perpetual contract suffix if present (.P)
	if (clean.endsWith('.P')) {
		clean = clean.slice(0, -2);
	}
	return clean;
}

function matchesSymbol(candidate, target) {
	const a = normalizeSymbol(candidate);
	const t = normalizeSymbol(target);
	if (!a || !t) return false;
	if (a === t) return true;
	if (a === `${t}USDT` || a === `${t}USD` || a === `${t}PERP`) return true;
	return false;
}

class ChatPreferenceService {
	constructor() {
		this._db = null;
		this._cache = new Map();
	}

	isEnabled() {
		try {
			const rc = remoteConfigService.getRuntimeConfig();
			if (rc && typeof rc.ENABLE_FIRESTORE_CHAT_PREFERENCES === 'boolean') {
				return rc.ENABLE_FIRESTORE_CHAT_PREFERENCES;
			}
		} catch {
			// Fallback to process.env
		}
		return process.env.ENABLE_FIRESTORE_CHAT_PREFERENCES === 'true';
	}

	getRetentionDays() {
		try {
			const rc = remoteConfigService.getRuntimeConfig();
			if (rc && typeof rc.CHAT_PREFERENCES_RETENTION_DAYS === 'number') {
				return rc.CHAT_PREFERENCES_RETENTION_DAYS;
			}
		} catch {
			// Fallback
		}
		const envVal = parseInt(process.env.CHAT_PREFERENCES_RETENTION_DAYS, 10);
		return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_RETENTION_DAYS;
	}

	getCacheTtlMs() {
		try {
			const rc = remoteConfigService.getRuntimeConfig();
			if (rc && typeof rc.CHAT_PREFERENCES_CACHE_TTL_MS === 'number') {
				return rc.CHAT_PREFERENCES_CACHE_TTL_MS;
			}
		} catch {
			// Fallback
		}
		const envVal = parseInt(process.env.CHAT_PREFERENCES_CACHE_TTL_MS, 10);
		return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_CACHE_TTL_MS;
	}

	getFirestore() {
		if (this._db) {
			return this._db;
		}
		if (!this.isEnabled()) {
			return null;
		}
		try {
			const loaded = loadFirebaseAdminCredentialsOrNull();
			const appOptions = {};
			if (loaded && loaded.credential) {
				appOptions.credential = loaded.credential;
			}
			if (loaded && loaded.projectId) {
				appOptions.projectId = loaded.projectId;
			}

			if (!admin.apps.length) {
				admin.initializeApp(appOptions);
			}

			this._db = admin.firestore();
			return this._db;
		} catch (error) {
			console.warn('[ChatPreferenceService] Failed to initialize Firestore client:', error.message);
			return null;
		}
	}

	_setFirestoreForTesting(mockDb) {
		this._db = mockDb;
	}

	setDb(mockDb) {
		this._db = mockDb;
	}

	_clearCacheForTesting() {
		this._cache.clear();
	}

	clearCache() {
		this._cache.clear();
	}

	getStatus() {
		const enabled = this.isEnabled();
		const configured = isFirestoreConfigured();
		const dbClient = this.getFirestore();
		const ready = Boolean(enabled && configured && dbClient);

		let status = 'disabled';
		if (enabled) {
			status = ready ? 'active' : configured ? 'initializing' : 'misconfigured';
		}

		return {
			enabled,
			configured,
			ready,
			status,
			cachedEntries: this._cache.size,
			retentionDays: this.getRetentionDays(),
			cacheTtlMs: this.getCacheTtlMs(),
		};
	}

	normalizeDocId(chatId, channel = 'telegram') {
		const safeChannel = String(channel || 'telegram').toLowerCase().trim();
		const safeChatId = String(chatId || '').replace(/\//g, '_').trim();
		return `${safeChannel}_${safeChatId}`;
	}

	getDefaultPreferences(chatId, channel = 'telegram') {
		return {
			chatId: String(chatId || ''),
			channel: String(channel || 'telegram').toLowerCase().trim(),
			symbolFilter: [],
			symbolExclude: [],
			categories: [],
			minConfidence: 0,
			quietHoursStart: null,
			quietHoursEnd: null,
			timezone: DEFAULT_TIMEZONE,
		};
	}

	sanitizePreferences(input = {}) {
		const result = {};

		// Symbols inclusion
		if (Array.isArray(input.symbolFilter)) {
			result.symbolFilter = input.symbolFilter
				.map((s) => normalizeSymbol(s))
				.filter((s) => s.length > 0);
		}

		// Symbols exclusion
		if (Array.isArray(input.symbolExclude)) {
			result.symbolExclude = input.symbolExclude
				.map((s) => normalizeSymbol(s))
				.filter((s) => s.length > 0);
		}

		// Categories
		if (Array.isArray(input.categories)) {
			result.categories = input.categories
				.map((c) => String(c).toLowerCase().trim())
				.filter((c) => VALID_CATEGORIES.includes(c));
		}

		// minConfidence
		if (input.minConfidence !== undefined) {
			const conf = Number(input.minConfidence);
			if (Number.isFinite(conf)) {
				let normalized = conf;
				if (normalized > 1) {
					if (normalized <= 100 && normalized >= 5) {
						normalized = normalized / 100;
					} else {
						normalized = 1;
					}
				}
				result.minConfidence = Math.max(0, Math.min(1, normalized));
			} else {
				result.minConfidence = 0;
			}
		}

		// Quiet hours
		if (input.quietHoursStart !== undefined) {
			if (input.quietHoursStart === null) {
				result.quietHoursStart = null;
			} else {
				const start = Number(input.quietHoursStart);
				result.quietHoursStart = Number.isInteger(start) && start >= 0 && start <= 23 ? start : null;
			}
		}
		if (input.quietHoursEnd !== undefined) {
			if (input.quietHoursEnd === null) {
				result.quietHoursEnd = null;
			} else {
				const end = Number(input.quietHoursEnd);
				result.quietHoursEnd = Number.isInteger(end) && end >= 0 && end <= 23 ? end : null;
			}
		}

		// Timezone
		if (input.timezone !== undefined) {
			result.timezone = isValidTimezone(input.timezone) ? input.timezone : DEFAULT_TIMEZONE;
		}

		return result;
	}

	_getFromCache(docId) {
		const cached = this._cache.get(docId);
		if (!cached) return null;
		const ttl = this.getCacheTtlMs();
		if (Date.now() - cached.cachedAt > ttl) {
			this._cache.delete(docId);
			return null;
		}
		return cached.data;
	}

	_setCache(docId, data) {
		this._cache.set(docId, {
			cachedAt: Date.now(),
			data: { ...data },
		});
	}

	async getPreferences(chatId, channel = 'telegram') {
		const docId = this.normalizeDocId(chatId, channel);
		const cached = this._getFromCache(docId);
		if (cached) {
			return cached;
		}

		const defaults = this.getDefaultPreferences(chatId, channel);
		const db = this.getFirestore();
		if (!db) {
			return defaults;
		}

		try {
			const doc = await db.collection('chatPreferences').doc(docId).get();
			if (!doc || !doc.exists) {
				this._setCache(docId, defaults);
				return defaults;
			}

			const data = doc.data() || {};
			const sanitized = {
				chatId: String(data.chatId || chatId),
				channel: String(data.channel || channel),
				symbolFilter: Array.isArray(data.symbolFilter) ? data.symbolFilter : [],
				symbolExclude: Array.isArray(data.symbolExclude) ? data.symbolExclude : [],
				categories: Array.isArray(data.categories) ? data.categories : [],
				minConfidence: typeof data.minConfidence === 'number' ? data.minConfidence : 0,
				quietHoursStart: typeof data.quietHoursStart === 'number' ? data.quietHoursStart : null,
				quietHoursEnd: typeof data.quietHoursEnd === 'number' ? data.quietHoursEnd : null,
				timezone: typeof data.timezone === 'string' && isValidTimezone(data.timezone) ? data.timezone : DEFAULT_TIMEZONE,
				updatedAt: data.updatedAt,
				expiresAt: data.expiresAt,
			};

			this._setCache(docId, sanitized);
			return sanitized;
		} catch (error) {
			console.warn(`[ChatPreferenceService] Failed to get preferences for ${docId}:`, error.message);
			return defaults;
		}
	}

	async setPreferences(chatId, channel = 'telegram', updates = {}) {
		const docId = this.normalizeDocId(chatId, channel);
		const existing = await this.getPreferences(chatId, channel);
		const sanitizedUpdates = this.sanitizePreferences(updates);

		const merged = {
			...existing,
			...sanitizedUpdates,
			chatId: String(chatId),
			channel: String(channel).toLowerCase().trim(),
		};

		const db = this.getFirestore();
		if (db) {
			try {
				const retentionDays = this.getRetentionDays();
				const expiresAtDate = new Date(Date.now() + retentionDays * 86400000);
				const serverTimestamp = admin.firestore?.FieldValue?.serverTimestamp
					? admin.firestore.FieldValue.serverTimestamp()
					: new Date();
				const timestampFromDate = admin.firestore?.Timestamp?.fromDate
					? admin.firestore.Timestamp.fromDate(expiresAtDate)
					: expiresAtDate;

				const payload = stripUndefinedFields({
					...merged,
					updatedAt: serverTimestamp,
					expiresAt: timestampFromDate,
				});

				await db.collection('chatPreferences').doc(docId).set(payload, { merge: true });
			} catch (error) {
				console.warn(`[ChatPreferenceService] Failed to persist preferences for ${docId}:`, error.message);
			}
		}

		this._setCache(docId, merged);
		return merged;
	}

	async deletePreferences(chatId, channel = 'telegram') {
		const docId = this.normalizeDocId(chatId, channel);
		this._cache.delete(docId);

		const db = this.getFirestore();
		if (db) {
			try {
				await db.collection('chatPreferences').doc(docId).delete();
			} catch (error) {
				console.warn(`[ChatPreferenceService] Failed to delete preferences for ${docId}:`, error.message);
			}
		}

		return true;
	}

	extractAlertMetadata(alert = {}) {
		// Extract symbol
		const rawSymbol = alert.symbol
			|| alert.enriched?.symbol
			|| alert.enriched?.parsedSignal?.symbol
			|| alert.parsedSignal?.symbol
			|| '';
		const symbol = normalizeSymbol(rawSymbol);

		// Extract category
		let category = 'core';
		if (alert.category && typeof alert.category === 'string') {
			category = alert.category.trim().toLowerCase();
		} else {
			const source = String(alert.source || '').toLowerCase();
			if (source.includes('scanner') || source.includes('market_scanner')) {
				category = 'scanner';
			} else if (source.includes('news') || source.includes('news_monitor')) {
				category = 'news';
			} else if (source.includes('expanded') || source.includes('analysis')) {
				category = 'expanded';
			} else if (source.includes('volume')) {
				category = 'volume';
			}
		}

		// Extract confidence
		let confidence = null;
		const candidates = [
			alert.confidence,
			alert.enriched?.confidence,
			alert.enriched?.confidenceScore,
			alert.enriched?.geminiAnalysis?.confidence,
			alert.analysis?.confidence,
		];
		for (const cand of candidates) {
			if (typeof cand === 'number' && Number.isFinite(cand)) {
				confidence = cand > 1 && cand <= 100 ? cand / 100 : cand;
				break;
			}
		}

		return { symbol, category, confidence };
	}

	isQuietHourNow(start, end, timezone = DEFAULT_TIMEZONE, now = new Date()) {
		if (start === null || end === null || start === undefined || end === undefined) {
			return false;
		}

		let currentHour;
		try {
			const formatter = new Intl.DateTimeFormat('en-US', {
				timeZone: isValidTimezone(timezone) ? timezone : DEFAULT_TIMEZONE,
				hour: 'numeric',
				hourCycle: 'h23',
			});
			currentHour = parseInt(formatter.format(now), 10);
		} catch {
			currentHour = now.getUTCHours();
		}

		if (start === end) {
			return currentHour === start;
		}
		if (start < end) {
			return currentHour >= start && currentHour < end;
		}
		// Overnight span (e.g. start = 23, end = 7)
		return currentHour >= start || currentHour < end;
	}

	async shouldDeliverAlert({ chatId, channel = 'telegram', alert = {}, options = {}, now = new Date() } = {}) {
		// Fail-open: wrap entire check in try/catch
		try {
			if (!this.isEnabled()) {
				return { deliver: true };
			}

			if (options.bypassPreferences || alert.bypassPreferences || options.isProbe || alert.isProbe) {
				return { deliver: true };
			}

			if (!chatId) {
				return { deliver: true };
			}

			const prefs = await this.getPreferences(chatId, channel);
			if (!prefs) {
				return { deliver: true };
			}

			// 1. Quiet Hours check
			if (prefs.quietHoursStart !== null && prefs.quietHoursEnd !== null) {
				if (this.isQuietHourNow(prefs.quietHoursStart, prefs.quietHoursEnd, prefs.timezone, now)) {
					return { deliver: false, reason: 'quiet_hours' };
				}
			}

			const { symbol, category, confidence } = this.extractAlertMetadata(alert);

			// 2. Minimum Confidence filter
			if (prefs.minConfidence > 0 && typeof confidence === 'number') {
				if (confidence < prefs.minConfidence) {
					return { deliver: false, reason: 'min_confidence' };
				}
			}

			// 3. Category selection filter
			if (Array.isArray(prefs.categories) && prefs.categories.length > 0) {
				if (!prefs.categories.includes(category)) {
					return { deliver: false, reason: 'category_excluded' };
				}
			}

			// 4. Symbol Exclude filter
			if (Array.isArray(prefs.symbolExclude) && prefs.symbolExclude.length > 0 && symbol) {
				const isExcluded = prefs.symbolExclude.some((ex) => matchesSymbol(symbol, ex));
				if (isExcluded) {
					return { deliver: false, reason: 'symbol_excluded' };
				}
			}

			// 5. Symbol Inclusion filter
			if (Array.isArray(prefs.symbolFilter) && prefs.symbolFilter.length > 0) {
				if (!symbol) {
					return { deliver: false, reason: 'symbol_not_matched' };
				}
				const isMatched = prefs.symbolFilter.some((inc) => matchesSymbol(symbol, inc));
				if (!isMatched) {
					return { deliver: false, reason: 'symbol_not_matched' };
				}
			}

			return { deliver: true };
		} catch (error) {
			console.warn('[ChatPreferenceService] Failed to evaluate alert delivery (failing open):', error.message);
			return { deliver: true };
		}
	}
}

const chatPreferenceService = new ChatPreferenceService();

module.exports = {
	ChatPreferenceService,
	chatPreferenceService,
	stripUndefinedFields,
	normalizeSymbol,
	matchesSymbol,
	isValidTimezone,
	VALID_CATEGORIES,
};
