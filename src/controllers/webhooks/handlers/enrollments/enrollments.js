'use strict';

const chatEnrollmentsService = require('../../../../services/enrollments/ChatEnrollmentsService');
const { sendErrorFrom } = require('../../../../lib/errorEnvelope');
const { ADMIN_OPERATOR } = require('../../../../lib/adminAuth');

const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';
const FEATURE_DISABLED_CODE = 'FEATURE_DISABLED';
const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 200;

function resolveLimit(rawLimit) {
	if (rawLimit === undefined) {
		return DEFAULT_LIMIT;
	}
	if (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit)) return null;
	const parsed = Number(rawLimit);
	if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed) || parsed < 1) {
		return null;
	}
	if (parsed > MAX_LIMIT) return MAX_LIMIT;
	return parsed;
}

async function listEnrollments(req, res) {
	try {
		if (!chatEnrollmentsService.isEnabled()) {
			return sendErrorFrom(res, 403, {
				error: 'Chat enrollments are disabled. Set ENABLE_CHAT_ENROLLMENTS=true to enable.',
				code: FEATURE_DISABLED_CODE,
			}, { req });
		}

		const limit = resolveLimit(req.query && req.query.limit);
		if (limit === null) {
			return sendErrorFrom(res, 400, {
				error: `Invalid limit. Use an integer between 1 and ${MAX_LIMIT}.`,
				code: 'INVALID_REQUEST',
			}, { req });
		}

		const includeChatIdsQuery = req.query && req.query.includeChatIds;
		if (includeChatIdsQuery !== undefined && !['true', 'false'].includes(includeChatIdsQuery)) {
			return sendErrorFrom(res, 400, {
				error: 'Invalid includeChatIds. Use true or false.', code: 'INVALID_REQUEST',
			}, { req });
		}
		const adminRole = req && req.adminRole;
		const includeChatIds = adminRole === ADMIN_OPERATOR
			&& includeChatIdsQuery === 'true';

		let payload;
		try {
			payload = await chatEnrollmentsService.getSummary({ includeChatIds, limit });
		} catch (error) {
			console.error('[enrollments] getSummary failed:', error.message);
			return sendErrorFrom(res, 503, {
				error: 'Chat enrollment storage is unavailable.',
				code: STORAGE_UNAVAILABLE_CODE,
			}, { req });
		}

		if (!payload) {
			return sendErrorFrom(res, 503, {
				error: 'Chat enrollment storage is unavailable.',
				code: STORAGE_UNAVAILABLE_CODE,
			}, { req });
		}
		return res.status(200).json(payload);
	} catch (error) {
		console.error('[enrollments] listEnrollments failed:', error.message);
		return sendErrorFrom(res, 503, {
			error: 'Chat enrollment storage is unavailable.',
			code: STORAGE_UNAVAILABLE_CODE,
		}, { req });
	}
}

module.exports = {
	listEnrollments,
	STORAGE_UNAVAILABLE_CODE,
	FEATURE_DISABLED_CODE,
	MAX_LIMIT,
	DEFAULT_LIMIT,
};
