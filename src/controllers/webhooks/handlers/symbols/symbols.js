'use strict';

/**
 * `/api/symbols/*` HTTP controller.
 *
 * Two endpoints back the symbol-alias-resolver feature (issue #845):
 *
 *   POST /api/symbols/resolve
 *     body: { query: string, defaultExchange?: string, maxResults?: number }
 *     200 → { matches: [...], normalizedQuery: string, totalEntries: number }
 *     400 → INVALID_REQUEST for missing/non-string query.
 *
 *   GET /api/symbols/aliases
 *     200 → { aliases: [...] } (static table, deterministic order)
 *
 * Both endpoints require admin auth (operator). They never modify state and
 * are safe to mount behind the existing `validateAdminAccess` middleware.
 */

const {
	resolveSymbolQuery,
	listAliases,
} = require('../../../../services/symbols/aliasResolver');

const DEFAULT_MAX_RESULTS = 5;
const MAX_MAX_RESULTS = 25;

function badRequest(res, message, code = 'INVALID_REQUEST') {
	return res.status(400).json({ error: message, code });
}

function postResolveSymbol() {
	return async (req, res) => {
		const body = (req && req.body && typeof req.body === 'object') ? req.body : {};
		const query = body.query;

		if (typeof query !== 'string') {
			return badRequest(res, '`query` is required and must be a string', 'INVALID_REQUEST');
		}

		const trimmed = query.trim();
		if (trimmed.length === 0) {
			return badRequest(res, '`query` must not be empty', 'INVALID_REQUEST');
		}

		let maxResults = DEFAULT_MAX_RESULTS;
		if (body.maxResults !== undefined && body.maxResults !== null) {
			if (typeof body.maxResults !== 'number' || !Number.isFinite(body.maxResults)) {
				return badRequest(res, '`maxResults` must be a finite number', 'INVALID_REQUEST');
			}
			if (body.maxResults <= 0) {
				return badRequest(res, '`maxResults` must be > 0', 'INVALID_REQUEST');
			}
			if (body.maxResults > MAX_MAX_RESULTS) {
				return badRequest(res, `\`maxResults\` must be <= ${MAX_MAX_RESULTS}`, 'INVALID_REQUEST');
			}
			maxResults = Math.floor(body.maxResults);
		}

		const defaultExchange = typeof body.defaultExchange === 'string'
			? body.defaultExchange.trim()
			: undefined;

		const { matches, normalizedQuery, totalEntries } = resolveSymbolQuery(trimmed, {
			defaultExchange,
			maxResults,
		});

		return res.status(200).json({
			matches,
			normalizedQuery,
			totalEntries,
			query: trimmed,
		});
	};
}

function getAliases() {
	return async (req, res) => {
		const aliases = listAliases();
		return res.status(200).json({
			aliases,
			totalEntries: aliases.length,
		});
	};
}

module.exports = {
	postResolveSymbol,
	getAliases,
	DEFAULT_MAX_RESULTS,
	MAX_MAX_RESULTS,
};