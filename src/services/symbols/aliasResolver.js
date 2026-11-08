'use strict';

/**
 * Symbol alias resolver.
 *
 * Resolves friendly ticker queries (e.g. "GOLD", "XAUUSD", "BTC", "ES") to
 * canonical `EXCHANGE:SYMBOL` identifiers accepted by TradingView MCP and the
 * existing webhook/expanded-analysis handlers. The static alias table lives in
 * `./aliases.json` so the map can be reviewed and extended without touching
 * code paths.
 *
 * Resolver contract:
 *   resolveSymbolQuery(query, options) → { matches: Array<Match>, normalizedQuery: string, totalEntries: number }
 *   listAliases()                       → Array<{ aliases, exchange, symbol, assetClass }>
 *
 * Match shape: { exchange, symbol, aliases, assetClass, matchType, score }
 *
 * The resolver is intentionally a pure synchronous lookup — no external
 * provider calls. The failure mode is bounded: unknown queries return
 * `{ matches: [] }`, never an exception. Callers must surface that empty
 * result as a structured `INVALID_REQUEST` (or Telegram hint) without
 * altering the existing behavior for un-mapped tickers.
 */

const path = require('path');
const fs = require('fs');

const ALIASES_FILE = path.join(__dirname, 'aliases.json');

let cachedEntries = null;
let cachedVersion = null;

function loadAliases() {
	if (cachedEntries && cachedVersion !== undefined) {
		return cachedEntries;
	}

	let raw;
	try {
		raw = fs.readFileSync(ALIASES_FILE, 'utf8');
	} catch (err) {
		// Fail-safe: never block callers. The resolver returns no matches when
		// the table cannot be read; controllers must surface that as
		// `INVALID_REQUEST` so the rest of the flow stays unchanged.
		console.warn('aliasResolver: failed to read aliases.json:', err.message);
		cachedEntries = [];
		cachedVersion = -1;
		return cachedEntries;
	}

	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		console.warn('aliasResolver: failed to parse aliases.json:', err.message);
		cachedEntries = [];
		cachedVersion = -1;
		return cachedEntries;
	}

	const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
	const normalized = [];
	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		if (!entry || typeof entry !== 'object') continue;
		const aliases = Array.isArray(entry.aliases) ? entry.aliases : [];
		const exchange = typeof entry.exchange === 'string' ? entry.exchange.trim() : '';
		const symbol = typeof entry.symbol === 'string' ? entry.symbol.trim() : '';
		if (!exchange || !symbol) continue;
		const assetClass = typeof entry.assetClass === 'string' ? entry.assetClass.trim() : null;
		const dedup = [];
		const seen = new Set();
		for (let j = 0; j < aliases.length; j += 1) {
			const a = aliases[j];
			if (typeof a !== 'string') continue;
			const trimmed = a.trim();
			if (!trimmed) continue;
			const key = trimmed.toUpperCase();
			if (seen.has(key)) continue;
			seen.add(key);
			dedup.push(trimmed);
		}
		if (dedup.length === 0) continue;
		normalized.push({
			aliases: dedup,
			exchange,
			symbol,
			assetClass: assetClass || null,
			// Deterministic ordering key — keeps `matches` stable for the
			// `defaultExchange` tie-breaker and snapshot tests.
			order: i,
		});
	}

	cachedEntries = normalized;
	cachedVersion = typeof parsed.version === 'number' ? parsed.version : 0;
	return cachedEntries;
}

function normalizeQuery(rawQuery) {
	if (typeof rawQuery !== 'string') {
		return '';
	}
	// Trim, uppercase, collapse whitespace and remove noise characters that
	// traders paste from chat UIs (`/`, `=`, leading `$`, surrounding parens).
	return rawQuery
		.trim()
		.replace(/[\s\(\)\$\=]+/g, '')
		.replace(/\//g, '')
		.toUpperCase();
}

function canonicalize(query) {
	// Internal canonical form used for matching. Returns the original token
	// plus any slash-stripped variant so "XAU/USD" and "XAUUSD" collapse to
	// the same bucket.
	if (!query) return '';
	return query;
}

/**
 * Resolve a free-form ticker query to canonical identifiers.
 *
 * @param {string} rawQuery - Free-form user input (e.g. "GOLD", "XAU/USD", "ES1!").
 * @param {object} [options]
 * @param {string} [options.defaultExchange] - Preferred exchange for the top match
 *   when more than one entry matches. When omitted, ordering is deterministic
 *   by alias-table index then by score.
 * @param {number} [options.maxResults=5] - Cap on matches length.
 * @returns {{ matches: Array<object>, normalizedQuery: string, totalEntries: number }}
 */
function resolveSymbolQuery(rawQuery, options = {}) {
	const entries = loadAliases();
	const normalizedQuery = normalizeQuery(rawQuery);
	const maxResults = Number.isFinite(options.maxResults) && options.maxResults > 0
		? Math.floor(options.maxResults)
		: 5;
	const defaultExchange = typeof options.defaultExchange === 'string' && options.defaultExchange.trim()
		? options.defaultExchange.trim().toUpperCase()
		: null;

	if (!normalizedQuery) {
		return { matches: [], normalizedQuery: '', totalEntries: entries.length };
	}

	const target = canonicalize(normalizedQuery);
	const results = [];

	for (let i = 0; i < entries.length; i += 1) {
		const entry = entries[i];
		let matchType = null;
		let score = 0;
		for (let j = 0; j < entry.aliases.length; j += 1) {
			const alias = entry.aliases[j];
			const aliasKey = normalizeQuery(alias);
			if (!aliasKey) continue;
			if (aliasKey === target) {
				matchType = 'exact';
				score = 100;
				break;
			}
			// Prefix / substring fallback so "GOL" hints at "GOLD" but never
			// misclassifies "BTC" → "ETH". Score is bounded so the
			// `defaultExchange` tie-breaker still wins.
			if (aliasKey.startsWith(target) && target.length >= 3) {
				if (score < 60) {
					matchType = 'prefix';
					score = 60;
				}
			} else if (target.startsWith(aliasKey) && aliasKey.length >= 3) {
				if (score < 40) {
					matchType = 'alias-prefix';
					score = 40;
				}
			}
		}

		if (!matchType) continue;

		results.push({
			exchange: entry.exchange,
			symbol: entry.symbol,
			aliases: entry.aliases.slice(),
			assetClass: entry.assetClass,
			matchType,
			score,
			order: entry.order,
		});
	}

	if (results.length > 0) {
		results.sort((a, b) => {
			if (defaultExchange) {
				const aDefault = a.exchange.toUpperCase() === defaultExchange ? 1 : 0;
				const bDefault = b.exchange.toUpperCase() === defaultExchange ? 1 : 0;
				if (aDefault !== bDefault) return bDefault - aDefault;
			}
			if (a.score !== b.score) return b.score - a.score;
			return a.order - b.order;
		});
	}

	return {
		matches: results.slice(0, maxResults),
		normalizedQuery: target,
		totalEntries: entries.length,
	};
}

/**
 * Return the entire static alias table (deterministic order). Used by
 * `GET /api/symbols/aliases` so operators can audit the map.
 *
 * @returns {Array<{ aliases: string[], exchange: string, symbol: string, assetClass: string|null }>}
 */
function listAliases() {
	const entries = loadAliases();
	return entries.map((entry) => ({
		aliases: entry.aliases.slice(),
		exchange: entry.exchange,
		symbol: entry.symbol,
		assetClass: entry.assetClass,
	}));
}

/**
 * Convenience helper that resolves a query to a single canonical
 * `EXCHANGE:SYMBOL` identifier. Returns `null` when no match is found so
 * callers can preserve the existing `INVALID_REQUEST` failure mode for
 * un-mapped tickers.
 *
 * @param {string} rawQuery
 * @param {object} [options]
 * @returns {string|null}
 */
function resolveToCanonicalId(rawQuery, options = {}) {
	const { matches } = resolveSymbolQuery(rawQuery, options);
	if (matches.length === 0) return null;
	const top = matches[0];
	return `${top.exchange}:${top.symbol}`;
}

function isEnabled() {
	// The resolver is opt-out via `DISABLE_SYMBOL_ALIAS_RESOLVER` so production
	// can roll back without code changes. The route is gated by `validateApiKey`
	// and admin auth, so disable-by-default would defeat the purpose — it is
	// available whenever the static table loads successfully.
	if (process.env.DISABLE_SYMBOL_ALIAS_RESOLVER === 'true') return false;
	return loadAliases().length > 0;
}

// Test-only hook to reset the cached table between cases.
function _resetCache() {
	cachedEntries = null;
	cachedVersion = null;
}

module.exports = {
	resolveSymbolQuery,
	resolveToCanonicalId,
	listAliases,
	normalizeQuery,
	isEnabled,
	_resetCache,
};