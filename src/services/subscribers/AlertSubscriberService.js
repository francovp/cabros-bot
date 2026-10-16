'use strict';

const { v4: uuidv4 } = require('uuid');
const { validateCallbackUrl } = require('../../lib/callbackUrl');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const { resolveRemoteOverride } = require('../remoteConfig/resolveRemoteOverride');
const alertStorageService = require('../storage/AlertStorageService');

const COLLECTION_NAME = 'alertSubscribers';

class AlertSubscriberValidationError extends Error {
	constructor(message, details = null) {
		super(message);
		this.name = 'AlertSubscriberValidationError';
		this.code = 'INVALID_REQUEST';
		this.details = details;
	}
}

function isFirestoreEnabled() {
	const remote = resolveRemoteOverride('ENABLE_FIRESTORE_ALERT_SUBSCRIBERS');
	if (typeof remote === 'boolean') {
		return remote;
	}
	return process.env.ENABLE_FIRESTORE_ALERT_SUBSCRIBERS === 'true';
}

function sanitizeFirestoreDoc(data) {
	const clean = {};
	for (const [key, val] of Object.entries(data)) {
		if (val !== undefined) {
			if (val && typeof val === 'object' && !Array.isArray(val) && !(val instanceof Date)) {
				clean[key] = sanitizeFirestoreDoc(val);
			} else {
				clean[key] = val;
			}
		}
	}
	return clean;
}

function toPublicSubscriber(sub) {
	if (!sub) return null;
	return {
		id: sub.id,
		url: sub.url,
		description: sub.description || '',
		filter: sub.filter || {},
		enabled: sub.enabled !== false,
		createdAt: sub.createdAt,
		updatedAt: sub.updatedAt,
		lastDeliveryAt: sub.lastDeliveryAt || null,
		lastDeliveryStatus: sub.lastDeliveryStatus || null,
		hasSecret: Boolean(sub.secret),
	};
}

function matchesAlert(subscriber, alert) {
	if (!subscriber || subscriber.enabled === false) {
		return false;
	}
	const filter = subscriber.filter;
	if (!filter || typeof filter !== 'object' || Object.keys(filter).length === 0) {
		return true;
	}

	// 1. Symbol filter
	if (Array.isArray(filter.symbols) && filter.symbols.length > 0) {
		const alertSymbol = alert.symbol || (typeof alert.text === 'string' && alert.text.match(/\b([A-Z0-9]{2,10}(?:USDT|USD|BTC|ETH)?)\b/i)?.[1]);
		if (!alertSymbol) return false;
		const upperSymbols = filter.symbols.map(s => String(s).toUpperCase());
		if (!upperSymbols.includes(String(alertSymbol).toUpperCase())) {
			return false;
		}
	}

	// 2. Source filter
	if (Array.isArray(filter.sources) && filter.sources.length > 0) {
		const alertSource = alert.source || 'webhook-alert';
		if (!filter.sources.includes(alertSource)) {
			return false;
		}
	}

	// 3. Enriched filter
	if (typeof filter.enriched === 'boolean') {
		const isEnriched = Boolean(alert.enriched);
		if (isEnriched !== filter.enriched) {
			return false;
		}
	}

	// 4. Channels filter
	if (Array.isArray(filter.channels) && filter.channels.length > 0) {
		const alertChannels = Array.isArray(alert.channels)
			? alert.channels
			: (Array.isArray(alert.deliveredChannels) ? alert.deliveredChannels : []);
		const hasChannelMatch = filter.channels.some(ch => alertChannels.includes(ch));
		if (!hasChannelMatch) {
			return false;
		}
	}

	return true;
}

class AlertSubscriberService {
	constructor() {
		this.memorySubscribers = new Map();
	}

	_getFirestore() {
		return isFirestoreEnabled() ? alertStorageService.getFirestore() : null;
	}

	async validateSubscriberPayload(data, isUpdate = false) {
		if (!isUpdate || data.url !== undefined) {
			if (!data.url || typeof data.url !== 'string') {
				throw new AlertSubscriberValidationError('url is required and must be a string');
			}
			const urlValidation = await validateCallbackUrl(data.url);
			if (!urlValidation.valid) {
				const reason = urlValidation.reason === 'private'
					? 'Callback URL is blocked (private network or internal metadata address)'
					: 'Callback URL format is invalid';
				throw new AlertSubscriberValidationError(reason, { reason: urlValidation.reason });
			}
		}

		if (data.secret !== undefined && data.secret !== null && typeof data.secret !== 'string') {
			throw new AlertSubscriberValidationError('secret must be a string or null');
		}

		if (data.description !== undefined && data.description !== null && typeof data.description !== 'string') {
			throw new AlertSubscriberValidationError('description must be a string');
		}

		if (data.filter !== undefined && data.filter !== null) {
			if (typeof data.filter !== 'object' || Array.isArray(data.filter)) {
				throw new AlertSubscriberValidationError('filter must be an object');
			}
			if (data.filter.symbols !== undefined && !Array.isArray(data.filter.symbols)) {
				throw new AlertSubscriberValidationError('filter.symbols must be an array of strings');
			}
			if (data.filter.sources !== undefined && !Array.isArray(data.filter.sources)) {
				throw new AlertSubscriberValidationError('filter.sources must be an array of strings');
			}
			if (data.filter.channels !== undefined && !Array.isArray(data.filter.channels)) {
				throw new AlertSubscriberValidationError('filter.channels must be an array of strings');
			}
			if (data.filter.enriched !== undefined && typeof data.filter.enriched !== 'boolean') {
				throw new AlertSubscriberValidationError('filter.enriched must be a boolean');
			}
		}

		if (data.enabled !== undefined && typeof data.enabled !== 'boolean') {
			throw new AlertSubscriberValidationError('enabled must be a boolean');
		}
	}

	async createSubscriber(data) {
		await this.validateSubscriberPayload(data, false);

		const id = uuidv4();
		const now = new Date().toISOString();
		const subscriber = {
			id,
			url: data.url.trim(),
			secret: typeof data.secret === 'string' ? data.secret.trim() : null,
			description: typeof data.description === 'string' ? data.description.trim() : '',
			filter: data.filter || {},
			enabled: data.enabled !== false,
			createdAt: now,
			updatedAt: now,
			lastDeliveryAt: null,
			lastDeliveryStatus: null,
		};

		// Store in memory
		this.memorySubscribers.set(id, { ...subscriber });

		// Persist to Firestore if enabled
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(id);
				await docRef.set(sanitizeFirestoreDoc(subscriber));
			} catch (err) {
				console.warn('[AlertSubscriberService] Failed to persist subscriber to Firestore, falling back to memory:', err.message);
			}
		}

		return toPublicSubscriber(subscriber);
	}

	async getSubscriber(id, { includeSecret = false } = {}) {
		if (!id) return null;

		let subscriber = this.memorySubscribers.get(id);

		if (!subscriber) {
			const firestore = this._getFirestore();
			if (firestore) {
				try {
					const doc = await firestore.collection(COLLECTION_NAME).doc(id).get();
					if (doc.exists) {
						subscriber = doc.data();
						this.memorySubscribers.set(id, { ...subscriber });
					}
				} catch (err) {
					console.warn('[AlertSubscriberService] Firestore read failed:', err.message);
				}
			}
		}

		if (!subscriber) return null;
		return includeSecret ? { ...subscriber } : toPublicSubscriber(subscriber);
	}

	async listSubscribers({ includeSecret = false } = {}) {
		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore.collection(COLLECTION_NAME).get();
				for (const doc of snapshot.docs) {
					const sub = doc.data();
					this.memorySubscribers.set(sub.id, { ...sub });
				}
			} catch (err) {
				console.warn('[AlertSubscriberService] Firestore list failed, using memory store:', err.message);
			}
		}

		const list = Array.from(this.memorySubscribers.values());
		list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
		return includeSecret ? list.map(s => ({ ...s })) : list.map(toPublicSubscriber);
	}

	async updateSubscriber(id, data) {
		const existing = await this.getSubscriber(id, { includeSecret: true });
		if (!existing) return null;

		await this.validateSubscriberPayload(data, true);

		const updated = {
			...existing,
			url: data.url !== undefined ? data.url.trim() : existing.url,
			secret: data.secret !== undefined ? (data.secret ? data.secret.trim() : null) : existing.secret,
			description: data.description !== undefined ? data.description.trim() : existing.description,
			filter: data.filter !== undefined ? data.filter : existing.filter,
			enabled: data.enabled !== undefined ? data.enabled : existing.enabled,
			updatedAt: new Date().toISOString(),
		};

		this.memorySubscribers.set(id, { ...updated });

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(id).set(sanitizeFirestoreDoc(updated));
			} catch (err) {
				console.warn('[AlertSubscriberService] Firestore update failed, falling back to memory:', err.message);
			}
		}

		return toPublicSubscriber(updated);
	}

	async deleteSubscriber(id) {
		const existed = this.memorySubscribers.has(id);
		this.memorySubscribers.delete(id);

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(id);
				const doc = await docRef.get();
				if (doc.exists) {
					await docRef.delete();
					return true;
				}
			} catch (err) {
				console.warn('[AlertSubscriberService] Firestore delete failed:', err.message);
			}
		}

		return existed;
	}

	async recordDelivery(id, { success, timestamp = new Date().toISOString() }) {
		const subscriber = this.memorySubscribers.get(id);
		if (subscriber) {
			subscriber.lastDeliveryAt = timestamp;
			subscriber.lastDeliveryStatus = success ? 'success' : 'failed';
		}

		const firestore = this._getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(id).update({
					lastDeliveryAt: timestamp,
					lastDeliveryStatus: success ? 'success' : 'failed',
				});
			} catch (_) {
				// Non-blocking update failure fails open
			}
		}
	}

	getStorageStatus() {
		const enabled = isFirestoreEnabled();
		const configured = enabled && isFirestoreConfigured() && Boolean(this._getFirestore());
		const durableIntent = enabled && configured;

		let status;
		if (!enabled) {
			status = 'disabled';
		} else if (!configured) {
			status = 'misconfigured';
		} else {
			status = 'ready';
		}

		const subscribers = Array.from(this.memorySubscribers.values());
		const activeCount = subscribers.filter(s => s && s.enabled !== false).length;

		return {
			enabled,
			configured,
			ready: status === 'ready',
			status,
			mode: durableIntent ? 'durable' : 'ephemeral',
			backend: durableIntent ? 'firestore' : 'memory',
			failOpen: true,
			collection: COLLECTION_NAME,
			count: subscribers.length,
			activeCount,
		};
	}

	resetForTesting() {
		this.memorySubscribers.clear();
	}
}

const alertSubscriberService = new AlertSubscriberService();

module.exports = {
	AlertSubscriberService,
	alertSubscriberService,
	AlertSubscriberValidationError,
	matchesAlert,
	toPublicSubscriber,
	isFirestoreEnabled,
};
