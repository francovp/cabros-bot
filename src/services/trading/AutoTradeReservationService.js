'use strict';

const crypto = require('crypto');
const { getFirestore } = require('../storage/AlertStorageService');

const COLLECTION = 'autoTradeReservations';
const COOLDOWN_COLLECTION = 'autoTradeCooldowns';

function digest(value) {
	return crypto.createHash('sha256').update(value).digest('hex');
}

/** Atomically claim a permanent occurrence and a shared cooldown slot. */
async function reserveAutoTrade(signalId, intentFingerprint, { cooldownKey, cooldownMs } = {}) {
	const firestore = getFirestore();
	if (!firestore || typeof firestore.runTransaction !== 'function' || !cooldownKey
		|| !Number.isFinite(cooldownMs) || cooldownMs <= 0) return { state: 'unavailable' };
	const docRef = firestore.collection(COLLECTION).doc(digest(signalId));
	const cooldownRef = firestore.collection(COOLDOWN_COLLECTION).doc(digest(cooldownKey));
	const fingerprint = digest(intentFingerprint);
	try {
		const outcome = await firestore.runTransaction(async (transaction) => {
			// Firestore requires all transaction reads before writes. A concurrent
			// reservation retries against the latest cooldown document.
			const [occurrence, cooldown] = await Promise.all([
				transaction.get(docRef), transaction.get(cooldownRef),
			]);
			if (occurrence.exists) {
				const existing = occurrence.data();
				return existing.fingerprint === fingerprint
					? { state: 'duplicate', status: existing.status }
					: { state: 'conflict' };
			}
			const nowMs = Date.now();
			if (cooldown.exists && nowMs - cooldown.data().firedAtMs < cooldownMs) {
				return { state: 'cooldown' };
			}
			const now = new Date(nowMs);
			transaction.set(docRef, { fingerprint, status: 'pending', createdAt: now, updatedAt: now });
			transaction.set(cooldownRef, { firedAtMs: nowMs, updatedAt: now });
			return { state: 'reserved' };
		});
		return outcome.state === 'reserved' ? { ...outcome, docRef } : outcome;
	} catch (error) {
		console.warn('[AutoTradeReservationService] reservation failed', { code: error?.code });
		return { state: 'unavailable' };
	}
}

async function finishAutoTrade(reservation, status, details = {}) {
	if (reservation?.state !== 'reserved') return false;
	const document = { status, updatedAt: new Date() };
	if (Number.isSafeInteger(details.orderId)) document.orderId = details.orderId;
	if (typeof details.errorCode === 'string') document.errorCode = details.errorCode;
	try {
		await reservation.docRef.update(document);
		return true;
	} catch (error) {
		// Keep the pending claim. A status write failure must never permit a second order.
		console.warn('[AutoTradeReservationService] reservation status update failed', { code: error?.code });
		return false;
	}
}

module.exports = { reserveAutoTrade, finishAutoTrade };
