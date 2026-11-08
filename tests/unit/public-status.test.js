const bootstrapReadiness = require('../../src/lib/bootstrapReadiness');
const {
	getPublicStatus,
	readPublicSnapshot,
	resetPublicStatusCacheForTesting,
} = require('../../src/controllers/publicStatus');

function makeRes() {
	const headers = {};
	return {
		statusCode: 200,
		body: undefined,
		headers,
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(payload) {
			this.body = payload;
			return this;
		},
		set(name, value) {
			headers[name] = value;
			return this;
		},
	};
}

function makeGetStatus({ telegramReady = true, whatsappReady = false, discordReady = false } = {}) {
	return function getStatus() {
		return {
			service: { name: 'cabros-bot', version: '1.2.3' },
			deliveryChannels: {
				telegram: { enabled: telegramReady },
				whatsapp: { enabled: whatsappReady },
				discord: { enabled: discordReady },
			},
			dependencies: {
				gemini: { ready: true, configured: true, enabled: true, status: 'ready' },
				tradingViewMcp: { ready: false, configured: true, enabled: true, status: 'ready' },
				firestore: { ready: true, configured: true, enabled: true, status: 'ready' },
			},
		};
	};
}

describe('publicStatus controller', () => {
	beforeEach(() => {
		resetPublicStatusCacheForTesting();
		bootstrapReadiness.reset();
	});

	afterEach(() => {
		bootstrapReadiness.reset();
		resetPublicStatusCacheForTesting();
	});

	it('returns a redacted public snapshot with only safe fields', () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		bootstrapReadiness.markDisabled('telegramBot');
		bootstrapReadiness.markDisabled('notificationServices');
		bootstrapReadiness.markDisabled('newsMonitor');

		const handler = getPublicStatus(makeGetStatus());
		const res = makeRes();
		handler({}, res);

		expect(res.statusCode).toBe(200);
		expect(res.body.service).toEqual({ name: 'cabros-bot', version: '1.2.3' });
		expect(res.body.status.ok).toBe(true);
		expect(typeof res.body.status.uptimeSeconds).toBe('number');
		expect(res.body.status.lastUpdated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(res.body.status.shuttingDown).toBe(false);
		expect(res.body.channels.enabled).toEqual(['telegram']);
		expect(res.body.dependencies).toEqual({
			gemini: { ready: true },
			tradingview: { ready: false },
			firestore: { ready: true },
		});

		// No secret/PII/operator-only data leaks
		expect(res.body).not.toHaveProperty('featureFlags');
		expect(res.body).not.toHaveProperty('deliveryMetrics');
		expect(res.body).not.toHaveProperty('readiness');
		expect(res.body.dependencies.gemini).not.toHaveProperty('configured');
		expect(res.body.dependencies.firestore).not.toHaveProperty('configured');
	});

	it('returns 503 when the process is still bootstrapping', () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		// do not mark anything ready
		const handler = getPublicStatus(makeGetStatus());
		const res = makeRes();
		handler({}, res);

		expect(res.statusCode).toBe(503);
		expect(res.body.status.ok).toBe(false);
		expect(res.body.error).toBe('service_not_ready');
		expect(res.body.code).toBe('SERVICE_NOT_READY');
	});

	it('lists enabled channels based on deliveryChannels map', () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		bootstrapReadiness.markDisabled('telegramBot');
		bootstrapReadiness.markDisabled('notificationServices');
		bootstrapReadiness.markDisabled('newsMonitor');

		const handler = getPublicStatus(makeGetStatus({ telegramReady: true, whatsappReady: true, discordReady: true }));
		const res = makeRes();
		handler({}, res);

		expect(res.statusCode).toBe(200);
		expect(res.body.channels.enabled.sort()).toEqual(['discord', 'telegram', 'whatsapp']);
	});

	it('returns 500 with INTERNAL_ERROR when the upstream status builder throws', () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		bootstrapReadiness.markDisabled('telegramBot');
		bootstrapReadiness.markDisabled('notificationServices');
		bootstrapReadiness.markDisabled('newsMonitor');

		const handler = getPublicStatus(() => { throw new Error('boom'); });
		const res = makeRes();
		handler({}, res);

		expect(res.statusCode).toBe(500);
		expect(res.body.code).toBe('INTERNAL_ERROR');
		expect(res.body.error).toBe('boom');
	});

	it('caches the snapshot across multiple requests for at most 30s', () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		bootstrapReadiness.markDisabled('telegramBot');
		bootstrapReadiness.markDisabled('notificationServices');
		bootstrapReadiness.markDisabled('newsMonitor');

		let calls = 0;
		const getStatus = function getStatusSpy() {
			calls += 1;
			return makeGetStatus()();
		};

		const handler = getPublicStatus(getStatus);
		const res1 = makeRes();
		handler({}, res1);
		const res2 = makeRes();
		handler({}, res2);
		const res3 = makeRes();
		handler({}, res3);

		expect(calls).toBe(1);
		expect(res1.body.status.lastUpdated).toBe(res2.body.status.lastUpdated);
		expect(res2.body.status.lastUpdated).toBe(res3.body.status.lastUpdated);
	});

	it('refreshes the snapshot when forceRefresh is requested', () => {
		const first = readPublicSnapshot({
			getStatus: makeGetStatus(),
			now: 1000,
		});
		const second = readPublicSnapshot({
			getStatus: makeGetStatus(),
			now: 2000,
		});
		expect(first.status.lastUpdated).not.toBe(second.status.lastUpdated);
	});
});