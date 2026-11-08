'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const signalOutcomeService = require('../../services/storage/SignalOutcomeService');
const alertAcknowledgementService = require('../../services/storage/AlertAcknowledgementService');
const { parseAlertPaginationCursor } = require('../../services/storage/alertPaginationCursor');
const { sendErrorFrom, STANDARD_ERROR_CODES } = require('../../lib/errorEnvelope');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_CALIBRATION_LIMIT = 1000;
const MAX_CALIBRATION_LIMIT = 1000;
const DEFAULT_EXPORT_LIMIT = 100;
const MAX_EXPORT_LIMIT = 1000;
const MAX_EXPORT_WINDOW_DAYS = 31;
const MAX_EXPORT_WINDOW_MS = MAX_EXPORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
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
const VALID_TREND_WINDOWS = {
	'1h': '1h',
	'4h': '4h',
	'1d': '1D',
	'1D': '1D',
	'1w': '1W',
	'1W': '1W',
};
const VALID_WINDOWS = {
	'1m': '1m',
	'5m': '5m',
	'15m': '15m',
	'30m': '30m',
	'1h': '1h',
	'4h': '4h',
	'1d': '1D',
	'1w': '1W',
	'1M': '1M',
};

function parseLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_LIMIT;
	}

	if (typeof rawLimit !== 'string' && typeof rawLimit !== 'number') {
		return null;
	}

	const str = String(rawLimit).trim();
	if (!/^\d+$/.test(str)) {
		return null;
	}

	const limit = Number.parseInt(str, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
		return null;
	}

	return limit;
}

function parseCalibrationLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_CALIBRATION_LIMIT;
	}

	if (typeof rawLimit !== 'string' && typeof rawLimit !== 'number') {
		return null;
	}

	const str = String(rawLimit).trim();
	if (!/^\d+$/.test(str)) {
		return null;
	}

	const limit = Number.parseInt(str, 10);
	if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CALIBRATION_LIMIT) {
		return null;
	}

	return limit;
}

function parseExportLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_EXPORT_LIMIT;
	}
	if ((typeof rawLimit !== 'string' && typeof rawLimit !== 'number') || !/^\d+$/.test(String(rawLimit).trim())) {
		return null;
	}
	const limit = Number.parseInt(String(rawLimit).trim(), 10);
	return Number.isInteger(limit) && limit >= 1 && limit <= MAX_EXPORT_LIMIT ? limit : null;
}

function parseExportFormat(rawFormat) {
	const format = rawFormat === undefined ? 'jsonl' : String(rawFormat).trim().toLowerCase();
	return ['jsonl', 'csv'].includes(format) ? format : null;
}

function parseOptionalSetupType(rawSetupType) {
	if (typeof rawSetupType !== 'string') return undefined;
	return rawSetupType.trim() || undefined;
}

function escapeCsvValue(value) {
	if (value === null || value === undefined) return '';
	const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
	const safeSerialized = typeof value === 'string'
		&& /^[\t\r\n]*[=+\-@＝＋－＠]/u.test(value)
		&& !Number.isFinite(Number(value))
		? `'${serialized}`
		: serialized;
	return /[",\n\r]/.test(safeSerialized)
		? `"${safeSerialized.replace(/"/g, '""')}"`
		: safeSerialized;
}

function buildOutcomeCsv(outcomes) {
	const rows = outcomes.map((outcome) => OUTCOME_EXPORT_FIELDS
		.map((field) => escapeCsvValue(outcome[field]))
		.join(','));
	return [OUTCOME_EXPORT_FIELDS.join(','), ...rows].join('\n');
}

function validateExportWindow(from, to) {
	if (new Date(from).getTime() > new Date(to).getTime()) {
		return { error: 'Invalid time window. from must be before or equal to to.', code: 'INVALID_REQUEST' };
	}
	if (new Date(to).getTime() - new Date(from).getTime() > MAX_EXPORT_WINDOW_MS) {
		return {
			error: `Invalid export window. Maximum export window is ${MAX_EXPORT_WINDOW_DAYS} days.`,
			code: 'INVALID_REQUEST',
		};
	}
	return null;
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
	if (rawWindow.trim() === '1M') {
		return '1M';
	}
	return VALID_WINDOWS[win] || null;
}

function parseBreakdown(rawBreakdown) {
	if (rawBreakdown === undefined) {
		return undefined;
	}
	if (typeof rawBreakdown !== 'string') {
		return null;
	}
	const values = rawBreakdown.split(',').map((value) => value.trim().toLowerCase());
	if (values.some((value) => value !== 'symbol' && value !== 'setup')) {
		return null;
	}
	return [...new Set(values)];
}

function parseAcknowledgementsFlag(rawValue) {
	if (rawValue === undefined) {
		return false;
	}
	if (typeof rawValue !== 'string') {
		return null;
	}
	const normalized = rawValue.trim().toLowerCase();
	if (normalized === 'true') {
		return true;
	}
	if (normalized === 'false') {
		return false;
	}
	return null;
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

function listOutcomes(req, res) {
	return handleAsync(req, res, '/api/outcomes', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return sendErrorFrom(res, 403, {
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseLimit(req.query.limit);
		if (limit === null) {
			return sendErrorFrom(res, 400, {
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const before = typeof req.query.before === 'string' && req.query.before.trim()
			? req.query.before.trim()
			: undefined;
		if (before && !parseAlertPaginationCursor(before)) {
			return sendErrorFrom(res, 400, {
				error: signalOutcomeService.INVALID_CURSOR_MESSAGE,
				code: 'INVALID_REQUEST',
			});
		}

		const status = parseStatus(req.query.status);
		if (status === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			});
		}

		const window = parseWindow(req.query.window);
		if (window === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid window filter. Use 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, or 1M.',
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return sendErrorFrom(res, 400, from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return sendErrorFrom(res, 400, to.error);
		}

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return sendErrorFrom(res, 400, {
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
			return sendErrorFrom(res, 403, {
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseLimit(req.query.limit);
		if (limit === null) {
			return sendErrorFrom(res, 400, {
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const status = parseStatus(req.query.status);
		if (status === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid status filter. Use pending, evaluated, or unavailable.',
				code: 'INVALID_REQUEST',
			});
		}

		const window = parseWindow(req.query.window);
		if (window === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid window filter. Use 1m, 5m, 15m, 30m, 1h, 4h, 1D, 1W, or 1M.',
				code: 'INVALID_REQUEST',
			});
		}

		const breakdown = parseBreakdown(req.query.breakdown);
		if (breakdown === null) {
			return res.status(400).json({
				error: 'Invalid breakdown parameter. Allowed values: symbol, setup.',
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return sendErrorFrom(res, 400, from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return sendErrorFrom(res, 400, to.error);
		}

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return sendErrorFrom(res, 400, {
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

		let setupType;
		if (req.query.setupType !== undefined) {
			if (typeof req.query.setupType !== 'string' || !req.query.setupType.trim()) {
				return res.status(400).json({
					error: 'Invalid setupType parameter. Use a single non-empty value.',
					code: 'INVALID_REQUEST',
				});
			}
			setupType = req.query.setupType.trim();
		}

		const includeAcknowledgments = parseAcknowledgementsFlag(req.query.includeAcknowledgments);
		if (includeAcknowledgments === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid includeAcknowledgments flag. Use true or false.',
				code: 'INVALID_REQUEST',
			});
		}

		const summaryParams = {
			limit,
			symbol,
			exchange,
			...(setupType !== undefined ? { setupType } : {}),
			...(breakdown !== undefined ? { breakdown } : {}),
			status,
			window,
			from: from.value,
			to: to.value,
		};
		const summary = await signalOutcomeService.summarizeOutcomes(summaryParams);

		if (includeAcknowledgments === true) {
			try {
				if (alertAcknowledgementService.isEnabled()) {
					const ackSummary = await alertAcknowledgementService.summarizeAcknowledgements({
						symbol,
						exchange,
						from: from.value,
						to: to.value,
						limit: 1000,
					});
					summary.acknowledgementBreakdown = {
						total: ackSummary.total,
						breakdown: ackSummary.breakdown,
						bySymbol: ackSummary.bySymbol,
						byExchange: ackSummary.byExchange,
						storage: ackSummary.storage,
						window: ackSummary.window,
					};
				} else {
					summary.acknowledgementBreakdown = {
						total: 0,
						breakdown: {
							took_trade: 0,
							skipped: 0,
							no_trade_no_signal: 0,
							snoozed: 0,
						},
						bySymbol: {},
						byExchange: {},
						storage: 'memory',
						window: { from: null, to: null, limit: null },
					};
				}
			} catch (ackError) {
				console.warn('[OutcomesController] Failed to read acknowledgement breakdown:', ackError.message);
				summary.acknowledgementBreakdown = {
					total: 0,
					breakdown: {
						took_trade: 0,
						skipped: 0,
						no_trade_no_signal: 0,
						snoozed: 0,
					},
					bySymbol: {},
					byExchange: {},
					storage: 'memory',
					window: { from: null, to: null, limit: null },
				};
			}
		}

		return res.status(200).json({
			success: true,
			summary,
		});
	});
}

function getOutcomeById(req, res) {
	return handleAsync(req, res, `/api/outcomes/${req.params.outcomeId}`, async () => {
		if (!signalOutcomeService.isEnabled()) {
			return sendErrorFrom(res, 403, {
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}
		const outcomeId = typeof req.params.outcomeId === 'string' ? req.params.outcomeId.trim() : '';
		if (!outcomeId) {
			return sendErrorFrom(res, 400, { error: 'Missing outcomeId parameter', code: 'INVALID_REQUEST' });
		}
		const outcome = await signalOutcomeService.getOutcomeById(outcomeId);
		if (!outcome) return sendErrorFrom(res, 404, { error: 'Outcome not found', code: 'NOT_FOUND' });
		return res.status(200).json({ success: true, outcome });
	});
}

function exportOutcomes(req, res) {
	return handleAsync(req, res, '/api/outcomes/export', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return sendErrorFrom(res, 403, {
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}
		const format = parseExportFormat(req.query.format);
		if (!format) return sendErrorFrom(res, 400, { error: 'Invalid export format. Use jsonl or csv.', code: 'INVALID_REQUEST' });
		const limit = parseExportLimit(req.query.limit);
		if (limit === null) {
			return sendErrorFrom(res, 400, {
				error: `Invalid limit. Use an integer between 1 and ${MAX_EXPORT_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}
		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) return sendErrorFrom(res, 400, from.error);
		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) return sendErrorFrom(res, 400, to.error);
		if (!from.value || !to.value) {
			return sendErrorFrom(res, 400, {
				error: 'Export requests require bounded from and to ISO-8601 timestamps.',
				code: 'INVALID_REQUEST',
			});
		}
		const windowError = validateExportWindow(from.value, to.value);
		if (windowError) return sendErrorFrom(res, 400, windowError);
		const symbol = typeof req.query.symbol === 'string' && req.query.symbol.trim() ? req.query.symbol.trim() : undefined;
		const exchange = typeof req.query.exchange === 'string' && req.query.exchange.trim() ? req.query.exchange.trim() : undefined;
		const setupType = parseOptionalSetupType(req.query.setupType);
		if (req.query.setupType !== undefined && setupType === undefined) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid setupType parameter. Use a single non-empty value.',
				code: 'INVALID_REQUEST',
			});
		}
		const result = await signalOutcomeService.exportOutcomes({
			from: from.value,
			to: to.value,
			limit,
			symbol,
			exchange,
			setupType,
			signal: req.requestDeadlineSignal,
		});
		const extension = format === 'csv' ? 'csv' : 'jsonl';
		res.set('Content-Disposition', `attachment; filename="outcomes-${result.window.from.substring(0, 10)}-${result.window.to.substring(0, 10)}.${extension}"`);
		if (format === 'csv') {
			res.type('text/csv; charset=utf-8');
			return res.status(200).send(`${buildOutcomeCsv(result.outcomes)}\n`);
		}
		res.type('application/x-ndjson; charset=utf-8');
		const body = result.outcomes.map((outcome) => JSON.stringify(outcome)).join('\n');
		return res.status(200).send(body ? `${body}\n` : '');
	});
}

function getOutcomesCalibration(req, res) {
	return handleAsync(req, res, '/api/outcomes/calibration', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return sendErrorFrom(res, 403, {
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const limit = parseCalibrationLimit(req.query.limit);
		if (limit === null) {
			return sendErrorFrom(res, 400, {
				error: `Invalid limit. Use an integer between 1 and ${MAX_CALIBRATION_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const window = parseWindow(req.query.window);
		if (window === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return sendErrorFrom(res, 400, from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return sendErrorFrom(res, 400, to.error);
		}

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return sendErrorFrom(res, 400, {
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

		const calibration = await signalOutcomeService.getOutcomesCalibration({
			limit,
			symbol,
			exchange,
			window,
			from: from.value,
			to: to.value,
			signal: req.requestDeadlineSignal,
		});

		return res.status(200).json({
			success: true,
			calibration,
		});
	});
}

function parseTrendWindow(rawWindow) {
	if (rawWindow === undefined || (typeof rawWindow === 'string' && rawWindow.trim() === '')) return '1D';
	if (typeof rawWindow !== 'string') return null;
	const trimmed = rawWindow.trim();
	return VALID_TREND_WINDOWS[trimmed] || null;
}

function getOutcomesTrend(req, res) {
	return handleAsync(req, res, '/api/outcomes/trend', async () => {
		if (!signalOutcomeService.isEnabled()) {
			return sendErrorFrom(res, 403, {
				error: 'Signal outcome tracking feature is disabled. Set ENABLE_SIGNAL_OUTCOME_TRACKING=true to enable.',
				code: 'FEATURE_DISABLED',
			});
		}

		const window = parseTrendWindow(req.query.window);
		if (window === null) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid window filter. Use 1h, 4h, 1D, or 1W.',
				code: 'INVALID_REQUEST',
			});
		}

		const from = parseOptionalTimestamp(req.query.from, 'from');
		if (from.error) {
			return sendErrorFrom(res, 400, from.error);
		}

		const to = parseOptionalTimestamp(req.query.to, 'to');
		if (to.error) {
			return sendErrorFrom(res, 400, to.error);
		}

		if (from.value && to.value && new Date(from.value) > new Date(to.value)) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid time window. from must be before or equal to to.',
				code: 'INVALID_REQUEST',
			});
		}

		const bucket = typeof req.query.bucket === 'string' && req.query.bucket.trim()
			? req.query.bucket.trim()
			: 'all';

		const trend = await signalOutcomeService.getOutcomesTrend({
			window,
			from: from.value,
			to: to.value,
			bucket,
		});

		return res.status(200).json(trend);
	});
}

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
		if (error.code === 'ABORTED' && req.requestDeadlineSignal?.aborted) return undefined;
		console.error('[OutcomesController] Request failed:', error.message);
		const statusCode = error.statusCode || error.status || (error.code === signalOutcomeService.STORAGE_UNAVAILABLE_CODE ? 503 : (error.code === 'INVALID_REQUEST' ? 400 : 500));
		sentryService.captureRuntimeError({
			channel: 'outcomes-controller',
			error,
			http: {
				endpoint,
				method: req.method,
				statusCode,
			},
		});
		return handleError(error, req, res, endpoint);
	});
}

function handleError(error, req, res, route) {
	if (error.code === signalOutcomeService.STORAGE_UNAVAILABLE_CODE) {
		return sendErrorFrom(res, 503, {
			error: error.message,
			code: signalOutcomeService.STORAGE_UNAVAILABLE_CODE,
		});
	}

	if (error.message === signalOutcomeService.INVALID_CURSOR_MESSAGE) {
		return sendErrorFrom(res, 400, {
			error: error.message,
			code: 'INVALID_REQUEST',
		});
	}

	const statusCode = error.statusCode || error.status;
	if (statusCode === 404) {
		return sendErrorFrom(res, 404, {
			error: error.message,
			code: 'NOT_FOUND',
		});
	}

	if (statusCode === 400 || error.code === 'INVALID_REQUEST') {
		return sendErrorFrom(res, 400, {
			error: error.message,
			code: 'INVALID_REQUEST',
		});
	}

	return sendErrorFrom(res, 500, {
		error: 'Internal server error',
		code: 'INTERNAL_ERROR',
	});
}

module.exports = {
	listOutcomes,
	summarizeOutcomes,
	getOutcomesCalibration,
	getOutcomesTrend,
	getOutcomeById,
	exportOutcomes,
	parseLimit,
	parseCalibrationLimit,
	parseExportFormat,
	parseExportLimit,
	parseOptionalSetupType,
	buildOutcomeCsv,
	escapeCsvValue,
	OUTCOME_EXPORT_FIELDS,
	DEFAULT_EXPORT_LIMIT,
	MAX_EXPORT_LIMIT,
	parseStatus,
	parseWindow,
	parseTrendWindow,
	parseOptionalTimestamp,
};
