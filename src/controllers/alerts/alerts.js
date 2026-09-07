'use strict';

const alertStorageService = require('../../services/storage/AlertStorageService');
const sentryService = require('../../services/monitoring/SentryService');
const signalOutcomeService = require('../../services/storage/SignalOutcomeService');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const VALID_CHANNELS = ['telegram', 'whatsapp', 'discord'];
const DEFAULT_SUMMARY_LIMIT = 500;
const MAX_SUMMARY_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 500;
const MAX_EXPORT_LIMIT = 1000;
const EXPORT_FIELDS = [
	'id',
	'requestId',
	'receivedAt',
	'source',
	'enriched',
	'useTradingViewData',
	'tradingViewEnrichmentApplied',
	'tradingViewEnrichmentStatus',
	'eventCategory',
	'confidence',
	'sentimentScore',
	'dedupStatus',
	'channels',
	'deliveryResults',
	'suppressedRepeat',
	'tokenUsage',
	'text',
];

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

const ALLOWED_INCLUDE_VALUES = new Set(['enrichment_summary']);

function parseInclude(rawInclude) {
	if (rawInclude === undefined || rawInclude === null || rawInclude === '') {
		return { success: true, values: [] };
	}

	let items = [];
	if (Array.isArray(rawInclude)) {
		items = rawInclude.flatMap((item) => (typeof item === 'string' ? item.split(',') : []));
	} else if (typeof rawInclude === 'string') {
		items = rawInclude.split(',');
	} else {
		return {
			success: false,
			error: 'Invalid include parameter. Allowed values: enrichment_summary.',
		};
	}

	const normalized = [];
	for (const item of items) {
		const trimmed = item.trim();
		if (!trimmed) {
			continue;
		}
		if (!ALLOWED_INCLUDE_VALUES.has(trimmed)) {
			return {
				success: false,
				error: `Invalid include parameter '${trimmed}'. Allowed values: enrichment_summary.`,
			};
		}
		normalized.push(trimmed);
	}

	return { success: true, values: Array.from(new Set(normalized)) };
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

function parseExportLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_EXPORT_LIMIT;
	}

	const limit = Number.parseInt(rawLimit, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EXPORT_LIMIT) {
		return null;
	}

	return limit;
}

function parseBooleanFlag(rawValue, defaultValue = false) {
	if (rawValue === undefined) {
		return defaultValue;
	}

	if (rawValue === 'true' || rawValue === true) {
		return true;
	}

	if (rawValue === 'false' || rawValue === false) {
		return false;
	}

	return null;
}

function parseExportFormat(rawFormat) {
	const format = rawFormat === undefined ? 'jsonl' : String(rawFormat).trim().toLowerCase();
	return ['jsonl', 'csv'].includes(format) ? format : null;
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

		const parsedInclude = parseInclude(req.query.include);
		if (!parsedInclude.success) {
			return res.status(400).json({
				error: parsedInclude.error,
				code: 'INVALID_REQUEST',
			});
		}

		const listParams = {
			before,
			enriched,
			limit,
			source,
		};
		if (parsedInclude.values.length > 0) {
			listParams.include = parsedInclude.values;
			listParams.includeEnrichmentSummary = parsedInclude.values.includes('enrichment_summary');
		}

		const result = await alertStorageService.listAlerts(listParams);

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

		const summary = await alertStorageService.summarizeAlerts({
			from: from.value,
			limit,
			to: to.value,
			source,
			enriched,
		});

		const hasReportFilters = Boolean(source) || typeof enriched === 'boolean';
		if (!hasReportFilters) {
			let shadowModeMetrics = 'No measurements found';
			if (signalOutcomeService.isEnabled()) {
				shadowModeMetrics = await signalOutcomeService.getMetricsSummary({
					from: from.value,
					to: to.value,
					limit,
				});
			}
			summary.shadowModeMetrics = shadowModeMetrics;
		}

		return res.status(200).json({
			success: true,
			summary,
		});
	});
}

function escapeCsvValue(value) {
	if (value === null || value === undefined) {
		return '';
	}

	const serialized = typeof value === 'object'
		? JSON.stringify(value)
		: String(value);
	const safeSerialized = typeof value === 'string'
		&& /^[\t\r\n]*[=+\-@]/.test(value)
		&& !Number.isFinite(Number(value))
		? `'${serialized}`
		: serialized;

	if (/[",\n\r]/.test(safeSerialized)) {
		return `"${safeSerialized.replace(/"/g, '""')}"`;
	}

	return safeSerialized;
}

function buildCsv(alerts, includeText) {
	const fields = includeText
		? EXPORT_FIELDS
		: EXPORT_FIELDS.filter(field => field !== 'text');
	const rows = alerts.map(alert => fields.map(field => escapeCsvValue(alert[field])).join(','));
	return [fields.join(','), ...rows].join('\n');
}

function exportAlerts(req, res) {
	return handleAsync(req, res, '/api/alerts/export', async () => {
		if (!alertStorageService.isEnabled()) {
			return res.status(403).json({
				error: 'Alert storage feature is disabled. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const format = parseExportFormat(req.query.format);
		if (!format) {
			return res.status(400).json({
				error: 'Invalid export format. Use jsonl or csv.',
				code: 'INVALID_REQUEST',
			});
		}

		const limit = parseExportLimit(req.query.limit);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_EXPORT_LIMIT}.`,
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

		if (!from.value || !to.value) {
			return res.status(400).json({
				error: 'Export requests require bounded from and to ISO-8601 timestamps.',
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

		const includeText = parseBooleanFlag(req.query.includeText, false);
		if (includeText === null) {
			return res.status(400).json({
				error: 'Invalid includeText flag. Use true or false.',
				code: 'INVALID_REQUEST',
			});
		}

		const source = typeof req.query.source === 'string' && req.query.source.trim()
			? req.query.source.trim()
			: undefined;

		const result = await alertStorageService.exportAlerts({
			from: from.value,
			to: to.value,
			limit,
			source,
			enriched,
			includeText,
		});

		const hasReportFilters = Boolean(source) || typeof enriched === 'boolean';
		if (!hasReportFilters) {
			let shadowModeMetrics = 'No measurements found';
			if (signalOutcomeService.isEnabled()) {
				shadowModeMetrics = await signalOutcomeService.getMetricsSummary({
					from: from.value,
					to: to.value,
					limit,
				});
			}
			res.set('X-Shadow-Mode-Metrics', JSON.stringify(shadowModeMetrics));
		}

		const filename = `alerts-${from.value.substring(0, 10)}-${to.value.substring(0, 10)}.${format === 'csv' ? 'csv' : 'jsonl'}`;
		res.set('Content-Disposition', `attachment; filename="${filename}"`);

		if (format === 'csv') {
			res.type('text/csv; charset=utf-8');
			return res.status(200).send(`${buildCsv(result.alerts, includeText)}\n`);
		}

		res.type('application/x-ndjson; charset=utf-8');
		const body = result.alerts.map(alert => JSON.stringify(alert)).join('\n');
		return res.status(200).send(body ? `${body}\n` : '');
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

		let lastReplay = null;
		try {
			lastReplay = await alertStorageService.getLatestReplayForAlert(alertId);
		} catch (error) {
			// Storage errors are surfaced by the outer handleAsync — never block alert reads.
			if (error && error.code === alertStorageService.STORAGE_UNAVAILABLE_CODE) {
				throw error;
			}
			console.warn('[AlertsController] Failed to read last replay metadata:', error && error.message);
		}

		return res.status(200).json({
			success: true,
			alert,
			lastReplay,
		});
	});
}

function listReplays(req, res) {
	return handleAsync(req, res, '/api/alerts/replays', async () => {
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

		const alertId = typeof req.query.alertId === 'string' && req.query.alertId.trim()
			? req.query.alertId.trim()
			: undefined;

		const result = await alertStorageService.listReplayAttempts({
			limit,
			alertId,
			before,
		});

		return res.status(200).json({
			success: true,
			replays: result.replays,
			pagination: {
				hasMore: result.hasMore,
				limit,
				nextBefore: result.nextBefore,
			},
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
		|| req.headers['x-idempotency-key']
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
					error: 'Replay requests require an idempotency-key or x-idempotency-key header or idempotencyKey body field.',
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

			let storedTelegramThreadId = storedAlert.telegramThreadId;
			if (storedTelegramThreadId === undefined && Array.isArray(storedAlert.deliveryResults)) {
				const telegramResult = storedAlert.deliveryResults.find((r) => r && r.channel === 'telegram');
				if (telegramResult) {
					if (typeof telegramResult.threadId === 'number' && Number.isSafeInteger(telegramResult.threadId) && telegramResult.threadId >= 0) {
						storedTelegramThreadId = telegramResult.threadId;
					} else if (typeof telegramResult.message_thread_id === 'number' && Number.isSafeInteger(telegramResult.message_thread_id) && telegramResult.message_thread_id >= 0) {
						storedTelegramThreadId = telegramResult.message_thread_id;
					}
				}
			}

			const replayPayload = {
				text: storedAlert.text,
				enriched: storedAlert.enrichmentData || undefined,
				source: storedAlert.source || 'alert-replay',
				replay: {
					originalAlertId: alertId,
					idempotencyKey: idempotencyKey.trim(),
				},
				...(storedAlert.telegramChatId ? { telegramChatId: storedAlert.telegramChatId } : {}),
				...(storedTelegramThreadId !== undefined && storedTelegramThreadId !== null
					? { telegramThreadId: storedTelegramThreadId }
					: {}),
				...(storedAlert.whatsappChatId ? { whatsappChatId: storedAlert.whatsappChatId } : {}),
				...(storedAlert.discordWebhookUrl ? { discordWebhookUrl: storedAlert.discordWebhookUrl } : {}),
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
	listReplays,
	replayAlert,
	summarizeAlerts,
	exportAlerts,
};
