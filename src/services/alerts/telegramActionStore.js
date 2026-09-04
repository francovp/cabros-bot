'use strict';

/**
 * TelegramActionStore — bounded in-memory registry that maps compact short IDs
 * to stored alert metadata, so inline keyboard buttons can pass 64-byte
 * callback_data payloads that resolve back to the full Firestore alertId.
 *
 * The store is fail-open: any read/write error must never block alert delivery
 * or block the bot action handler. The store is process-local; in a multi-
 * replica deployment the same shortId will not resolve across instances, and
 * the action handler treats unknown shortIds as a no-op acknowledgement.
 *
 * Constraints:
 *   - Each entry keeps an absolute `expiresAt` (Date) for bounded retention.
 *   - LRU eviction caps the maximum live entries; overflow evicts the
 *     least-recently-touched entry before insertion.
 *   - Short IDs are derived deterministically from the alertId via SHA-256 +
 *     8-character Crockford-style base32 (no I/L/O/U to keep callback_data
 *     free of ambiguous characters when copy-pasted by operators).
 */

const crypto = require('crypto');

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h, matches alert retention upper bound
const SHORT_ID_LENGTH = 8;
const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes, length) {
	let bits = 0n;
	let value = 0n;
	let output = '';
	for (let i = 0; i < bytes.length && output.length < length; i += 1) {
		value = (value << 8n) | BigInt(bytes[i]);
		bits += 8n;
		while (bits >= 5n && output.length < length) {
			bits -= 5n;
			const index = Number((value >> bits) & 0x1Fn);
			output += CROCKFORD_BASE32[index];
			value &= (1n << bits) - 1n;
		}
	}
	return output;
}

function shortIdFor(alertId) {
	if (typeof alertId !== 'string' || !alertId.trim()) {
		throw new TypeError('alertId must be a non-empty string');
	}
	const hash = crypto.createHash('sha256').update(alertId).digest();
	return encodeBase32(hash, SHORT_ID_LENGTH);
}

function createTelegramActionStore(options = {}) {
	const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
		? options.maxEntries
		: DEFAULT_MAX_ENTRIES;
	const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
		? options.ttlMs
		: DEFAULT_TTL_MS;
	const now = options.now || (() => Date.now());

	const entries = new Map();

	function evictExpired(currentTime) {
		for (const [key, entry] of entries) {
			if (entry.expiresAt <= currentTime) {
				entries.delete(key);
			}
		}
	}

	function touch(key, entry, currentTime) {
		entries.delete(key);
		entry.lastTouchedAt = currentTime;
		entries.set(key, entry);
	}

	function register(alertId, metadata = {}) {
		if (typeof alertId !== 'string' || !alertId.trim()) {
			return null;
		}
		const currentTime = now();
		evictExpired(currentTime);
		const key = shortIdFor(alertId);
		if (entries.has(key)) {
			const existing = entries.get(key);
			touch(key, existing, currentTime);
			return key;
		}
		if (entries.size >= maxEntries) {
			// Evict least-recently-touched (Map iteration order is insertion
			// order; we keep entries that were re-touched at the tail, so
			// the head is the oldest by construction).
			const oldestKey = entries.keys().next().value;
			if (oldestKey !== undefined) {
				entries.delete(oldestKey);
			}
		}
		const entry = {
			alertId,
			shortId: key,
			chatId: metadata.chatId,
			threadId: metadata.threadId,
			messageIds: Array.isArray(metadata.messageIds) ? metadata.messageIds.slice() : [],
			createdAt: currentTime,
			expiresAt: currentTime + ttlMs,
			lastTouchedAt: currentTime,
		};
		entries.set(key, entry);
		return key;
	}

	function lookup(shortId) {
		if (typeof shortId !== 'string' || !shortId) {
			return null;
		}
		const entry = entries.get(shortId);
		if (!entry) {
			return null;
		}
		const currentTime = now();
		if (entry.expiresAt <= currentTime) {
			entries.delete(shortId);
			return null;
		}
		touch(shortId, entry, currentTime);
		return {
			alertId: entry.alertId,
			shortId: entry.shortId,
			chatId: entry.chatId,
			threadId: entry.threadId,
			messageIds: entry.messageIds.slice(),
			createdAt: entry.createdAt,
			expiresAt: entry.expiresAt,
		};
	}

	function clear() {
		entries.clear();
	}

	function size() {
		return entries.size;
	}

	function snapshot() {
		return Array.from(entries.values()).map((entry) => ({
			alertId: entry.alertId,
			shortId: entry.shortId,
			chatId: entry.chatId,
			threadId: entry.threadId,
			messageIds: entry.messageIds.slice(),
			createdAt: entry.createdAt,
			expiresAt: entry.expiresAt,
		}));
	}

	return {
		register,
		lookup,
		clear,
		size,
		snapshot,
		shortIdFor,
		_maxEntries: maxEntries,
		_ttlMs: ttlMs,
	};
}

const defaultStore = createTelegramActionStore();

module.exports = {
	createTelegramActionStore,
	defaultStore,
	shortIdFor,
	CROCKFORD_BASE32,
	SHORT_ID_LENGTH,
	DEFAULT_MAX_ENTRIES,
	DEFAULT_TTL_MS,
};
