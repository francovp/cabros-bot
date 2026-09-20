'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const symbolAnalysisStorageService = require('../../services/storage/SymbolAnalysisStorageService');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_SUMMARY_LIMIT = 500;
const MAX_SUMMARY_LIMIT = 1000;
const VALID_ACTIONS = new Set(['BUY', 'SELL', 'NO_TRADE']);

function parseLimit(rawLimit, defaultLimit = DEFAULT_LIMIT, maxLimit = MAX_LIMIT) {
	if (rawLimit === undefined) {
		return defaultLimit;
	}

	const limit = Number.parseInt(rawLimit, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
		return null;
	}

	return limit;
}

function parseAction(rawAction) {
	if (rawAction === undefined) {
		return undefined;
	}

	if (typeof rawAction !== 'string') {
		return null;
	}

	const action = rawAction.trim().toUpperCase();
	return VALID_ACTIONS.has(action) ? action : null;
}

function parseOptionalTimestamp(rawValue, name) {
	if (rawValue === undefined) {
		return { value: undefined };
	}

	if (typeof rawValue !== 'string' || !rawValue.trim() || Number.isNaN(Date.parse(rawValue))) {
		return {
			error: {
				error: `Invalid ${name} timestamp. Use an ISO-8601 timestamp.`,
				code: 'INVALID_REQUEST',
			},
		};
	}

	return { value: new Date(rawValue).toISOString() };
}

async function listSymbolAnalyses(req, res) {
	return handleAsync(req, res, '/api/symbol-analyses', async () => {
		if (!symbolAnalysisStorageService.isEnabled()) {
			return res.status(403).json({
				error: 'Symbol analysis storage feature is disabled. Set ENABLE_SYMBOL_ANALYSIS_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseLimit(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return res.status(400).json(from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return res.status(400).json(to.error);
		}

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return res.status(400).json({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		}

		let action;
		if (req.query.action !== undefined) {
			action = parseAction(req.query.action);
			if (!action) {
				return res.status(400).json({
					error: 'Invalid action. Supported values are BUY, SELL, or NO_TRADE.',
					code: 'INVALID_REQUEST',
				});
			}
		}

		const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim()
			? req.query.symbol.trim().toUpperCase()
			: undefined;

		const exchange = typeof req.query.exchange === 'string' && req.query.exchange.trim()
			? req.query.exchange.trim().toUpperCase()
			: undefined;

		const timeframe = typeof req.query.timeframe === 'string' && req.query.timeframe.trim()
			? req.query.timeframe.trim()
			: undefined;

		const before = typeof req.query.before === 'string' && req.query.before.trim()
			? req.query.before.trim()
			: undefined;

		const result = await symbolAnalysisStorageService.listAnalyses({
			limit,
			from: from.value,
			to: to.value,
			symbol,
			exchange,
			timeframe,
			action,
			before,
			beforeCursor: before,
		});

		return res.status(200).json({
			success: true,
			...result,
		});
	});
}

async function summarizeSymbolAnalyses(req, res) {
	return handleAsync(req, res, '/api/symbol-analyses/summary', async () => {
		if (!symbolAnalysisStorageService.isEnabled()) {
			return res.status(403).json({
				error: 'Symbol analysis storage feature is disabled. Set ENABLE_SYMBOL_ANALYSIS_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseLimit(req.query.limit, DEFAULT_SUMMARY_LIMIT, MAX_SUMMARY_LIMIT);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_SUMMARY_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return res.status(400).json(from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return res.status(400).json(to.error);
		}

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return res.status(400).json({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		}

		const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim()
			? req.query.symbol.trim().toUpperCase()
			: undefined;

		const exchange = typeof req.query.exchange === 'string' && req.query.exchange.trim()
			? req.query.exchange.trim().toUpperCase()
			: undefined;

		const timeframe = typeof req.query.timeframe === 'string' && req.query.timeframe.trim()
			? req.query.timeframe.trim()
			: undefined;

		const summary = await symbolAnalysisStorageService.summarizeAnalyses({
			limit,
			from: from.value,
			to: to.value,
			symbol,
			exchange,
			timeframe,
		});

		return res.status(200).json({
			success: true,
			summary,
		});
	});
}

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		console.error('[SymbolAnalysesController] Request failed:', error.message);
		const statusCode = error.code === 'STORAGE_UNAVAILABLE'
			? 503
			: (error.code === 'INVALID_REQUEST' ? 400 : (error.code === 'FEATURE_DISABLED' ? 403 : 500));

		sentryService.captureRuntimeError({
			channel: 'symbol-analyses-controller',
			error,
			http: {
				endpoint,
				method: req.method,
				statusCode,
			},
		});

		if (statusCode === 503) {
			return res.status(503).json({
				error: error.message,
				code: 'STORAGE_UNAVAILABLE',
			});
		}

		if (statusCode === 403) {
			return res.status(403).json({
				error: error.message,
				code: 'FEATURE_DISABLED',
			});
		}

		if (statusCode === 400) {
			return res.status(400).json({
				error: error.message,
				code: 'INVALID_REQUEST',
			});
		}

		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	});
}

module.exports = {
	listSymbolAnalyses,
	summarizeSymbolAnalyses,
	parseLimit,
	parseAction,
	parseOptionalTimestamp,
};
