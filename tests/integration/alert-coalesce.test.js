/* global saveEnv, restoreEnv */
const request = require('supertest');
const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices, resetNotificationManagerForTesting, getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');
const { alertCoalescer } = require('../../src/services/alerts/alertCoalescer');
const { alertSubscriberService } = require('../../src/services/subscribers/AlertSubscriberService');

describe('Opt-in webhook alert coalescing', () => {
	let savedEnv;
	let send;
	beforeEach(async () => {
		savedEnv = saveEnv();
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key', ENABLE_ALERT_COALESCE: 'true', ALERT_COALESCE_WINDOW_MS: '5000',
			ENABLE_TELEGRAM_BOT: 'true', TELEGRAM_CHAT_ID: '123456789', BOT_TOKEN: 'test-token',
			ENABLE_GEMINI_GROUNDING: 'false', ENABLE_WHATSAPP_ALERTS: 'false', ENABLE_DISCORD_ALERTS: 'false',
		});
		resetNotificationManagerForTesting();
		send = jest.fn().mockResolvedValue({ message_id: 1 });
		const bot = { telegram: { sendMessage: send, getMe: jest.fn().mockResolvedValue({ id: 123 }) } };
		await initializeNotificationServices(bot);
		app.use('/api', getRoutes(bot));
	});
	afterEach(() => {
		restoreEnv(savedEnv);
		jest.restoreAllMocks();
		resetNotificationManagerForTesting();
		app._router.stack.pop();
	});
	const post = (body, id) => request(app).post('/api/webhook/alert').set('x-api-key', 'test-key').set('x-request-id', id).send(body);
	it('sends a concurrent burst once and returns the canonical request ID', async () => {
		const body = { text: 'coalescing concurrent signal' };
		const replies = await Promise.all([post(body, 'one'), post(body, 'two'), post(body, 'three')]);
		expect(replies.map(r => r.status)).toEqual([200, 200, 200]);
		expect(send).toHaveBeenCalledTimes(1);
		const original = replies.find(r => !r.body.coalesced).body;
		expect(replies.filter(r => r.body.coalesced).map(r => r.body.originalRequestId)).toEqual([original.requestId, original.requestId]);
	});
	it('preserves the disabled default and distinct destinations and payloads', async () => {
		process.env.ENABLE_ALERT_COALESCE = 'false';
		await post({ text: 'disabled' }, 'd1');
		await post({ text: 'disabled' }, 'd2');
		process.env.ENABLE_ALERT_COALESCE = 'true';
		await post({ text: 'routed', channels: ['telegram'], telegramChatId: '111' }, 'r1');
		await post({ text: 'routed', channels: ['telegram'], telegramChatId: '222' }, 'r2');
		await post({ text: 'different' }, 'r3');
		expect(send).toHaveBeenCalledTimes(5);
	});
	it('retries a failed delivery instead of treating it as delivered', async () => {
		const dispatch = jest.spyOn(getNotificationManager(), 'sendToAll').mockResolvedValueOnce([{ channel: 'telegram', success: false }]);
		await post({ text: 'retry failed' }, 'f1');
		const second = await post({ text: 'retry failed' }, 'f2');
		expect(second.body.coalesced).toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
		dispatch.mockRestore();
	});
	it.each([
		{ results: [] },
		{ results: [{ channel: 'telegram', success: true }, { channel: 'whatsapp', success: false }] },
	])('does not retain empty or partial delivery: %j', async ({ results }) => {
		jest.spyOn(getNotificationManager(), 'sendToAll').mockResolvedValueOnce(results);
		await post({ text: 'incomplete' }, 'p1');
		const retry = await post({ text: 'incomplete' }, 'p2');
		expect(retry.body.coalesced).toBeUndefined();
		expect(send).toHaveBeenCalledTimes(1);
	});
	it('releases delivery exceptions and fails open when the cache throws', async () => {
		jest.spyOn(getNotificationManager(), 'sendToAll').mockRejectedValueOnce(new Error('delivery unavailable'));
		expect((await post({ text: 'exception' }, 'e1')).status).toBe(500);
		expect((await post({ text: 'exception' }, 'e2')).body.coalesced).toBeUndefined();
		jest.spyOn(alertCoalescer, 'acquire').mockRejectedValueOnce(new Error('cache unavailable'));
		expect((await post({ text: 'cache failure' }, 'e3')).status).toBe(200);
		expect(send).toHaveBeenCalledTimes(2);
	});
	it('bypasses async subscribers and preserves malformed payload validation', async () => {
		jest.spyOn(alertSubscriberService, 'getStorageStatus').mockReturnValue({ enabled: false, activeCount: 1 });
		await post({ text: 'subscriber' }, 's1');
		const second = await post({ text: 'subscriber' }, 's2');
		expect(second.body.coalesced).toBeUndefined();
		expect(send).toHaveBeenCalledTimes(2);
		expect((await post({ text: 'invalid routing', channels: ['invalid'] }, 'invalid')).status).toBe(400);
	});
	it('never coalesces dry runs or different query options', async () => {
		await post({ text: 'dry', dryRun: true }, 'dry1');
		expect((await post({ text: 'dry', dryRun: true }, 'dry2')).body.coalesced).toBeUndefined();
		expect(send).not.toHaveBeenCalled();
		await post({ text: 'query' }, 'q1');
		await request(app).post('/api/webhook/alert?useTradingViewData=false').set('x-api-key', 'test-key').send({ text: 'query' });
		expect(send).toHaveBeenCalledTimes(2);
	});
});
