'use strict';

const alertStorageService = require('../../services/storage/AlertStorageService');
const sentryService = require('../../services/monitoring/SentryService');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

function parseLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_LIMIT;
	}

	const limit = Number.parseInt(rawLimit, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		return null;
	}

	return limit;
}

function parseEnriched(rawEnriched) {
	if (rawEnriched === undefined) {
		return undefined;
	}

	if (rawEnriched === 'true' || rawEnriched === true) {
		return true;
	}

	if (rawEnriched === 'false' || rawEnriched === false) {
		return false;
	}

	return null;
}

function listAlerts(req, res) {
	return handleAsync(req, res, '/api/alerts', async () => {
		if (!alertStorageService.isEnabled()) {
			return res.status(403).json({
				error: 'Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseLimit(req.query.limit);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const before = req.query.before;
		if (before && Number.isNaN(Date.parse(before))) {
			return res.status(400).json({
				error: 'Invalid before cursor. Use an ISO-8601 timestamp.',
				code: 'INVALID_REQUEST',
			});
		}

		const enriched = parseEnriched(req.query.enriched);
		if (enriched === null) {
			return res.status(400).json({
				error: 'Invalid enriched filter. Use true or false.',
				code: 'INVALID_REQUEST',
			});
		}

		const source = typeof req.query.source === 'string' && req.query.source.trim()
			? req.query.source.trim()
			: undefined;

		const result = await alertStorageService.listAlerts({
			before,
			enriched,
			limit,
			source,
		});

		return res.status(200).json({
			success: true,
			alerts: result.alerts,
			pagination: {
				hasMore: result.hasMore,
				limit,
				nextBefore: result.nextBefore,
			},
		});
	});
}

function getAlertById(req, res) {
	return handleAsync(req, res, `/api/alerts/${req.params.alertId}`, async () => {
		if (!alertStorageService.isEnabled()) {
			return res.status(403).json({
				error: 'Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const { alertId } = req.params;
		if (!alertId) {
			return res.status(400).json({
				error: 'Missing alertId parameter',
				code: 'INVALID_REQUEST',
			});
		}

		const alert = await alertStorageService.getAlertById(alertId);
		if (!alert) {
			return res.status(404).json({
				error: 'Alert not found',
				code: 'NOT_FOUND',
			});
		}

		return res.status(200).json({
			success: true,
			alert,
		});
	});
}

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		console.error('[AlertsController] Request failed:', error.message);
		const statusCode = error.code === alertStorageService.STORAGE_UNAVAILABLE_CODE ? 503 : 500;
		sentryService.captureRuntimeError({
			channel: 'alerts-controller',
			error,
			http: {
				endpoint,
				method: req.method,
				statusCode,
			},
		});

		if (statusCode === 503) {
			return res.status(503).json({
				error: error.message,
				code: alertStorageService.STORAGE_UNAVAILABLE_CODE,
			});
		}

		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	});
}

module.exports = {
	listAlerts,
	getAlertById,
};
