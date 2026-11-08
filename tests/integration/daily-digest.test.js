'use strict';

jest.mock('firebase-admin');

const { getStatus } = require('../../src/controllers/status');
const { DailyDigestService, previousUtcDay } = require('../../src/services/digest/DailyDigestService');

describe('Daily digest integration', () => {
	const savedEnv = { ...process.env };
	afterEach(() => {
		process.env = { ...savedEnv };
		jest.clearAllMocks();
	});

	test('full previous-day aggregation renders sections in order and formats within Telegram limits', async () => {
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
		const svc = new DailyDigestService({
			getAlertStorage: () => ({
				summarizeAlerts: jest.fn(async () => ({
					totalAlerts: 12,
					bySource: { webhook: 9, 'market-scanner': 3 },
					delivery: { byChannel: { telegram: { total: 12, success: 12, failure: 0 }, whatsapp: { total: 5, success: 5, failure: 0 } } },
					enrichment: { tokenUsage: { totalCost: 0.0123 } },
				})),
				listAlerts: jest.fn(async () => ({
					alerts: [
						{ source: 'market-scanner', symbol: 'BTCUSDT', exchange: 'BINANCE', score: 95, receivedAt: '2026-11-07T09:00:00.000Z' },
						{ source: 'market-scanner', symbol: 'ETHUSDT', exchange: 'BINANCE', score: 88, receivedAt: '2026-11-07T10:00:00.000Z' },
						{ source: 'market-scanner', symbol: 'SOLUSDT', exchange: 'BINANCE', score: 77, receivedAt: '2026-11-07T11:00:00.000Z' },
					],
				})),
			}),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({ hitRatePercent: 60, totalSignalsEligible: 20, totalSignalsEvaluated: 15, totalSignalsPending: 5 })),
				listOutcomes: jest.fn(async () => ({
					outcomes: [
						{ symbol: 'BTCUSDT', exchange: 'BINANCE', outcomes: { '1D': { status: 'evaluated', rMultiple: 2.5 } } },
						{ symbol: 'ETHUSDT', exchange: 'BINANCE', outcomes: { '1D': { status: 'evaluated', rMultiple: 1.9 } } },
						{ symbol: 'NVDA', exchange: 'NASDAQ', outcomes: { '1D': { status: 'evaluated', rMultiple: 2.1 } } },
					],
				})),
			}),
			sendTelegram: jest.fn(async () => ({ success: true, messageId: '999' })),
		});
		const sendTelegram = svc.sendTelegram;
		// wire firestore mock for reservation
		const docs = new Map();
		svc.getFirestoreFn = () => ({
			collection: () => ({ doc: () => ({ id: 'test-doc' }) }),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: false, data: () => undefined })),
				set: jest.fn((ref, data) => docs.set('test-doc', data)),
			})),
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const result = await svc.runDigestForDay(day, {});
		expect(result.sent).toBe(true);
		expect(result.messageId).toBe('999');
		expect(sendTelegram).toHaveBeenCalledTimes(1);
		const text = result.text;
		expect(text.length).toBeLessThanOrEqual(4000);
		const idxAlerts = text.indexOf('Alertas');
		const idxOutcomes = text.indexOf('Outcomes');
		const idxScanner = text.indexOf('Top scanner');
		const idxWinners = text.indexOf('Top outcome');
		const idxSpend = text.indexOf('Gasto');
		expect(idxAlerts).toBeGreaterThan(0);
		expect(idxOutcomes).toBeGreaterThan(idxAlerts);
		expect(idxScanner).toBeGreaterThan(idxOutcomes);
		expect(idxWinners).toBeGreaterThan(idxScanner);
		expect(idxSpend).toBeGreaterThan(idxWinners);
	});

	test('stateless digest status is projected through getStatus without chat id leakage', () => {
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
		process.env.DIGEST_DELIVERY_HOUR_UTC = '13';
		process.env.DIGEST_MAX_PREVIOUS_DAY_SPEND_USD = '50';
		const status = getStatus({ skipTelemetrySync: true });
		expect(status.featureFlags.dailyDigest).toBe(true);
		const dd = status.dependencies.dailyDigest;
		expect(dd).toMatchObject({ enabled: true, deliveryHourUtc: 13, maxSpendUsd: 50 });
		expect(JSON.stringify(dd)).not.toContain('-100123');
	});
});
