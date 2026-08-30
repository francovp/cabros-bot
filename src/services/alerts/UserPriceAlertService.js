'use strict';

const crypto = require('crypto');
const admin = require('firebase-admin');
const alertStorageService = require('../storage/AlertStorageService');
const { isFirestoreConfigured } = require('../storage/firestoreConfig');
const sentryService = require('../monitoring/SentryService');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

function getFetchPriceModule() {
	return require('../../controllers/commands/handlers/core/fetchPriceCryptoSymbol');
}

const COLLECTION_NAME = 'userPriceAlerts';
const DEFAULT_EVALUATION_INTERVAL_MS = 60000;
const MIN_EVALUATION_INTERVAL_MS = 1000;
const MAX_EVALUATION_INTERVAL_MS = 3600000;

const DEFAULT_BATCH_LIMIT = 50;
const MIN_BATCH_LIMIT = 1;
const MAX_BATCH_LIMIT = 500;

const DEFAULT_MAX_PER_CHAT = 20;
const MIN_MAX_PER_CHAT = 1;
const MAX_MAX_PER_CHAT = 100;

const DEFAULT_EXPIRY_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

class UserPriceAlertError extends Error {
	constructor(message, code = 'INVALID_USER_PRICE_ALERT') {
		super(message);
		this.name = 'UserPriceAlertError';
		this.code = code;
		this.isUserFriendly = true;
	}
}

function stripUndefinedFieldsDeep(value) {
	if (value === null || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value
			.map((item) => stripUndefinedFieldsDeep(item))
			.filter((item) => item !== undefined);
	}
	const result = {};
	for (const [key, val] of Object.entries(value)) {
		if (val !== undefined) {
			result[key] = stripUndefinedFieldsDeep(val);
		}
	}
	return result;
}

function parseEnvInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
	if (value === undefined || value === null || value === '') {
		return fallback;
	}
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
		return fallback;
	}
	return Math.max(min, Math.min(parsed, max));
}

function normalizeOperator(op) {
	if (!op || typeof op !== 'string') return null;
	const trimmed = op.trim().toLowerCase();
	if (trimmed === '<' || trimmed === '<=' || trimmed === '>' || trimmed === '>=') {
		return trimmed;
	}
	if (trimmed === 'menor' || trimmed === 'debajo' || trimmed === 'lower' || trimmed === 'below') {
		return '<';
	}
	if (trimmed === 'mayor' || trimmed === 'encima' || trimmed === 'higher' || trimmed === 'above') {
		return '>';
	}
	return null;
}

function parsePriceNumber(rawPrice) {
	if (!rawPrice || typeof rawPrice !== 'string') {
		if (typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0) {
			return rawPrice;
		}
		return null;
	}
	let cleaned = rawPrice.trim();
	// Handle European number formats: 1.234,56 -> 1234.56
	if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(cleaned)) {
		cleaned = cleaned.replace(/\./g, '').replace(',', '.');
	} else {
		// Handle standard comma separators: 1,234.56 -> 1234.56
		cleaned = cleaned.replace(/,/g, '');
	}

	const parsed = Number(cleaned);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return null;
	}
	return parsed;
}

function parseUserPriceAlertInput(tokens, options = {}) {
	if (!Array.isArray(tokens) || tokens.length === 0) {
		return { valid: false, error: 'missing_args' };
	}

	const filteredTokens = tokens.map((t) => String(t).trim()).filter(Boolean);
	if (filteredTokens.length === 0) {
		return { valid: false, error: 'missing_args' };
	}

	const rawSymbol = filteredTokens[0];
	const rest = filteredTokens.slice(1);

	if (rest.length === 0) {
		return { valid: false, error: 'missing_price_or_condition' };
	}

	let operator = null;
	let targetPrice = null;

	if (rest.length === 1) {
		const token = rest[0];
		// Case: "<60000", ">=3500", etc.
		const opMatch = token.match(/^([<>]=?)(.+)$/);
		if (opMatch) {
			operator = normalizeOperator(opMatch[1]);
			targetPrice = parsePriceNumber(opMatch[2]);
		} else {
			// Case: "60000" without explicit operator
			targetPrice = parsePriceNumber(token);
			if (targetPrice !== null && options && typeof options.currentPrice === 'number') {
				operator = targetPrice < options.currentPrice ? '<' : '>';
			}
		}
	} else if (rest.length >= 2) {
		const firstOp = normalizeOperator(rest[0]);
		if (firstOp) {
			operator = firstOp;
			targetPrice = parsePriceNumber(rest[1]);
		} else {
			// Check if second token is an operator and third is price, or vice-versa
			const secondOp = normalizeOperator(rest[1]);
			if (secondOp && rest.length >= 3) {
				operator = secondOp;
				targetPrice = parsePriceNumber(rest[2]);
			}
		}
	}

	if (!operator || targetPrice === null) {
		return {
			valid: false,
			rawSymbol,
			error: 'invalid_price_or_operator',
		};
	}

	return {
		valid: true,
		rawSymbol,
		operator,
		targetPrice,
	};
}

function escapeMarkdownV2(text) {
	return String(text || '').replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

class UserPriceAlertService {
	constructor(options = {}) {
		this.botGetter = options.botGetter || null;
		this.running = false;
		this.timer = null;
		this.activeSweepPromise = null;
		this.shutdownRequested = false;

		// In-memory fallback
		this._memoryAlerts = new Map();

		// Metrics
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunTriggeredCount = 0;
		this.lastRunErrorCount = 0;
	}

	_resetForTesting() {
		this._memoryAlerts.clear();
		this.lastRunAt = null;
		this.lastRunDurationMs = null;
		this.lastRunScannedCount = 0;
		this.lastRunTriggeredCount = 0;
		this.lastRunErrorCount = 0;
	}

	setBotGetter(getter) {
		this.botGetter = getter;
	}

	isEnabled() {
		const runtimeConfig = getRuntimeConfig();
		if (runtimeConfig.ENABLE_USER_PRICE_ALERTS !== undefined) {
			return Boolean(runtimeConfig.ENABLE_USER_PRICE_ALERTS);
		}
		return process.env.ENABLE_USER_PRICE_ALERTS === 'true';
	}

	getWorkerRole() {
		const rawRole = (process.env.USER_PRICE_ALERT_WORKER_ROLE || 'web').toLowerCase().trim();
		if (rawRole === 'worker' || rawRole === 'disabled') {
			return rawRole;
		}
		return 'web';
	}

	getIntervalMs() {
		const runtimeConfig = getRuntimeConfig();
		const raw = runtimeConfig.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS !== undefined
			? runtimeConfig.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS
			: process.env.USER_PRICE_ALERT_EVALUATION_INTERVAL_MS;
		return parseEnvInt(raw, DEFAULT_EVALUATION_INTERVAL_MS, MIN_EVALUATION_INTERVAL_MS, MAX_EVALUATION_INTERVAL_MS);
	}

	getBatchLimit() {
		const runtimeConfig = getRuntimeConfig();
		const raw = runtimeConfig.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT !== undefined
			? runtimeConfig.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT
			: process.env.USER_PRICE_ALERT_EVALUATION_BATCH_LIMIT;
		return parseEnvInt(raw, DEFAULT_BATCH_LIMIT, MIN_BATCH_LIMIT, MAX_BATCH_LIMIT);
	}

	getMaxPerChat() {
		const runtimeConfig = getRuntimeConfig();
		const raw = runtimeConfig.USER_PRICE_ALERT_MAX_PER_CHAT !== undefined
			? runtimeConfig.USER_PRICE_ALERT_MAX_PER_CHAT
			: process.env.USER_PRICE_ALERT_MAX_PER_CHAT;
		return parseEnvInt(raw, DEFAULT_MAX_PER_CHAT, MIN_MAX_PER_CHAT, MAX_MAX_PER_CHAT);
	}

	getStatus() {
		const enabled = this.isEnabled();
		const role = this.getWorkerRole();
		const ready = enabled && role !== 'disabled';

		return {
			enabled,
			configured: true,
			ready,
			status: !enabled ? 'disabled' : (role === 'disabled' ? 'disabled' : 'ready'),
			role,
			running: this.running,
			intervalMs: this.getIntervalMs(),
			batchLimit: this.getBatchLimit(),
			maxPerChat: this.getMaxPerChat(),
			lastRunAt: this.lastRunAt ? this.lastRunAt.toISOString() : null,
			lastRunDurationMs: this.lastRunDurationMs,
			lastRunScannedCount: this.lastRunScannedCount,
			lastRunTriggeredCount: this.lastRunTriggeredCount,
			lastRunErrorCount: this.lastRunErrorCount,
		};
	}

	async createAlert(params) {
		const {
			chatId,
			telegramThreadId,
			symbol,
			rawSymbol,
			exchange,
			assetClass = 'crypto',
			operator,
			targetPrice,
			initialPrice,
			userId,
		} = params;

		if (!chatId) {
			throw new UserPriceAlertError('chatId es requerido para crear una alerta.');
		}
		if (!symbol) {
			throw new UserPriceAlertError('Símbolo es requerido.');
		}
		const normalizedOp = normalizeOperator(operator);
		if (!normalizedOp) {
			throw new UserPriceAlertError(`Operador no válido: "${operator}". Usa <, <=, >, o >=.`);
		}
		const priceNum = parsePriceNumber(targetPrice);
		if (priceNum === null) {
			throw new UserPriceAlertError(`Precio objetivo no válido: "${targetPrice}".`);
		}

		const maxPerChat = this.getMaxPerChat();
		const currentAlerts = await this.listAlerts({ chatId: String(chatId), status: 'armed' });
		if (currentAlerts.length >= maxPerChat) {
			throw new UserPriceAlertError(
				`Límite de alertas activas alcanzado (máximo ${maxPerChat}). Cancela alguna alerta existente con /alerta cancel <id>.`,
			);
		}

		const alertId = `alert_${crypto.randomUUID().slice(0, 8)}`;
		const now = new Date();
		const expiresAtDate = new Date(now.getTime() + DEFAULT_EXPIRY_DAYS * DAY_MS);

		const alertData = {
			id: alertId,
			chatId: String(chatId),
			telegramThreadId: telegramThreadId !== undefined && telegramThreadId !== null ? Number(telegramThreadId) : undefined,
			symbol: symbol.toUpperCase(),
			rawSymbol: rawSymbol ? rawSymbol.toUpperCase() : symbol.toUpperCase(),
			exchange: exchange || undefined,
			assetClass,
			operator: normalizedOp,
			targetPrice: priceNum,
			initialPrice: initialPrice !== undefined && initialPrice !== null ? Number(initialPrice) : undefined,
			userId: userId ? String(userId) : undefined,
			status: 'armed',
			createdAt: now.toISOString(),
			expiresAt: expiresAtDate.toISOString(),
		};

		const cleanedData = stripUndefinedFieldsDeep(alertData);
		this._memoryAlerts.set(alertId, cleanedData);

		const firestore = alertStorageService.getFirestore();
		if (firestore) {
			try {
				const docRef = firestore.collection(COLLECTION_NAME).doc(alertId);
				const docPayload = {
					...cleanedData,
					createdAt: admin.firestore.FieldValue.serverTimestamp(),
					expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
				};
				await docRef.set(stripUndefinedFieldsDeep(docPayload));
			} catch (err) {
				console.warn('[UserPriceAlertService] Firestore write failed, saving to memory fallback:', err.message);
			}
		}

		return cleanedData;
	}

	async listAlerts({ chatId, status = 'armed', limit = 50 } = {}) {
		const firestore = alertStorageService.getFirestore();
		if (firestore) {
			try {
				let query = firestore.collection(COLLECTION_NAME);
				if (chatId) {
					query = query.where('chatId', '==', String(chatId));
				}
				if (status) {
					query = query.where('status', '==', status);
				}
				query = query.limit(limit);
				const snapshot = await query.get();
				const docs = [];
				const docsList = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : (snapshot && typeof snapshot.forEach === 'function' ? snapshot : []);
				(docsList.forEach ? docsList : (snapshot && snapshot.docs) || []).forEach((doc) => {
					const data = doc.data() || {};
					docs.push({
						...data,
						id: doc.id,
						createdAt: data.createdAt && typeof data.createdAt.toDate === 'function'
							? data.createdAt.toDate().toISOString()
							: (data.createdAt || new Date().toISOString()),
						expiresAt: data.expiresAt && typeof data.expiresAt.toDate === 'function'
							? data.expiresAt.toDate().toISOString()
							: (data.expiresAt || null),
					});
				});
				return docs;
			} catch (err) {
				console.warn('[UserPriceAlertService] Firestore query failed, falling back to memory:', err.message);
			}
		}

		// Fallback memory query
		const results = [];
		for (const alert of this._memoryAlerts.values()) {
			if (chatId && alert.chatId !== String(chatId)) continue;
			if (status && alert.status !== status) continue;
			results.push(alert);
			if (results.length >= limit) break;
		}
		return results;
	}

	async getAlert(alertId) {
		if (!alertId) return null;
		const firestore = alertStorageService.getFirestore();
		if (firestore) {
			try {
				const doc = await firestore.collection(COLLECTION_NAME).doc(alertId).get();
				if (doc.exists) {
					const data = doc.data() || {};
					return {
						...data,
						id: doc.id,
					};
				}
			} catch (err) {
				console.warn('[UserPriceAlertService] Firestore get failed:', err.message);
			}
		}
		return this._memoryAlerts.get(alertId) || null;
	}

	async cancelAlert({ chatId, alertId }) {
		if (!chatId || !alertId) {
			throw new UserPriceAlertError('chatId y alertId son requeridos para cancelar una alerta.');
		}

		const alert = await this.getAlert(alertId);
		if (!alert || alert.chatId !== String(chatId) || alert.status !== 'armed') {
			throw new UserPriceAlertError(`No se encontró una alerta activa con ese ID: ${alertId}`);
		}

		const now = new Date();
		const updatedData = {
			...alert,
			status: 'cancelled',
			cancelledAt: now.toISOString(),
		};

		const firestore = alertStorageService.getFirestore();
		if (firestore) {
			try {
				await firestore.collection(COLLECTION_NAME).doc(alertId).update({
					status: 'cancelled',
					cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
				});
			} catch (err) {
				console.warn('[UserPriceAlertService] Firestore cancel update failed, updating memory:', err.message);
			}
		}

		this._memoryAlerts.set(alertId, updatedData);
		return updatedData;
	}

	async _fetchCurrentPrice(item) {
		const fetchPriceModule = getFetchPriceModule();
		const { symbol, exchange, assetClass } = item;
		if (assetClass === 'equity') {
			const quote = await fetchPriceModule.fetchEquityPrice(symbol, exchange);
			return { symbol: quote.symbol, price: quote.price, assetClass: 'equity' };
		}
		const quote = await fetchPriceModule.fetchCryptoPrice(symbol);
		return { symbol: quote.symbol, price: quote.price, assetClass: 'crypto' };
	}

	async evaluateAlerts(options = {}) {
		const startTime = Date.now();
		let scannedCount = 0;
		let triggeredCount = 0;
		let errorsCount = 0;

		const batchLimit = this.getBatchLimit();
		let armedAlerts = [];

		const firestore = alertStorageService.getFirestore();
		if (firestore) {
			try {
				const snapshot = await firestore
					.collection(COLLECTION_NAME)
					.where('status', '==', 'armed')
					.limit(batchLimit)
					.get();

				const docsList = snapshot && Array.isArray(snapshot.docs) ? snapshot.docs : (snapshot && typeof snapshot.forEach === 'function' ? snapshot : []);
				(docsList.forEach ? docsList : (snapshot && snapshot.docs) || []).forEach((doc) => {
					const data = doc.data() || {};
					armedAlerts.push({
						...data,
						id: doc.id,
						expiresAt: data.expiresAt && typeof data.expiresAt.toDate === 'function'
							? data.expiresAt.toDate()
							: (data.expiresAt ? new Date(data.expiresAt) : null),
					});
				});
			} catch (err) {
				console.warn('[UserPriceAlertService] Firestore sweep fetch failed, using memory:', err.message);
				armedAlerts = Array.from(this._memoryAlerts.values()).filter((a) => a.status === 'armed');
			}
		} else {
			armedAlerts = Array.from(this._memoryAlerts.values()).filter((a) => a.status === 'armed');
		}

		scannedCount = armedAlerts.length;
		const nowTime = Date.now();

		// Step 1: Check expiration
		const validAlerts = [];
		for (const alert of armedAlerts) {
			const expiryMillis = alert.expiresAt ? new Date(alert.expiresAt).getTime() : null;
			if (expiryMillis && expiryMillis <= nowTime) {
				alert.status = 'expired';
				if (firestore) {
					void firestore.collection(COLLECTION_NAME).doc(alert.id).update({
						status: 'expired',
					}).catch(() => {});
				}
				this._memoryAlerts.set(alert.id, { ...alert, status: 'expired' });
			} else {
				validAlerts.push(alert);
			}
		}

		// Step 2: Fetch prices for distinct symbols
		const symbolMap = new Map();
		for (const alert of validAlerts) {
			const key = `${alert.assetClass || 'crypto'}:${alert.symbol}:${alert.exchange || ''}`;
			if (!symbolMap.has(key)) {
				symbolMap.set(key, {
					symbol: alert.symbol,
					exchange: alert.exchange,
					assetClass: alert.assetClass || 'crypto',
				});
			}
		}

		const priceCache = new Map();
		await Promise.all(
			Array.from(symbolMap.entries()).map(async ([key, query]) => {
				try {
					const priceInfo = await this._fetchCurrentPrice(query);
					if (priceInfo && Number.isFinite(priceInfo.price)) {
						priceCache.set(key, priceInfo.price);
					}
				} catch (priceErr) {
					console.warn(`[UserPriceAlertService] Price lookup failed for ${query.symbol}:`, priceErr.message);
					errorsCount++;
				}
			}),
		);

		// Step 3: Evaluate conditions and trigger
		const bot = typeof this.botGetter === 'function' ? this.botGetter() : this.botGetter;

		for (const alert of validAlerts) {
			const key = `${alert.assetClass || 'crypto'}:${alert.symbol}:${alert.exchange || ''}`;
			const currentPrice = priceCache.get(key);
			if (currentPrice === undefined || !Number.isFinite(currentPrice)) {
				continue;
			}

			let triggered = false;
			const target = alert.targetPrice;
			if (alert.operator === '<' && currentPrice < target) triggered = true;
			else if (alert.operator === '<=' && currentPrice <= target) triggered = true;
			else if (alert.operator === '>' && currentPrice > target) triggered = true;
			else if (alert.operator === '>=' && currentPrice >= target) triggered = true;

			if (triggered) {
				triggeredCount++;
				const triggeredAtDate = new Date();
				const updated = {
					...alert,
					status: 'triggered',
					triggeredPrice: currentPrice,
					triggeredAt: triggeredAtDate.toISOString(),
				};

				if (firestore) {
					try {
						await firestore.collection(COLLECTION_NAME).doc(alert.id).update({
							status: 'triggered',
							triggeredPrice: currentPrice,
							triggeredAt: admin.firestore.FieldValue.serverTimestamp(),
						});
					} catch (updErr) {
						console.warn(`[UserPriceAlertService] Failed to update triggered alert ${alert.id}:`, updErr.message);
					}
				}
				this._memoryAlerts.set(alert.id, updated);

				// Deliver notification
				if (bot && bot.telegram) {
					const conditionText = `${alert.operator} ${target.toLocaleString('en-US')}`;
					const priceText = currentPrice.toLocaleString('en-US');
					const initialPriceText = alert.initialPrice !== undefined ? alert.initialPrice.toLocaleString('en-US') : null;

					const lines = [
						'🔔 *Alerta de Precio Activada*',
						'',
						`• Símbolo: \`${alert.symbol}\``,
						`• Condición: \`${conditionText}\``,
						`• Precio actual: *${escapeMarkdownV2(priceText)}*`,
					];
					if (initialPriceText) {
						lines.push(`• Precio inicial: ${escapeMarkdownV2(initialPriceText)}`);
					}
					lines.push(`• ID: \`${alert.id}\``);

					const messageText = lines.join('\n');
					const sendOptions = { parse_mode: 'MarkdownV2' };
					if (alert.telegramThreadId !== undefined && alert.telegramThreadId !== null) {
						sendOptions.message_thread_id = alert.telegramThreadId;
					}

					try {
						await bot.telegram.sendMessage(alert.chatId, messageText, sendOptions);
					} catch (sendErr) {
						console.error(`[UserPriceAlertService] Failed to deliver alert ${alert.id} to chat ${alert.chatId}:`, sendErr.message);
						sentryService.captureRuntimeError({
							channel: 'telegram',
							error: sendErr,
							extra: {
								service: 'UserPriceAlertService',
								alertId: alert.id,
								chatId: alert.chatId,
							},
						});
					}
				}
			}
		}

		const durationMs = Date.now() - startTime;
		this.lastRunAt = new Date();
		this.lastRunDurationMs = durationMs;
		this.lastRunScannedCount = scannedCount;
		this.lastRunTriggeredCount = triggeredCount;
		this.lastRunErrorCount = errorsCount;

		return {
			evaluatedCount: scannedCount,
			triggeredCount,
			errorsCount,
			durationMs,
		};
	}

	startWorker(options = {}) {
		if (!this.isEnabled() || this.getWorkerRole() === 'disabled') {
			return false;
		}
		if (this.running) {
			return true;
		}

		this.running = true;
		this.shutdownRequested = false;
		this._scheduleNextSweep(this.getIntervalMs());
		console.log('[UserPriceAlertService] Worker started');
		return true;
	}

	_scheduleNextSweep(delayMs) {
		if (!this.running || this.shutdownRequested) {
			return;
		}
		this.timer = setTimeout(async () => {
			if (!this.running || this.shutdownRequested) return;
			try {
				this.activeSweepPromise = this.evaluateAlerts();
				await this.activeSweepPromise;
			} catch (sweepErr) {
				console.error('[UserPriceAlertService] Sweep evaluation error:', sweepErr.message);
			} finally {
				this.activeSweepPromise = null;
				this._scheduleNextSweep(this.getIntervalMs());
			}
		}, delayMs);
		if (this.timer && typeof this.timer.unref === 'function') {
			this.timer.unref();
		}
	}

	async stopWorker(options = {}) {
		this.running = false;
		this.shutdownRequested = true;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (options.drain && this.activeSweepPromise) {
			try {
				await this.activeSweepPromise;
			} catch (_) {}
		}
	}
}

const userPriceAlertService = new UserPriceAlertService();

module.exports = {
	UserPriceAlertService,
	userPriceAlertService,
	UserPriceAlertError,
	parseUserPriceAlertInput,
	normalizeOperator,
	parsePriceNumber,
	stripUndefinedFieldsDeep,
};
