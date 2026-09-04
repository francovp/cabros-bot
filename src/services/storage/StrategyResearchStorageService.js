'use strict';

const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const { isFirestoreConfigured } = require('./firestoreConfig');

const COLLECTION_NAME = 'strategyResearch';
const DEFAULT_RETENTION_DAYS = 30;

function sanitizeFirestoreData(value) {
	if (value === undefined) {
		return undefined;
	}

	if (value === null || typeof value !== 'object') {
		return value;
	}

	if (value instanceof Date) {
		return value;
	}

	if (Array.isArray(value)) {
		return value.map((item) => (item === undefined ? null : sanitizeFirestoreData(item)));
	}

	const cleaned = {};
	for (const [key, val] of Object.entries(value)) {
		if (val !== undefined) {
			const sanitizedVal = sanitizeFirestoreData(val);
			if (sanitizedVal !== undefined) {
				cleaned[key] = sanitizedVal;
			}
		}
	}

	return cleaned;
}

class StrategyResearchStorageService {
	constructor(options = {}) {
		this.firestoreInstance = options.firestore || null;
		this.forcedEnabled = options.enabled !== undefined ? options.enabled : null;
		this.logger = options.logger || console;
	}

	isEnabled() {
		if (this.forcedEnabled !== null) {
			return Boolean(this.forcedEnabled);
		}
		try {
			return Boolean(getRuntimeConfig().ENABLE_STRATEGY_RESEARCH);
		} catch (error) {
			return process.env.ENABLE_STRATEGY_RESEARCH === 'true';
		}
	}

	getFirestore() {
		if (!this.isEnabled()) {
			return null;
		}

		if (this.firestoreInstance) {
			return this.firestoreInstance;
		}

		try {
			if (!admin.apps.length) {
				if (!isFirestoreConfigured()) {
					return null;
				}
				const appOptions = {};
				if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
					appOptions.credential = admin.credential.cert(
						JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
					);
				}
				if (process.env.FIREBASE_PROJECT_ID) {
					appOptions.projectId = process.env.FIREBASE_PROJECT_ID;
				}
				admin.initializeApp(appOptions);
			}

			this.firestoreInstance = admin.firestore();
			return this.firestoreInstance;
		} catch (error) {
			this.logger.warn('[StrategyResearchStorage] Failed to initialize Firestore:', error.message);
			return null;
		}
	}

	async saveResearchRun(data = {}) {
		if (!this.isEnabled()) {
			return { saved: false, reason: 'disabled' };
		}

		const db = this.getFirestore();
		if (!db) {
			return { saved: false, reason: 'firestore_unavailable' };
		}

		try {
			const id = data.id || uuidv4();
			const now = new Date();
			let retentionDays = DEFAULT_RETENTION_DAYS;

			try {
				const cfg = getRuntimeConfig();
				if (cfg.STRATEGY_RESEARCH_RETENTION_DAYS) {
					retentionDays = cfg.STRATEGY_RESEARCH_RETENTION_DAYS;
				}
			} catch (e) {
				if (process.env.STRATEGY_RESEARCH_RETENTION_DAYS) {
					const parsed = parseInt(process.env.STRATEGY_RESEARCH_RETENTION_DAYS, 10);
					if (Number.isFinite(parsed) && parsed > 0) {
						retentionDays = parsed;
					}
				}
			}

			const expiresAt = new Date(now.getTime() + retentionDays * 24 * 60 * 60 * 1000);

			const rawDoc = {
				id,
				tool: data.tool,
				symbol: data.symbol,
				exchange: data.exchange,
				strategy: data.strategy,
				interval: data.interval,
				period: data.period,
				params: data.params,
				result: data.result,
				cached: Boolean(data.cached),
				createdAt: now.toISOString(),
				expiresAt: expiresAt.toISOString(),
			};

			const cleanDoc = sanitizeFirestoreData(rawDoc);

			await db.collection(COLLECTION_NAME).doc(id).set(cleanDoc);

			return { saved: true, id };
		} catch (error) {
			this.logger.warn('[StrategyResearchStorage] Failed to save research run:', error.message);
			return { saved: false, error: error.message };
		}
	}
}

const strategyResearchStorageService = new StrategyResearchStorageService();

module.exports = {
	StrategyResearchStorageService,
	strategyResearchStorageService,
	sanitizeFirestoreData,
	COLLECTION_NAME,
};
