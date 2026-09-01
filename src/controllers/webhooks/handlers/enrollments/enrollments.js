'use strict';

const chatEnrollmentsService = require('../../../../services/enrollments/ChatEnrollmentsService');
const { ADMIN_OPERATOR } = require('../../../../lib/adminAuth');

const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';
const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED';
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function resolveLimit(rawLimit) {
	if (rawLimit === undefined || rawLimit === null || rawLimit === '') {
		return DEFAULT_LIMIT;
	}
	const parsed = Number(String(rawLimit).trim());
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 1) {
		return null;
	}
	if (parsed > MAX_LIMIT) return MAX_LIMIT;
	return parsed;
}

async function listEnrollments(req, res) {
	try {
		if (!chatEnrollmentsService.isEnabled()) {
			return res.status(403).json({
				error: 'Chat enrollments are disabled. Set ENABLE_CHAT_ENROLLMENTS=true to enable.',
				code: FEATURE_DISABLED_CODE,
			});
		}

		const limit = resolveLimit(req.query && req.query.limit);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		const adminRole = req && req.adminRole;
		const includeChatIds = adminRole === ADMIN_OPERATOR
			&& req.query
			&& req.query.includeChatIds === 'true';

		let payload;
		try {
			payload = await chatEnrollmentsService.getSummary({ includeChatIds, limit });
		} catch (error) {
			console.error('[enrollments] getSummary failed:', error.message);
			return res.status(503).json({
				error: 'Chat enrollment storage is unavailable.',
				code: STORAGE_UNAVAILABLE_CODE,
			});
		}

		if (!payload) {
			return res.status(503).json({
				error: 'Chat enrollment storage is unavailable.',
				code: STORAGE_UNAVAILABLE_CODE,
			});
		}
		return res.status(200).json(payload);
	} catch (error) {
		console.error('[enrollments] listEnrollments failed:', error.message);
		return res.status(503).json({
			error: 'Chat enrollment storage is unavailable.',
			code: STORAGE_UNAVAILABLE_CODE,
		});
	}
}

module.exports = {
	listEnrollments,
	STORAGE_UNAVAILABLE_CODE,
	FEATURE_DISABLED_CODE,
	MAX_LIMIT,
	DEFAULT_LIMIT,
};
