'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const {
	BinanceOrderRequestError,
	BinanceOrderServiceError,
	binanceOrderService,
} = require('../../services/trading/BinanceOrderService');
const { getIdempotencyKey } = require('../../lib/idempotency');
const { binanceOrderAuditService } = require('../../services/trading/BinanceOrderAuditService');

async function postBinanceOrder(req, res) {
	const startTime = Date.now();
	try {
		const result = await binanceOrderService.placeOrder(req.body, {
			idempotencyKey: getIdempotencyKey(req),
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

		if (!result.dryRun) {
			binanceOrderAuditService.recordMutation({
				operator: binanceOrderAuditService.extractOperatorHash(req),
				action: 'PLACE',
				symbol: result.order?.symbol || req.body?.symbol,
				side: result.order?.side || req.body?.side || null,
				type: result.order?.type || req.body?.type || null,
				quantity: result.order?.origQty ?? result.order?.quantity ?? req.body?.quantity ?? null,
				price: result.order?.price ?? req.body?.price ?? null,
				status: result.order?.status || 'SUBMITTED',
				binanceOrderId: result.order?.orderId ?? null,
				response: result,
				processingMs,
			}).catch((err) => {
				console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
			});
		}

		return res.status(result.dryRun ? 200 : 201).json(result);
	} catch (error) {
		const processingMs = Date.now() - startTime;
		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order rejected', { code: error.code });
			if (req.body?.dryRun !== true) {
				binanceOrderAuditService.recordMutation({
					operator: binanceOrderAuditService.extractOperatorHash(req),
					action: 'PLACE',
					symbol: req.body?.symbol,
					side: req.body?.side || null,
					type: req.body?.type || null,
					quantity: req.body?.quantity ?? null,
					price: req.body?.price ?? null,
					status: error.code || 'REJECTED',
					binanceOrderId: null,
					response: { error: error.message, code: error.code },
					processingMs,
				}).catch((err) => {
					console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
				});
			}
			return res.status(error.statusCode || 400).json({
				success: false,
				error: error.message,
				code: error.code,
			});
		}

		console.error('[BinanceOrdersController] order failed', { code: 'BINANCE_ORDER_FAILED' });
		if (req.body?.dryRun !== true) {
			binanceOrderAuditService.recordMutation({
				operator: binanceOrderAuditService.extractOperatorHash(req),
				action: 'PLACE',
				symbol: req.body?.symbol,
				side: req.body?.side || null,
				type: req.body?.type || null,
				quantity: req.body?.quantity ?? null,
				price: req.body?.price ?? null,
				status: 'FAILED',
				binanceOrderId: null,
				response: { error: error.message, code: 'BINANCE_ORDER_FAILED' },
				processingMs,
			}).catch((err) => {
				console.warn('[BinanceOrdersController] audit logging failed:', err?.message || err);
			});
		}
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
	try {
		const result = await binanceOrderService.getOrders(req.query);
		return res.status(200).json(result);
	} catch (error) {
		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order query rejected', { code: error.code });
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
			operator: binanceOrderAuditService.extractOperatorHash(req),
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
				operator: binanceOrderAuditService.extractOperatorHash(req),
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
			operator: binanceOrderAuditService.extractOperatorHash(req),
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

module.exports = {
	postBinanceOrder,
	getBinanceOrders,
	deleteBinanceOrder,
};

