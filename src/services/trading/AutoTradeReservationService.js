const crypto = require('crypto');
const { getFirestore } = require('../storage/AlertStorageService');
const { smartEscapeMarkdownV2 } = require('../notification/formatters/MarkdownV2Formatter');

const COLLECTION = 'autoTradeReservations';
const COOLDOWN_COLLECTION = 'autoTradeCooldowns';
const MAX_PAGED_RESERVATIONS = 1000;

const pagedReservations = new Set();
const activeAmbiguousIds = new Set();
let cachedDurableCount = null;
let lastCountRefreshedAt = 0;

let botGetter = null;

function setBotGetter(getter) {
	botGetter = getter;
}

function digest(value) {
	return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function escapeV2(text) {
	return typeof smartEscapeMarkdownV2 === 'function'
		? smartEscapeMarkdownV2(String(text || ''))
		: String(text || '');
}

function trackAmbiguous(id) {
	if (id) {
		activeAmbiguousIds.add(String(id));
		if (cachedDurableCount !== null) cachedDurableCount = activeAmbiguousIds.size;
	}
}

function untrackAmbiguous(id) {
	if (id) {
		activeAmbiguousIds.delete(String(id));
		if (cachedDurableCount !== null) cachedDurableCount = activeAmbiguousIds.size;
	}
}

async function refreshAmbiguousCount() {
	const firestore = getFirestore();
	if (!firestore) return cachedDurableCount ?? activeAmbiguousIds.size;
	try {
		const docsMap = new Map();
		const [ambSnap, unkSnap] = await Promise.all([
			(firestore.collection(COLLECTION).where('ambiguous', '==', true).get ? firestore.collection(COLLECTION).where('ambiguous', '==', true).get() : Promise.resolve(null)).catch(() => null),
			(firestore.collection(COLLECTION).where('status', '==', 'unknown').get ? firestore.collection(COLLECTION).where('status', '==', 'unknown').get() : Promise.resolve(null)).catch(() => null),
		]);
		for (const snap of [ambSnap, unkSnap]) {
			if (snap && Array.isArray(snap.docs)) {
				for (const doc of snap.docs) {
					const data = typeof doc.data === 'function' ? doc.data() : doc;
					if (data.ambiguous === true || (data.status === 'unknown' && data.ambiguous !== false)) {
						docsMap.set(doc.id, true);
					}
				}
			}
		}
		activeAmbiguousIds.clear();
		for (const id of docsMap.keys()) {
			activeAmbiguousIds.add(id);
		}
		cachedDurableCount = activeAmbiguousIds.size;
		lastCountRefreshedAt = Date.now();
		return cachedDurableCount;
	} catch {
		return cachedDurableCount ?? activeAmbiguousIds.size;
	}
}

function getAmbiguousCount() {
	if (cachedDurableCount === null || Date.now() - lastCountRefreshedAt > 30000) {
		refreshAmbiguousCount().catch(() => {});
	}
	return cachedDurableCount !== null ? cachedDurableCount : activeAmbiguousIds.size;
}

/** Atomically claim a permanent occurrence and a shared cooldown slot. */
async function reserveAutoTrade(signalId, intentFingerprint, options = {}) {
	const { cooldownKey, cooldownMs, context, intent } = options;
	const firestore = getFirestore();
	if (!firestore || typeof firestore.runTransaction !== 'function' || !cooldownKey
		|| !Number.isFinite(cooldownMs) || cooldownMs <= 0) return { state: 'unavailable' };
	const docId = digest(signalId);
	const docRef = firestore.collection(COLLECTION).doc(docId);
	const cooldownDocId = digest(cooldownKey);
	const cooldownRef = firestore.collection(COOLDOWN_COLLECTION).doc(cooldownDocId);
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
				cooldownDocId,
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
			transaction.set(cooldownRef, {
				firedAtMs: nowMs,
				updatedAt: now,
				reservationId: docId,
				signalId: String(signalId),
			});
			return { state: 'reserved' };
		});
		return outcome.state === 'reserved'
			? { ...outcome, docRef, id: docId, signalId: String(signalId), cooldownKey }
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
		if (typeof botGetter === 'function') {
			try {
				const bot = botGetter();
				if (bot && bot.telegram && typeof bot.telegram.sendMessage === 'function') {
					await bot.telegram.sendMessage(adminChatId, message, { parse_mode: 'MarkdownV2' });
					dispatched = true;
				}
			} catch {
				// ignore bot lookup failure
			}
		}

		if (!dispatched) {
			const botToken = process.env.BOT_TOKEN;
			if (botToken) {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), 5000);
				try {
					await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							chat_id: adminChatId,
							text: message,
							parse_mode: 'MarkdownV2',
						}),
						signal: controller.signal,
					});
				} finally {
					clearTimeout(timeoutId);
				}
			}
		}
		return true;
	} catch (error) {
		console.warn('[AutoTradeReservationService] failed to notify admin Telegram chat (fail-open):', error?.message || error);
		return false;
	}
}

/**
 * Update a claimed reservation once the Binance order lifecycle outcome is known.
 * Supports marking indeterminate submissions as ambiguous for operator reconciliation.
 */
async function finishAutoTrade(reservation, status, details = {}) {
	if (!reservation || !reservation.docRef || !status) return false;
	const isIndeterminate = status === 'unknown' || details.ambiguous === true;
	const now = new Date();
	const document = {
		status: isIndeterminate ? 'unknown' : status,
		ambiguous: Boolean(isIndeterminate),
		resolvedAt: null,
		updatedAt: now,
	};
	if (isIndeterminate) {
		document.ambiguousReason = details.errorCode || details.reason || 'BINANCE_ORDER_STATUS_UNKNOWN';
		document.lastAttempt = {
			attemptedAt: now,
			errorCode: details.errorCode || null,
			clientOrderId: details.clientOrderId || null,
			error: details.error || null,
		};
	}
	if (details.orderId !== undefined && details.orderId !== null) {
		document.orderId = details.orderId;
	}
	try {
		await reservation.docRef.update(document);
		if (isIndeterminate) {
			const reservationId = reservation.id || reservation.docRef.id;
			trackAmbiguous(reservationId);
			notifyAdminOfAmbiguousReservation({
				reservationId,
				signalId: reservation.signalId,
				signalContext: reservation.signalContext,
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
	if (!firestore) return { success: false, error: 'Firestore unavailable', code: 'STORAGE_UNAVAILABLE', reservations: [], count: 0, ambiguousCount: getAmbiguousCount() };

	if (limit !== undefined && limit !== null && limit !== '') {
		const str = String(limit).trim();
		if (!/^\d+$/.test(str)) {
			const error = new Error('limit must be an integer between 1 and 100');
			error.code = 'INVALID_REQUEST';
			error.statusCode = 400;
			throw error;
		}
		const parsed = parseInt(str, 10);
		if (parsed < 1 || parsed > 100) {
			const error = new Error('limit must be an integer between 1 and 100');
			error.code = 'INVALID_REQUEST';
			error.statusCode = 400;
			throw error;
		}
	}
	const boundedLimit = Math.max(1, Math.min(Number(limit) || 50, 100));

	try {
		const docsMap = new Map();
		if (status === 'ambiguous') {
			let ambQuery = firestore.collection(COLLECTION).where('ambiguous', '==', true);
			let unkQuery = firestore.collection(COLLECTION).where('status', '==', 'unknown');
			if (symbol) {
				const sym = String(symbol).toUpperCase();
				ambQuery = ambQuery.where('signalContext.symbol', '==', sym);
				unkQuery = unkQuery.where('signalContext.symbol', '==', sym);
			}
			const [ambSnap, unkSnap] = await Promise.all([
				(ambQuery.get ? ambQuery.get() : Promise.resolve(null)).catch(() => null),
				(unkQuery.get ? unkQuery.get() : Promise.resolve(null)).catch(() => null),
			]);
			for (const snap of [ambSnap, unkSnap]) {
				if (snap && Array.isArray(snap.docs)) {
					for (const doc of snap.docs) {
						const data = typeof doc.data === 'function' ? doc.data() : doc;
						if (data.ambiguous === true || (data.status === 'unknown' && data.ambiguous !== false)) {
							docsMap.set(doc.id, { id: doc.id, ...data });
						}
					}
				}
			}
		} else {
			let query = firestore.collection(COLLECTION).where('status', '==', status);
			if (symbol) {
				query = query.where('signalContext.symbol', '==', String(symbol).toUpperCase());
			}
			const snapshot = await (query.get ? query.get() : Promise.resolve(null));
			if (snapshot && Array.isArray(snapshot.docs)) {
				for (const doc of snapshot.docs) {
					const data = typeof doc.data === 'function' ? doc.data() : doc;
					docsMap.set(doc.id, { id: doc.id, ...data });
				}
			}
		}

		const reservations = Array.from(docsMap.values());
		reservations.sort((a, b) => {
			const timeA = a.createdAt?.toMillis ? a.createdAt.toMillis() : new Date(a.createdAt || 0).getTime();
			const timeB = b.createdAt?.toMillis ? b.createdAt.toMillis() : new Date(b.createdAt || 0).getTime();
			return timeB - timeA;
		});

		if (status === 'ambiguous') {
			activeAmbiguousIds.clear();
			for (const r of reservations) {
				activeAmbiguousIds.add(r.id);
			}
			cachedDurableCount = activeAmbiguousIds.size;
			lastCountRefreshedAt = Date.now();
		}

		const sliced = reservations.slice(0, boundedLimit);
		return {
			success: true,
			reservations: sliced,
			count: sliced.length,
			ambiguousCount: getAmbiguousCount(),
		};
	} catch (error) {
		console.warn('[AutoTradeReservationService] listAmbiguousReservations failed:', error?.message || error);
		return { success: false, error: error.message, code: 'STORAGE_UNAVAILABLE', reservations: [], count: 0, ambiguousCount: getAmbiguousCount() };
	}
}

async function getAmbiguousReservation(reservationId) {
	if (!reservationId || typeof reservationId !== 'string') return null;
	const firestore = getFirestore();
	if (!firestore) {
		const error = new Error('Storage unavailable');
		error.code = 'STORAGE_UNAVAILABLE';
		error.statusCode = 503;
		throw error;
	}
	const trimmed = reservationId.trim();
	const docId = trimmed.length === 64 ? trimmed : digest(trimmed);
	try {
		const doc = await firestore.collection(COLLECTION).doc(docId).get();
		if (!doc || !doc.exists) return null;
		return { id: doc.id, ...(typeof doc.data === 'function' ? doc.data() : doc) };
	} catch (error) {
		console.warn('[AutoTradeReservationService] getAmbiguousReservation failed:', error?.message || error);
		const err = new Error(error.message || 'Storage unavailable');
		err.code = 'STORAGE_UNAVAILABLE';
		err.statusCode = 503;
		throw err;
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
			// not_placed: settle cooldown with ownership verification
			const cooldownDocId = data.cooldownDocId || (data.cooldownKey ? digest(data.cooldownKey) : null);
			if (cooldownDocId) {
				const cooldownRef = firestore.collection(COOLDOWN_COLLECTION).doc(cooldownDocId);
				const cooldownDoc = await transaction.get(cooldownRef);
				if (cooldownDoc && cooldownDoc.exists) {
					const cdData = typeof cooldownDoc.data === 'function' ? cooldownDoc.data() : cooldownDoc;
					const matches = !cdData.reservationId
						|| cdData.reservationId === docId
						|| cdData.signalId === String(data.signalId);
					if (matches) {
						transaction.delete(cooldownRef);
					}
				}
			}
		}
		transaction.update(docRef, updateData);
		return { idempotent: false, reservation: { id: doc.id, ...data, ...updateData } };
	});

	if (resolvedAs === 'not_placed' && outcome?.reservation?.cooldownKey) {
		try {
			const { clearAutoTradeCooldown } = require('./AlertSignalRouter');
			if (typeof clearAutoTradeCooldown === 'function') {
				clearAutoTradeCooldown(outcome.reservation.cooldownKey, {
					reservationId: docId,
					signalId: outcome.reservation.signalId,
				});
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
	refreshAmbiguousCount,
	trackAmbiguous,
	untrackAmbiguous,
	setBotGetter,
	digest,
	__resetForTesting: () => {
		activeAmbiguousIds.clear();
		pagedReservations.clear();
		cachedDurableCount = null;
		lastCountRefreshedAt = 0;
	},
};
