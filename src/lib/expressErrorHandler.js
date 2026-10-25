'use strict';

const { buildErrorEnvelope } = require('./errorEnvelope');
const Sentry = require('@sentry/node');

function resolveStatusCode(error) {
	for (const candidate of [error && error.status, error && error.statusCode]) {
		const statusCode = Number(candidate);
		if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
			return statusCode;
		}
	}
	return 500;
}

function resolveErrorDetails(error, statusCode) {
	if (statusCode >= 500) {
		return { error: 'Internal server error', code: 'INTERNAL_ERROR' };
	}
	if (error && error.type === 'entity.parse.failed') {
		return { error: 'Malformed JSON request body', code: 'INVALID_REQUEST' };
	}
	if (error && error.type === 'entity.too.large') {
		return { error: 'Request body exceeds maximum size', code: 'PAYLOAD_TOO_LARGE' };
	}
	if (error && error.type === 'parameters.too.many') {
		return { error: 'Request contains too many URL-encoded parameters', code: 'PAYLOAD_TOO_LARGE' };
	}
	return { error: 'Request could not be processed', code: 'INVALID_REQUEST' };
}

function resolveSentryEventId(value) {
	if (typeof value !== 'string' || !value.trim()) return '';
	try {
		return typeof Sentry.isEnabled === 'function' && Sentry.isEnabled() ? value.trim() : '';
	} catch (_error) {
		return '';
	}
}

function expressErrorHandler(error, req, res, next) {
	if (res.headersSent) return next(error);

	const statusCode = resolveStatusCode(error);
	const details = resolveErrorDetails(error, statusCode);
	const envelope = buildErrorEnvelope({
		...details,
		requestId: req.requestId,
		statusCode,
	});
	const sentryEventId = resolveSentryEventId(res.sentry);
	if (sentryEventId) envelope.sentryEventId = sentryEventId;

	return res.status(statusCode).json(envelope);
}

module.exports = expressErrorHandler;
