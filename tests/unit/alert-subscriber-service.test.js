'use strict';

const {
	AlertSubscriberService,
	alertSubscriberService,
	AlertSubscriberValidationError,
	matchesAlert,
} = require('../../src/services/subscribers/AlertSubscriberService');

describe('AlertSubscriberService', () => {
	beforeEach(() => {
		alertSubscriberService.resetForTesting();
		delete process.env.ENABLE_FIRESTORE_ALERT_SUBSCRIBERS;
		delete process.env.ALLOW_PRIVATE_CALLBACKS;
	});

	afterEach(() => {
		alertSubscriberService.resetForTesting();
		delete process.env.ENABLE_FIRESTORE_ALERT_SUBSCRIBERS;
		delete process.env.ALLOW_PRIVATE_CALLBACKS;
	});

	describe('Validation & SSRF Guards', () => {
		it('rejects invalid URL formats', async () => {
			await expect(alertSubscriberService.createSubscriber({
				url: 'not-a-valid-url',
			})).rejects.toThrow(AlertSubscriberValidationError);
		});

		it('rejects private IP / loopback URLs by default in production mode', async () => {
			const savedNodeEnv = process.env.NODE_ENV;
			process.env.NODE_ENV = 'production';
			try {
				await expect(alertSubscriberService.createSubscriber({
					url: 'http://127.0.0.1:8080/webhook',
				})).rejects.toThrow(AlertSubscriberValidationError);

				await expect(alertSubscriberService.createSubscriber({
					url: 'http://169.254.169.254/latest/meta-data',
				})).rejects.toThrow(AlertSubscriberValidationError);

				await expect(alertSubscriberService.createSubscriber({
					url: 'http://192.168.1.50/alert',
				})).rejects.toThrow(AlertSubscriberValidationError);
			} finally {
				process.env.NODE_ENV = savedNodeEnv;
			}
		});

		it('allows valid public HTTPS URLs', async () => {
			const subscriber = await alertSubscriberService.createSubscriber({
				url: 'https://example.com/webhook',
				description: 'My trading bridge',
				secret: 'supersecret123',
			});

			expect(subscriber).toBeDefined();
			expect(subscriber.id).toBeDefined();
			expect(subscriber.url).toBe('https://example.com/webhook');
			expect(subscriber.description).toBe('My trading bridge');
			expect(subscriber.hasSecret).toBe(true);
			expect(subscriber.secret).toBeUndefined(); // Secret must never be exposed
			expect(subscriber.enabled).toBe(true);
		});

		it('validates filter structure', async () => {
			await expect(alertSubscriberService.createSubscriber({
				url: 'https://example.com/webhook',
				filter: 'invalid-filter',
			})).rejects.toThrow(AlertSubscriberValidationError);

			await expect(alertSubscriberService.createSubscriber({
				url: 'https://example.com/webhook',
				filter: { symbols: 'not-an-array' },
			})).rejects.toThrow(AlertSubscriberValidationError);
		});
	});

	describe('CRUD operations', () => {
		it('creates, retrieves, updates, and deletes subscribers in ephemeral mode', async () => {
			const created = await alertSubscriberService.createSubscriber({
				url: 'https://example.com/webhook-1',
				description: 'Initial',
				secret: 'sec-key',
				filter: { symbols: ['BTCUSDT'] },
			});

			expect(created.id).toBeDefined();
			expect(created.hasSecret).toBe(true);

			// Retrieve single
			const fetched = await alertSubscriberService.getSubscriber(created.id);
			expect(fetched).toBeDefined();
			expect(fetched.id).toBe(created.id);
			expect(fetched.hasSecret).toBe(true);
			expect(fetched.secret).toBeUndefined();

			// Internal retrieval with secret
			const internal = await alertSubscriberService.getSubscriber(created.id, { includeSecret: true });
			expect(internal.secret).toBe('sec-key');

			// List
			const list = await alertSubscriberService.listSubscribers();
			expect(list).toHaveLength(1);
			expect(list[0].id).toBe(created.id);
			expect(list[0].secret).toBeUndefined();

			// Update
			const updated = await alertSubscriberService.updateSubscriber(created.id, {
				description: 'Updated description',
				enabled: false,
			});
			expect(updated.description).toBe('Updated description');
			expect(updated.enabled).toBe(false);

			// Delete
			const deleted = await alertSubscriberService.deleteSubscriber(created.id);
			expect(deleted).toBe(true);

			const afterDelete = await alertSubscriberService.getSubscriber(created.id);
			expect(afterDelete).toBeNull();
		});

		it('returns null when updating non-existent subscriber', async () => {
			const updated = await alertSubscriberService.updateSubscriber('non-existent-id', { enabled: false });
			expect(updated).toBeNull();
		});

		it('records delivery outcomes', async () => {
			const subscriber = await alertSubscriberService.createSubscriber({
				url: 'https://example.com/webhook-delivery',
			});

			await alertSubscriberService.recordDelivery(subscriber.id, { success: true });
			const fetched = await alertSubscriberService.getSubscriber(subscriber.id);
			expect(fetched.lastDeliveryStatus).toBe('success');
			expect(fetched.lastDeliveryAt).toBeDefined();
		});
	});

	describe('matchesAlert filter logic', () => {
		it('matches all alerts when filter is empty or missing', () => {
			const sub = { enabled: true };
			expect(matchesAlert(sub, { symbol: 'BTCUSDT', source: 'webhook-alert' })).toBe(true);
		});

		it('does not match when subscriber is disabled', () => {
			const sub = { enabled: false };
			expect(matchesAlert(sub, { symbol: 'BTCUSDT' })).toBe(false);
		});

		it('matches by symbol case-insensitively', () => {
			const sub = {
				enabled: true,
				filter: { symbols: ['BTCUSDT', 'ETHUSDT'] },
			};
			expect(matchesAlert(sub, { symbol: 'btcusdt' })).toBe(true);
			expect(matchesAlert(sub, { symbol: 'SOLUSDT' })).toBe(false);
			expect(matchesAlert(sub, {})).toBe(false);
		});

		it('matches by source', () => {
			const sub = {
				enabled: true,
				filter: { sources: ['webhook-alert'] },
			};
			expect(matchesAlert(sub, { source: 'webhook-alert' })).toBe(true);
			expect(matchesAlert(sub, { source: 'news-monitor' })).toBe(false);
		});

		it('matches by enriched boolean', () => {
			const sub = {
				enabled: true,
				filter: { enriched: true },
			};
			expect(matchesAlert(sub, { enriched: true })).toBe(true);
			expect(matchesAlert(sub, { enriched: false })).toBe(false);
		});

		it('matches by channels intersection', () => {
			const sub = {
				enabled: true,
				filter: { channels: ['discord', 'telegram'] },
			};
			expect(matchesAlert(sub, { channels: ['telegram'] })).toBe(true);
			expect(matchesAlert(sub, { channels: ['whatsapp'] })).toBe(false);
		});
	});

	describe('Storage status', () => {
		it('reports ephemeral / memory mode when ENABLE_FIRESTORE_ALERT_SUBSCRIBERS is not enabled', () => {
			const status = alertSubscriberService.getStorageStatus();
			expect(status.mode).toBe('ephemeral');
			expect(status.backend).toBe('memory');
			expect(status.enabled).toBe(false);
			expect(status.status).toBe('disabled');
			expect(typeof status.count).toBe('number');
			expect(typeof status.activeCount).toBe('number');
		});
	});
});
