'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const {
	BinanceOrderRequestError,
	BinanceOrderServiceError,
	binanceOrderService,
	deriveClientOrderId,
} = require('../../services/trading/BinanceOrderService');
const { getIdempotencyKey } = require('../../lib/idempotency');
const { binanceOrderAuditService } = require('../../services/trading/BinanceOrderAuditService');

async function postBinanceOrder(req, res) {
	const startTime = Date.now();
	const idempotencyKey = getIdempotencyKey(req);
	try {
		const result = await binanceOrderService.placeOrder(req.body, {
			idempotencyKey,
		});
		const processingMs = Date.now() - startTime;
		try {
			console.log('[BinanceOrdersController] order processed', {
				symbol: result.order?.symbol,
				side: result.order?.side,
				type: result.order?.type,
				dryRun: result.dryRun,
				environment: result.environment,
			});
		} catch {
			// Audit logging is best effort; never turn a confirmed order into a false failure.
		}

		binanceOrderAuditService.recordMutation({
			req,
			action: 'PLACE',
			symbol: result.order?.symbol || req.body?.symbol,
			side: result.order?.side || req.body?.side || null,
			type: result.order?.type || req.body?.type || null,
			quantity: result.order?.origQty ?? result.order?.quantity ?? req.body?.quantity ?? null,
			quoteOrderQty: result.order?.quoteOrderQty ?? req.body?.quoteOrderQty ?? null,
			price: result.order?.price ?? req.body?.price ?? null,
			timeInForce: result.order?.timeInForce ?? req.body?.timeInForce ?? null,
			status: result.dryRun ? 'dry_run' : (result.order?.status || 'SUBMITTED'),
			dryRun: Boolean(result.dryRun),
			environment: result.environment,
			binanceOrderId: result.order?.orderId ?? null,
			clientOrderId: result.order?.clientOrderId ?? null,
			response: result,
			processingMs,
		}).catch((err) => {
			console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
		});

		return res.status(result.dryRun ? 200 : 201).json(result);
	} catch (error) {
		const processingMs = Date.now() - startTime;
		const clientOrderId = error.clientOrderId
			|| req.body?.clientOrderId
			|| (idempotencyKey ? deriveClientOrderId(idempotencyKey, req.body) : null);

		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order rejected', { code: error.code });
			const isAmbiguous = error.code === 'BINANCE_ORDER_STATUS_UNKNOWN';
			const status = isAmbiguous ? 'ambiguous' : 'rejected';
			binanceOrderAuditService.recordMutation({
				req,
				action: 'PLACE',
				symbol: req.body?.symbol,
				side: req.body?.side || null,
				type: req.body?.type || null,
				quantity: req.body?.quantity ?? null,
				quoteOrderQty: req.body?.quoteOrderQty ?? null,
				price: req.body?.price ?? null,
				timeInForce: req.body?.timeInForce ?? null,
				status,
				errorCode: error.code,
				dryRun: Boolean(req.body?.dryRun),
				binanceOrderId: null,
				clientOrderId: clientOrderId ?? null,
				response: { error: error.message, code: error.code },
				processingMs,
			}).catch((err) => {
				console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
			});
			return res.status(error.statusCode || 400).json({
				success: false,
				error: error.message,
				code: error.code,
			});
		}

		console.error('[BinanceOrdersController] order failed', { code: 'BINANCE_ORDER_FAILED' });
		binanceOrderAuditService.recordMutation({
			req,
			action: 'PLACE',
			symbol: req.body?.symbol,
			side: req.body?.side || null,
			type: req.body?.type || null,
			quantity: req.body?.quantity ?? null,
			quoteOrderQty: req.body?.quoteOrderQty ?? null,
			price: req.body?.price ?? null,
			timeInForce: req.body?.timeInForce ?? null,
			status: 'rejected',
			errorCode: 'BINANCE_ORDER_FAILED',
			dryRun: Boolean(req.body?.dryRun),
			binanceOrderId: null,
			clientOrderId: clientOrderId ?? null,
			response: { error: error.message, code: 'BINANCE_ORDER_FAILED' },
			processingMs,
		}).catch((err) => {
			console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
		});
		sentryService.captureRuntimeError({
			channel: 'binance-orders-controller',
			error,
			http: {
				endpoint: '/api/trading/binance/orders',
				method: 'POST',
				statusCode: 502,
			},
		});
		return res.status(502).json({
			success: false,
			error: 'Binance order request failed',
			code: 'BINANCE_ORDER_FAILED',
		});
	}
}

async function getBinanceOrders(req, res) {
	const startTime = Date.now();
	try {
		const result = await binanceOrderService.getOrders(req.query);
		const processingMs = Date.now() - startTime;
		binanceOrderAuditService.recordMutation({
			req,
			action: 'RECONCILE',
			symbol: req.query?.symbol,
			status: result.order ? 'confirmed' : 'queried',
			binanceOrderId: result.order?.orderId ?? req.query?.orderId ?? null,
			clientOrderId: result.order?.clientOrderId ?? req.query?.origClientOrderId ?? null,
			response: result,
			processingMs,
		}).catch((err) => {
			console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
		});
		return res.status(200).json(result);
	} catch (error) {
		const processingMs = Date.now() - startTime;
		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order query rejected', { code: error.code });
			binanceOrderAuditService.recordMutation({
				req,
				action: 'RECONCILE',
				symbol: req.query?.symbol,
				status: 'rejected',
				errorCode: error.code,
				binanceOrderId: req.query?.orderId ?? null,
				clientOrderId: req.query?.origClientOrderId ?? null,
				response: { error: error.message, code: error.code },
				processingMs,
			}).catch((err) => {
				console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
			});
			return res.status(error.statusCode || 400).json({
				success: false,
				error: error.message,
				code: error.code,
			});
		}

		console.error('[BinanceOrdersController] order query failed', { code: 'BINANCE_ORDER_QUERY_FAILED' });
		sentryService.captureRuntimeError({
			channel: 'binance-orders-controller',
			error,
			http: {
				endpoint: '/api/trading/binance/orders',
				method: 'GET',
				statusCode: 502,
			},
		});
		return res.status(502).json({
			success: false,
			error: 'Binance order query failed',
			code: 'BINANCE_ORDER_QUERY_FAILED',
		});
	}
}

async function deleteBinanceOrder(req, res) {
	const startTime = Date.now();
	try {
		const result = await binanceOrderService.cancelOrder(req.body || {});
		const processingMs = Date.now() - startTime;
		try {
			console.log('[BinanceOrdersController] order cancelled', {
				symbol: result.order?.symbol,
				orderId: result.order?.orderId,
				clientOrderId: result.order?.clientOrderId,
				environment: result.environment,
			});
		} catch {
			// Audit logging is best effort; never turn a confirmed cancel into a false failure.
		}

		binanceOrderAuditService.recordMutation({
			req,
			action: 'CANCEL',
			symbol: result.order?.symbol || req.body?.symbol,
			side: result.order?.side || null,
			type: result.order?.type || null,
			quantity: result.order?.origQty ?? result.order?.quantity ?? null,
			price: result.order?.price ?? null,
			status: result.order?.status || 'CANCELED',
			binanceOrderId: result.order?.orderId ?? req.body?.orderId ?? null,
			response: result,
			processingMs,
		}).catch((err) => {
			console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
		});

		return res.status(200).json(result);
	} catch (error) {
		const processingMs = Date.now() - startTime;
		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order cancel rejected', { code: error.code });
			binanceOrderAuditService.recordMutation({
				req,
				action: 'CANCEL',
				symbol: req.body?.symbol,
				side: null,
				type: null,
				quantity: null,
				price: null,
				status: error.code || 'REJECTED',
				binanceOrderId: req.body?.orderId ?? null,
				response: { error: error.message, code: error.code },
				processingMs,
			}).catch((err) => {
				console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
			});
			return res.status(error.statusCode || 400).json({
				success: false,
				error: error.message,
				code: error.code,
			});
		}

		console.error('[BinanceOrdersController] order cancel failed', { code: 'BINANCE_ORDER_CANCEL_FAILED' });
		binanceOrderAuditService.recordMutation({
			req,
			action: 'CANCEL',
			symbol: req.body?.symbol,
			side: null,
			type: null,
			quantity: null,
			price: null,
			status: 'FAILED',
			binanceOrderId: req.body?.orderId ?? null,
			response: { error: error.message, code: 'BINANCE_ORDER_CANCEL_FAILED' },
			processingMs,
		}).catch((err) => {
			console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
		});
		sentryService.captureRuntimeError({
			channel: 'binance-orders-controller',
			error,
			http: {
				endpoint: '/api/trading/binance/orders',
				method: 'DELETE',
				statusCode: 502,
			},
		});
		return res.status(502).json({
			success: false,
			error: 'Binance cancel request failed',
			code: 'BINANCE_ORDER_CANCEL_FAILED',
		});
	}
}

async function getBinanceOrderAudit(req, res) {
	if (!binanceOrderAuditService.isEnabled()) {
		return res.status(403).json({
			success: false,
			error: 'Binance order audit trail is disabled',
			code: 'FEATURE_DISABLED',
		});
	}

	if (!binanceOrderAuditService.isConfigured()) {
		return res.status(503).json({
			success: false,
			error: 'Binance order audit trail is enabled but Firestore is not configured',
			code: 'STORAGE_UNAVAILABLE',
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

	const {
		before,
		symbol,
		status,
		from,
		to,
		startDate,
		endDate,
		environment,
		orderId,
	} = req.query;

	const effectiveFrom = from || startDate;
	const effectiveTo = to || endDate;

	if (effectiveFrom && Number.isNaN(Date.parse(effectiveFrom))) {
		return res.status(400).json({
			success: false,
			error: 'Invalid from date parameter',
			code: 'INVALID_REQUEST',
		});
	}

	if (effectiveTo && Number.isNaN(Date.parse(effectiveTo))) {
		return res.status(400).json({
			success: false,
			error: 'Invalid to date parameter',
			code: 'INVALID_REQUEST',
		});
	}

	try {
		const result = await binanceOrderAuditService.listAuditRecords({
			limit: effectiveLimit,
			before,
			symbol,
			status,
			from: effectiveFrom,
			to: effectiveTo,
			environment,
			orderId,
			signal: req.signal,
		});

		const records = result?.records || [];
		const hasMore = Boolean(result?.hasMore);
		const nextBefore = result?.nextBefore || null;

		return res.status(200).json({
			success: true,
			records,
			audit: records,
			pagination: {
				hasMore,
				limit: result?.limit ?? effectiveLimit,
				nextBefore,
			},
		});
	} catch (error) {
		if (error.code === 'INVALID_REQUEST') {
			return res.status(400).json({
				success: false,
				error: error.message || 'Invalid request parameters',
				code: 'INVALID_REQUEST',
			});
		}

		if (error.code === 'ABORTED' || error.name === 'AbortError') {
			return res.status(499).json({
				success: false,
				error: 'Request was aborted',
				code: 'ABORTED',
			});
		}

		if (error.code === 'STORAGE_UNAVAILABLE') {
			return res.status(503).json({
				success: false,
				error: error.message || 'Audit storage unavailable',
				code: 'STORAGE_UNAVAILABLE',
			});
		}

		console.error('[BinanceOrdersController] audit query failed:', error);
		sentryService.captureRuntimeError({
			channel: 'binance-orders-controller',
			error,
			http: {
				endpoint: '/api/trading/binance/orders/audit',
				method: 'GET',
				statusCode: 500,
			},
		});

		return res.status(500).json({
			success: false,
			error: 'Failed to retrieve Binance order audit logs',
			code: 'INTERNAL_ERROR',
		});
	}
}

module.exports = {
	postBinanceOrder,
	getBinanceOrders,
	deleteBinanceOrder,
	getBinanceOrderAudit,
};

