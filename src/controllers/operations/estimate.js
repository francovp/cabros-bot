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
	const symbols = Array.isArray(body.symbols) ? body.symbols : [];
	const costEstimate = costEstimationService.estimate({ operation: canonical, symbols, body });
	return res.status(200).json({
		success: true,
		operation: canonical,
		costEstimate,
	});
}

module.exports = { postOperationEstimate };
