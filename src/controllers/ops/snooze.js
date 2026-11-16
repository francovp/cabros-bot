/**
 * SnoozeController - HTTP surface for the global incident snooze service.
 *
 * Endpoints (mounted at `/api/ops/snooze`):
 *   GET    /api/ops/snooze     - returns the active snooze or { active: false }
 *   POST   /api/ops/snooze     - activates a snooze (admin/operator)
 *   DELETE /api/ops/snooze     - cancels the active snooze (admin/operator)
 *
 * The endpoints are protected by the same `validateApiKey` / admin-operator
 * middleware as the rest of the operator surface. They never throw: errors
 * are mapped to safe JSON responses with explicit error codes.
 */

const {
	snoozeService,
	MIN_DURATION_MS,
	MAX_DURATION_MS,
} = require('../../services/notification/SnoozeService');
const { sendError, resolveEnvelopeRequestId } = require('../../lib/errorEnvelope');

function getSnooze(req, res) {
	try {
		const active = snoozeService.getActive();
		return res.status(200).json(active || { active: false });
	} catch (error) {
		console.error('[SnoozeController] getSnooze failed:', error.message);
		return sendError(res, 500, {
			error: 'internal_error',
			code: 'INTERNAL_ERROR',
			requestId: resolveEnvelopeRequestId(req),
		});
	}
}

function postSnooze(req, res) {
	const body = req.body || {};
	const { durationMs, reason, channels, actorIp } = body;

	if (typeof durationMs !== 'number' && typeof durationMs !== 'string') {
		return sendError(res, 400, {
			error: 'durationMs must be a number',
			code: 'INVALID_DURATION',
			requestId: resolveEnvelopeRequestId(req),
		});
	}
	const parsed = typeof durationMs === 'string' ? Number(durationMs) : durationMs;
	if (!Number.isFinite(parsed) || parsed < MIN_DURATION_MS || parsed > MAX_DURATION_MS) {
		return sendError(res, 400, {
			error: `durationMs must be between ${MIN_DURATION_MS} and ${MAX_DURATION_MS}`,
			code: 'INVALID_DURATION',
			requestId: resolveEnvelopeRequestId(req),
		});
	}

	if (channels !== undefined && !Array.isArray(channels)) {
		return sendError(res, 400, {
			error: 'channels must be an array of channel names',
			code: 'INVALID_CHANNELS',
			requestId: resolveEnvelopeRequestId(req),
		});
	}

	const result = snoozeService.activate({
		durationMs: parsed,
		reason: typeof reason === 'string' ? reason : '',
		channels: channels !== undefined ? channels : undefined,
		actorIp: typeof actorIp === 'string' ? actorIp : (req.ip || null),
	});

	if (!result.ok) {
		return sendError(res, 400, {
			error: result.error,
			code: result.error,
			requestId: resolveEnvelopeRequestId(req),
		});
	}
	return res.status(200).json(result.snooze);
}

function deleteSnooze(req, res) {
	try {
		const result = snoozeService.cancel();
		return res.status(200).json(result.snooze);
	} catch (error) {
		console.error('[SnoozeController] deleteSnooze failed:', error.message);
		return sendError(res, 500, {
			error: 'internal_error',
			code: 'INTERNAL_ERROR',
			requestId: resolveEnvelopeRequestId(req),
		});
	}
}

module.exports = {
	getSnooze,
	postSnooze,
	deleteSnooze,
};
