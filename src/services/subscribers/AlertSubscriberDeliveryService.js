'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { fetch: undiciFetch } = require('undici');
const {
	validateCallbackUrl,
	createPinnedCallbackDispatcher,
	sanitizeCallbackUrlForLog,
	NON_RETRYABLE_CALLBACK_STATUSES,
} = require('../../lib/callbackUrl');
const {
	alertSubscriberService: defaultSubscriberService,
	matchesAlert,
} = require('./AlertSubscriberService');
const { trackBackgroundTask } = require('../../lib/backgroundTaskTracker');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

function computeHmacSignature({ secret, timestamp, event, deliveryId, payloadStr }) {
	if (!secret) return null;
	const canonicalInput = [timestamp, event, deliveryId, payloadStr].join('\n');
	return crypto.createHmac('sha256', secret).update(canonicalInput).digest('hex');
}

class AlertSubscriberDeliveryService {
	constructor(options = {}) {
		this.subscriberService = options.subscriberService || defaultSubscriberService;
		this.fetchFn = options.fetchFn || null;
	}

	_getFetch() {
		if (this.fetchFn) return this.fetchFn;
		return globalThis.fetch || undiciFetch;
	}

	async deliverToSubscriber(subscriber, payloadData, options = {}) {
		const event = options.event || 'alert.dispatched';
		const maxAttempts = options.maxAttempts || DEFAULT_MAX_ATTEMPTS;
		let delayMs = options.retryDelayMs !== undefined ? options.retryDelayMs : DEFAULT_RETRY_DELAY_MS;
		const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

		const payloadStr = JSON.stringify(payloadData);
		const secret = subscriber.secret;
		const url = subscriber.url;

		const attempts = [];
		let success = false;
		let lastStatusCode = null;
		let lastError = null;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const timestamp = new Date().toISOString();
			const deliveryId = uuidv4();

			const headers = {
				'Content-Type': 'application/json',
				'x-alert-subscriber-timestamp': timestamp,
				'x-alert-subscriber-event': event,
				'x-alert-subscriber-delivery-id': deliveryId,
			};

			if (secret) {
				headers['x-alert-subscriber-signature'] = computeHmacSignature({
					secret,
					timestamp,
					event,
					deliveryId,
					payloadStr,
				});
			}

			// Validate URL for SSRF / private networks before each attempt
			const validation = await validateCallbackUrl(url);
			if (!validation.valid) {
				const isDnsFailure = validation.reason === 'dns';
				console.warn(
					`[AlertSubscriberDelivery] ${isDnsFailure ? 'Retrying subscriber webhook after DNS failure' : 'Aborting delivery to blocked URL'}:`,
					sanitizeCallbackUrlForLog(url),
				);
				attempts.push({
					attempt,
					timestamp,
					deliveryId,
					error: isDnsFailure ? 'DNS validation failed' : 'Callback URL blocked (private network)',
				});
				if (!isDnsFailure) {
					lastError = 'Blocked unsafe URL';
					break;
				}
				if (attempt < maxAttempts) {
					await new Promise((resolve) => setTimeout(resolve, delayMs));
					delayMs *= 2;
				}
				continue;
			}

			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
			const dispatcher = createPinnedCallbackDispatcher(validation.addresses);

			try {
				const fetchToUse = this._getFetch();
				const response = await fetchToUse(url, {
					method: 'POST',
					headers,
					body: payloadStr,
					signal: controller.signal,
					redirect: 'error',
					dispatcher,
				});

				if (response.body && typeof response.body.cancel === 'function') {
					try {
						const cancelRes = response.body.cancel();
						if (cancelRes && typeof cancelRes.catch === 'function') {
							await cancelRes.catch(() => {});
						}
					} catch (_) {}
				}

				lastStatusCode = response.status;
				const attemptInfo = {
					attempt,
					timestamp,
					deliveryId,
					statusCode: response.status,
				};

				if (response.ok) {
					attempts.push(attemptInfo);
					success = true;
					break;
				} else {
					attemptInfo.error = `HTTP ${response.status} ${response.statusText || ''}`;
					attempts.push(attemptInfo);

					if (NON_RETRYABLE_CALLBACK_STATUSES.has(response.status)) {
						lastError = attemptInfo.error;
						break;
					}
				}
			} catch (err) {
				const errorMsg = err.name === 'AbortError' ? `Request timed out after ${timeoutMs}ms` : err.message;
				attempts.push({
					attempt,
					timestamp,
					deliveryId,
					error: errorMsg,
				});
				lastError = errorMsg;
			} finally {
				clearTimeout(timeoutId);
			}

			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				delayMs *= 2;
			}
		}

		// Record delivery outcome (fail-open)
		try {
			if (subscriber.id) {
				await this.subscriberService.recordDelivery(subscriber.id, {
					success,
					timestamp: new Date().toISOString(),
				});
			}
		} catch (err) {
			console.warn('[AlertSubscriberDelivery] Failed to record delivery outcome:', err.message);
		}

		return {
			success,
			statusCode: lastStatusCode,
			error: success ? null : lastError,
			attempts,
		};
	}

	async dispatchAlert(alertData) {
		try {
			const subscribers = await this.subscriberService.listSubscribers({ includeSecret: true });
			if (!Array.isArray(subscribers) || subscribers.length === 0) {
				return;
			}

			const matching = subscribers.filter((sub) => matchesAlert(sub, alertData));
			if (matching.length === 0) {
				return;
			}

			const payload = {
				event: 'alert.dispatched',
				alertId: alertData.alertId || alertData.id || null,
				symbol: alertData.symbol || null,
				exchange: alertData.exchange || null,
				side: alertData.side || null,
				text: alertData.text || '',
				enriched: Boolean(alertData.enriched),
				enrichmentData: alertData.enrichmentData || alertData.enrichedAlert || null,
				channels: alertData.channels || [],
				source: alertData.source || 'webhook-alert',
				dispatchedAt: new Date().toISOString(),
			};

			const deliveryPromises = matching.map((sub) =>
				this.deliverToSubscriber(sub, payload).catch((err) => {
					console.warn(`[AlertSubscriberDelivery] Delivery to ${sanitizeCallbackUrlForLog(sub.url)} failed:`, err.message);
				}),
			);

			await Promise.allSettled(deliveryPromises);
		} catch (err) {
			console.warn('[AlertSubscriberDelivery] Error during alert fan-out:', err.message);
		}
	}

	async sendTestNotification(subscriber) {
		const testPayload = {
			event: 'subscriber.test',
			message: 'Cabros Bot Alert Subscriber Test Webhook',
			subscriberId: subscriber.id,
			timestamp: new Date().toISOString(),
		};

		return this.deliverToSubscriber(subscriber, testPayload, {
			event: 'subscriber.test',
			maxAttempts: 1,
		});
	}
}

const alertSubscriberDeliveryService = new AlertSubscriberDeliveryService();

module.exports = {
	AlertSubscriberDeliveryService,
	alertSubscriberDeliveryService,
	computeHmacSignature,
};
