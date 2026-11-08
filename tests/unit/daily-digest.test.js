'use strict';

const { DailyDigestService, previousUtcDay } = require('../../src/services/digest/DailyDigestService');

describe('DailyDigestService', () => {
	let savedEnv;
	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
		process.env.DIGEST_DELIVERY_HOUR_UTC = '13';
		process.env.DIGEST_MAX_PREVIOUS_DAY_SPEND_USD = '50';
	});
	afterEach(() => {
		process.env = savedEnv;
		jest.clearAllMocks();
	});

	test('previousUtcDay returns prior UTC day boundaries', () => {
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		expect(day.dateStr).toBe('2026-11-07');
		expect(day.from.toISOString()).toBe('2026-11-07T00:00:00.000Z');
		expect(day.to.toISOString()).toBe('2026-11-08T00:00:00.000Z');
	});

	test('aggregateForDay composes alert and outcome summaries with matured 1D coverage', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({
				summarizeAlerts: jest.fn(async () => ({
					totalAlerts: 12,
					bySource: { webhook: 9, 'market-scanner': 3 },
					delivery: { byChannel: { telegram: { total: 12, success: 12, failure: 0 } } },
					enrichment: { tokenUsage: { totalCost: 51 } },
				})),
				listAlerts: jest.fn(async () => ({
					alerts: [
						{ source: 'market-scanner', symbol: 'BTCUSDT', exchange: 'BINANCE', score: 90, receivedAt: '2026-11-07T10:00:00.000Z' },
						{ source: 'market-scanner', symbol: 'ETHUSDT', exchange: 'BINANCE', score: 80, receivedAt: '2026-11-07T11:00:00.000Z' },
						{ source: 'webhook', symbol: 'SOLUSDT', receivedAt: '2026-11-07T12:00:00.000Z' },
					],
				})),
			}),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({
					windows: { '1D': { hitRatePercent: 55 } },
					totalSignalsEligible: 10,
					totalSignalsEvaluated: 8,
					totalSignalsPending: 2,
				})),
				listOutcomes: jest.fn(async () => ({
					outcomes: [
						{ symbol: 'NVDA', exchange: 'NASDAQ', outcomes: { '1D': { status: 'evaluated', rMultiple: 2.1 } } },
						{ symbol: 'AAPL', exchange: 'NASDAQ', outcomes: { '1D': { status: 'evaluated', rMultiple: 1.1 } } },
						{ symbol: 'TSLA', exchange: 'NASDAQ', outcomes: { '1D': { status: 'pending' } } },
					],
				})),
			}),
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const agg = await svc.aggregateForDay(day);
		expect(agg.totalAlerts).toBe(12);
		expect(agg.bySource).toEqual({ webhook: 9, 'market-scanner': 3 });
		expect(agg.outcomes).toEqual({ hitRatePercent: 55, eligible: 10, evaluated: 8, pending: 2 });
		expect(agg.topScannerHits[0].symbol).toBe('BTCUSDT');
		expect(agg.topWinners[0].symbol).toBe('NVDA');
		expect(agg.spendExceeded).toBe(true);
		const text = svc.formatDigest(agg);
		expect(text).toContain('Daily Digest');
		expect(text).toContain('hit');
		expect(text).toContain('BTCUSDT');
		expect(text).toContain('NVDA');
		expect(text).toContain('superó');
	});

	test('runDigestForDay dryRun returns formatted text without reserving or sending', async () => {
		const sendTelegram = jest.fn();
		const firestore = { collection: jest.fn(), runTransaction: jest.fn() };
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 1, bySource: { webhook: 1 }, delivery: { byChannel: {} }, enrichment: { tokenUsage: { totalCost: 0.01 } } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 50 } }, totalSignalsEligible: 2, totalSignalsEvaluated: 2, totalSignalsPending: 0 })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			sendTelegram,
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const result = await svc.runDigestForDay(day, { dryRun: true });
		expect(result.dryRun).toBe(true);
		expect(result.text).toContain('Daily Digest');
		expect(sendTelegram).not.toHaveBeenCalled();
		expect(firestore.runTransaction).not.toHaveBeenCalled();
	});

	test('send is omitted and status is degraded when durable runs are disabled', async () => {
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'false';
		const sendTelegram = jest.fn();
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({})), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => null,
			sendTelegram,
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const result = await svc.runDigestForDay(day, {});
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe('digest-runs-disabled');
		expect(sendTelegram).not.toHaveBeenCalled();
		expect(svc.getStatus().status).toBe('degraded');
	});

	test('multi-replica lease contention: already-sent reservation skips without sending', async () => {
		const docs = new Map();
		const docId = '2026-11-07__' + require('crypto').createHash('sha256').update('-100123').digest('hex').slice(0, 16);
		docs.set(docId, { status: 'sent' });
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({ id: docId })) })),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: true, data: () => docs.get(docId) })),
				set: jest.fn((ref, data) => docs.set(ref.id, { ...docs.get(ref.id), ...data })),
			})),
		};
		const sendTelegram = jest.fn();
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({})), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			sendTelegram,
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const result = await svc.runDigestForDay(day, {});
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe('already-sent');
		expect(sendTelegram).not.toHaveBeenCalled();
	});

	test('ambiguous send is marked ambiguous and never auto-retried', async () => {
		const docs = new Map();
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({ id: 'x' })) })),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: false, data: () => undefined })),
				set: jest.fn((ref, data) => docs.set(ref.id, data)),
			})),
		};
		// First run: reserved then send returns failure -> ambiguous.
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({})), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			sendTelegram: jest.fn(async () => ({ success: false, error: 'unknown-send-outcome' })),
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const result = await svc.runDigestForDay(day, {});
		expect(result.ambiguous).toBe(true);
		expect(svc.getStatus().lastRunStatus).toBe('ambiguous');

		// Second run against a firestore that reports ambiguous -> skipped, no send.
		const sendTelegram2 = jest.fn();
		const firestoreAmbiguous = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({ id: 'x' })) })),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: true, data: () => ({ status: 'ambiguous' }) })),
				set: jest.fn(),
			})),
		};
		const svc2 = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({})), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestoreAmbiguous,
			sendTelegram: sendTelegram2,
		});
		const result2 = await svc2.runDigestForDay(day, {});
		expect(result2.reason).toBe('ambiguous');
		expect(sendTelegram2).not.toHaveBeenCalled();
	});

	test('scheduled check skips before delivery hour', async () => {
		const svc = new DailyDigestService();
		const result = await svc.runScheduledCheck(new Date('2026-11-08T10:00:00Z'));
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe('before-delivery-hour');
	});

	test('status exposes dailyDigest fields without chat id', () => {
		const svc = new DailyDigestService();
		const st = svc.getStatus();
		expect(st).toMatchObject({ enabled: true, configured: true, deliveryHourUtc: 13, maxSpendUsd: 50 });
		expect(JSON.stringify(st)).not.toContain('-100123');
	});
});
describe('DailyDigestService Codex fixes', () => {
	const savedEnv = { ...process.env };
	beforeEach(() => {
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
	});
	afterEach(() => { process.env = { ...savedEnv }; jest.clearAllMocks(); });

	test('spend amount and budget warning are MarkdownV2-escaped', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} }, enrichment: { tokenUsage: { totalCost: 51 } } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 10 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
		});
		const agg = await svc.aggregateForDay(previousUtcDay(new Date('2026-11-08T13:30:00Z')));
		const text = svc.formatDigest(agg);
		expect(text).toContain('51\\.0000');
		expect(text).toContain('presupuesto\\.');
	});

	test('thrown transport error marks ambiguous not failed', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 10 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => ({
				collection: () => ({ doc: () => ({ id: 'x' }) }),
				runTransaction: jest.fn(async (cb) => cb({ get: jest.fn(async () => ({ exists: false, data: () => undefined })), set: jest.fn() })),
			}),
			sendTelegram: jest.fn(async () => { throw new Error('ECONNRESET'); }),
		});
		jest.spyOn(svc, 'markDigestDone');
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		await expect(svc.runDigestForDay(day)).rejects.toThrow('ECONNRESET');
		expect(svc.getStatus().lastRunStatus).toBe('ambiguous');
		const statuses = svc.markDigestDone.mock.calls.map((c) => c[3]);
		expect(statuses).toContain('sending');
		expect(statuses).toContain('ambiguous');
		expect(statuses).not.toContain('failed');
	});

	test('sending checkpoint prevents reclaim of in-flight reservation', async () => {
		const firestore = {
			collection: () => ({ doc: () => ({ id: 'x' }) }),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: true, data: () => ({ status: 'sending' }) })),
				set: jest.fn(),
			})),
		};
		const svc = new DailyDigestService({ getFirestoreFn: () => firestore });
		const res = await svc.reserveDigest('2026-11-07', '-100123');
		expect(res.ok).toBe(false);
		expect(res.reason).toBe('ambiguous');
	});

	test('on-demand send does not suppress scheduled destination', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })), listAlerts: jest.fn(async () => ({ alerts: [] })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 10 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => ({
				collection: () => ({ doc: () => ({ id: 'x' }) }),
				runTransaction: jest.fn(async (cb) => cb({ get: jest.fn(async () => ({ exists: false, data: () => undefined })), set: jest.fn() })),
			}),
			sendTelegram: jest.fn(async () => ({ success: true, messageId: '1' })),
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		await svc.runDigestForDay(day, { chatId: '-999' });
		expect(svc.lastRunKey).toBe(`${day.dateStr}|-999`);
		// Scheduled key is different destination, so already-sent shortcut must not fire.
		const check = await svc.runScheduledCheck(new Date('2026-11-08T13:30:00Z'));
		expect(check.skipped).not.toBe(true);
	});
});
