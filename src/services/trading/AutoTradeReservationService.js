'use strict';

const crypto = require('crypto');
const { getFirestore } = require('../storage/AlertStorageService');
const { smartEscapeMarkdownV2 } = require('../notification/formatters/markdownV2Formatter');

const COLLECTION = 'autoTradeReservations';
const COOLDOWN_COLLECTION = 'autoTradeCooldowns';

const activeAmbiguousIds = new Set();
const pagedReservations = new Set();
const MAX_PAGED_RESERVATIONS = 500;

function digest(value) {
	return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function escapeV2(text) {
	return typeof smartEscapeMarkdownV2 === 'function'
		? smartEscapeMarkdownV2(String(text || ''))
		: String(text || '');
}

function trackAmbiguous(id) {
	if (id) activeAmbiguousIds.add(String(id));
}

function untrackAmbiguous(id) {
	if (id) activeAmbiguousIds.delete(String(id));
}

function getAmbiguousCount() {
	return activeAmbiguousIds.size;
}

/** Atomically claim a permanent occurrence and a shared cooldown slot. */
async function reserveAutoTrade(signalId, intentFingerprint, options = {}) {
	const { cooldownKey, cooldownMs, context, intent } = options;
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
			const document = {
				fingerprint,
				signalId: String(signalId),
				status: 'pending',
				ambiguous: false,
				cooldownKey: cooldownKey || null,
				cooldownDocId: cooldownKey ? digest(cooldownKey) : null,
				cooldownMs: cooldownMs || null,
				createdAt: now,
				updatedAt: now,
			};
			if (context && typeof context === 'object') {
				document.signalContext = context;
			} else {
				try {
					const parsed = JSON.parse(intentFingerprint);
					if (parsed && typeof parsed === 'object') {
						document.intent = parsed;
						document.signalContext = {
							signalId: String(signalId),
							symbol: parsed.symbol,
							side: parsed.side,
							timeframe: parsed.timeframe,
							exchange: parsed.exchange,
							quoteOrderQty: parsed.quoteOrderQty,
						};
					}
				} catch {
					// not a JSON string, fallback
				}
			}
			if (intent && typeof intent === 'object') document.intent = intent;

			transaction.set(docRef, document);
			transaction.set(cooldownRef, { firedAtMs: nowMs, updatedAt: now });
			return { state: 'reserved' };
		});
		return outcome.state === 'reserved'
			? { ...outcome, docRef, id: digest(signalId), signalId: String(signalId), cooldownKey }
			: outcome;
	} catch (error) {
		console.warn('[AutoTradeReservationService] reservation failed', { code: error?.code });
		return { state: 'unavailable' };
	}
}

async function notifyAdminOfAmbiguousReservation({ reservationId, signalId, signalContext, reason, details = {} } = {}) {
	const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
	if (!adminChatId) return false;
	const resId = String(reservationId || signalId || '');
	if (!resId) return false;

	// #827 Dedup pattern: page only on first report of a new ambiguous row
	if (pagedReservations.has(resId)) {
		return false;
	}
	if (pagedReservations.size >= MAX_PAGED_RESERVATIONS) {
		const oldest = pagedReservations.values().next().value;
		pagedReservations.delete(oldest);
	}
	pagedReservations.add(resId);

	const symbol = signalContext?.symbol || details?.symbol || 'UNKNOWN';
	const side = signalContext?.side || details?.side || 'BUY';
	const reasonStr = reason || details?.errorCode || 'BINANCE_ORDER_STATUS_UNKNOWN';

	const message = [
		'⚠️ *Auto\\-Trade Ambiguous Reservation*',
		`*Signal ID:* \`${escapeV2(String(signalId || resId))}\``,
		`*Symbol:* \`${escapeV2(symbol)}\` \\| *Side:* \`${escapeV2(side)}\``,
		`*Reason:* \`${escapeV2(String(reasonStr))}\``,
		`*Reservation ID:* \`${escapeV2(resId)}\``,
		'Manual reconciliation required via `POST /api/trading/binance/reconciliation/:id`',
	].join('\n');

	try {
		let dispatched = false;
		try {
			const { notificationRedriveService } = require('../notification/NotificationRedriveService');
			const manager = notificationRedriveService?.getNotificationManager?.();
			if (manager && typeof manager._dispatchAdminPage === 'function') {
				const result = await manager._dispatchAdminPage({ message, pageType: 'auto-trade-ambiguous' });
				dispatched = Boolean(result?.delivered);
			}
		} catch {
			// Fallback below
		}

		if (!dispatched) {
			const { resolveBot } = require('../../lib/maintenanceMode');
			const bot = typeof resolveBot === 'function' ? resolveBot() : null;
			if (bot?.telegram && typeof bot.telegram.sendMessage === 'function') {
				await bot.telegram.sendMessage(adminChatId, message, { parse_mode: 'MarkdownV2' });
				dispatched = true;
			}
		}
		return dispatched;
	} catch (error) {
		console.warn('[AutoTradeReservationService] failed to page admin on ambiguous reservation:', error?.message || error);
		return false;
	}
}

async function finishAutoTrade(reservation, status, details = {}) {
	if (reservation?.state !== 'reserved') return false;
	const isAmbiguous = status === 'unknown' || details.ambiguous === true;
	const document = { status, ambiguous: isAmbiguous, updatedAt: new Date() };
	if (isAmbiguous) {
		document.ambiguousReason = details.reason || details.errorCode || 'BINANCE_ORDER_STATUS_UNKNOWN';
		if (details.lastAttempt && typeof details.lastAttempt === 'object') {
			document.lastAttempt = details.lastAttempt;
		} else if (details.errorCode || details.errorMessage || details.clientOrderId) {
			document.lastAttempt = {
				errorCode: details.errorCode || null,
				errorMessage: details.errorMessage || null,
				clientOrderId: details.clientOrderId || null,
				attemptedAt: new Date(),
			};
		}
		if (details.signalContext && typeof details.signalContext === 'object') {
			document.signalContext = details.signalContext;
		}
	}
	if (Number.isSafeInteger(details.orderId)) document.orderId = details.orderId;
	if (typeof details.errorCode === 'string') document.errorCode = details.errorCode;
	if (typeof details.clientOrderId === 'string') document.clientOrderId = details.clientOrderId;

	try {
		await reservation.docRef.update(document);
		const reservationId = reservation.id || (reservation.signalId ? digest(reservation.signalId) : null);
		if (isAmbiguous && reservationId) {
			trackAmbiguous(reservationId);
			// Page admin on first report of new ambiguous row (#827 pattern)
			void notifyAdminOfAmbiguousReservation({
				reservationId,
				signalId: reservation.signalId,
				signalContext: details.signalContext || reservation.signalContext,
				reason: document.ambiguousReason,
				details,
			}).catch((err) => {
				console.warn('[AutoTradeReservationService] admin notification failed:', err?.message || err);
			});
		}
		return true;
	} catch (error) {
		// Keep the pending claim. A status write failure must never permit a second order.
		console.warn('[AutoTradeReservationService] reservation status update failed', { code: error?.code });
		return false;
	}
}

async function listAmbiguousReservations({ limit = 50, symbol, status = 'ambiguous' } = {}) {
	const firestore = getFirestore();
	if (!firestore) return { success: false, error: 'Firestore unavailable', reservations: [], count: 0, ambiguousCount: getAmbiguousCount() };
	const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));
	try {
		let query = firestore.collection(COLLECTION);
		if (status === 'ambiguous') {
			query = query.where('ambiguous', '==', true);
		}
		if (symbol && typeof query.where === 'function') {
			query = query.where('signalContext.symbol', '==', String(symbol).toUpperCase());
		}
		const snapshot = await (query.limit ? query.limit(boundedLimit).get() : query.get());
		const reservations = [];
		if (snapshot && Array.isArray(snapshot.docs)) {
			for (const doc of snapshot.docs) {
				const data = doc.data ? doc.data() : doc;
				reservations.push({ id: doc.id, ...data });
			}
		}
		reservations.sort((a, b) => {
			const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
			const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
			return timeB - timeA;
		});
		return {
			success: true,
			reservations,
			count: reservations.length,
			ambiguousCount: getAmbiguousCount(),
		};
	} catch (error) {
		console.warn('[AutoTradeReservationService] listAmbiguousReservations failed:', error?.message || error);
		return { success: false, error: error.message, reservations: [], count: 0, ambiguousCount: getAmbiguousCount() };
	}
}

async function getAmbiguousReservation(reservationId) {
	if (!reservationId || typeof reservationId !== 'string') return null;
	const firestore = getFirestore();
	if (!firestore) return null;
	const trimmed = reservationId.trim();
	const docId = trimmed.length === 64 ? trimmed : digest(trimmed);
	try {
		const doc = await firestore.collection(COLLECTION).doc(docId).get();
		if (!doc || !doc.exists) return null;
		return { id: doc.id, ...(typeof doc.data === 'function' ? doc.data() : doc) };
	} catch (error) {
		console.warn('[AutoTradeReservationService] getAmbiguousReservation failed:', error?.message || error);
		return null;
	}
}

async function resolveAmbiguousReservation(reservationId, { resolvedAs, orderId, notes, actor } = {}) {
	if (!['placed', 'not_placed'].includes(resolvedAs)) {
		const error = new Error("resolvedAs must be 'placed' or 'not_placed'");
		error.code = 'INVALID_REQUEST';
		error.statusCode = 400;
		throw error;
	}
	const firestore = getFirestore();
	if (!firestore || typeof firestore.runTransaction !== 'function') {
		const error = new Error('Storage unavailable');
		error.code = 'STORAGE_UNAVAILABLE';
		error.statusCode = 503;
		throw error;
	}
	const trimmed = String(reservationId || '').trim();
	const docId = trimmed.length === 64 ? trimmed : digest(trimmed);
	const docRef = firestore.collection(COLLECTION).doc(docId);

	const outcome = await firestore.runTransaction(async (transaction) => {
		const doc = await transaction.get(docRef);
		if (!doc || !doc.exists) {
			const error = new Error('Reservation not found');
			error.code = 'RESERVATION_NOT_FOUND';
			error.statusCode = 404;
			throw error;
		}
		const data = typeof doc.data === 'function' ? doc.data() : doc;
		if (!data.ambiguous && data.status !== 'unknown') {
			if (data.resolvedAs === resolvedAs) {
				return { idempotent: true, reservation: { id: doc.id, ...data } };
			}
			if (data.resolvedAs && data.resolvedAs !== resolvedAs) {
				const error = new Error(`Reservation already resolved as ${data.resolvedAs}`);
				error.code = 'RESERVATION_ALREADY_RESOLVED';
				error.statusCode = 409;
				throw error;
			}
			const error = new Error('Reservation is not ambiguous');
			error.code = 'NOT_AMBIGUOUS';
			error.statusCode = 400;
			throw error;
		}

		const now = new Date();
		const isPlaced = resolvedAs === 'placed';
		const updateData = {
			status: isPlaced ? 'submitted' : 'failed',
			ambiguous: false,
			resolvedAs,
			resolvedAt: now,
			resolvedBy: actor || 'operator',
			updatedAt: now,
		};
		if (notes !== undefined && notes !== null) updateData.notes = String(notes);
		if (isPlaced) {
			if (orderId !== undefined && orderId !== null) updateData.orderId = Number(orderId);
		} else {
			// not_placed: settle cooldown
			const cooldownDocId = data.cooldownDocId || (data.cooldownKey ? digest(data.cooldownKey) : null);
			if (cooldownDocId) {
				const cooldownRef = firestore.collection(COOLDOWN_COLLECTION).doc(cooldownDocId);
				transaction.delete(cooldownRef);
			}
		}
		transaction.update(docRef, updateData);
		return { idempotent: false, reservation: { id: doc.id, ...data, ...updateData } };
	});

	if (resolvedAs === 'not_placed' && outcome?.reservation?.cooldownKey) {
		try {
			const { clearAutoTradeCooldown } = require('./AlertSignalRouter');
			if (typeof clearAutoTradeCooldown === 'function') {
				clearAutoTradeCooldown(outcome.reservation.cooldownKey);
			}
		} catch {
			// fail-open
		}
	}

	untrackAmbiguous(docId);
	return outcome;
}

module.exports = {
	reserveAutoTrade,
	finishAutoTrade,
	listAmbiguousReservations,
	getAmbiguousReservation,
	resolveAmbiguousReservation,
	notifyAdminOfAmbiguousReservation,
	getAmbiguousCount,
	trackAmbiguous,
	untrackAmbiguous,
	digest,
	__resetForTesting: () => {
		activeAmbiguousIds.clear();
		pagedReservations.clear();
	},
};
