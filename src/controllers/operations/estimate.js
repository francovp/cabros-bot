'use strict';

const { sendErrorFrom } = require('../../lib/errorEnvelope');
const costEstimationService = require('../../services/cost/CostEstimationService');
const { resolveRequestId } = require('../../lib/requestDeadline');

function postOperationEstimate(req, res) {
	const requestId = (req && req.requestId) || resolveRequestId(req);
	if (!costEstimationService.isEnabled()) {
		return sendErrorFrom(res, 404, {
			error: 'Cost estimation is disabled. Set ENABLE_DRY_RUN_COST=true to enable.',
			code: 'FEATURE_DISABLED',
			requestId,
		});
	}
	const body = req && req.body && typeof req.body === 'object' ? req.body : {};
	const operation = body.operation;
	if (typeof operation !== 'string' || operation.trim() === '') {
		return sendErrorFrom(res, 400, {
			error: 'Missing required "operation" field.',
			code: 'INVALID_REQUEST',
			requestId,
		});
	}
	const canonical = costEstimationService.normalizeOperation(operation);
	if (!canonical) {
		return sendErrorFrom(res, 400, {
			error: `Invalid operation. Supported: ${costEstimationService.CANONICAL_OPERATIONS.join(', ')}`,
			code: 'INVALID_REQUEST',
			requestId,
		});
	}
	// Resolve environment defaults the live handlers would use, so an omitted
	// symbol list estimates the configured workload instead of returning $0.
	const getDefaultSymbols = (envName) => {
		try {
			// eslint-disable-next-line global-require
			const { resolveRemoteOverride } = require('../../services/remoteConfig/resolveRemoteOverride');
			return (resolveRemoteOverride(envName) ?? process.env[envName] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
		} catch (error) {
			return (process.env[envName] ?? '').split(',').map((entry) => entry.trim()).filter(Boolean);
		}
	};
	let symbols = Array.isArray(body.symbols) ? body.symbols : [];
	const effectiveBody = { ...body };
	if (canonical === 'news-monitor') {
		const allProvided = [...(body.crypto || []), ...(body.stocks || []), ...symbols];
		if (allProvided.length === 0) {
			symbols = [...getDefaultSymbols('NEWS_SYMBOLS_CRYPTO'), ...getDefaultSymbols('NEWS_SYMBOLS_STOCKS')];
			effectiveBody.crypto = getDefaultSymbols('NEWS_SYMBOLS_CRYPTO');
			effectiveBody.stocks = getDefaultSymbols('NEWS_SYMBOLS_STOCKS');
		}
	} else if (canonical === 'expanded-analysis-alert') {
		if (symbols.length === 0) {
			symbols = getDefaultSymbols('EXPANDED_ANALYSIS_ALERT_SYMBOLS');
			effectiveBody.symbols = symbols;
		}
	}
	const costEstimate = costEstimationService.estimate({ operation: canonical, symbols, body: effectiveBody });
	return res.status(200).json({
		success: true,
		operation: canonical,
		costEstimate,
	});
}

module.exports = { postOperationEstimate };
