'use strict';

const sentryService = require('../../services/monitoring/SentryService');
const signalOutcomeService = require('../../services/storage/SignalOutcomeService');
const { parseAlertPaginationCursor } = require('../../services/storage/alertPaginationCursor');
const { sendErrorFrom, STANDARD_ERROR_CODES } = require('../../lib/errorEnvelope');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_CALIBRATION_LIMIT = 1000;
const MAX_CALIBRATION_LIMIT = 1000;
const VALID_STATUSES = new Set(['pending', 'evaluated', 'unavailable']);
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

		return res.status(200).json({
			success: true,
			summary,
		});
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

function handleAsync(req, res, endpoint, handler) {
	return Promise.resolve(handler()).catch((error) => {
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

	if (statusCode === 400) {
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
	parseLimit,
	parseCalibrationLimit,
	parseStatus,
	parseWindow,
	parseOptionalTimestamp,
};
