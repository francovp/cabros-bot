'use strict';

/**
 * Trade ledger controllers (#1275):
 * - GET /api/trading/positions
 * - GET /api/trading/pnl/summary
 * - GET /api/trading/trades
 *
 * Gated by admin read (admin.viewer role or WEBHOOK_API_KEY).
 * Echoes `environment` in every response.
 * Returns 403 when ENABLE_TRADE_LEDGER is disabled, 503 when Firestore is unconfigured,
 * 400 on invalid query parameters.
 */

const { tradeLedgerService, ENVIRONMENTS } = require('../../services/trading/TradeLedgerService');
const { matchFifo, buildPositions, summarize, GROUP_BY_VALUES } = require('../../services/trading/tradePnl');
const sentryService = require('../../services/monitoring/SentryService');

function resolveEnvironment(query = {}) {
	const raw = query.environment || process.env.BINANCE_TRADING_ENV || 'testnet';
	const env = String(raw).trim().toLowerCase();
	return env;
}

function validateLedgerReadiness(res) {
	if (!tradeLedgerService.isEnabled()) {
		res.status(403).json({
			success: false,
			error: 'Trade ledger is disabled',
			code: 'FEATURE_DISABLED',
		});
		return false;
	}
	if (!tradeLedgerService.isConfigured()) {
		res.status(503).json({
			success: false,
			error: 'Trade ledger is enabled but storage is not configured',
			code: 'STORAGE_UNAVAILABLE',
		});
		return false;
	}
	return true;
}

function parseDateParam(val) {
	if (!val) return null;
	const parsed = Date.parse(val);
	return Number.isNaN(parsed) ? undefined : parsed;
}

async function getPositions(req, res) {
	if (!validateLedgerReadiness(res)) return;
	const environment = resolveEnvironment(req.query);
	if (!ENVIRONMENTS.has(environment)) {
		return res.status(400).json({
			success: false,
			error: `Invalid environment: ${environment}. Must be one of: ${[...ENVIRONMENTS].join(', ')}`,
			code: 'INVALID_REQUEST',
		});
	}

	try {
		const { fills, scanTruncated, maxScan } = await tradeLedgerService.listFills({ environment });
		const { openLots, unmatchedSellQty } = matchFifo(fills);
		const symbols = [...new Set(openLots.map((l) => l.symbol))];
		const markPrices = await tradeLedgerService.fetchMarkPrices(symbols, environment);
		const positions = buildPositions(openLots, markPrices);

		return res.status(200).json({
			success: true,
			environment,
			positions,
			count: positions.length,
			unmatchedSellQty,
			scanTruncated,
			maxScan,
		});
	} catch (error) {
		if (error?.code === 'STORAGE_UNAVAILABLE') {
			return res.status(503).json({
				success: false,
				error: error.message || 'Trade ledger storage is unavailable',
				code: 'STORAGE_UNAVAILABLE',
			});
		}
		console.error('[TradeLedgerController] getPositions failed:', error);
		sentryService.captureRuntimeError({
			channel: 'trade-ledger-controller',
			error,
			http: { endpoint: '/api/trading/positions', method: 'GET', statusCode: 500 },
		});
		return res.status(500).json({
			success: false,
			error: 'Failed to retrieve trading positions',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function getPnlSummary(req, res) {
	if (!validateLedgerReadiness(res)) return;
	const environment = resolveEnvironment(req.query);
	if (!ENVIRONMENTS.has(environment)) {
		return res.status(400).json({
			success: false,
			error: `Invalid environment: ${environment}. Must be one of: ${[...ENVIRONMENTS].join(', ')}`,
			code: 'INVALID_REQUEST',
		});
	}

	const fromParam = req.query.from || req.query.startDate;
	const toParam = req.query.to || req.query.endDate;
	const fromMs = parseDateParam(fromParam);
	const toMs = parseDateParam(toParam);
	if (fromParam && fromMs === undefined) {
		return res.status(400).json({
			success: false,
			error: 'Invalid from date parameter',
			code: 'INVALID_REQUEST',
		});
	}
	if (toParam && toMs === undefined) {
		return res.status(400).json({
			success: false,
			error: 'Invalid to date parameter',
			code: 'INVALID_REQUEST',
		});
	}
	if (fromMs !== null && toMs !== null && fromMs > toMs) {
		return res.status(400).json({
			success: false,
			error: 'from date must be earlier than or equal to to date',
			code: 'INVALID_REQUEST',
		});
	}

	const groupBy = req.query.groupBy;
	if (groupBy && !GROUP_BY_VALUES.includes(groupBy)) {
		return res.status(400).json({
			success: false,
			error: `Invalid groupBy parameter. Must be one of: ${GROUP_BY_VALUES.join(', ')}`,
			code: 'INVALID_REQUEST',
		});
	}

	try {
		const { fills, scanTruncated, maxScan } = await tradeLedgerService.listFills({ environment });
		let { roundTrips, openLots, unmatchedSellQty } = matchFifo(fills);

		if (fromMs !== null || toMs !== null) {
			roundTrips = roundTrips.filter((rt) => {
				const exitMs = Date.parse(rt.exitAt);
				if (fromMs !== null && exitMs < fromMs) return false;
				if (toMs !== null && exitMs > toMs) return false;
				return true;
			});
		}

		const symbols = [...new Set(openLots.map((l) => l.symbol))];
		const markPrices = await tradeLedgerService.fetchMarkPrices(symbols, environment);
		const positions = buildPositions(openLots, markPrices);

		const summary = summarize({ roundTrips, positions, groupBy });

		return res.status(200).json({
			success: true,
			environment,
			...summary,
			summary,
			unmatchedSellQty,
			scanTruncated,
			maxScan,
		});
	} catch (error) {
		if (error?.code === 'STORAGE_UNAVAILABLE') {
			return res.status(503).json({
				success: false,
				error: error.message || 'Trade ledger storage is unavailable',
				code: 'STORAGE_UNAVAILABLE',
			});
		}
		console.error('[TradeLedgerController] getPnlSummary failed:', error);
		sentryService.captureRuntimeError({
			channel: 'trade-ledger-controller',
			error,
			http: { endpoint: '/api/trading/pnl/summary', method: 'GET', statusCode: 500 },
		});
		return res.status(500).json({
			success: false,
			error: 'Failed to retrieve P&L summary',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function getTrades(req, res) {
	if (!validateLedgerReadiness(res)) return;
	const environment = resolveEnvironment(req.query);
	if (!ENVIRONMENTS.has(environment)) {
		return res.status(400).json({
			success: false,
			error: `Invalid environment: ${environment}. Must be one of: ${[...ENVIRONMENTS].join(', ')}`,
			code: 'INVALID_REQUEST',
		});
	}

	let effectiveLimit = 50;
	if (req.query.limit !== undefined) {
		const parsed = Number(req.query.limit);
		if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
			return res.status(400).json({
				success: false,
				error: 'limit must be an integer between 1 and 100',
				code: 'INVALID_REQUEST',
			});
		}
		effectiveLimit = parsed;
	}

	const symbolFilter = req.query.symbol ? String(req.query.symbol).trim().toUpperCase() : null;
	const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;

	try {
		const { fills, scanTruncated, maxScan } = await tradeLedgerService.listFills({ environment });
		let { roundTrips } = matchFifo(fills);

		if (symbolFilter) {
			roundTrips = roundTrips.filter((rt) => rt.symbol === symbolFilter);
		}

		// Sort newest closed first
		roundTrips.sort((a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt));

		let startIndex = 0;
		if (cursor) {
			const idx = roundTrips.findIndex((rt) => rt.id === cursor);
			if (idx >= 0) {
				startIndex = idx + 1;
			}
		}

		const paginated = roundTrips.slice(startIndex, startIndex + effectiveLimit);
		const hasMore = startIndex + effectiveLimit < roundTrips.length;
		const nextCursor = hasMore && paginated.length > 0 ? paginated[paginated.length - 1].id : null;

		return res.status(200).json({
			success: true,
			environment,
			trades: paginated,
			count: paginated.length,
			pagination: {
				hasMore,
				limit: effectiveLimit,
				nextCursor,
				scanTruncated,
				maxScan,
			},
		});
	} catch (error) {
		if (error?.code === 'STORAGE_UNAVAILABLE') {
			return res.status(503).json({
				success: false,
				error: error.message || 'Trade ledger storage is unavailable',
				code: 'STORAGE_UNAVAILABLE',
			});
		}
		console.error('[TradeLedgerController] getTrades failed:', error);
		sentryService.captureRuntimeError({
			channel: 'trade-ledger-controller',
			error,
			http: { endpoint: '/api/trading/trades', method: 'GET', statusCode: 500 },
		});
		return res.status(500).json({
			success: false,
			error: 'Failed to retrieve trade ledger records',
			code: 'INTERNAL_ERROR',
		});
	}
}

module.exports = {
	getPositions,
	getPnlSummary,
	getTrades,
};
