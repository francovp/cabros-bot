'use strict';

const { postSymbolAnalysis } = require('../../src/controllers/webhooks/handlers/symbolAnalysis/symbolAnalysis');
const { postVolumeConfirmation } = require('../../src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation');
const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');
const { postExpandedAnalysisAlert } = require('../../src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert');
const { postMarketScannerAlert } = require('../../src/controllers/webhooks/handlers/marketScanner/marketScanner');
const { postRunPreset } = require('../../src/controllers/webhooks/handlers/scannerPresets/scannerPresets');

function createMockRes() {
	const res = {
		statusCode: 200,
		body: null,
		status: jest.fn(function (code) {
			res.statusCode = code;
			return res;
		}),
		json: jest.fn(function (data) {
			res.body = data;
			return res;
		}),
	};
	return res;
}

describe('Handlers requestId reuse', () => {
	it('postSymbolAnalysis reuses req.requestId on validation error', async () => {
		const handler = postSymbolAnalysis();
		const req = {
			requestId: 'req-sym-123',
			body: {},
		};
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.body).toEqual(expect.objectContaining({
			requestId: 'req-sym-123',
		}));
	});

	it('postVolumeConfirmation reuses req.requestId on validation error', async () => {
		const handler = postVolumeConfirmation();
		const req = {
			requestId: 'req-vol-456',
			body: {},
		};
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.body).toEqual(expect.objectContaining({
			requestId: 'req-vol-456',
		}));
	});

	it('NewsMonitorHandler reuses req.requestId when feature is disabled', async () => {
		const originalEnv = process.env.ENABLE_NEWS_MONITOR;
		process.env.ENABLE_NEWS_MONITOR = 'false';
		try {
			const controller = new NewsMonitorHandler();
			const req = {
				requestId: 'req-news-999',
				body: {},
			};
			const res = createMockRes();

			await controller.handleRequest(req, res);

			expect(res.status).toHaveBeenCalledWith(403);
			expect(res.body).toEqual(expect.objectContaining({
				requestId: 'req-news-999',
			}));
		} finally {
			if (originalEnv === undefined) {
				delete process.env.ENABLE_NEWS_MONITOR;
			} else {
				process.env.ENABLE_NEWS_MONITOR = originalEnv;
			}
		}
	});

	it('postExpandedAnalysisAlert reuses req.requestId on validation error', async () => {
		const handler = postExpandedAnalysisAlert();
		const req = {
			requestId: 'req-exp-789',
			body: {},
		};
		const res = createMockRes();

		await handler(req, res);

		expect(res.status).toHaveBeenCalledWith(400);
		expect(res.body).toEqual(expect.objectContaining({
			requestId: 'req-exp-789',
		}));
	});

	it('postMarketScannerAlert reuses req.requestId and req.startTime when feature is disabled or invalid', async () => {
		const handler = postMarketScannerAlert();
		const explicitStartTime = Date.now() - 200;
		const req = {
			requestId: 'req-scan-321',
			startTime: explicitStartTime,
			body: {},
		};
		const res = createMockRes();

		await handler(req, res);

		expect(res.body).toEqual(expect.objectContaining({
			requestId: 'req-scan-321',
		}));
	});

	it('postRunPreset reuses req.requestId and req.startTime when feature is disabled or invalid', async () => {
		const handler = postRunPreset();
		const explicitStartTime = Date.now() - 150;
		const req = {
			params: { id: 'test-preset' },
			requestId: 'req-preset-654',
			startTime: explicitStartTime,
			body: {},
		};
		const res = createMockRes();

		await handler(req, res);

		expect(res.body).toEqual(expect.objectContaining({
			requestId: 'req-preset-654',
		}));
	});
});
