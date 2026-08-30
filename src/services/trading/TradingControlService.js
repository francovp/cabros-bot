'use strict';

/**
 * TradingControlService — operator-gated runtime control plane for the
 * optional Binance Spot order workflow.
 *
 * The pause state is intentionally kept out of Firebase Remote Config
 * to stay consistent with the documented policy that route/security gates
 * stay environment-only. It is stored in a small Firestore document so
 * multiple web/worker replicas observe the same authoritative state.
 *
 * Storage layout:
 *   collection `tradingControl` / document `state`:
 *     paused:         boolean
 *     pausedBy:       string | null
 *     pausedAt:       ISO-8601 string | null
 *     pausedReason:   string | null
 *     resumedBy:      string | null
 *     resumedAt:      ISO-8601 string | null
 *     lastChangedAt:  ISO-8601 string
 *     lastChangedBy:  string
 *     lastAction:     'pause' | 'resume'
 *
 * Behavior:
 *   - When ENABLE_BINANCE_TRADING=true and the pause state cannot be
 *     read from Firestore, getPauseState() returns { paused: false,
 *     unavailable: true } and isBlocked() flips to true so callers
 *     fail closed.
 *   - When ENABLE_BINANCE_TRADING=false, getPauseState() returns
 *     { paused: false, inactive: true } so the gate never blocks a
 *     disabled path.
 *   - pause()/resume() are idempotent and audit-logged.
 *   - Firestore errors fail open in the read path when trading is
 *     disabled, and fail closed when trading is enabled.
 */

const admin = require('firebase-admin');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');

const STATE_DOC_PATH = 'tradingControl/state';
const COLLECTION_NAME = 'tradingControl';
const STATE_DOC_ID = 'state';
const MAX_REASON_LENGTH = 280;
const REASON_KEYS = ['reason', 'pauseReason', 'resumeReason'];
const ACTION_KEYS = ['action'];

function isBinanceTradingEnabled() {
	return process.env.ENABLE_BINANCE_TRADING === 'true';
}

function normalizeActor(actor) {
	if (typeof actor !== 'string') return 'unknown';
	const trimmed = actor.trim();
	return trimmed ? trimmed.slice(0, 80) : 'unknown';
}

function normalizeReason(reason) {
	if (reason === undefined || reason === null) return null;
	if (typeof reason !== 'string') return null;
	const trimmed = reason.trim();
	if (!trimmed) return null;
	return trimmed.slice(0, MAX_REASON_LENGTH);
}

function readReason(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	for (const key of REASON_KEYS) {
		if (Object.prototype.hasOwnProperty.call(body, key)) {
			return normalizeReason(body[key]);
		}
	}
	return null;
}

function readAction(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	for (const key of ACTION_KEYS) {
		if (Object.prototype.hasOwnProperty.call(body, key)) {
			const value = body[key];
			if (typeof value !== 'string') return null;
			const trimmed = value.trim().toLowerCase();
			if (trimmed === 'pause' || trimmed === 'resume') return trimmed;
		}
	}
	return null;
}

class TradingControlError extends Error {
	constructor(message, code = 'TRADING_CONTROL_ERROR', statusCode = 500) {
		super(message);
		this.name = 'TradingControlError';
		this.code = code;
		this.statusCode = statusCode;
	}
}

class TradingControlState {
	constructor({
		paused = false,
		pausedBy = null,
		pausedAt = null,
		pausedReason = null,
		resumedBy = null,
		resumedAt = null,
		lastChangedAt = null,
		lastChangedBy = null,
		lastAction = null,
		unavailable = false,
		inactive = false,
		storage = 'memory',
	} = {}) {
		this.paused = Boolean(paused);
		this.pausedBy = pausedBy;
		this.pausedAt = pausedAt;
		this.pausedReason = pausedReason;
		this.resumedBy = resumedBy;
		this.resumedAt = resumedAt;
		this.lastChangedAt = lastChangedAt;
		this.lastChangedBy = lastChangedBy;
		this.lastAction = lastAction;
		this.unavailable = Boolean(unavailable);
		this.inactive = Boolean(inactive);
		this.storage = storage;
	}

	toJSON() {
		return {
			paused: this.paused,
			pausedBy: this.pausedBy,
			pausedAt: this.pausedAt,
			pausedReason: this.pausedReason,
			resumedBy: this.resumedBy,
			resumedAt: this.resumedAt,
			lastChangedAt: this.lastChangedAt,
			lastChangedBy: this.lastChangedBy,
			lastAction: this.lastAction,
			unavailable: this.unavailable,
			inactive: this.inactive,
			storage: this.storage,
		};
	}

	isBlocked() {
		// Fail-closed only when trading is enabled and the state is
		// unavailable. When trading is disabled the gate is open by
		// definition — no live orders can flow.
		return this.paused || (this.unavailable && !this.inactive);
	}
}

function createTradingControlService({
	firestoreFactory = () => {
		try {
			if (!admin.apps.length) {
				const options = {};
				if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
					options.credential = admin.credential.cert(
						JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
					);
				}
				if (process.env.FIREBASE_PROJECT_ID) {
					options.projectId = process.env.FIREBASE_PROJECT_ID;
				}
				admin.initializeApp(options);
			}
			return admin.firestore();
		} catch (error) {
			return null;
		}
	},
	now = () => new Date().toISOString(),
	log = console,
} = {}) {
	const memoryState = new TradingControlState();
	let firestoreRef = null;
	let firestoreInitialized = false;
	let lastFirestoreError = null;

	function getFirestore() {
		if (firestoreInitialized) return firestoreRef;
		firestoreInitialized = true;
		if (!isFirestoreConfigured()) {
			firestoreRef = null;
			return null;
		}
		try {
			firestoreRef = firestoreFactory();
		} catch (error) {
			firestoreRef = null;
			lastFirestoreError = error;
			if (log && typeof log.warn === 'function') {
				log.warn(
					'[TradingControlService] Failed to initialize Firestore client:',
					error && error.message ? error.message : error,
				);
			}
		}
		return firestoreRef;
	}

	function buildSnapshotFromMemory() {
		return new TradingControlState({
			paused: memoryState.paused,
			pausedBy: memoryState.pausedBy,
			pausedAt: memoryState.pausedAt,
			pausedReason: memoryState.pausedReason,
			resumedBy: memoryState.resumedBy,
			resumedAt: memoryState.resumedAt,
			lastChangedAt: memoryState.lastChangedAt,
			lastChangedBy: memoryState.lastChangedBy,
			lastAction: memoryState.lastAction,
			inactive: !isBinanceTradingEnabled(),
			unavailable: false,
			storage: 'memory',
		});
	}

	function applyToMemory(snapshot) {
		memoryState.paused = snapshot.paused;
		memoryState.pausedBy = snapshot.pausedBy;
		memoryState.pausedAt = snapshot.pausedAt;
		memoryState.pausedReason = snapshot.pausedReason;
		memoryState.resumedBy = snapshot.resumedBy;
		memoryState.resumedAt = snapshot.resumedAt;
		memoryState.lastChangedAt = snapshot.lastChangedAt;
		memoryState.lastChangedBy = snapshot.lastChangedBy;
		memoryState.lastAction = snapshot.lastAction;
	}

	async function readFirestoreState() {
		const db = getFirestore();
		if (!db) return null;
		const snapshot = await db.doc(STATE_DOC_PATH).get();
		if (!snapshot.exists) {
			return {
				paused: false,
				pausedBy: null,
				pausedAt: null,
				pausedReason: null,
				resumedBy: null,
				resumedAt: null,
				lastChangedAt: null,
				lastChangedBy: null,
				lastAction: null,
			};
		}
		const data = snapshot.data() || {};
		return {
			paused: data.paused === true,
			pausedBy: typeof data.pausedBy === 'string' ? data.pausedBy : null,
			pausedAt: typeof data.pausedAt === 'string' ? data.pausedAt : null,
			pausedReason: typeof data.pausedReason === 'string' ? data.pausedReason : null,
			resumedBy: typeof data.resumedBy === 'string' ? data.resumedBy : null,
			resumedAt: typeof data.resumedAt === 'string' ? data.resumedAt : null,
			lastChangedAt: typeof data.lastChangedAt === 'string' ? data.lastChangedAt : null,
			lastChangedBy: typeof data.lastChangedBy === 'string' ? data.lastChangedBy : null,
			lastAction: data.lastAction === 'pause' || data.lastAction === 'resume'
				? data.lastAction
				: null,
		};
	}

	async function getPauseState() {
		const tradingEnabled = isBinanceTradingEnabled();
		if (!tradingEnabled) {
			// When the trading path is disabled, the gate is open by
			// definition (no live orders can flow) so the surface
			// state is always paused:false, unavailable:false,
			// inactive:true. Memory metadata (who paused, when, why)
			// is still surfaced for observability.
			return new TradingControlState({
				paused: false,
				pausedBy: memoryState.pausedBy,
				pausedAt: memoryState.pausedAt,
				pausedReason: memoryState.pausedReason,
				resumedBy: memoryState.resumedBy,
				resumedAt: memoryState.resumedAt,
				lastChangedAt: memoryState.lastChangedAt,
				lastChangedBy: memoryState.lastChangedBy,
				lastAction: memoryState.lastAction,
				unavailable: false,
				inactive: true,
				storage: 'memory',
			});
		}

		const db = getFirestore();
		if (!db) {
			return new TradingControlState({
				paused: false,
				unavailable: true,
				inactive: false,
				storage: 'memory',
			});
		}

		try {
			const remote = await readFirestoreState();
			const snapshot = new TradingControlState({
				...remote,
				unavailable: false,
				inactive: false,
				storage: 'firestore',
			});
			applyToMemory(snapshot);
			return snapshot;
		} catch (error) {
			lastFirestoreError = error;
			if (log && typeof log.warn === 'function') {
				log.warn(
					'[TradingControlService] Failed to read pause state, failing closed:',
					error && error.message ? error.message : error,
				);
			}
			return new TradingControlState({
				paused: false,
				unavailable: true,
				inactive: false,
				storage: 'memory',
			});
		}
	}

	async function writePauseState({ paused, actor, reason }) {
		const db = getFirestore();
		const normalizedActor = normalizeActor(actor);
		const timestamp = now();
		const update = paused
			? {
				paused: true,
				pausedBy: normalizedActor,
				pausedAt: timestamp,
				pausedReason: reason,
				resumedBy: null,
				resumedAt: null,
				lastChangedAt: timestamp,
				lastChangedBy: normalizedActor,
				lastAction: 'pause',
			}
			: {
				paused: false,
				pausedBy: null,
				pausedAt: null,
				pausedReason: null,
				resumedBy: normalizedActor,
				resumedAt: timestamp,
				lastChangedAt: timestamp,
				lastChangedBy: normalizedActor,
				lastAction: 'resume',
			};

		if (!db) {
			applyToMemory(new TradingControlState({
				...update,
				unavailable: false,
				inactive: false,
				storage: 'memory',
			}));
			return new TradingControlState({
				...update,
				unavailable: false,
				inactive: !isBinanceTradingEnabled(),
				storage: 'memory',
			});
		}

		await db.doc(STATE_DOC_PATH).set(update, { merge: false });
		applyToMemory(new TradingControlState({
			...update,
			unavailable: false,
			inactive: false,
			storage: 'firestore',
		}));
		return new TradingControlState({
			...update,
			unavailable: false,
			inactive: !isBinanceTradingEnabled(),
			storage: 'firestore',
		});
	}

	async function pause({ actor, reason } = {}) {
		const tradingEnabled = isBinanceTradingEnabled();
		if (!tradingEnabled) {
			throw new TradingControlError(
				'Binance trading is disabled; pause state cannot be set without an enabled order path',
				'TRADING_DISABLED',
				409,
			);
		}
		const current = await getPauseState();
		if (current.unavailable) {
			throw new TradingControlError(
				'Pause state is unavailable; refuse to update without authoritative storage',
				'TRADING_CONTROL_UNAVAILABLE',
				503,
			);
		}
		const next = await writePauseState({
			paused: true,
			actor,
			reason,
		});
		if (log && typeof log.log === 'function') {
			log.log('[TradingControlService] Binance order submissions paused', {
				actor: next.lastChangedBy,
				reason: next.pausedReason,
				timestamp: next.lastChangedAt,
			});
		}
		return next;
	}

	async function resume({ actor, reason } = {}) {
		const tradingEnabled = isBinanceTradingEnabled();
		if (!tradingEnabled) {
			throw new TradingControlError(
				'Binance trading is disabled; resume is a no-op when the order path is disabled',
				'TRADING_DISABLED',
				409,
			);
		}
		const current = await getPauseState();
		if (current.unavailable) {
			throw new TradingControlError(
				'Pause state is unavailable; refuse to update without authoritative storage',
				'TRADING_CONTROL_UNAVAILABLE',
				503,
			);
		}
		const next = await writePauseState({
			paused: false,
			actor,
			reason,
		});
		if (log && typeof log.log === 'function') {
			log.log('[TradingControlService] Binance order submissions resumed', {
				actor: next.lastChangedBy,
				reason,
				timestamp: next.lastChangedAt,
			});
		}
		return next;
	}

	function getStatus() {
		const firestore = getFirestore();
		return {
			enabled: isBinanceTradingEnabled(),
			storage: firestore ? 'firestore' : 'memory',
			paused: memoryState.paused,
			pausedBy: memoryState.pausedBy,
			pausedAt: memoryState.pausedAt,
			pausedReason: memoryState.pausedReason,
			lastChangedAt: memoryState.lastChangedAt,
			lastChangedBy: memoryState.lastChangedBy,
			lastAction: memoryState.lastAction,
			firestoreReady: Boolean(firestore),
		};
	}

	function _setMemoryStateForTesting(snapshot) {
		applyToMemory(snapshot || {});
	}

	function _resetFirestoreForTesting() {
		firestoreInitialized = false;
		firestoreRef = null;
		lastFirestoreError = null;
	}

	function _getLastFirestoreErrorForTesting() {
		return lastFirestoreError;
	}

	return {
		pause,
		resume,
		getPauseState,
		getStatus,
		readAction,
		readReason,
		normalizeActor,
		normalizeReason,
		_setMemoryStateForTesting,
		_resetFirestoreForTesting,
		_getLastFirestoreErrorForTesting,
	};
}

const tradingControlService = createTradingControlService();

module.exports = {
	createTradingControlService,
	tradingControlService,
	TradingControlError,
	TradingControlState,
	STATE_DOC_PATH,
	COLLECTION_NAME,
	STATE_DOC_ID,
};
