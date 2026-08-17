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

module.exports = {
	postBinanceOrder,
};
