'use strict';

const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class StrategyResearchCache {
	constructor() {
		this.cache = new Map();
	}

	buildKey(toolName, params = {}) {
		const sortedEntries = Object.entries(params)
			.filter(([, v]) => v !== undefined && v !== null)
			.sort(([k1], [k2]) => k1.localeCompare(k2));

		const paramString = sortedEntries
			.map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
			.join('&');

		return `${toolName}:${paramString}`;
	}

	get(key) {
		if (!this.cache.has(key)) {
			return null;
		}

		const entry = this.cache.get(key);
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			return null;
		}

		return entry.data;
	}

	set(key, data, ttlMs = DEFAULT_CACHE_TTL_MS) {
		const expiresAt = Date.now() + ttlMs;
		this.cache.set(key, { data, expiresAt });
	}

	delete(key) {
		this.cache.delete(key);
	}

	clear() {
		this.cache.clear();
	}

	size() {
		const now = Date.now();
		let count = 0;
		for (const [key, entry] of this.cache.entries()) {
			if (now > entry.expiresAt) {
				this.cache.delete(key);
			} else {
				count += 1;
			}
		}
		return count;
	}
}

const strategyResearchCache = new StrategyResearchCache();

module.exports = {
	StrategyResearchCache,
	strategyResearchCache,
	DEFAULT_CACHE_TTL_MS,
};
