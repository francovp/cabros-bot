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
				this.finish({ key, entry }, false);
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
					return delivered ? { originalRequestId: entry.requestId } : null;
				} finally {
					signal?.removeEventListener('abort', onAbort);
				}
			}
			this.entries.delete(key);
			this.entries.set(key, entry);
			return { originalRequestId: entry.requestId };
		}
		while (this.entries.size >= this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			this.finish({ key: oldest, entry: this.entries.get(oldest) }, false);
		}
		const entry = { requestId, pending: true, expiresAt: Date.now() + windowMs };
		entry.done = new Promise(resolve => { entry.resolve = resolve; });
		const token = { key, entry };
		entry.timer = setTimeout(() => this.finish(token, false), this.pendingMs);
		entry.timer.unref?.();
		this.entries.set(key, entry);
		return token;
	}

	finish(token, delivered) {
		if (!token?.entry || this.entries.get(token.key) !== token.entry) return;
		const entry = token.entry;
		clearTimeout(entry.timer);
		entry.pending = false;
		if (!delivered) this.entries.delete(token.key);
		entry.resolve(delivered);
	}

	reset() {
		for (const [key, entry] of this.entries) this.finish({ key, entry }, false);
	}
}

module.exports = { AlertCoalescer, fingerprint, alertCoalescer: new AlertCoalescer() };
