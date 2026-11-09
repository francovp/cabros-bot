'use strict';

const admin = require('firebase-admin');
const { initializeFirebaseAdminApp } = require('../../../../services/storage/firebaseAdminCredentials');
const { isFirestoreConfigured } = require('../../../../services/storage/firestoreConfig');

const COLLECTION_NAME = 'newsMonitorPause';
const DOC_ID = 'state';
const DEFAULT_CACHE_TTL_MS = 5000;
const READ_TIMEOUT_MS = 3000;
const WRITE_TIMEOUT_MS = 5000;

let pauseState = {
	paused: false,
	pausedAt: null,
	reason: null,
};
let lastFetchedAt = 0;
let inFlightSync = null;
let customFirestore = null;

function isFirestorePauseEnabled() {
	return process.env.ENABLE_FIRESTORE_NEWS_MONITOR_PAUSE === 'true';
}

function getCacheTtlMs() {
	const raw = parseInt(process.env.NEWS_MONITOR_PAUSE_CACHE_TTL_MS, 10);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CACHE_TTL_MS;
}

function withTimeout(promise, timeoutMs) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			reject(new Error(`Firestore operation timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		if (timer.unref) timer.unref();

		promise.then(
			(res) => {
				clearTimeout(timer);
				resolve(res);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			}
		);
	});
}

function getFirestore() {
	if (customFirestore) return customFirestore;
	if (!isFirestoreConfigured()) return null;
	try {
		const init = initializeFirebaseAdminApp({ admin });
		if (!init || !init.ok) return null;
		return admin.firestore();
	} catch {
		return null;
	}
}

async function syncNewsMonitorPauseState(options = {}) {
	if (!isFirestorePauseEnabled()) {
		return getNewsMonitorPauseState();
	}

	const force = Boolean(options.force);
	const ttl = getCacheTtlMs();
	const now = Date.now();

	if (!force && lastFetchedAt > 0 && (now - lastFetchedAt) < ttl) {
		return getNewsMonitorPauseState();
	}

	if (inFlightSync && !force) {
		return inFlightSync;
	}

	inFlightSync = (async () => {
		try {
			const db = getFirestore();
			if (!db) {
				lastFetchedAt = Date.now();
				return getNewsMonitorPauseState();
			}
			const docRef = db.collection(COLLECTION_NAME).doc(DOC_ID);
			const doc = await withTimeout(docRef.get(), READ_TIMEOUT_MS);
			if (doc && doc.exists) {
				const data = typeof doc.data === 'function' ? doc.data() : doc.data;
				const safeData = data || {};
				pauseState = {
					paused: Boolean(safeData.paused),
					pausedAt: typeof safeData.pausedAt === 'string' ? safeData.pausedAt : null,
					reason: typeof safeData.reason === 'string' ? safeData.reason : null,
				};
			}
			lastFetchedAt = Date.now();
		} catch (error) {
			console.warn('[NewsMonitorPauseState] Failed to fetch pause state from Firestore; failing open to in-memory state:', error.message);
			lastFetchedAt = Date.now();
		} finally {
			inFlightSync = null;
		}
		return getNewsMonitorPauseState();
	})();

	return inFlightSync;
}

function isNewsMonitorPaused() {
	if (isFirestorePauseEnabled()) {
		const now = Date.now();
		if ((now - lastFetchedAt) >= getCacheTtlMs() && !inFlightSync) {
			syncNewsMonitorPauseState().catch(() => {});
		}
	}
	return pauseState.paused;
}

function getNewsMonitorPauseState() {
	return {
		paused: pauseState.paused,
		pausedAt: pauseState.pausedAt,
		reason: pauseState.reason,
	};
}

function pauseNewsMonitor(options = {}) {
	const reason = (typeof options.reason === 'string' && options.reason.trim().length > 0)
		? options.reason.trim()
		: null;

	pauseState = {
		paused: true,
		pausedAt: new Date().toISOString(),
		reason,
	};
	lastFetchedAt = Date.now();

	const currentState = getNewsMonitorPauseState();

	if (isFirestorePauseEnabled()) {
		const persistPromise = (async () => {
			try {
				const db = getFirestore();
				if (db) {
					const docRef = db.collection(COLLECTION_NAME).doc(DOC_ID);
					const payload = {
						paused: true,
						pausedAt: currentState.pausedAt,
						reason: currentState.reason,
						updatedAt: new Date().toISOString(),
					};
					await withTimeout(docRef.set(payload, { merge: true }), WRITE_TIMEOUT_MS);
				}
			} catch (error) {
				console.warn('[NewsMonitorPauseState] Failed to persist pause state to Firestore:', error.message);
			}
			return currentState;
		})();
		return Object.assign(persistPromise, currentState);
	}

	return Object.assign(Promise.resolve(currentState), currentState);
}

function resumeNewsMonitor() {
	const previousState = { ...pauseState };
	pauseState = {
		paused: false,
		pausedAt: null,
		reason: null,
	};
	lastFetchedAt = Date.now();

	const result = {
		paused: false,
		resumedAt: new Date().toISOString(),
		wasPaused: previousState.paused,
		previouslyPausedAt: previousState.pausedAt,
	};

	if (isFirestorePauseEnabled()) {
		const persistPromise = (async () => {
			try {
				const db = getFirestore();
				if (db) {
					const docRef = db.collection(COLLECTION_NAME).doc(DOC_ID);
					const payload = {
						paused: false,
						pausedAt: null,
						reason: null,
						resumedAt: result.resumedAt,
						updatedAt: new Date().toISOString(),
					};
					await withTimeout(docRef.set(payload, { merge: true }), WRITE_TIMEOUT_MS);
				}
			} catch (error) {
				console.warn('[NewsMonitorPauseState] Failed to persist resume state to Firestore:', error.message);
			}
			return result;
		})();
		return Object.assign(persistPromise, result);
	}

	return Object.assign(Promise.resolve(result), result);
}

function resetNewsMonitorPauseStateForTest() {
	pauseState = {
		paused: false,
		pausedAt: null,
		reason: null,
	};
	lastFetchedAt = 0;
	inFlightSync = null;
	customFirestore = null;
}

function setFirestoreForTest(db) {
	customFirestore = db;
}

async function postPauseNewsMonitor(req, res) {
	const reason = req.body && typeof req.body === 'object' && typeof req.body.reason === 'string'
		? req.body.reason
		: undefined;

	const state = await pauseNewsMonitor({ reason });

	return res.status(200).json({
		message: 'News monitor analysis paused',
		paused: state.paused,
		pausedAt: state.pausedAt,
		reason: state.reason,
	});
}

async function postResumeNewsMonitor(req, res) {
	const result = await resumeNewsMonitor();

	return res.status(200).json({
		message: 'News monitor analysis resumed',
		paused: result.paused,
		resumedAt: result.resumedAt,
		wasPaused: result.wasPaused,
		previouslyPausedAt: result.previouslyPausedAt,
	});
}

async function getNewsMonitorStatus(req, res) {
	await syncNewsMonitorPauseState();
	const state = getNewsMonitorPauseState();

	return res.status(200).json(state);
}

module.exports = {
	isNewsMonitorPaused,
	getNewsMonitorPauseState,
	pauseNewsMonitor,
	resumeNewsMonitor,
	resetNewsMonitorPauseStateForTest,
	setFirestoreForTest,
	syncNewsMonitorPauseState,
	postPauseNewsMonitor,
	postResumeNewsMonitor,
	getNewsMonitorStatus,
};
