'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const { sendErrorFrom } = require('../../lib/errorEnvelope');
const { binanceOrderAuditService } = require('../../services/trading/BinanceOrderAuditService');
const autoTradeReservationService = require('../../services/trading/AutoTradeReservationService');

function readActor(req) {
	if (req.adminRole) return String(req.adminRole);
	if (req.headers && req.headers['x-api-key']) return 'api-key';
	if (req.headers && req.headers.authorization) return 'firebase-bearer';
	return 'unknown';
}

function parseAndValidateLimit(rawLimit) {
	if (rawLimit === undefined || rawLimit === null || rawLimit === '') return 50;
	const str = String(rawLimit).trim();
	if (!/^\d+$/.test(str)) {
		const error = new Error('limit must be an integer between 1 and 100');
		error.code = 'INVALID_REQUEST';
		error.statusCode = 400;
		throw error;
	}
	const val = parseInt(str, 10);
	if (val < 1 || val > 100) {
		const error = new Error('limit must be an integer between 1 and 100');
		error.code = 'INVALID_REQUEST';
		error.statusCode = 400;
		throw error;
	}
	return val;
}

async function getBinanceReconciliation(req, res) {
	let limit;
	try {
		limit = parseAndValidateLimit(req.query.limit);
	} catch (err) {
		return sendErrorFrom(res, err.statusCode || 400, {
			error: err.message,
			code: err.code || 'INVALID_REQUEST',
		}, { req });
	}

	try {
		const result = await autoTradeReservationService.listAmbiguousReservations({
			limit,
			symbol: req.query.symbol,
			status: req.query.status || 'ambiguous',
		});
		if (!result || !result.success) {
			return sendErrorFrom(res, 503, {
				error: result?.error || 'Storage unavailable',
				code: result?.code || 'STORAGE_UNAVAILABLE',
				retryable: true,
			}, { req });
		}
		return res.status(200).json({
			success: true,
			reservations: result.reservations,
			count: result.count,
			ambiguousCount: result.ambiguousCount,
		});
	} catch (error) {
		console.error('[BinanceReconciliationController] query failed:', error);
		sentryService.captureRuntimeError({
			channel: 'binance-reconciliation-controller',
			error,
			http: {
				endpoint: '/api/trading/binance/reconciliation',
				method: 'GET',
				statusCode: error.statusCode || 500,
			},
		});
		return sendErrorFrom(res, error.statusCode || 500, {
			error: error.message || 'Failed to retrieve ambiguous reservations',
			code: error.code || 'INTERNAL_ERROR',
		}, { req });
	}
}

async function getBinanceReconciliationById(req, res) {
	const reservationId = req.params.reservationId;
	try {
		const reservation = await autoTradeReservationService.getAmbiguousReservation(reservationId);
		if (!reservation) {
			return sendErrorFrom(res, 404, {
				error: 'Ambiguous reservation not found',
				code: 'RESERVATION_NOT_FOUND',
			}, { req });
		}
		return res.status(200).json({
			success: true,
			reservation,
		});
	} catch (error) {
		const isStorage = error.code === 'STORAGE_UNAVAILABLE' || error.statusCode === 503;
		if (!isStorage) {
			console.error('[BinanceReconciliationController] getById failed:', error);
			sentryService.captureRuntimeError({
				channel: 'binance-reconciliation-controller',
				error,
				http: {
					endpoint: `/api/trading/binance/reconciliation/${reservationId}`,
					method: 'GET',
					statusCode: error.statusCode || 500,
				},
			});
		}
		return sendErrorFrom(res, error.statusCode || 500, {
			error: error.message || 'Failed to retrieve ambiguous reservation',
			code: error.code || 'INTERNAL_ERROR',
			retryable: isStorage,
		}, { req });
	}
}

async function postResolveAmbiguousReservation(req, res) {
	const startTime = Date.now();
	const reservationId = req.params.reservationId;
	const { resolvedAs, orderId, notes } = req.body || {};

	if (!['placed', 'not_placed'].includes(resolvedAs)) {
		return sendErrorFrom(res, 400, {
			error: "resolvedAs must be 'placed' or 'not_placed'",
			code: 'INVALID_REQUEST',
		}, { req });
	}

	try {
		const actor = readActor(req);
		const outcome = await autoTradeReservationService.resolveAmbiguousReservation(reservationId, {
			resolvedAs,
			orderId,
			notes,
			actor,
		});

		const processingMs = Date.now() - startTime;
		binanceOrderAuditService.recordMutation({
			operation: 'reconcile_auto_trade_reservation',
			reservationId,
			resolvedAs,
			orderId: orderId || null,
			actor,
			idempotent: Boolean(outcome.idempotent),
			processingMs,
			success: true,
		});

		return res.status(200).json({
			success: true,
			action: outcome.idempotent ? 'already_resolved' : 'reconcile_resolve',
			resolvedAs,
			idempotent: Boolean(outcome.idempotent),
			reservation: outcome.reservation,
		});
	} catch (error) {
		const statusCode = error.statusCode || 500;
		const errorCode = error.code || 'RECONCILIATION_FAILED';

		if (statusCode >= 500) {
			console.error('[BinanceReconciliationController] resolve failed:', error);
			sentryService.captureRuntimeError({
				channel: 'binance-reconciliation-controller',
				error,
				http: {
					endpoint: `/api/trading/binance/reconciliation/${reservationId}`,
					method: 'POST',
					statusCode,
				},
			});
		}

		return sendErrorFrom(res, statusCode, {
			error: error.message || 'Failed to resolve ambiguous reservation',
			code: errorCode,
			retryable: statusCode === 503,
		}, { req });
	}
}

module.exports = {
	getBinanceReconciliation,
	getBinanceReconciliationById,
	postResolveAmbiguousReservation,
	parseAndValidateLimit,
};
