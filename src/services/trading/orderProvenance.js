'use strict';

const AlertStorageService = require('../storage/AlertStorageService');

const COLLECTION_NAME = 'orderProvenance';
const MAX_CACHE_SIZE = 5000;
const memoryCache = new Map();

function getCacheKey(environment, symbol, clientOrderId) {
	if (!environment || !symbol || !clientOrderId) return null;
	return `${environment}:${String(symbol).toUpperCase()}:${clientOrderId}`;
}

function normalizeProvenance({ origin, alertId, setupType } = {}) {
	const normOrigin = typeof origin === 'string' && origin.trim() ? origin.trim().toLowerCase() : undefined;
	const normAlertId = typeof alertId === 'string' && alertId.trim() ? alertId.trim() : (alertId === null ? null : undefined);
	const normSetupType = typeof setupType === 'string' && setupType.trim() ? setupType.trim().toLowerCase() : (setupType === null ? null : undefined);
	return {
		origin: normOrigin,
		alertId: normAlertId,
		setupType: normSetupType,
	};
}

function getFirestore(customFirestore) {
	return customFirestore || AlertStorageService.getFirestore();
}

async function bindOrderProvenance({
	environment,
	symbol,
	clientOrderId,
	binanceOrderId = null,
	origin,
	alertId = null,
	setupType = null,
	firestore = null,
} = {}) {
	const key = getCacheKey(environment, symbol, clientOrderId);
	if (!key) return { origin: origin || 'manual', alertId: alertId || null, setupType: setupType || null };

	const normalized = normalizeProvenance({ origin, alertId, setupType });
	const record = {
		environment,
		symbol: String(symbol).toUpperCase(),
		clientOrderId,
		binanceOrderId: binanceOrderId ? String(binanceOrderId) : null,
		origin: normalized.origin || 'manual',
		alertId: normalized.alertId || null,
		setupType: normalized.setupType || null,
		recordedAt: new Date().toISOString(),
	};

	if (memoryCache.size >= MAX_CACHE_SIZE) {
		const oldestKey = memoryCache.keys().next().value;
		if (oldestKey) memoryCache.delete(oldestKey);
	}
	memoryCache.set(key, record);

	const db = getFirestore(firestore);
	if (db) {
		try {
			await db.collection(COLLECTION_NAME).doc(key).set(record, { merge: true });
		} catch (err) {
			console.warn('[orderProvenance] Failed to persist order provenance to Firestore:', err?.message || err);
		}
	}

	return {
		origin: record.origin,
		alertId: record.alertId,
		setupType: record.setupType,
	};
}

async function resolveOrderProvenance({
	environment,
	symbol,
	clientOrderId,
	binanceOrderId = null,
	origin = undefined,
	alertId = undefined,
	setupType = undefined,
	firestore = null,
	ErrorClass = Error,
} = {}) {
	const key = getCacheKey(environment, symbol, clientOrderId);
	if (!key) {
		return { origin: origin || 'manual', alertId: alertId || null, setupType: setupType || null };
	}

	let existing = memoryCache.get(key) || null;

	if (!existing) {
		const db = getFirestore(firestore);
		if (db) {
			try {
				const doc = await db.collection(COLLECTION_NAME).doc(key).get();
				if (doc && doc.exists) {
					existing = doc.data();
					memoryCache.set(key, existing);
				}
			} catch (err) {
				console.warn('[orderProvenance] Failed to read order provenance from Firestore:', err?.message || err);
			}

			if (!existing) {
				try {
					const snapshot = await db.collection('tradeFills')
						.where('environment', '==', environment)
						.where('clientOrderId', '==', clientOrderId)
						.limit(1)
						.get();
					if (snapshot && !snapshot.empty) {
						const fillData = snapshot.docs[0].data();
						if (fillData) {
							existing = {
								origin: fillData.origin || 'manual',
								alertId: fillData.alertId || null,
								setupType: fillData.setupType || null,
							};
							memoryCache.set(key, existing);
						}
					}
				} catch (err) {
					console.warn('[orderProvenance] Failed to query tradeFills for provenance:', err?.message || err);
				}
			}
		}
	}

	if (existing) {
		const incoming = normalizeProvenance({ origin, alertId, setupType });
		const existingOrigin = existing.origin || 'manual';
		const existingAlertId = existing.alertId || null;
		const existingSetupType = existing.setupType || null;

		let conflict = false;
		if (incoming.origin !== undefined && incoming.origin !== existingOrigin) {
			conflict = true;
		}
		if (incoming.alertId !== undefined && incoming.alertId !== existingAlertId) {
			conflict = true;
		}
		if (incoming.setupType !== undefined && incoming.setupType !== existingSetupType) {
			conflict = true;
		}

		if (conflict) {
			const error = new ErrorClass(
				'Reconciled Binance order provenance does not match the request',
				'BINANCE_ORDER_CONFLICT',
				409,
			);
			error.code = 'BINANCE_ORDER_CONFLICT';
			error.statusCode = 409;
			error.clientOrderId = clientOrderId;
			throw error;
		}

		return {
			origin: existingOrigin,
			alertId: existingAlertId,
			setupType: existingSetupType,
		};
	}

	return bindOrderProvenance({
		environment,
		symbol,
		clientOrderId,
		binanceOrderId,
		origin,
		alertId,
		setupType,
		firestore,
	});
}

function resetOrderProvenanceForTesting() {
	memoryCache.clear();
}

module.exports = {
	bindOrderProvenance,
	resolveOrderProvenance,
	resetOrderProvenanceForTesting,
	COLLECTION_NAME,
};
