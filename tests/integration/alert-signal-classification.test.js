/* global jest, describe, it, beforeEach, afterEach, expect */

const request = require('supertest');

jest.mock('../../src/services/storage/AlertStorageService', () => {
	const actual = jest.requireActual('../../src/services/storage/AlertStorageService');
	return {
		...actual,
		isEnabled: jest.fn(),
		saveAlert: jest.fn(),
		extractSymbolAndExchange: jest.fn(),
	};
});

jest.mock('../../src/services/storage/SignalOutcomeService', () => ({
	isEnabled: jest.fn(() => false),
	recordSignal: jest.fn(),
	getMetricsSummary: jest.fn(),
}));

jest.mock('../../src/services/grounding/grounding', () => ({
	enrichAlert: jest.fn(async (alert) => alert),
}));

const app = require('../../app');
const { getRoutes } = require('../../src/routes');
const { initializeNotificationServices, resetNotificationManagerForTesting } = require('../../src/controllers/webhooks/handlers/alert/alert');
const alertStorageService = require('../../src/services/storage/AlertStorageService');
const { signalClassMetrics } = require('../../src/services/alerts/signalClassifier');

/**
 * Issue #858 — `signalClass` was never populated on the webhook ingest path.
 *
 * `validateAlert()` returned 'unknown' for every alert whose caller omitted an
 * explicit `signalClass`, so the live badge markers (🎯 breakout, 🔄
 * mean_reversion, …) never rendered even though `featureFlags.signalClassMarker`
 * was `true` and production evidence showed 10/10 stored alerts in `unknown`.
 */
const REALISTIC_BREAKOUT_ALERT = 'BTCUSDT broke resistance with strong volume';

describe('Alert signal classification (issue #858)', () => {
	let savedEnv;
	let mockTelegramSendMessage;
	let mockBot;

	beforeEach(async () => {
		savedEnv = { ...process.env };
		Object.assign(process.env, {
			WEBHOOK_API_KEY: 'test-key',
			ENABLE_TELEGRAM_BOT: 'true',
			ENABLE_WHATSAPP_ALERTS: 'false',
			ENABLE_DISCORD_ALERTS: 'false',
			BOT_TOKEN: 'test-bot-token',
			TELEGRAM_CHAT_ID: '123456789',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
			ENABLE_SIGNAL_CLASS_MARKER: 'true',
		});

		jest.clearAllMocks();
		signalClassMetrics.reset();
		alertStorageService.isEnabled.mockReturnValue(true);
		alertStorageService.saveAlert.mockResolvedValue('stored-alert-id');
		alertStorageService.extractSymbolAndExchange.mockReturnValue({ symbol: 'BTCUSDT', exchange: 'BINANCE' });

		mockTelegramSendMessage = jest.fn().mockResolvedValue({ message_id: 'test-msg-id' });
		mockBot = {
			telegram: {
				sendMessage: mockTelegramSendMessage,
				getMe: jest.fn().mockResolvedValue({ id: 123456789, username: 'TestBot' }),
			},
		};

		resetNotificationManagerForTesting();
		await initializeNotificationServices(mockBot);
		app.use('/api', getRoutes(mockBot));
	});

	afterEach(() => {
		process.env = savedEnv;
		if (app._router && app._router.stack && app._router.stack.length > 0) {
			app._router.stack.pop();
		}
	});

	it('classifies a realistic production alert instead of persisting unknown', async () => {
		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: REALISTIC_BREAKOUT_ALERT })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(alertStorageService.saveAlert).toHaveBeenCalledTimes(1);
		const persisted = alertStorageService.saveAlert.mock.calls[0][0];
		expect(persisted.signalClass).toBe('breakout');
	});

	it('renders the badge marker for the classified alert on Telegram', async () => {
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: REALISTIC_BREAKOUT_ALERT })
			.expect(200);

		expect(mockTelegramSendMessage).toHaveBeenCalledWith(
			'123456789',
			expect.stringMatching(/^🎯 breakout/),
			expect.objectContaining({ parse_mode: 'MarkdownV2' }),
		);
	});

	it('keeps an explicit caller-supplied signalClass authoritative', async () => {
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: REALISTIC_BREAKOUT_ALERT, signalClass: 'reversal' })
			.expect(200);

		expect(alertStorageService.saveAlert.mock.calls[0][0].signalClass).toBe('reversal');
	});

	it('honors metadata.signalClass, which validateAlert also treats as explicit', async () => {
		// Regression: the classifier consulted only the top-level/query value, so a
		// caller using the documented metadata form was silently derived instead.
		// Replay preserves metadata (AGENTS.md "Replay Payload Preservation"), so this
		// also had to round-trip.
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({
				text: REALISTIC_BREAKOUT_ALERT,
				metadata: { signalClass: 'reversal' },
			})
			.expect(200);

		expect(alertStorageService.saveAlert.mock.calls[0][0].signalClass).toBe('reversal');
	});

	it('still honors unknown when the caller explicitly asks for it', async () => {
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: REALISTIC_BREAKOUT_ALERT, signalClass: 'unknown' })
			.expect(200);

		expect(alertStorageService.saveAlert.mock.calls[0][0].signalClass).toBe('unknown');
	});

	it('does not force a class onto genuinely unclassifiable text', async () => {
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: 'hello' })
			.expect(200);

		expect(alertStorageService.saveAlert.mock.calls[0][0].signalClass).toBe('unknown');
	});

	it('still delivers when classification bookkeeping throws (fail-open)', async () => {
		const spy = jest
			.spyOn(signalClassMetrics, 'record')
			.mockImplementation(() => {
				throw new Error('metrics exploded');
			});

		const response = await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: REALISTIC_BREAKOUT_ALERT })
			.expect(200);

		expect(response.body.success).toBe(true);
		expect(mockTelegramSendMessage).toHaveBeenCalled();
		spy.mockRestore();
	});

	it('records a non-zero classification population rate', async () => {
		await request(app)
			.post('/api/webhook/alert')
			.set('x-api-key', 'test-key')
			.send({ text: REALISTIC_BREAKOUT_ALERT })
			.expect(200);

		const snapshot = signalClassMetrics.getSnapshot();
		expect(snapshot).not.toBeNull();
		expect(snapshot.totalAlerts).toBe(1);
		expect(snapshot.classifiedAlerts).toBe(1);
		expect(snapshot.populationRate).toBe(1);
	});
});
