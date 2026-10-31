'use strict';

const {
	alertSubscriberService,
	AlertSubscriberValidationError,
} = require('../../services/subscribers/AlertSubscriberService');
const { alertSubscriberDeliveryService } = require('../../services/subscribers/AlertSubscriberDeliveryService');
const sentryService = require('../../services/monitoring/SentryService');
const { sendErrorFrom } = require('../../lib/errorEnvelope');

function getStorageMetadata() {
	return alertSubscriberService.getStorageStatus();
}

async function listSubscribers(req, res) {
	try {
		const subscribers = await alertSubscriberService.listSubscribers();
		return res.status(200).json({
			success: true,
			storage: getStorageMetadata(),
			subscribers,
		});
	} catch (error) {
		console.error('[AlertSubscribers] List failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'alert-subscribers',
			error,
			http: { endpoint: '/api/alert-subscribers', method: 'GET', statusCode: 500 },
		});
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function postSubscriber(req, res) {
	try {
		const subscriber = await alertSubscriberService.createSubscriber(req.body || {});
		return res.status(201).json({
			success: true,
			storage: getStorageMetadata(),
			subscriber,
		});
	} catch (error) {
		if (error instanceof AlertSubscriberValidationError) {
			return sendErrorFrom(res, 400, {
				error: error.message,
				code: error.code || 'INVALID_REQUEST',
				details: error.details,
			});
		}
		console.error('[AlertSubscribers] Create failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'alert-subscribers',
			error,
			http: { endpoint: '/api/alert-subscribers', method: 'POST', statusCode: 500 },
		});
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function getSubscriber(req, res) {
	try {
		const subscriber = await alertSubscriberService.getSubscriber(req.params.id);
		if (!subscriber) {
			return sendErrorFrom(res, 404, {
				error: 'Subscriber not found',
				code: 'NOT_FOUND',
				storage: getStorageMetadata(),
			});
		}
		return res.status(200).json({
			success: true,
			storage: getStorageMetadata(),
			subscriber,
		});
	} catch (error) {
		console.error('[AlertSubscribers] Get failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'alert-subscribers',
			error,
			http: { endpoint: `/api/alert-subscribers/${req.params.id}`, method: 'GET', statusCode: 500 },
		});
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function updateSubscriber(req, res) {
	try {
		const subscriber = await alertSubscriberService.updateSubscriber(req.params.id, req.body || {});
		if (!subscriber) {
			return sendErrorFrom(res, 404, {
				error: 'Subscriber not found',
				code: 'NOT_FOUND',
				storage: getStorageMetadata(),
			});
		}
		return res.status(200).json({
			success: true,
			storage: getStorageMetadata(),
			subscriber,
		});
	} catch (error) {
		if (error instanceof AlertSubscriberValidationError) {
			return sendErrorFrom(res, 400, {
				error: error.message,
				code: error.code || 'INVALID_REQUEST',
				details: error.details,
			});
		}
		console.error('[AlertSubscribers] Update failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'alert-subscribers',
			error,
			http: { endpoint: `/api/alert-subscribers/${req.params.id}`, method: req.method, statusCode: 500 },
		});
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function deleteSubscriber(req, res) {
	try {
		const deleted = await alertSubscriberService.deleteSubscriber(req.params.id);
		if (!deleted) {
			return sendErrorFrom(res, 404, {
				error: 'Subscriber not found',
				code: 'NOT_FOUND',
				storage: getStorageMetadata(),
			});
		}
		return res.status(200).json({
			success: true,
			storage: getStorageMetadata(),
		});
	} catch (error) {
		console.error('[AlertSubscribers] Delete failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'alert-subscribers',
			error,
			http: { endpoint: `/api/alert-subscribers/${req.params.id}`, method: 'DELETE', statusCode: 500 },
		});
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

async function testSubscriber(req, res) {
	try {
		const subscriber = await alertSubscriberService.getSubscriber(req.params.id, { includeSecret: true });
		if (!subscriber) {
			return sendErrorFrom(res, 404, {
				error: 'Subscriber not found',
				code: 'NOT_FOUND',
			});
		}

		const delivery = await alertSubscriberDeliveryService.sendTestNotification(subscriber);
		return res.status(200).json({
			success: true,
			delivery,
		});
	} catch (error) {
		console.error('[AlertSubscribers] Test ping failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'alert-subscribers',
			error,
			http: { endpoint: `/api/alert-subscribers/${req.params.id}/test`, method: 'POST', statusCode: 500 },
		});
		return sendErrorFrom(res, 500, {
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

module.exports = {
	listSubscribers,
	postSubscriber,
	getSubscriber,
	updateSubscriber,
	deleteSubscriber,
	testSubscriber,
};
