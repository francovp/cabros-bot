const alertStorageService = require('../storage/AlertStorageService');

const MAX_SYMBOLS = 50;
const SYMBOL_PATTERN = /^(?:[A-Z0-9_]+:)?[A-Z0-9._-]{1,30}$/;

function normalizeSymbol(value) {
	const symbol = typeof value === 'string' ? value.trim().toUpperCase() : '';
	if (!SYMBOL_PATTERN.test(symbol)) {
		throw new TypeError('Invalid watchlist symbol');
	}
	return symbol;
}

function normalizeAlertReference(value) {
	const reference = typeof value === 'string' ? value.trim().toUpperCase() : '';
	const slashPair = /^(?:[A-Z0-9_]+:)?[A-Z0-9][A-Z0-9._-]+\/[A-Z0-9][A-Z0-9._-]+$/;
	return normalizeSymbol(slashPair.test(reference) ? reference.replace('/', '') : reference);
}

function normalizeChatId(value) {
	const chatId = String(value ?? '').trim();
	if (!/^-?\d{1,20}$/.test(chatId)) {
		throw new TypeError('Invalid Telegram chat ID');
	}
	return chatId;
}

function matchesEntries(symbols, symbol) {
	if (!symbol || symbols.length === 0) return true;
	return symbols.some((entry) => entry === symbol ||
		(!entry.includes(':') && entry === symbol.split(':').at(-1)) ||
		(!symbol.includes(':') && entry.split(':').at(-1) === symbol));
}

function withTimeout(promise, timeoutMs, label) {
	let timer;
	return Promise.race([promise, new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
		timer.unref?.();
	})]).finally(() => clearTimeout(timer));
}

class WatchlistService {
	constructor({ firestoreEnabled = () => process.env.ENABLE_FIRESTORE_WATCHLIST === 'true',
		getFirestore = () => alertStorageService.getFirestore(), readTimeoutMs = 250, writeTimeoutMs = 1000 } = {}) {
		this.firestoreEnabled = firestoreEnabled;
		this.getFirestore = getFirestore;
		this.readTimeoutMs = readTimeoutMs;
		this.writeTimeoutMs = writeTimeoutMs;
		this.lists = new Map();
		this.dirty = new Set();
		this.dirtyOps = new Map();
		this.pending = new Map();
		this.remotePending = new Map();
		this.recovery = new Map();
		this.nextRecoveryAt = new Map();
		this.readFailures = 0;
		this.writeFailures = 0;
	}

	isEnabled() {
		return typeof this.firestoreEnabled === 'function' ? this.firestoreEnabled() : this.firestoreEnabled;
	}

	_getDoc(chatId) {
		if (!this.isEnabled()) return null;
		const firestore = this.getFirestore();
		return firestore?.collection('watchlists').doc(chatId) || null;
	}

	async _read(chatId) {
		let doc;
		try {
			if (this.dirty.has(chatId)) {
				this._scheduleRecovery(chatId);
				return { symbols: this.lists.get(chatId) || [], failed: true };
			}
			doc = this._getDoc(chatId);
			if (!doc) return { symbols: this.lists.get(chatId) || [], failed: this.isEnabled() };
			const snapshot = await withTimeout(doc.get(), this.readTimeoutMs, 'Watchlist read');
			const symbols = snapshot.exists && Array.isArray(snapshot.data()?.symbols)
				? snapshot.data().symbols.filter((value) => typeof value === 'string' && SYMBOL_PATTERN.test(value))
				: [];
			this.lists.set(chatId, symbols);
			return { symbols, failed: false };
		} catch (error) {
			this.readFailures += 1;
			console.warn('[WatchlistService] Firestore read failed:', error.message);
			return { symbols: this.lists.get(chatId) || [], failed: true };
		}
	}

	_setLocal(chatId, symbols) {
		if (symbols.length === 0) this.lists.delete(chatId);
		else this.lists.set(chatId, symbols);
	}

	_scheduleRecovery(chatId, force = false) {
		if (!this.dirty.has(chatId) || this.remotePending.has(chatId) || this.recovery.has(chatId)) return;
		if (!force && Date.now() < (this.nextRecoveryAt.get(chatId) || 0)) return;
		this.nextRecoveryAt.set(chatId, Date.now() + 5000);
		const work = this._mutate(chatId, (current) => current, false);
		this.recovery.set(chatId, work);
		work.then(() => this.recovery.delete(chatId), () => this.recovery.delete(chatId));
	}

	async _mutate(chatId, transform, recordDirty = true) {
		const prior = this.pending.get(chatId) || Promise.resolve();
		const work = prior.catch(() => {}).then(async () => {
			let symbols;
			let persisted = false;
			let firestore;
			let doc;
			try {
				firestore = this.isEnabled() ? this.getFirestore() : null;
				doc = firestore?.collection('watchlists').doc(chatId);
				if (this.remotePending.has(chatId)) {
					symbols = transform(this.lists.get(chatId) || []);
				} else if (doc && typeof firestore.runTransaction === 'function') {
					const pendingOps = this.dirtyOps.get(chatId) || [];
					let timedOut = false;
					const remoteWork = firestore.runTransaction(async (transaction) => {
						const snapshot = await transaction.get(doc);
						const current = snapshot.exists && Array.isArray(snapshot.data()?.symbols) ? snapshot.data().symbols : [];
						// Queued outage additions may exceed the limit until a later removal or clear is applied.
						symbols = transform(pendingOps.reduce((list, operation) => operation(list, false), current), false);
						if (symbols.length > MAX_SYMBOLS) throw new RangeError(`Watchlist cannot exceed ${MAX_SYMBOLS} symbols`);
						if (symbols.length === 0) transaction.delete(doc);
						else transaction.set(doc, { symbols, updatedAt: new Date().toISOString() });
					});
					this.remotePending.set(chatId, remoteWork);
					const clearPending = () => {
						if (this.remotePending.get(chatId) === remoteWork) {
							this.remotePending.delete(chatId);
							if (timedOut) setImmediate(() => this._scheduleRecovery(chatId, true));
						}
					};
					remoteWork.then(clearPending, clearPending);
					try {
						await withTimeout(remoteWork, this.writeTimeoutMs, 'Watchlist write');
					} catch (error) {
						if (error.message === 'Watchlist write timeout') timedOut = true;
						throw error;
					}
					persisted = true;
				} else {
					symbols = transform((await this._read(chatId)).symbols);
					if (doc) {
						if (symbols.length === 0) await withTimeout(doc.delete(), this.writeTimeoutMs, 'Watchlist write');
						else await withTimeout(doc.set({ symbols, updatedAt: new Date().toISOString() }), this.writeTimeoutMs, 'Watchlist write');
						persisted = true;
					}
				}
			} catch (error) {
				if (error instanceof RangeError) throw error;
				this.writeFailures += 1;
				console.warn('[WatchlistService] Firestore write failed; using memory:', error.message);
				if (!symbols) symbols = transform(this.lists.get(chatId) || []);
			}
			this._setLocal(chatId, symbols);
			if (persisted) {
				this.dirty.delete(chatId);
				this.dirtyOps.delete(chatId);
			} else if (this.isEnabled()) {
				this.dirty.add(chatId);
				if (recordDirty) this.dirtyOps.set(chatId, [...(this.dirtyOps.get(chatId) || []), transform]);
			}
			return symbols.slice();
		});
		this.pending.set(chatId, work);
		try { return await work; } finally {
			if (this.pending.get(chatId) === work) this.pending.delete(chatId);
		}
	}

	async add(chatIdValue, values) {
		const chatId = normalizeChatId(chatIdValue);
		const additions = values.map(normalizeSymbol);
		return this._mutate(chatId, (current, enforceLimit = true) => {
			const symbols = [...new Set([...current, ...additions])];
			if (enforceLimit && symbols.length > MAX_SYMBOLS) throw new RangeError(`Watchlist cannot exceed ${MAX_SYMBOLS} symbols`);
			return symbols;
		});
	}

	async remove(chatIdValue, values) {
		const chatId = normalizeChatId(chatIdValue);
		const removals = new Set(values.map(normalizeSymbol));
		return this._mutate(chatId, (current) => current.filter((value) => !removals.has(value)));
	}

	async get(chatIdValue) {
		return (await this._read(normalizeChatId(chatIdValue))).symbols.slice();
	}

	async clear(chatIdValue) {
		return this._mutate(normalizeChatId(chatIdValue), () => []);
	}

	async matches(chatIdValue, value) {
		return this.matchesAny(chatIdValue, [value]);
	}

	async matchesAny(chatIdValue, values) {
		if (!Array.isArray(values) || values.length === 0) return true;
		try {
			const references = values.map(normalizeAlertReference);
			const { symbols, failed } = await this._read(normalizeChatId(chatIdValue));
			if (failed || symbols.length === 0) return true;
			return references.some((reference) => matchesEntries(symbols, reference));
		} catch {
			return true;
		}
	}

	getStatus() {
		return { enabled: true, mode: this.isEnabled() ? 'firestore' : 'memory',
			readFailures: this.readFailures, writeFailures: this.writeFailures };
	}
}

const watchlistService = new WatchlistService();

module.exports = { WatchlistService, watchlistService, normalizeSymbol, matchesEntries };
