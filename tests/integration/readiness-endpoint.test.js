const request = require('supertest');
const app = require('../../app');
const bootstrapReadiness = require('../../src/lib/bootstrapReadiness');

describe('GET /ready', () => {
	afterEach(() => {
		bootstrapReadiness.reset();
	});

	it('returns 503 while bootstrap readiness is pending', async () => {
		const response = await request(app).get('/ready');

		expect(response.status).toBe(503);
		expect(response.body.status).toBe('pending');
		expect(response.body.ready).toBe(false);
	});

	it('returns 200 when required bootstrap components are ready', async () => {
		bootstrapReadiness.begin({ telegramRequired: false, newsMonitorRequired: false });
		bootstrapReadiness.markReady('notificationServices');

		const response = await request(app).get('/ready');

		expect(response.status).toBe(200);
		expect(response.body.status).toBe('ready');
		expect(response.body.components).toEqual({
			telegramBot: { status: 'disabled' },
			notificationServices: { status: 'ready' },
			newsMonitor: { status: 'disabled' },
		});
	});

	it('returns 503 when Telegram bootstrap fails', async () => {
		bootstrapReadiness.begin({ telegramRequired: true, newsMonitorRequired: false });
		bootstrapReadiness.markReady('notificationServices');
		bootstrapReadiness.markFailed('telegramBot', new Error('launch failed'));

		const response = await request(app).get('/ready');

		expect(response.status).toBe(503);
		expect(response.body.status).toBe('failed');
		expect(response.body.components.telegramBot).toEqual({ status: 'failed' });
		expect(response.body.error).toBe('launch failed');
	});

	it('returns 503 when bootstrap exceeds the bounded wait', async () => {
		jest.useFakeTimers();
		bootstrapReadiness.begin({ telegramRequired: true, timeoutMs: 25 });
		jest.advanceTimersByTime(25);

		const response = await request(app).get('/ready');

		expect(response.status).toBe(503);
		expect(response.body.status).toBe('failed');
		expect(response.body.error).toContain('25ms');
		jest.useRealTimers();
	});

	it('revokes readiness and returns 503 when a component fails after initially reporting ready', async () => {
		bootstrapReadiness.begin({ telegramRequired: true, newsMonitorRequired: false });
		bootstrapReadiness.markReady('notificationServices');
		bootstrapReadiness.markReady('telegramBot');

		const initialResponse = await request(app).get('/ready');
		expect(initialResponse.status).toBe(200);
		expect(initialResponse.body.status).toBe('ready');
		expect(initialResponse.body.ready).toBe(true);

		bootstrapReadiness.markFailed('telegramBot', new Error('late polling failure'));

		const response = await request(app).get('/ready');
		expect(response.status).toBe(503);
		expect(response.body.status).toBe('failed');
		expect(response.body.ready).toBe(false);
		expect(response.body.components.telegramBot).toEqual({ status: 'failed' });
		expect(response.body.error).toBe('late polling failure');
	});
});
