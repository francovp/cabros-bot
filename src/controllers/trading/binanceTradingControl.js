'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const {
	tradingControlService,
	TradingControlError,
} = require('../../services/trading/TradingControlService');
const {
	BinanceOrderServiceError,
} = require('../../services/trading/BinanceOrderService');

function sendTradingControlError(res, error) {
	if (error instanceof TradingControlError) {
		console.warn('[BinanceTradingControlController] rejected', { code: error.code });
		return res.status(error.statusCode || 500).json({
			success: false,
			error: error.message,
			code: error.code,
		});
	}
	if (error instanceof BinanceOrderServiceError) {
		console.warn('[BinanceTradingControlController] binance order error reused', { code: error.code });
		return res.status(error.statusCode || 500).json({
			success: false,
			error: error.message,
			code: error.code,
		});
	}

	console.error('[BinanceTradingControlController] unexpected error', { code: 'TRADING_CONTROL_ERROR' });
	sentryService.captureRuntimeError({
		channel: 'binance-trading-control-controller',
		error,
		http: {
			endpoint: '/api/trading/binance/control',
			method: 'POST',
			statusCode: 500,
		},
	});
	return res.status(500).json({
		success: false,
		error: 'Trading control request failed',
		code: 'TRADING_CONTROL_ERROR',
	});
}

function readActor(req) {
	if (req.adminRole) return String(req.adminRole);
	if (req.headers['x-api-key']) return 'api-key';
	if (req.headers && req.headers.authorization) return 'firebase-bearer';
	return 'unknown';
}

function buildStatePayload(snapshot) {
	return {
		paused: snapshot.paused,
		pausedBy: snapshot.pausedBy,
		pausedAt: snapshot.pausedAt,
		pausedReason: snapshot.pausedReason,
		resumedBy: snapshot.resumedBy,
		resumedAt: snapshot.resumedAt,
		lastChangedAt: snapshot.lastChangedAt,
		lastChangedBy: snapshot.lastChangedBy,
		lastAction: snapshot.lastAction,
		unavailable: snapshot.unavailable,
		storage: snapshot.storage,
	};
}

async function postBinancePause(req, res) {
	try {
		const snapshot = await tradingControlService.pause({
			actor: readActor(req),
			reason: tradingControlService.readReason(req.body),
		});
		return res.status(200).json({
			success: true,
			action: 'pause',
			state: buildStatePayload(snapshot),
		});
	} catch (error) {
		return sendTradingControlError(res, error);
	}
}

async function postBinanceResume(req, res) {
	try {
		const snapshot = await tradingControlService.resume({
			actor: readActor(req),
			reason: tradingControlService.readReason(req.body),
		});
		return res.status(200).json({
			success: true,
			action: 'resume',
			state: buildStatePayload(snapshot),
		});
	} catch (error) {
		return sendTradingControlError(res, error);
	}
}

async function getBinancePause(req, res) {
	try {
		const snapshot = await tradingControlService.getPauseState();
		return res.status(200).json({
			success: true,
			state: buildStatePayload(snapshot),
		});
	} catch (error) {
		return sendTradingControlError(res, error);
	}
}

module.exports = {
	postBinancePause,
	postBinanceResume,
	getBinancePause,
};
