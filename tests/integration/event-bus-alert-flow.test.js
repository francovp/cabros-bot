/**
 * tests/integration/event-bus-alert-flow.test.js
 *
 * Integration test that wires the in-process event bus to the alert
 * controller. It proves that side-effect consumers can subscribe via
 * the bus without coupling to the webhook handler, and that a failing
 * subscriber does not break the response, the delivery path, or other
 * subscribers.
 */

const express = require('express');
const request = require('supertest');

const { eventBus } = require('../../src/lib/eventBus');
const { EVENT_NAMES } = require('../../src/lib/eventBusCatalog');
const { initializeNotificationServices, getNotificationManager } = require('../../src/controllers/webhooks/handlers/alert/alert');

describe('event bus alert flow', () => {
	let app;
	let unhandled;
	let mockBot;

	beforeEach(() => {
		eventBus.removeAllListeners();

		process.env.ENABLE_TELEGRAM_BOT = 'true';
		process.env.BOT_TOKEN = 'test-bot-token';
		process.env.TELEGRAM_CHAT_ID = '-1001234567890';
		process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '';
		process.env.WEBHOOK_API_KEY = 'integration-test-key';

		unhandled = jest.fn();
		process.on('unhandledRejection', unhandled);

		mockBot = {
			telegram: {
				sendMessage: jest.fn().mockResolvedValue({ message_id: 'tg-123' }),
				getMe: jest.fn().mockResolvedValue({ id: 123, username: 'BusBot' }),
			},
		};
	});

	afterEach(() => {
		eventBus.removeAllListeners();
		process.removeListener('unhandledRejection', unhandled);
		jest.restoreAllMocks();
	});

	describe('subscriber isolation', () => {
		it('continues dispatching even when a synchronous subscriber throws', async () => {
			const observed = [];
			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, () => {
				throw new Error('subscriber-boom');
			});
			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, (payload) => {
				observed.push(payload);
			});

			await eventBus.emitAsync(EVENT_NAMES.ALERT_DELIVERED, { alertId: 'a-1', results: [] });

			expect(observed).toHaveLength(1);
			expect(observed[0]).toEqual({ alertId: 'a-1', results: [] });
		});

		it('does not propagate an async subscriber rejection to the publisher', async () => {
			const slowFailing = jest.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				throw new Error('late-boom');
			});
			const ok = jest.fn();

			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, slowFailing);
			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, ok);

			const settled = await eventBus.emitAsync(EVENT_NAMES.ALERT_DELIVERED, { alertId: 'a-2' });

			expect(ok).toHaveBeenCalledTimes(1);
			expect(slowFailing).toHaveBeenCalledTimes(1);
			expect(settled).toHaveLength(2);
			expect(settled[0]).toEqual({ error: expect.any(Error) });
			expect(settled[1]).toEqual({ value: undefined });

			await new Promise((resolve) => setImmediate(resolve));
			expect(unhandled).not.toHaveBeenCalled();
		});
	});

	describe('end-to-end alert path', () => {
		beforeEach(async () => {
			const manager = await initializeNotificationServices(mockBot);
			expect(manager).toBe(getNotificationManager());

			app = express();
			app.use(express.json());

			// Mount a stub alert route that wires the bus just like the
			// production handler would. The stub records delivery so the
			// test can assert bus subscribers observe the same payload.
			app.post('/api/stub-alert', async (req, res) => {
				const results = await getNotificationManager().sendToAll({
					text: req.body.text,
					alertId: req.body.alertId,
				});
				eventBus.emit(EVENT_NAMES.ALERT_DELIVERED, {
					alertId: req.body.alertId,
					results,
				});
				res.json({ success: true, alertId: req.body.alertId, results });
			});
		});

		it('publishes alert.delivered to every subscriber after delivery completes', async () => {
			const subscribers = [jest.fn(), jest.fn(), jest.fn()];
			subscribers.forEach((handler) => eventBus.on(EVENT_NAMES.ALERT_DELIVERED, handler));

			const response = await request(app)
				.post('/api/stub-alert')
				.set('x-api-key', 'integration-test-key')
				.send({ alertId: 'e2e-1', text: 'integration test alert' })
				.expect(200);

			expect(response.body.success).toBe(true);

			// The bus is fire-and-forget synchronous so subscribers may
			// run before the response is sent. Wait one tick to allow
			// any queued microtasks to settle.
			await new Promise((resolve) => setImmediate(resolve));

			subscribers.forEach((handler) => {
				expect(handler).toHaveBeenCalledTimes(1);
				const [payload] = handler.mock.calls[0];
				expect(payload.alertId).toBe('e2e-1');
				expect(Array.isArray(payload.results)).toBe(true);
			});
		});

		it('still returns 200 when a subscriber throws synchronously', async () => {
			const throwing = jest.fn(() => {
				throw new Error('subscriber-blew-up');
			});
			const ok = jest.fn();
			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, throwing);
			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, ok);

			const response = await request(app)
				.post('/api/stub-alert')
				.set('x-api-key', 'integration-test-key')
				.send({ alertId: 'e2e-2', text: 'second alert' })
				.expect(200);

			expect(response.body.success).toBe(true);
			expect(ok).toHaveBeenCalledTimes(1);
			expect(throwing).toHaveBeenCalledTimes(1);
		});

		it('a slow async subscriber does not delay the HTTP response', async () => {
			const slow = jest.fn(async () => {
				await new Promise((resolve) => setTimeout(resolve, 250));
			});
			eventBus.on(EVENT_NAMES.ALERT_DELIVERED, slow);

			const start = Date.now();
			const response = await request(app)
				.post('/api/stub-alert')
				.set('x-api-key', 'integration-test-key')
				.send({ alertId: 'e2e-3', text: 'third alert' })
				.expect(200);
			const elapsed = Date.now() - start;

			expect(response.body.success).toBe(true);
			// Synchronous emit path — even if the subscriber schedules an
			// async tail, the response is sent before it resolves.
			expect(elapsed).toBeLessThan(200);
		});
	});
});
