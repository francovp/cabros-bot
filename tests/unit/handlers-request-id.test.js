'use strict';

const { postSymbolAnalysis } = require('../../src/controllers/webhooks/handlers/symbolAnalysis/symbolAnalysis');
const { postVolumeConfirmation } = require('../../src/controllers/webhooks/handlers/volumeConfirmation/volumeConfirmation');
const { NewsMonitorHandler } = require('../../src/controllers/webhooks/handlers/newsMonitor/newsMonitor');

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
});
