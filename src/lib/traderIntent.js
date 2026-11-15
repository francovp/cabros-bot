'use strict';

const VALID_HORIZONS = new Set(['1h', '4h', '1D', '1W']);
const VALID_SIDES = new Set(['BUY', 'SELL']);
const ALLOWED_FIELDS = new Set(['side', 'entry', 'invalidation', 'target', 'horizon', 'notes']);
const MAX_NOTES_LENGTH = 500;

function invalid(field, message) {
	const error = new Error(`Invalid traderIntent.${field}: ${message}`);
	error.statusCode = 400;
	error.code = 'INVALID_REQUEST';
	error.response = {
		error: error.message,
		code: error.code,
		error_code: error.statusCode,
	};
	return error;
}

function readPositiveNumber(raw, field, required = false) {
	if (raw === undefined) {
		if (required) throw invalid(field, 'field is required.');
		return undefined;
	}
	if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
		throw invalid(field, 'must be a finite positive number.');
	}
	return raw;
}

function validateTraderIntent(raw) {
	if (raw === undefined) return undefined;
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		throw invalid('traderIntent', 'must be an object.');
	}

	for (const field of Object.keys(raw)) {
		if (!ALLOWED_FIELDS.has(field)) {
			throw invalid(field, 'field is not supported.');
		}
	}

	const entry = readPositiveNumber(raw.entry, 'entry', true);
	const invalidation = readPositiveNumber(raw.invalidation, 'invalidation');
	const target = readPositiveNumber(raw.target, 'target');

	if (typeof raw.horizon !== 'string' || !VALID_HORIZONS.has(raw.horizon)) {
		throw invalid('horizon', `must be one of: ${Array.from(VALID_HORIZONS).join(', ')}.`);
	}

	let side;
	if (raw.side !== undefined) {
		if (typeof raw.side !== 'string' || !VALID_SIDES.has(raw.side)) {
			throw invalid('side', 'must be BUY or SELL.');
		}
		side = raw.side;
	} else if (invalidation !== undefined || target !== undefined) {
		throw invalid('side', 'is required when invalidation or target is provided.');
	}

	if (side === 'BUY') {
		if (invalidation !== undefined && invalidation >= entry) {
			throw invalid('invalidation', 'must be less than entry for BUY.');
		}
		if (target !== undefined && target <= entry) {
			throw invalid('target', 'must be greater than entry for BUY.');
		}
	}
	if (side === 'SELL') {
		if (invalidation !== undefined && invalidation <= entry) {
			throw invalid('invalidation', 'must be greater than entry for SELL.');
		}
		if (target !== undefined && target >= entry) {
			throw invalid('target', 'must be less than entry for SELL.');
		}
	}

	let notes;
	if (raw.notes !== undefined) {
		if (typeof raw.notes !== 'string' || !raw.notes.trim() || raw.notes.trim().length > MAX_NOTES_LENGTH) {
			throw invalid('notes', `must be a non-empty string up to ${MAX_NOTES_LENGTH} characters.`);
		}
		notes = raw.notes.trim();
	}

	return {
		...(side ? { side } : {}),
		entry,
		...(invalidation !== undefined ? { invalidation } : {}),
		...(target !== undefined ? { target } : {}),
		horizon: raw.horizon,
		...(notes ? { notes } : {}),
	};
}

function isCompleteTraderIntent(intent) {
	return Boolean(
		intent
		&& VALID_SIDES.has(intent.side)
		&& typeof intent.entry === 'number'
		&& typeof intent.invalidation === 'number'
		&& typeof intent.target === 'number'
		&& VALID_HORIZONS.has(intent.horizon),
	);
}

module.exports = {
	validateTraderIntent,
	isCompleteTraderIntent,
};
