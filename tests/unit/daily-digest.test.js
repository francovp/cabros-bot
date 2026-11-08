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
						{ source: 'market-scanner', symbol: 'BTCUSDT', exchange: 'BINANCE', score: 90, outcomes: { '1D': { status: 'evaluated', rMultiple: 0.5 } } },
						{ source: 'market-scanner', symbol: 'ETHUSDT', exchange: 'BINANCE', score: 80, outcomes: { '1D': { status: 'evaluated', rMultiple: 0.4 } } },
						{ symbol: 'NVDA', exchange: 'NASDAQ', score: 95, outcomes: { '1D': { status: 'evaluated', rMultiple: 2.1 } } },
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

describe('DailyDigestService ranking units', () => {
	const savedEnv = { ...process.env };
	beforeEach(() => {
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
	});
	afterEach(() => { process.env = { ...savedEnv }; jest.clearAllMocks(); });

	test('percentage return alone never ranks as R winner or scanner hit', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 0 } } })),
				listOutcomes: jest.fn(async () => ({
					outcomes: [
						{ source: 'market-scanner', symbol: 'FAKE', exchange: 'NASDAQ', outcomes: { '1D': { status: 'evaluated', return: 5 } } },
						{ source: 'webhook', symbol: 'REAL', exchange: 'BINANCE', score: 99, outcomes: { '1D': { status: 'evaluated', rMultiple: 1.5 } } },
					],
				})),
			}),
		});
		const agg = await svc.aggregateForDay(previousUtcDay(new Date('2026-11-08T13:30:00Z')));
		// FAKE has no score and no rMultiple: excluded from both lists.
		expect(agg.topScannerHits.map((o) => o.symbol)).not.toContain('FAKE');
		expect(agg.topWinners.map((o) => o.symbol)).toEqual(['REAL']);
	});
});

describe('DailyDigestService pagination', () => {
	const savedEnv = { ...process.env };
	beforeEach(() => {
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
	});
	afterEach(() => { process.env = { ...savedEnv }; jest.clearAllMocks(); });

	test('pages through outcomes cursor so older high-R signals are ranked', async () => {
		const listOutcomes = jest.fn()
			.mockResolvedValueOnce({ outcomes: [{ symbol: 'NEW', exchange: 'BINANCE', outcomes: { '1D': { status: 'evaluated', rMultiple: 0.5 } } }], hasMore: true, nextBefore: 'cursor-2' })
			.mockResolvedValueOnce({ outcomes: [{ symbol: 'OLDWIN', exchange: 'BINANCE', outcomes: { '1D': { status: 'evaluated', rMultiple: 3.0 } } }], hasMore: false, nextBefore: null });
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 50 } } })),
				listOutcomes,
			}),
		});
		const agg = await svc.aggregateForDay(previousUtcDay(new Date('2026-11-08T13:30:00Z')));
		expect(listOutcomes).toHaveBeenCalledTimes(2);
		expect(listOutcomes.mock.calls[1][0].before).toBe('cursor-2');
		expect(agg.topWinners[0].symbol).toBe('OLDWIN');
	});
});

describe('DailyDigestService Codex review follow-ups', () => {
	const savedEnv = { ...process.env };
	beforeEach(() => {
		process.env.ENABLE_DAILY_DIGEST = 'true';
		process.env.ENABLE_FIRESTORE_DIGEST_RUNS = 'true';
		process.env.TELEGRAM_DIGEST_CHAT_ID = '-100123';
	});
	afterEach(() => { process.env = { ...savedEnv }; jest.clearAllMocks(); });

	test('sanitizes Telegram errors so bot tokens are never stored or exposed', async () => {
		const rawError = new Error('invalid json response body at https://api.telegram.org/bot987654321:AAFakeTokenForTest1234567890abcdef/sendMessage reason: Unexpected token');
		const docs = new Map();
		const firestore = {
			collection: () => ({ doc: () => ({ id: 'x' }) }),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: false, data: () => undefined })),
				set: jest.fn((ref, data) => docs.set(ref.id, data)),
			})),
		};
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 0 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			sendTelegram: jest.fn(async () => { throw rawError; }),
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		await expect(svc.runDigestForDay(day)).rejects.toThrow();
		const st = svc.getStatus();
		expect(st.lastRunError).not.toContain('987654321:AAFakeTokenForTest1234567890abcdef');
		expect(st.lastRunError).toContain('[REDACTED]');
		expect(st.lastRunStatus).toBe('ambiguous');
	});

	test('normalizes directional scanner scores so strong bearish hits rank above weaker ones', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 0, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 50 } } })),
				listOutcomes: jest.fn(async () => ({
					outcomes: [
						{ source: 'market-scanner', symbol: 'WEAK_SELL', exchange: 'BINANCE', score: -0.2 },
						{ source: 'market-scanner', symbol: 'STRONG_SELL', exchange: 'BINANCE', score: -0.95 },
						{ source: 'market-scanner', symbol: 'MEDIUM_BUY', exchange: 'BINANCE', score: 0.5 },
					],
				})),
			}),
		});
		const agg = await svc.aggregateForDay(previousUtcDay(new Date('2026-11-08T13:30:00Z')));
		expect(agg.topScannerHits.map((o) => o.symbol)).toEqual(['STRONG_SELL', 'MEDIUM_BUY', 'WEAK_SELL']);
	});

	test('distinguishes failed summarizeAlerts query from zero activity and defers delivery', async () => {
		const sendTelegram = jest.fn();
		const svc = new DailyDigestService({
			getAlertStorage: () => ({
				summarizeAlerts: jest.fn(async () => { throw new Error('Firestore timeout'); }),
			}),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 50 } } })),
				listOutcomes: jest.fn(async () => ({ outcomes: [] })),
			}),
			getFirestoreFn: () => ({ collection: () => ({ doc: () => ({ id: 'x' }) }), runTransaction: jest.fn() }),
			sendTelegram,
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		// In dryRun, text renders N/D instead of 0 or $0.0000
		const dryResult = await svc.runDigestForDay(day, { dryRun: true });
		expect(dryResult.text).toContain('Alertas:* N/D');
		expect(dryResult.text).toContain('Gasto LLM:* N/D');
		expect(dryResult.text).not.toContain('$0.0000');

		// In real send, delivery is deferred so the day is not permanently deduplicated with zero data
		const realResult = await svc.runDigestForDay(day, { dryRun: false });
		expect(realResult.skipped).toBe(true);
		expect(realResult.reason).toBe('alert-summary-unavailable');
		expect(sendTelegram).not.toHaveBeenCalled();
		expect(svc.getStatus().status).toBe('degraded');
	});

	test('Telegram 429 rate limit is marked rate-limited and allows retry after cooldown', async () => {
		const rateLimitError = new Error('Too Many Requests: retry after 2');
		rateLimitError.statusCode = 429;
		rateLimitError.response = { error_code: 429, parameters: { retry_after: 2 } };

		const docs = new Map();
		const docId = '2026-11-07__' + require('crypto').createHash('sha256').update('-100123').digest('hex').slice(0, 16);
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({ id: docId })) })),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: docs.has(docId), data: () => docs.get(docId) })),
				set: jest.fn((ref, data) => docs.set(ref.id || docId, { ...docs.get(ref.id || docId), ...data })),
			})),
		};

		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 1, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 0 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			sendTelegram: jest.fn(async () => { throw rateLimitError; }),
		});

		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		await expect(svc.runDigestForDay(day)).rejects.toThrow('Too Many Requests');
		expect(svc.getStatus().lastRunStatus).toBe('rate-limited');

		// During cooldown, reservation is rate-limited
		const resImmediate = await svc.reserveDigest(day.dateStr, '-100123');
		expect(resImmediate.ok).toBe(false);
		expect(resImmediate.reason).toBe('rate-limited');

		// After cooldown passes, reservation succeeds so the digest is not lost forever
		const savedDoc = docs.get(docId);
		savedDoc.updatedAt = new Date(Date.now() - 5000).toISOString();
		docs.set(docId, savedDoc);

		const resAfterCooldown = await svc.reserveDigest(day.dateStr, '-100123');
		expect(resAfterCooldown.ok).toBe(true);
		expect(resAfterCooldown.reason).toBe('reserved');
	});

	test('bounds direct Telegram send with abortable deadline and preserves ambiguous outcome on timeout', async () => {
		const stallingBot = {
			telegram: {
				sendMessage: jest.fn((_chatId, _text, { signal }) => new Promise((_, reject) => {
					signal.addEventListener('abort', () => reject(new Error('Operation aborted')), { once: true });
				})),
			},
		};

		const docs = new Map();
		const docId = '2026-11-07__' + require('crypto').createHash('sha256').update('-100123').digest('hex').slice(0, 16);
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({ id: docId })) })),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: docs.has(docId), data: () => docs.get(docId) })),
				set: jest.fn((ref, data) => docs.set(ref.id || docId, { ...docs.get(ref.id || docId), ...data })),
			})),
		};

		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 1, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 0 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			botGetter: () => stallingBot,
		});

		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		// Use a short timeoutMs for fast unit test
		await expect(svc.runDigestForDay(day, { timeoutMs: 50 })).rejects.toThrow();
		expect(svc.getStatus().lastRunStatus).toBe('ambiguous');
		expect(docs.get(docId).status).toBe('ambiguous');
	});

	test('marks alerts and LLM spend as truncated when 1000 alert ceiling is reached', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({
				summarizeAlerts: jest.fn(async () => ({
					totalAlerts: 1000,
					bySource: { webhook: 1000 },
					delivery: { byChannel: {} },
					enrichment: { tokenUsage: { totalCost: 25.0 } },
				})),
			}),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 0 } } })), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
		});
		const agg = await svc.aggregateForDay(previousUtcDay(new Date('2026-11-08T13:30:00Z')));
		expect(agg.alertsTruncated).toBe(true);
		const text = svc.formatDigest(agg);
		expect(text).toContain('1000\\+ \\(límite 1000 alcanzado\\)');
		expect(text).toContain('25\\.0000\\+ \\(parcial\\)');
		expect(text).toContain('Muestra limitada a 1000 alertas');
	});

	test('keeps ranked scanner candidates separate from raw unranked indicator scores', async () => {
		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 1, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({
				summarizeOutcomes: jest.fn(async () => ({ windows: { '1D': { hitRatePercent: 50 } } })),
				listOutcomes: jest.fn(async () => ({
					outcomes: [
						// Preset unranked scan with raw RSI indicator score of 75
						{ source: 'scanner-preset', symbol: 'RSI_OUTLIER', exchange: 'BINANCE', score: 75, confidenceScore: null },
						// Ranked market scan with conviction score 0.95
						{ source: 'market-scanner', symbol: 'HIGH_CONVICTION', exchange: 'BINANCE', score: -0.95, confidenceScore: 0.8 },
					],
				})),
			}),
		});
		const agg = await svc.aggregateForDay(previousUtcDay(new Date('2026-11-08T13:30:00Z')));
		// Ranked candidate must not be eclipsed by raw unranked RSI score 75
		expect(agg.topScannerHits[0].symbol).toBe('HIGH_CONVICTION');
		expect(agg.topScannerHits.map((h) => h.symbol)).not.toContain('RSI_OUTLIER');
	});

	test('treats a null alert summary from disabled storage as unavailable and defers delivery', async () => {
		const sendTelegram = jest.fn();
		const svc = new DailyDigestService({
			getAlertStorage: () => ({
				summarizeAlerts: jest.fn(async () => null),
			}),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({})), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => ({ collection: () => ({ doc: () => ({ id: 'x' }) }), runTransaction: jest.fn() }),
			sendTelegram,
		});
		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		const res = await svc.runDigestForDay(day, { dryRun: false });
		expect(res.skipped).toBe(true);
		expect(res.reason).toBe('alert-summary-unavailable');
		expect(sendTelegram).not.toHaveBeenCalled();
		expect(svc.getStatus().status).toBe('degraded');
	});

	test('incidental 429 in error text without structured Telegram error code leaves delivery ambiguous', async () => {
		const docs = new Map();
		const docId = '2026-11-07__' + require('crypto').createHash('sha256').update('-100123').digest('hex').slice(0, 16);
		const firestore = {
			collection: jest.fn(() => ({ doc: jest.fn(() => ({ id: docId })) })),
			runTransaction: jest.fn(async (cb) => cb({
				get: jest.fn(async () => ({ exists: docs.has(docId), data: () => docs.get(docId) })),
				set: jest.fn((ref, data) => docs.set(ref.id || docId, { ...docs.get(ref.id || docId), ...data })),
			})),
		};

		// Telegraf JSON parse error mentioning request URL with token containing "429"
		const parseErrorWith429InUrl = new Error('invalid json response body at https://api.telegram.org/bot123456429:AAFakeToken/sendMessage reason: Unexpected token <');
		// Notably no statusCode and no response.error_code

		const svc = new DailyDigestService({
			getAlertStorage: () => ({ summarizeAlerts: jest.fn(async () => ({ totalAlerts: 1, bySource: {}, delivery: { byChannel: {} } })) }),
			getOutcomeStorage: () => ({ summarizeOutcomes: jest.fn(async () => ({})), listOutcomes: jest.fn(async () => ({ outcomes: [] })) }),
			getFirestoreFn: () => firestore,
			sendTelegram: jest.fn(async () => { throw parseErrorWith429InUrl; }),
		});

		const day = previousUtcDay(new Date('2026-11-08T13:30:00Z'));
		await expect(svc.runDigestForDay(day)).rejects.toThrow();
		expect(svc.getStatus().lastRunStatus).toBe('ambiguous');
		expect(docs.get(docId).status).toBe('ambiguous');
		expect(docs.get(docId).retryAfterSeconds).toBeUndefined();
	});

	test('escapes underscores and asterisks in dynamic sources, symbols and channels for MarkdownV2', () => {
		const svc = new DailyDigestService();
		const agg = {
			dateStr: '2026-11-07',
			totalAlerts: 5,
			bySource: { tradingview_alert: 3, custom_source_v1: 2 },
			byChannel: { whatsapp_group: { success: 2, total: 2 } },
			outcomes: { hitRatePercent: 66.7, eligible: 3, evaluated: 2, pending: 1 },
			topScannerHits: [
				{ symbol: 'BTC_USDT', exchange: 'BINANCE_FUTURES', score: 0.9 },
				{ symbol: 'ETH*SPECIAL', exchange: 'BYBIT', score: 0.8 },
			],
			topWinners: [
				{ symbol: 'SOL_USDT', exchange: 'BINANCE', outcomes: { '1D': { status: 'evaluated', rMultiple: 2.5 } } },
			],
			totalSpend: 0.05,
			maxSpend: 50,
			spendExceeded: false,
		};
		const text = svc.formatDigest(agg);
		// Underscores and asterisks must be escaped
		expect(text).toContain('tradingview\\_alert');
		expect(text).toContain('custom\\_source\\_v1');
		expect(text).toContain('whatsapp\\_group');
		expect(text).toContain('BINANCE\\_FUTURES:BTC\\_USDT');
		expect(text).toContain('ETH\\*SPECIAL');
		expect(text).toContain('SOL\\_USDT');
		// Must not contain unescaped dynamic underscores (excluding markdown bold * tags)
		expect(text).not.toMatch(/(?<!\\)_/);
	});
});
