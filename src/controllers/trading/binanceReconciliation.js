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

async function getBinanceReconciliation(req, res) {
	try {
		const result = await autoTradeReservationService.listAmbiguousReservations(req.query);
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
				statusCode: 500,
			},
		});
		return sendErrorFrom(res, 500, {
			success: false,
			error: 'Failed to retrieve ambiguous reservations',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function getBinanceReconciliationById(req, res) {
	try {
		const reservationId = req.params.reservationId;
		const reservation = await autoTradeReservationService.getAmbiguousReservation(reservationId);
		if (!reservation) {
			return sendErrorFrom(res, 404, {
				success: false,
				error: 'Ambiguous reservation not found',
				code: 'RESERVATION_NOT_FOUND',
			});
		}
		return res.status(200).json({
			success: true,
			reservation,
		});
	} catch (error) {
		console.error('[BinanceReconciliationController] getById failed:', error);
		sentryService.captureRuntimeError({
			channel: 'binance-reconciliation-controller',
			error,
			http: {
				endpoint: `/api/trading/binance/reconciliation/${req.params.reservationId}`,
				method: 'GET',
				statusCode: 500,
			},
		});
		return sendErrorFrom(res, 500, {
			success: false,
			error: 'Failed to retrieve ambiguous reservation',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function postResolveAmbiguousReservation(req, res) {
	const startTime = Date.now();
	const reservationId = req.params.reservationId;
	const { resolvedAs, orderId, notes } = req.body || {};

	if (!['placed', 'not_placed'].includes(resolvedAs)) {
		return sendErrorFrom(res, 400, {
			success: false,
			error: "resolvedAs must be 'placed' or 'not_placed'",
			code: 'INVALID_REQUEST',
		});
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
			req,
			request: req.body,
			action: 'RECONCILE_RESOLVE',
			symbol: outcome.reservation?.signalContext?.symbol || null,
			status: `resolved_${resolvedAs}`,
			binanceOrderId: orderId || outcome.reservation?.orderId || null,
			clientOrderId: outcome.reservation?.clientOrderId || null,
			response: outcome,
			processingMs,
		}).catch((err) => {
			console.warn('[BinanceReconciliationController] audit logging failed:', err?.message || err);
		});

		return res.status(200).json({
			success: true,
			action: 'reconcile_resolve',
			resolvedAs,
			idempotent: Boolean(outcome.idempotent),
			reservation: outcome.reservation,
		});
	} catch (error) {
		const statusCode = error.statusCode || 500;
		if (statusCode < 500) {
			console.warn('[BinanceReconciliationController] resolve rejected:', { code: error.code, message: error.message });
			return sendErrorFrom(res, statusCode, {
				success: false,
				error: error.message,
				code: error.code || 'INVALID_REQUEST',
			});
		}

		console.error('[BinanceReconciliationController] resolve failed:', error);
		sentryService.captureRuntimeError({
			channel: 'binance-reconciliation-controller',
			error,
			http: {
				endpoint: `/api/trading/binance/reconciliation/${reservationId}`,
				method: 'POST',
				statusCode: 500,
			},
		});
		return sendErrorFrom(res, 500, {
			success: false,
			error: 'Failed to resolve ambiguous reservation',
			code: error.code || 'INTERNAL_ERROR',
		});
	}
}

module.exports = {
	getBinanceReconciliation,
	getBinanceReconciliationById,
	postResolveAmbiguousReservation,
};
