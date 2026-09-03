'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const signalOutcomeService = require('../../services/storage/SignalOutcomeService');
const { parseAlertPaginationCursor } = require('../../services/storage/alertPaginationCursor');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 1000;
const OUTCOME_EXPORT_FIELDS = [
	'id',
	'receivedAt',
	'source',
	'symbol',
	'exchange',
	'side',
	'price',
	'setupType',
	'score',
	'outcomes',
];
const VALID_STATUSES = new Set(['pending', 'evaluated', 'unavailable']);
const VALID_WINDOWS = {
	'1h': '1h',
	'4h': '4h',
	'1d': '1D',
	'1w': '1W',
};

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

function parseExportFormat(rawFormat) {
	const format = rawFormat === undefined ? 'jsonl' : String(rawFormat).trim().toLowerCase();
	return ['jsonl', 'csv'].includes(format) ? format : null;
}

function parseOptionalSetupType(rawSetupType) {
	if (typeof rawSetupType !== 'string') {
		return undefined;
	}
	const trimmed = rawSetupType.trim();
	return trimmed || undefined;
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

function buildOutcomeCsv(outcomes) {
	const rows = outcomes.map((outcome) => OUTCOME_EXPORT_FIELDS
		.map((field) => escapeCsvValue(outcome[field]))
		.join(','));
	return [OUTCOME_EXPORT_FIELDS.join(','), ...rows].join('\n');
}

function parseStatus(rawStatus) {
	if (rawStatus === undefined) {
		return undefined;
	}

	if (typeof rawStatus !== 'string') {
		return null;
	}

	const status = rawStatus.trim().toLowerCase();
	return VALID_STATUSES.has(status) ? status : null;
}

function parseWindow(rawWindow) {
	if (rawWindow === undefined) {
		return undefined;
	}

	if (typeof rawWindow !== 'string') {
		return null;
	}

	const win = rawWindow.trim().toLowerCase();
	return VALID_WINDOWS[win] || null;
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

const MAX_EXPORT_WINDOW_DAYS = 31;
const MAX_EXPORT_WINDOW_MS = MAX_EXPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;

function validateExportWindow(fromValue, toValue) {
	if (!fromValue || !toValue) {
		return null;
	}
	const parsedFrom = new Date(fromValue);
	const parsedTo = new Date(toValue);
	if (Number.isNaN(parsedFrom.getTime()) || Number.isNaN(parsedTo.getTime())) {
		return null;
	}
	if (parsedFrom.getTime() > parsedTo.getTime()) {
		return {
			error: 'Invalid time window. from must be before or equal to to.',
			code: 'INVALID_REQUEST',
		};
	}
	if (parsedTo.getTime() - parsedFrom.getTime() > MAX_EXPORT_WINDOW_MS) {
		return {
			error: `Invalid export window. Maximum export window is ${MAX_EXPORT_WINDOW_DAYS} days.`,
			code: 'INVALID_REQUEST',
		};
	}
	return null;
}

function listOutcomes(req, res) {
	return handleAsync(req, res, '/api/outcomes', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return res.status(403).json({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
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
		if (before && !parseAlertPaginationCursor(before)) {
			return res.status(400).json({
				error: signalOutcomeService.INVALID_CURSOR_MESSAGE,
				code: 'INVALID_REQUEST',
			});
		}

		const status = parseStatus(req.query.status);
		if (status === null) {
			return res.status(400).json({
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			});
		}

		const window = parseWindow(req.query.window);
		if (window === null) {
			return res.status(400).json({
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
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

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return res.status(400).json({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		}

		const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim()
			? req.query.symbol.trim()
			: undefined;

		const exchange = typeof req.query.exchange === 'string' && req.query.exchange.trim()
			? req.query.exchange.trim()
			: undefined;

		const result = await signalOutcomeService.listOutcomes({
			before,
			limit,
			symbol,
			exchange,
			status,
			window,
			from: from.value,
			to: to.value,
		});

		return res.status(200).json({
			success: true,
			outcomes: result.outcomes,
			pagination: {
				hasMore: result.hasMore,
				limit,
				nextBefore: result.nextBefore,
			},
		});
	});
}

function summarizeOutcomes(req, res) {
	return handleAsync(req, res, '/api/outcomes/summary', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return res.status(403).json({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
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

		const status = parseStatus(req.query.status);
		if (status === null) {
			return res.status(400).json({
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			});
		}

		const window = parseWindow(req.query.window);
		if (window === null) {
			return res.status(400).json({
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
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

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return res.status(400).json({
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		}

		const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim()
			? req.query.symbol.trim()
			: undefined;

		const exchange = typeof req.query.exchange === 'string' && req.query.exchange.trim()
			? req.query.exchange.trim()
			: undefined;

		const summary = await signalOutcomeService.summarizeOutcomes({
			limit,
			symbol,
			exchange,
			status,
			window,
			from: from.value,
			to: to.value,
		});

		return res.status(200).json({
			success: true,
			summary,
		});
	});
}

function getOutcomeById(req, res) {
	return handleAsync(req, res, `/api/outcomes/${req.params.outcomeId}`, async () => {
		if (!signalOutcomeService.isEnabled()) {
			return res.status(403).json({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const { outcomeId } = req.params;
		if (!outcomeId || typeof outcomeId !== 'string' || !outcomeId.trim()) {
			return res.status(400).json({
				error: 'Missing outcomeId parameter',
				code: 'INVALID_REQUEST',
			});
		}

		const outcome = await signalOutcomeService.getOutcomeById(outcomeId.trim());
		if (!outcome) {
			return res.status(404).json({
				error: 'Outcome not found',
				code: 'NOT_FOUND',
			});
		}

		return res.status(200).json({
			success: true,
			outcome,
		});
	});
}

function exportOutcomes(req, res) {
	return handleAsync(req, res, '/api/outcomes/export', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return res.status(403).json({
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
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

		const windowError = validateExportWindow(from.value, to.value);
		if (windowError) {
			return res.status(400).json(windowError);
		}

		const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim()
			? req.query.symbol.trim()
			: undefined;

		const exchange = typeof req.query.exchange === 'string' && req.query.exchange.trim()
			? req.query.exchange.trim()
			: undefined;

		const setupType = parseOptionalSetupType(req.query.setupType);

		const result = await signalOutcomeService.exportOutcomes({
			from: from.value,
			to: to.value,
			limit,
			symbol,
			exchange,
			setupType,
		});

		const filename = `outcomes-${result.window.from.substring(0, 10)}-${result.window.to.substring(0, 10)}.${format === 'csv' ? 'csv' : 'jsonl'}`;
		res.set('Content-Disposition', `attachment; filename="${filename}"`);

		if (format === 'csv') {
			res.type('text/csv; charset=utf-8');
			return res.status(200).send(`${buildOutcomeCsv(result.outcomes)}\n`);
		}

		res.type('application/x-ndjson; charset=utf-8');
		const body = result.outcomes.map((outcome) => JSON.stringify(outcome)).join('\n');
		return res.status(200).send(body ? `${body}\n` : '');
	});
}

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		console.error('[OutcomesController] Request failed:', error.message);
		const statusCode = error.code === signalOutcomeService.STORAGE_UNAVAILABLE_CODE
			? 503
			: (error.code === 'INVALID_REQUEST' ? 400 : 500);
		sentryService.captureRuntimeError({
			channel: 'outcomes-controller',
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
				code: signalOutcomeService.STORAGE_UNAVAILABLE_CODE,
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
	listOutcomes,
	summarizeOutcomes,
	getOutcomeById,
	exportOutcomes,
	parseLimit,
	parseStatus,
	parseWindow,
	parseOptionalTimestamp,
	parseExportFormat,
	parseExportLimit,
	parseOptionalSetupType,
	buildOutcomeCsv,
	escapeCsvValue,
	OUTCOME_EXPORT_FIELDS,
	DEFAULT_EXPORT_LIMIT,
	MAX_EXPORT_LIMIT,
};
