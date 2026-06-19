'use strict';

const alertStorageService = require('../../services/storage/AlertStorageService');
const sentryService = require('../../services/monitoring/SentryService');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const VALID_CHANNELS = ['telegram', 'whatsapp'];
const DEFAULT_SUMMARY_LIMIT = 500;
const MAX_SUMMARY_LIMIT = 1000;

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

function parseSummaryLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_SUMMARY_LIMIT;
	}

	const limit = Number.parseInt(rawLimit, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SUMMARY_LIMIT) {
		return null;
	}

	return limit;
}

function parseOptionalTimestamp(rawValue, name) {
	if (rawValue === undefined) {
		return { value: undefined };
	}

	if (typeof rawValue !== 'string' || !rawValue.trim() || Number.isNaN(Date.parse(rawValue))) {
		return {
			error: {
				error: `Invalid ${name} timestamp. Use an ISO-8601 timestamp.`,
				code: 'INVALID_REQUEST',
			},
		};
	}

	return { value: new Date(rawValue).toISOString() };
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

		const before = typeof req.query.before === 'string' && req.query.before.trim()
			? req.query.before.trim()
			: undefined;
		if (before && !alertStorageService.parseAlertPaginationCursor(before)) {
			return res.status(400).json({
				error: alertStorageService.INVALID_CURSOR_MESSAGE,
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

function summarizeAlerts(req, res) {
	return handleAsync(req, res, '/api/alerts/summary', async () => {
		if (!alertStorageService.isEnabled()) {
			return res.status(403).json({
				error: 'Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseSummaryLimit(req.query.limit);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_SUMMARY_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return res.status(400).json(from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return res.status(400).json(to.error);
		}

		const summary = await alertStorageService.summarizeAlerts({
			from: from.value,
			limit,
			to: to.value,
		});

		return res.status(200).json({
			success: true,
			summary,
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

function parseReplayChannels(rawChannels) {
	if (rawChannels === undefined) {
		return VALID_CHANNELS;
	}

	if (!Array.isArray(rawChannels) || rawChannels.length === 0) {
		return null;
	}

	const channels = rawChannels
		.filter(channel => typeof channel === 'string')
		.map(channel => channel.trim().toLowerCase())
		.filter(Boolean);
	const uniqueChannels = Array.from(new Set(channels));
	if (uniqueChannels.length !== rawChannels.length) {
		return null;
	}

	return uniqueChannels;
}

function getIdempotencyKey(req) {
	return req.headers['idempotency-key']
		|| (req.body && (req.body.idempotencyKey || req.body.idempotency_key))
		|| (req.query && (req.query.idempotencyKey || req.query.idempotency_key));
}

function replayAlert(botOrGetter) {
	return function handleReplayAlert(req, res) {
		return handleAsync(req, res, `/api/alerts/${req.params.alertId}/replay`, async () => {
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

			const idempotencyKey = getIdempotencyKey(req);
			if (!idempotencyKey || typeof idempotencyKey !== 'string' || !idempotencyKey.trim()) {
				return res.status(400).json({
					error: 'Replay requests require an idempotency-key header or idempotencyKey body field.',
					code: 'INVALID_REQUEST',
				});
			}

			const channels = parseReplayChannels(req.body && req.body.channels);
			if (!channels) {
				return res.status(400).json({
					error: 'channels must be a non-empty array of channel names.',
					code: 'INVALID_REQUEST',
				});
			}

			const unknownChannels = channels.filter(channel => !VALID_CHANNELS.includes(channel));
			if (unknownChannels.length > 0) {
				return res.status(400).json({
					error: `Unknown channel(s): ${unknownChannels.join(', ')}. Valid channels: ${VALID_CHANNELS.join(', ')}.`,
					code: 'INVALID_REQUEST',
				});
			}

			const storedAlert = await alertStorageService.getAlertById(alertId);
			if (!storedAlert) {
				return res.status(404).json({
					error: 'Alert not found',
					code: 'NOT_FOUND',
				});
			}

			const { getNotificationManager, initializeNotificationServices } = require('../webhooks/handlers/alert/alert');
			let notificationManager = getNotificationManager();
			if (!notificationManager) {
				const bot = typeof botOrGetter === 'function' ? botOrGetter() : botOrGetter || null;
				notificationManager = await initializeNotificationServices(bot);
			}

			const replayPayload = {
				text: storedAlert.text,
				enriched: storedAlert.enrichmentData || undefined,
				replay: {
					originalAlertId: alertId,
					idempotencyKey: idempotencyKey.trim(),
				},
			};
			const results = await notificationManager.sendToChannels(replayPayload, channels);
			const replayId = await alertStorageService.saveReplayAttempt({
				alertId,
				idempotencyKey: idempotencyKey.trim(),
				channels,
				deliveryResults: results,
			});

			return res.status(200).json({
				success: true,
				alertId,
				replayId,
				results,
			});
		});
	};
}

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		console.error('[AlertsController] Request failed:', error.message);
		const statusCode = error.code === alertStorageService.STORAGE_UNAVAILABLE_CODE
			? 503
			: (error.code === 'INVALID_REQUEST' ? 400 : 500);
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

		if (statusCode === 400) {
			return res.status(400).json({
				error: error.message,
				code: 'INVALID_REQUEST',
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
	replayAlert,
	summarizeAlerts,
};
