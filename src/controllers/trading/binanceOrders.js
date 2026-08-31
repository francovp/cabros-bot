'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const {
	BinanceOrderRequestError,
	BinanceOrderServiceError,
	binanceOrderService,
} = require('../../services/trading/BinanceOrderService');
const { getIdempotencyKey } = require('../../lib/idempotency');

async function postBinanceOrder(req, res) {
	try {
		const result = await binanceOrderService.placeOrder(req.body, {
			idempotencyKey: getIdempotencyKey(req),
		});
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
		return res.status(result.dryRun ? 200 : 201).json(result);
	} catch (error) {
		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order rejected', { code: error.code });
			return res.status(error.statusCode || 400).json({
				success: false,
				error: error.message,
				code: error.code,
			});
		}

		console.error('[BinanceOrdersController] order failed', { code: 'BINANCE_ORDER_FAILED' });
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
	try {
		const result = await binanceOrderService.cancelOrder(req.body || {});
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
		return res.status(200).json(result);
	} catch (error) {
		if (error instanceof BinanceOrderRequestError || error instanceof BinanceOrderServiceError) {
			console.warn('[BinanceOrdersController] order cancel rejected', { code: error.code });
			return res.status(error.statusCode || 400).json({
				success: false,
				error: error.message,
				code: error.code,
			});
		}

		console.error('[BinanceOrdersController] order cancel failed', { code: 'BINANCE_ORDER_CANCEL_FAILED' });
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

