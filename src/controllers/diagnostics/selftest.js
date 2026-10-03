'use strict';

const { v4: uuidv4 } = require('uuid');
const { createSelfTestService } = require('../../services/diagnostics/SelfTestService');
const sentryService = require('../../services/monitoring/SentryService');

let singleton = null;

function getSelfTestService({ botOrGetter, getBinanceOrderService } = {}) {
	if (!singleton) {
		singleton = createSelfTestService({ botOrGetter, getBinanceOrderService });
	}
	return singleton;
}

function resetSelfTestService() {
	singleton = null;
}

function getSelfTest(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const service = getSelfTestService({
			botOrGetter,
			getBinanceOrderService: () => {
				try {
					return require('../../services/trading/BinanceOrderService').binanceOrderService;
				} catch (error) {
					return null;
				}
			},
		});
		const last = service.getLastResult();
		if (!last) {
			return res.status(200).json({
				status: 'unknown',
				message: 'No self-test has been run yet. POST /api/selftest/run to trigger one.',
				requestId,
				cached: false,
			});
		}
		return res.status(200).json({ ...last, requestId, cached: true });
	};
}

function postSelfTestRun(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const only = typeof req.query.only === 'string'
			? req.query.only
			: (req.body && typeof req.body.only === 'string' ? req.body.only : null);

		const service = getSelfTestService({
			botOrGetter,
			getBinanceOrderService: () => {
				try {
					return require('../../services/trading/BinanceOrderService').binanceOrderService;
				} catch (error) {
					return null;
				}
			},
		});

		try {
			const result = await service.run({ only });
			return res.status(200).json({ ...result, requestId, cached: false });
		} catch (error) {
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/selftest/run',
					method: 'POST',
					statusCode: 500,
					requestId,
				},
			});
			return res.status(500).json({
				error: 'Internal error running self-test suite.',
				code: 'INTERNAL_ERROR',
				requestId,
			});
		}
	};
}

module.exports = {
	getSelfTest,
	postSelfTestRun,
	getSelfTestService,
	resetSelfTestService,
};
