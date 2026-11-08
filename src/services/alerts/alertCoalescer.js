'use strict';

const crypto = require('crypto');

// Exact payload identity deliberately avoids collapsing distinct trade metadata.
function fingerprint(value) {
	const canonical = (item) => {
		if (Array.isArray(item)) return item.map(canonical);
		if (item && typeof item === 'object') {
			return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
		}
		return item;
	};
	return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

class AlertCoalescer {
	constructor({ maxEntries = 10000, pendingMs = 180000 } = {}) {
		this.entries = new Map();
		this.detached = new Set();
		this.maxEntries = maxEntries;
		this.pendingMs = pendingMs;
	}

	async acquire(key, requestId, windowMs, signal) {
		const arrivedAt = Date.now();
		for (;;) {
			if (signal?.aborted) return null;
			const entry = this.entries.get(key);
			if (!entry) break;
			if (entry.expiresAt <= arrivedAt) {
				this.entries.delete(key);
				if (entry.pending) this.detached.add(entry);
				continue;
			}
			if (entry.pending) {
				let onAbort;
				try {
					const delivered = await Promise.race([entry.done, new Promise(resolve => {
						onAbort = resolve;
						signal?.addEventListener('abort', onAbort, { once: true });
					})]);
					if (signal?.aborted) return null;
					if (delivered) return { originalRequestId: entry.requestId };
				} finally {
					signal?.removeEventListener('abort', onAbort);
				}
				continue;
			}
			this.entries.delete(key);
			this.entries.set(key, entry);
			return { originalRequestId: entry.requestId };
		}
		while (this.entries.size + this.detached.size >= this.maxEntries) {
			const oldDetached = this.detached.values().next().value;
			if (oldDetached) this.finish({ key: oldDetached.key, entry: oldDetached }, false);
			else {
				const oldest = this.entries.keys().next().value;
				const oldEntry = this.entries.get(oldest);
				if (oldEntry.pending) this.finish({ key: oldest, entry: oldEntry }, false);
				else this.entries.delete(oldest);
			}
		}
		const entry = { key, requestId, pending: true, expiresAt: Date.now() + windowMs };
		entry.done = new Promise(resolve => { entry.resolve = resolve; });
		const token = { key, entry };
		entry.timer = setTimeout(() => this.finish(token, false), this.pendingMs);
		entry.timer.unref?.();
		this.entries.set(key, entry);
		return token;
	}

	finish(token, delivered) {
		if (!token?.entry || !token.entry.pending) return;
		const entry = token.entry;
		clearTimeout(entry.timer);
		entry.pending = false;
		this.detached.delete(entry);
		if (!delivered && this.entries.get(token.key) === entry) this.entries.delete(token.key);
		entry.resolve(delivered);
	}

	reset() {
		for (const [key, entry] of this.entries) this.finish({ key, entry }, false);
		for (const entry of this.detached) this.finish({ key: entry.key, entry }, false);
		this.entries.clear();
	}
}

module.exports = { AlertCoalescer, fingerprint, alertCoalescer: new AlertCoalescer() };
