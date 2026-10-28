const crypto = require('node:crypto');

const COLLECTION = 'promptDriftEvents';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * DAY_MS;
const MAX_RECENT_EVENTS = 500;
const REFRESH_INTERVAL_MS = 30 * 1000;

function getDefaultFirestore() {
	const admin = require('firebase-admin');
	const { initializeFirebaseAdminApp } = require('../storage/firebaseAdminCredentials');
	if (!initializeFirebaseAdminApp({ admin }).ok) return null;
	return admin.firestore();
}

async function withinTimeout(operation, timeoutMs) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
	});
	try {
		return await Promise.race([operation, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

class PromptDriftService {
	constructor({ getFirestore = getDefaultFirestore, now = () => new Date(), readTimeoutMs = 2000, writeTimeoutMs = 2000 } = {}) {
		this.getFirestore = getFirestore;
		this.now = now;
		this.readTimeoutMs = readTimeoutMs;
		this.writeTimeoutMs = writeTimeoutMs;
		this.events = new Map();
		this.lastRefreshAttemptMs = 0;
		this.durableReadReady = false;
	}

	async record(promptName, version) {
		try {
			const firestore = this.getFirestore();
			if (!firestore) return false;
			const detectedAt = this.now();
			const id = crypto.createHash('sha256').update(JSON.stringify([promptName, version ?? null])).digest('hex');
			const event = {
				promptName,
				version: version ?? null,
				detectedAt: detectedAt.toISOString(),
				expiresAt: new Date(detectedAt.getTime() + RETENTION_MS),
			};
			try {
				await withinTimeout(firestore.collection(COLLECTION).doc(id).create(event), this.writeTimeoutMs);
				this.events.set(id, event);
				return true;
			} catch (error) {
				if (error.code === 6 || error.code === 'already-exists') return true;
				throw error;
			}
		} catch (error) {
			console.warn('[PromptDriftService] Durable drift write unavailable:', error.code || 'unknown');
			return false;
		}
	}

	async refresh() {
		try {
			const nowMs = this.now().getTime();
			if (nowMs - this.lastRefreshAttemptMs < REFRESH_INTERVAL_MS) return this.durableReadReady;
			this.lastRefreshAttemptMs = nowMs;
			const firestore = this.getFirestore();
			if (!firestore) {
				this.durableReadReady = false;
				return false;
			}
			const since = new Date(nowMs - DAY_MS).toISOString();
			const read = firestore.collection(COLLECTION)
				.where('detectedAt', '>=', since)
				.orderBy('detectedAt', 'desc')
				.limit(MAX_RECENT_EVENTS)
				.get();
			const snapshot = await withinTimeout(read, this.readTimeoutMs);
			this.events = new Map(snapshot.docs.map(doc => {
				const event = doc.data();
				return [`${event.promptName}:${event.version ?? 'unknown'}`, event];
			}));
			this.durableReadReady = snapshot.docs.length < MAX_RECENT_EVENTS;
			return true;
		} catch (error) {
			this.durableReadReady = false;
			console.warn('[PromptDriftService] Durable drift read unavailable:', error.code || 'unknown');
			return false;
		}
	}

	getStatus() {
		const since = this.now().getTime() - DAY_MS;
		const recent = [...this.events.values()]
			.filter(event => Date.parse(event.detectedAt) >= since)
			.sort((left, right) => right.detectedAt.localeCompare(left.detectedAt));
		return {
			durableReadReady: this.durableReadReady,
			driftCount24h: recent.length,
			lastDriftDetectedAt: recent[0]?.detectedAt ?? null,
			lastDriftPromptName: recent[0]?.promptName ?? null,
		};
	}
}

const promptDriftService = new PromptDriftService();
module.exports = { PromptDriftService, promptDriftService };
