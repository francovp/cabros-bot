'use strict';

const {
	chatSubscriptionService,
	ChatSubscriptionValidationError,
} = require('../../../../services/chatSubscriptions/ChatSubscriptionService');

function handleError(res, error, fallbackStatus = 500) {
	if (error && error.name === 'ChatSubscriptionValidationError') {
		return res.status(error.statusCode || 400).json({
			error: error.message,
			code: error.code || 'INVALID_REQUEST',
		});
	}
	console.error('[chatSubscriptionsController] failed:', error && error.message);
	return res.status(fallbackStatus).json({
		error: 'Internal server error',
		code: 'INTERNAL_ERROR',
	});
}

function listChatSubscriptions(req, res) {
	const { chatId, limit } = req.query;
	if (!chatId) {
		return res.status(400).json({
			error: 'chatId query parameter is required',
			code: 'INVALID_REQUEST',
		});
	}
	const parsedLimit = limit === undefined ? 50 : Number(limit);
	if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 50) {
		return res.status(400).json({
			error: 'Invalid limit. Use an integer between 1 and 50.',
			code: 'INVALID_REQUEST',
		});
	}
	chatSubscriptionService
		.listSubscriptions({ chatId: String(chatId), limit: parsedLimit })
		.then((subscriptions) => res.json({ subscriptions, count: subscriptions.length }))
		.catch((error) => handleError(res, error));
}

function createChatSubscription(req, res) {
	const { chatId, type, params, interval } = req.body || {};
	if (!chatId) {
		return res.status(400).json({
			error: 'chatId is required',
			code: 'INVALID_REQUEST',
		});
	}
	chatSubscriptionService
		.createSubscription({
			chatId: String(chatId),
			type,
			params: params || {},
			intervalMs: interval,
		})
		.then((result) => {
			const status = result.created ? 201 : 200;
			return res.status(status).json({
				subscription: result.subscription,
				replayed: !result.created,
				clamped: result.clamped,
			});
		})
		.catch((error) => {
			if (error instanceof ChatSubscriptionValidationError) {
				return handleError(res, error);
			}
			return handleError(res, error);
		});
}

function deleteChatSubscription(req, res) {
	const { chatId } = req.body || {};
	const { subscriptionId } = req.params || {};
	if (!chatId) {
		return res.status(400).json({
			error: 'chatId is required',
			code: 'INVALID_REQUEST',
		});
	}
	const all = !subscriptionId || subscriptionId === 'all';
	chatSubscriptionService
		.deleteSubscription({ chatId: String(chatId), subscriptionId, all })
		.then((result) => res.json(result))
		.catch((error) => handleError(res, error));
}

function getChatSubscriptionStatus(_req, res) {
	return res.json({ enabled: true, ready: true, status: 'available' });
}

module.exports = {
	listChatSubscriptions,
	createChatSubscription,
	deleteChatSubscription,
	getChatSubscriptionStatus,
};
