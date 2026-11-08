'use strict';

const crypto = require('crypto');
const {
	AlertSubscriberDeliveryService,
	alertSubscriberDeliveryService,
	computeHmacSignature,
} = require('../../src/services/subscribers/AlertSubscriberDeliveryService');
const { alertSubscriberService } = require('../../src/services/subscribers/AlertSubscriberService');

describe('AlertSubscriberDeliveryService', () => {
	beforeEach(() => {
		alertSubscriberService.resetForTesting();
	});

	describe('computeHmacSignature', () => {
		it('computes sha256 hex signature over canonical input', () => {
			const timestamp = '2026-10-16T12:00:00.000Z';
			const event = 'alert.dispatched';
			const deliveryId = 'delivery-123';
			const payloadStr = JSON.stringify({ message: 'test' });
			const secret = 'my-test-secret';

			const expectedCanonical = [timestamp, event, deliveryId, payloadStr].join('\n');
			const expectedSig = crypto.createHmac('sha256', secret).update(expectedCanonical).digest('hex');

			const sig = computeHmacSignature({ secret, timestamp, event, deliveryId, payloadStr });
			expect(sig).toBe(expectedSig);
		});
	});

	describe('deliverToSubscriber', () => {
		it('sends signed HTTP POST with expected headers', async () => {
			let capturedRequest = null;
			const mockFetch = jest.fn().mockImplementation(async (url, options) => {
				capturedRequest = { url, ...options };
				return {
					ok: true,
					status: 200,
					body: { cancel: jest.fn() },
				};
			});

			const deliveryService = new AlertSubscriberDeliveryService({ fetchFn: mockFetch });

			const subscriber = {
				id: 'sub-1',
				url: 'https://example.com/alerts/webhook',
				secret: 'webhook-sec',
			};

			const alertData = {
				symbol: 'BTCUSDT',
				text: 'BTCUSDT LONG Entry 70000',
				source: 'webhook-alert',
			};

			const result = await deliveryService.deliverToSubscriber(subscriber, alertData, {
				event: 'alert.dispatched',
				maxAttempts: 1,
			});

			expect(result.success).toBe(true);
			expect(mockFetch).toHaveBeenCalledTimes(1);
			expect(capturedRequest.url).toBe('https://example.com/alerts/webhook');
			expect(capturedRequest.headers['Content-Type']).toBe('application/json');
			expect(capturedRequest.headers['x-alert-subscriber-event']).toBe('alert.dispatched');
			expect(capturedRequest.headers['x-alert-subscriber-delivery-id']).toBeDefined();
			expect(capturedRequest.headers['x-alert-subscriber-timestamp']).toBeDefined();
			expect(capturedRequest.headers['x-alert-subscriber-signature']).toBeDefined();
		});

		it('stops without retrying on non-retryable 400 Bad Request', async () => {
			const mockFetch = jest.fn().mockImplementation(async () => {
				return {
					ok: false,
					status: 400,
					statusText: 'Bad Request',
					body: { cancel: jest.fn() },
				};
			});

			const deliveryService = new AlertSubscriberDeliveryService({ fetchFn: mockFetch });

			const subscriber = {
				id: 'sub-2',
				url: 'https://example.com/alerts/bad-endpoint',
			};

			const result = await deliveryService.deliverToSubscriber(subscriber, { text: 'Test' }, {
				maxAttempts: 3,
				retryDelayMs: 5,
			});

			expect(result.success).toBe(false);
			expect(mockFetch).toHaveBeenCalledTimes(1); // No retries after non-retryable 400
		});
	});

	describe('dispatchAlert fail-open', () => {
		it('fan-outs to matching subscribers asynchronously and catches all errors', async () => {
			const sub1 = await alertSubscriberService.createSubscriber({
				url: 'https://example.com/subscriber-btc',
				filter: { symbols: ['BTCUSDT'] },
			});

			const sub2 = await alertSubscriberService.createSubscriber({
				url: 'https://example.com/subscriber-eth',
				filter: { symbols: ['ETHUSDT'] },
			});

			const mockFetch = jest.fn().mockImplementation(async () => {
				return {
					ok: true,
					status: 200,
					body: { cancel: jest.fn() },
				};
			});

			const deliveryService = new AlertSubscriberDeliveryService({
				subscriberService: alertSubscriberService,
				fetchFn: mockFetch,
			});

			await deliveryService.dispatchAlert({
				symbol: 'BTCUSDT',
				text: 'BTC Breakout',
			});

			// Only sub1 matches BTCUSDT
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});
	});
});
