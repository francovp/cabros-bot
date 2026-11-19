'use strict';

const admin = require('firebase-admin');
const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');
const AlertStorageService = require('../../src/services/storage/AlertStorageService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');
const {
	computeWilsonCI95,
	computeExpectancyNormalCI95,
	evaluateStatisticalReliability,
	buildOutcomesLeaderboardFromDocs,
	normalizeLeaderboardOptions,
	queryOutcomesLeaderboard,
	clearLeaderboardCache,
	getLeaderboardCacheSize,
	MAX_LEADERBOARD_SCAN_DOCS,
} = require('../../src/services/storage/outcomesLeaderboard');

function buildDoc(id, {
	receivedAt = '2026-08-25T12:00:00.000Z',
	setupType = 'pullback',
	symbol = 'BTCUSDT',
	exchange = 'BINANCE',
	side = 'BUY',
	promptProvenance,
	window = '1D',
	status = 'evaluated',
	ret = 1.5,
	targetHit = true,
	stopHit = false,
	firstHit = 'target',
	rMultiple = 1.0,
	mae = -0.8,
	mfe = 2.4,
} = {}) {
	return {
		id,
		receivedAt: admin.firestore.Timestamp.fromDate(new Date(receivedAt)),
		requestId: `req-${id}`,
		source: 'webhook-alert',
		symbol,
		exchange,
		setupType,
		side,
		...(promptProvenance !== undefined ? { promptProvenance } : {}),
		outcomes: window
			? {
				[window]: {
					status,
					return: ret,
					targetHit,
					stopHit,
					firstHit,
					rMultiple,
					maxAdverseExcursion: mae,
					maxFavorableExcursion: mfe,
				},
			}
			: {},
	};
}

describe('Outcomes Leaderboard (#826)', () => {
	let savedEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		global.__firebaseAdminMockState.collections.clear();
		SignalOutcomeService._resetForTesting();
		remoteConfigService._resetForTesting();
		clearLeaderboardCache();
		jest.clearAllMocks();
	});

	afterEach(() => {
		Object.keys(process.env).forEach((key) => delete process.env[key]);
		Object.assign(process.env, savedEnv);
		remoteConfigService._resetForTesting();
		clearLeaderboardCache();
	});

	describe('Statistical Formulas (Wilson 95% & Normal-Approx Expectancy CI)', () => {
		it('computes exact Wilson 95% confidence interval for worked dataset', () => {
			// Worked example: 28 wins out of 42 trades (p = 2/3, z = 1.96)
			// pHat = 0.6667; Wilson lower = 0.5155, upper = 0.7899
			const ci = computeWilsonCI95(28, 42);
			expect(ci).toEqual({ lower: 0.5155, upper: 0.7899 });

			// Boundary cases clamped cleanly to [0, 1]
			expect(computeWilsonCI95(0, 10)).toEqual({ lower: 0, upper: 0.2775 });
			expect(computeWilsonCI95(10, 10)).toEqual({ lower: 0.7225, upper: 1 });
			expect(computeWilsonCI95(0, 0)).toEqual({ lower: 0, upper: 0 });
		});

		it('computes exact normal-approximation 95% CI for expectancyR and guards small m', () => {
			// Worked dataset: 4 values [-1, 1, 2, 2], mean = 1.0, sample variance = (4 + 0 + 1 + 1)/3 = 2.0
			// s = sqrt(2), SE = sqrt(2)/2 = sqrt(0.5) = 0.70710678, margin = 1.96 * 0.70710678 = 1.3859
			const rStats = computeExpectancyNormalCI95([-1, 1, 2, 2]);
			expect(rStats.expectancyR).toBe(1);
			expect(rStats.count).toBe(4);
			expect(rStats.expectancyRCI95).toEqual({
				lower: -0.3859,
				upper: 2.3859,
			});

			// Guards m = 1 and m = 0 without NaN or dividing by zero
			expect(computeExpectancyNormalCI95([1.5])).toEqual({
				expectancyR: 1.5,
				expectancyRCI95: null,
				stdDevR: null,
				count: 1,
			});
			expect(computeExpectancyNormalCI95([])).toEqual({
				expectancyR: null,
				expectancyRCI95: null,
				stdDevR: null,
				count: 0,
			});
		});

		it('flags reliability only when trades >= 30 and normal 95% CI excludes zero (both positive & negative)', () => {
			expect(evaluateStatisticalReliability(29, {
				expectancyR: 0.8,
				expectancyRCI95: { lower: 0.4, upper: 1.2 },
				count: 29,
			})).toEqual({
				isStatisticallyReliable: false,
				reliabilityNote: expect.stringContaining('< 30'),
			});

			expect(evaluateStatisticalReliability(35, {
				expectancyR: 0.42,
				expectancyRCI95: { lower: 0.12, upper: 0.72 },
				count: 35,
			})).toEqual({
				isStatisticallyReliable: true,
				reliabilityNote: expect.stringContaining('net-positive'),
			});

			expect(evaluateStatisticalReliability(38, {
				expectancyR: -0.42,
				expectancyRCI95: { lower: -0.68, upper: -0.16 },
				count: 38,
			})).toEqual({
				isStatisticallyReliable: true,
				reliabilityNote: expect.stringContaining('net-negative'),
			});

			expect(evaluateStatisticalReliability(35, {
				expectancyR: 0.1,
				expectancyRCI95: { lower: -0.15, upper: 0.35 },
				count: 35,
			})).toEqual({
				isStatisticallyReliable: false,
				reliabilityNote: expect.stringContaining('crosses zero'),
			});
		});
	});

	describe('Grouping, Partitioning, Ranking & Coverage', () => {
		it('aggregates worked cohort dataset, ranks by expectancy, and surfaces below-minTrades cohorts', () => {
			const nowMs = Date.parse('2026-08-28T00:00:00.000Z');
			const docs = [];

			// Cohort A (pullback): 42 trades -> 28 wins (+1.0R), 12 losses (-0.5R), 2 breakeven (0R)
			for (let i = 0; i < 28; i += 1) {
				docs.push({
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					setupType: 'pullback',
					side: 'BUY',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: 2.0,
							targetHit: true,
							stopHit: false,
							firstHit: 'target',
							rMultiple: 1.0,
							maxAdverseExcursion: -1.0,
							maxFavorableExcursion: 3.5,
						},
					},
				});
			}
			for (let i = 0; i < 12; i += 1) {
				docs.push({
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					setupType: 'pullback',
					side: 'BUY',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: -1.0,
							targetHit: false,
							stopHit: true,
							firstHit: 'stop',
							rMultiple: -0.5,
							maxAdverseExcursion: -2.0,
							maxFavorableExcursion: 0.5,
						},
					},
				});
			}
			for (let i = 0; i < 2; i += 1) {
				docs.push({
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					setupType: 'pullback',
					side: 'BUY',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: 0,
							targetHit: false,
							stopHit: false,
							firstHit: null,
							rMultiple: 0,
							maxAdverseExcursion: -0.5,
							maxFavorableExcursion: 0.5,
						},
					},
				});
			}

			// Cohort B (reversal): 30 losing trades (-0.4R)
			for (let i = 0; i < 30; i += 1) {
				docs.push({
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					setupType: 'reversal',
					side: 'SELL',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: -0.8,
							targetHit: false,
							stopHit: true,
							firstHit: 'stop',
							rMultiple: i % 2 === 0 ? -0.3 : -0.5,
							maxAdverseExcursion: -1.5,
							maxFavorableExcursion: 0.2,
						},
					},
				});
			}

			// Cohort C (scalp): 4 trades (< minTrades=10 -> unreliableCohorts)
			for (let i = 0; i < 4; i += 1) {
				docs.push({
					symbol: 'SOLUSDT',
					exchange: 'BINANCE',
					setupType: 'scalp',
					side: 'BUY',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: 4.0,
							targetHit: true,
							stopHit: false,
							firstHit: 'target',
							rMultiple: 2.0,
						},
					},
				});
			}

			// Pending doc (no evaluated 1D outcome)
			docs.push({
				symbol: 'NVDA',
				exchange: 'NASDAQ',
				setupType: 'breakout',
				side: 'BUY',
				outcomes: { '1D': { status: 'pending' } },
			});

			const normalized = normalizeLeaderboardOptions({
				groupBy: 'setupType',
				window: '1d',
				minTrades: 10,
				sort: 'expectancy',
				order: 'desc',
			}, nowMs);

			const res = buildOutcomesLeaderboardFromDocs(docs, normalized, 'req-worked');
			expect(res.window).toBe('1D');
			expect(res.requestId).toBe('req-worked');
			expect(res.ranked).toHaveLength(2);
			expect(res.excludedBelowThreshold).toBe(1);
			expect(res.unreliableCohorts).toEqual([
				{
					key: 'scalp',
					components: { setupType: 'scalp' },
					trades: 4,
					reason: 'below minTrades=10',
				},
			]);

			const first = res.ranked[0];
			expect(first.rank).toBe(1);
			expect(first.key).toBe('pullback');
			expect(first.trades).toBe(42);
			expect(first.wins).toBe(28);
			expect(first.losses).toBe(12);
			expect(first.breakeven).toBe(2);
			expect(first.hitRate).toBe(0.6667);
			expect(first.hitRateCI95).toEqual({ lower: 0.5155, upper: 0.7899 });
			expect(first.expectancyR).toBe(0.5238);
			expect(first.firstHitBreakdown).toEqual({ target: 28, stop: 12, neither: 2 });
			expect(first.isStatisticallyReliable).toBe(true);

			const second = res.ranked[1];
			expect(second.rank).toBe(2);
			expect(second.key).toBe('reversal');
			expect(second.expectancyR).toBe(-0.4);
			expect(second.isStatisticallyReliable).toBe(true);
			expect(second.reliabilityNote).toContain('net-negative');

			expect(res.coverage).toEqual(expect.objectContaining({
				scannedDocs: 77,
				docsWithEvaluatedWindow: 76,
				docsWithoutEvaluatedWindow: 1,
				totalCohorts: 3,
				unreliableCohortsCount: 1,
				truncatedByScanLimit: false,
			}));
			expect(res.warnings).toEqual([
				expect.stringContaining('1 of 77 scanned signals lack an evaluated'),
			]);
		});

		it('groups missing promptProvenance under promptSource: null instead of dropping records', () => {
			const docs = [
				{
					setupType: 'breakout',
					symbol: 'BTCUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					promptProvenance: { name: 'alert', source: 'langfuse' },
					outcomes: { '1D': { status: 'evaluated', return: 2, rMultiple: 1.2, targetHit: true } },
				},
				{
					setupType: 'breakout',
					symbol: 'ETHUSDT',
					exchange: 'BINANCE',
					side: 'BUY',
					// Legacy doc lacking promptProvenance
					outcomes: { '1D': { status: 'evaluated', return: -1, rMultiple: -0.6, stopHit: true } },
				},
			];
			const normalized = normalizeLeaderboardOptions({
				groupBy: 'promptSource',
				minTrades: 1,
			});
			const res = buildOutcomesLeaderboardFromDocs(docs, normalized);
			expect(res.ranked).toHaveLength(2);
			const legacy = res.ranked.find((c) => c.components.promptSource === null);
			const langfuse = res.ranked.find((c) => c.components.promptSource === 'langfuse');
			expect(legacy).toBeDefined();
			expect(legacy.key).toBe('unknown');
			expect(legacy.trades).toBe(1);
			expect(langfuse.trades).toBe(1);
		});

		it('isolates promptSource: null from literal promptSource="unknown" and breaks ties deterministically', () => {
			const docs = [
				{
					promptProvenance: { name: 'alert', source: 'unknown' },
					outcomes: { '1D': { status: 'evaluated', return: 1, rMultiple: 1 } },
				},
				{
					// Legacy doc without promptProvenance
					outcomes: { '1D': { status: 'evaluated', return: 1, rMultiple: 1 } },
				},
			];
			const res = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({ groupBy: 'promptSource', minTrades: 1 }),
			);
			expect(res.ranked).toHaveLength(2);
			expect(res.ranked.map((r) => r.components.promptSource)).toEqual([null, 'unknown']);
			expect(res.ranked.every((r) => r.key === 'unknown')).toBe(true);
		});

		it('supports 3-axis composite groupBy, normalizes axes, pushes null expectancyR last, and avoids mixing scales in sort=consistency', () => {
			const docs = [
				// 2 trades with finite R => consistency uses R CI lower bound (positive)
				...Array.from({ length: 2 }, () => ({
					setupType: 'pullback',
					side: 'BUY',
					exchange: 'binance',
					outcomes: { '1D': { status: 'evaluated', return: 2, rMultiple: 1.0 } },
				})),
				// 3 trades without R (expectancyR: null) even with high hitRate => ranks after finite R-CI in consistency/expectancy
				...Array.from({ length: 3 }, () => ({
					setupType: 'no-barriers',
					side: 'SELL',
					exchange: 'nasdaq',
					outcomes: { '1D': { status: 'evaluated', return: 2 } },
				})),
				// 2 trades with negative R
				...Array.from({ length: 2 }, () => ({
					setupType: 'loser',
					side: 'INVALID',
					exchange: 'bybit',
					outcomes: { '1D': { status: 'evaluated', return: -2, rMultiple: -1.0 } },
				})),
			];

			const expAsc = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({
					groupBy: 'setupType,side,exchange',
					minTrades: 1,
					sort: 'expectancy',
					order: 'asc',
				}),
			);
			// Null R still pushed after negative expectancyR in asc order
			expect(expAsc.ranked.map((r) => r.key)).toEqual([
				'loser:unknown:BYBIT',
				'pullback:BUY:BINANCE',
				'no-barriers:SELL:NASDAQ',
			]);

			const consistencyDesc = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({
					groupBy: 'setupType',
					minTrades: 1,
					sort: 'consistency',
					order: 'desc',
				}),
			);
			expect(consistencyDesc.ranked.map((r) => r.key)).toEqual([
				'pullback',
				'loser',
				'no-barriers',
			]);

			// When all cohorts lack R-multiples, sort=consistency falls back cleanly to Wilson lower bound
			const allNullR = buildOutcomesLeaderboardFromDocs(
				[
					...Array.from({ length: 10 }, () => ({
						setupType: 'all-win',
						outcomes: { '1D': { status: 'evaluated', return: 1 } },
					})),
					...Array.from({ length: 10 }, (_, idx) => ({
						setupType: 'mixed',
						outcomes: { '1D': { status: 'evaluated', return: idx < 5 ? 1 : -1 } },
					})),
				],
				normalizeLeaderboardOptions({ groupBy: 'setupType', minTrades: 1, sort: 'consistency', order: 'desc' }),
			);
			expect(allNullR.ranked.map((r) => r.key)).toEqual(['all-win', 'mixed']);
		});

		it('caps unreliableCohorts at 50 entries and honors limit slicing', () => {
			const docs = [];
			for (let i = 0; i < 55; i += 1) {
				docs.push({
					setupType: `small-${String(i).padStart(2, '0')}`,
					outcomes: { '1D': { status: 'evaluated', return: 1, rMultiple: 1 } },
				});
			}
			for (let j = 0; j < 3; j += 1) {
				for (let k = 0; k < 3; k += 1) {
					docs.push({
						setupType: `big-${j}`,
						outcomes: { '1D': { status: 'evaluated', return: 1 + j, rMultiple: 1 + j } },
					});
				}
			}

			const res = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({ minTrades: 2, limit: 2 }),
			);
			expect(res.ranked).toHaveLength(2);
			expect(res.excludedBelowThreshold).toBe(55);
			expect(res.unreliableCohorts).toHaveLength(50);
			expect(res.warnings.some((w) => w.includes('Showing top 50 of 55'))).toBe(true);
		});

		it('marks 30+ trades lacking sufficient R-multiples as statistically unreliable', () => {
			expect(evaluateStatisticalReliability(32, {
				expectancyR: 0.5,
				expectancyRCI95: null,
				count: 1,
			})).toEqual({
				isStatisticallyReliable: false,
				reliabilityNote: expect.stringContaining('insufficient R-multiple data'),
			});
		});

		it('supports sort=hitRate&order=asc, sort=sampleSize&order=desc, and sort=consistency', () => {
			const docs = [];
			// Cohort 'high-n': 15 trades, hitRate 0.6, R=0.5 (all equal R => tight CI)
			for (let i = 0; i < 15; i += 1) {
				docs.push({
					setupType: 'high-n',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: i < 9 ? 1.5 : -1,
							rMultiple: i < 9 ? 1.0 : -0.25,
						},
					},
				});
			}
			// Cohort 'high-hit': 10 trades, hitRate 0.9, R=0.3
			for (let i = 0; i < 10; i += 1) {
				docs.push({
					setupType: 'high-hit',
					outcomes: {
						'1D': {
							status: 'evaluated',
							return: i < 9 ? 1.0 : -2.0,
							rMultiple: i < 9 ? 0.4 : -0.6,
						},
					},
				});
			}

			const hitAsc = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({ minTrades: 10, sort: 'hitRate', order: 'asc' }),
			);
			expect(hitAsc.ranked.map((r) => r.key)).toEqual(['high-n', 'high-hit']);

			const sampleDesc = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({ minTrades: 10, sort: 'sampleSize', order: 'desc' }),
			);
			expect(sampleDesc.ranked.map((r) => r.key)).toEqual(['high-n', 'high-hit']);

			const consistencyDesc = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({ minTrades: 10, sort: 'consistency', order: 'desc' }),
			);
			expect(consistencyDesc.ranked).toHaveLength(2);
			expect(consistencyDesc.ranked[0].expectancyRCI95.lower)
				.toBeGreaterThanOrEqual(consistencyDesc.ranked[1].expectancyRCI95.lower);
		});

		it('emits truncation warning when scanned docs reach MAX_LEADERBOARD_SCAN_DOCS', () => {
			const docs = Array.from({ length: MAX_LEADERBOARD_SCAN_DOCS }, (_, idx) => ({
				setupType: 'breakout',
				outcomes: {
					'1D': {
						status: 'evaluated',
						return: idx % 2 === 0 ? 1.5 : -0.5,
						rMultiple: idx % 2 === 0 ? 1.0 : -0.5,
					},
				},
			}));
			const res = buildOutcomesLeaderboardFromDocs(
				docs,
				normalizeLeaderboardOptions({ minTrades: 10 }),
			);
			expect(res.coverage.truncatedByScanLimit).toBe(true);
			expect(res.warnings.some((w) => w.includes('1000-document cap'))).toBe(true);
		});
	});

	describe('Option Validation & Bounds', () => {
		it('rejects minTrades > 1000, limit > 100, span > 31 days, and unsupported params with INVALID_REQUEST', () => {
			expect(() => normalizeLeaderboardOptions({ minTrades: 1001 })).toThrow(/minTrades/);
			expect(() => normalizeLeaderboardOptions({ minTrades: 0 })).toThrow(/minTrades/);
			expect(() => normalizeLeaderboardOptions({ minTrades: '10.5' })).toThrow(/minTrades/);
			expect(() => normalizeLeaderboardOptions({ limit: 101 })).toThrow(/limit/);
			expect(() => normalizeLeaderboardOptions({ limit: 0 })).toThrow(/limit/);
			expect(() => normalizeLeaderboardOptions({ sort: 'sharpe' })).toThrow(/sort/);
			expect(() => normalizeLeaderboardOptions({ order: 'sideways' })).toThrow(/order/);
			expect(() => normalizeLeaderboardOptions({ window: '5m' })).toThrow(/window/);
			expect(() => normalizeLeaderboardOptions({ groupBy: 'foo' })).toThrow(/groupBy/);
			expect(() => normalizeLeaderboardOptions({ groupBy: 'setupType,symbol,exchange,side' })).toThrow(/At most 3/);
			expect(() => normalizeLeaderboardOptions({
				from: '2026-08-30T00:00:00.000Z',
				to: '2026-08-01T00:00:00.000Z',
			})).toThrow(/before or equal/);
			expect(() => normalizeLeaderboardOptions({
				from: '2026-07-01T00:00:00.000Z',
				to: '2026-08-15T00:00:00.000Z',
			})).toThrow(/31 days/);

			try {
				normalizeLeaderboardOptions({ sort: 'bad' });
			} catch (err) {
				expect(err.code).toBe('INVALID_REQUEST');
				expect(err.statusCode).toBe(400);
			}
		});
	});

	describe('60s In-Process Memoization Cache & Firestore Integration', () => {
		it('caches identical parameters for 60s, isolates requestId and filter variants, and enforces bounded FIFO eviction', async () => {
			const fetchDocs = jest.fn().mockResolvedValue([
				{
					setupType: 'breakout',
					exchange: 'BINANCE',
					outcomes: {
						'1D': { status: 'evaluated', return: 2, rMultiple: 1.5 },
						'4h': { status: 'evaluated', return: 1, rMultiple: 0.8 },
					},
				},
			]);

			const t0 = Date.parse('2026-08-28T12:00:00.000Z');
			const first = await queryOutcomesLeaderboard(
				{ groupBy: 'setupType', window: '1D', minTrades: 1, requestId: 'req-cache-1' },
				{ fetchDocs, nowMs: t0 },
			);
			const second = await queryOutcomesLeaderboard(
				{ groupBy: 'setupType', window: '1D', minTrades: 1 },
				{ fetchDocs, nowMs: t0 + 30000 },
			);

			expect(fetchDocs).toHaveBeenCalledTimes(1);
			expect(first.requestId).toBe('req-cache-1');
			// Cache-hitting call omitting requestId must NEVER leak 'req-cache-1'
			expect(second.requestId).toBeNull();
			expect({ ...second, requestId: 'req-cache-1' }).toEqual(first);
			expect(second).not.toBe(first);

			// Mutating caller response must not corrupt cached entry
			second.ranked[0].key = 'MUTATED';
			const third = await queryOutcomesLeaderboard(
				{ groupBy: 'setupType', window: '1D', minTrades: 1, requestId: 'req-cache-3' },
				{ fetchDocs, nowMs: t0 + 30001 },
			);
			expect(third.ranked[0].key).toBe('breakout');
			expect(third.requestId).toBe('req-cache-3');

			// Different groupBy, window, minTrades, sort, order, limit, from/to miss cache cleanly
			await queryOutcomesLeaderboard({ groupBy: 'exchange', window: '1D', minTrades: 1 }, { fetchDocs, nowMs: t0 + 30000 });
			await queryOutcomesLeaderboard({ groupBy: 'setupType', window: '4h', minTrades: 1 }, { fetchDocs, nowMs: t0 + 30000 });
			await queryOutcomesLeaderboard({ groupBy: 'setupType', window: '1D', minTrades: 2 }, { fetchDocs, nowMs: t0 + 30000 });
			await queryOutcomesLeaderboard({ groupBy: 'setupType', window: '1D', minTrades: 1, sort: 'hitRate' }, { fetchDocs, nowMs: t0 + 30000 });
			await queryOutcomesLeaderboard({ groupBy: 'setupType', window: '1D', minTrades: 1, order: 'asc' }, { fetchDocs, nowMs: t0 + 30000 });
			await queryOutcomesLeaderboard({ groupBy: 'setupType', window: '1D', minTrades: 1, limit: 5 }, { fetchDocs, nowMs: t0 + 30000 });
			await queryOutcomesLeaderboard({
				groupBy: 'setupType',
				window: '1D',
				minTrades: 1,
				from: '2026-08-21T00:00:00.000Z',
				to: '2026-08-28T00:00:00.000Z',
			}, { fetchDocs, nowMs: t0 + 30000 });
			expect(fetchDocs).toHaveBeenCalledTimes(8);
			expect(getLeaderboardCacheSize()).toBe(8);

			// After 60s TTL, refreshes
			await queryOutcomesLeaderboard(
				{ groupBy: 'setupType', window: '1D', minTrades: 1 },
				{ fetchDocs, nowMs: t0 + 60001 },
			);
			expect(fetchDocs).toHaveBeenCalledTimes(9);

			// Bounded eviction at MAX_LEADERBOARD_CACHE_ENTRIES = 128
			clearLeaderboardCache();
			for (let idx = 0; idx < 135; idx += 1) {
				await queryOutcomesLeaderboard(
					{ minTrades: idx + 1 },
					{ fetchDocs, nowMs: t0 },
				);
			}
			expect(getLeaderboardCacheSize()).toBe(128);
		});

		it('reads from Firestore via SignalOutcomeService, persists promptProvenance, and invalidates cache on recordSignal', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			process.env.ENABLE_FIRESTORE_ALERT_STORAGE = 'true';
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';

			const docsMap = new Map();
			for (let i = 0; i < 12; i += 1) {
				const doc = buildDoc(`sig-${i}`, {
					setupType: 'pullback',
					promptProvenance: { name: 'alert', source: 'langfuse', version: 3 },
				});
				const id = doc.id;
				delete doc.id;
				docsMap.set(id, doc);
			}
			global.__firebaseAdminMockState.collections.set(SignalOutcomeService.COLLECTION_NAME, docsMap);

			expect(SignalOutcomeService.isLeaderboardEnabled()).toBe(true);
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_OUTCOMES_LEADERBOARD: false });
			expect(SignalOutcomeService.isLeaderboardEnabled()).toBe(false);
			remoteConfigService._setRemoteOverridesForTesting({ ENABLE_OUTCOMES_LEADERBOARD: true });
			expect(SignalOutcomeService.isLeaderboardEnabled()).toBe(true);

			const res = await SignalOutcomeService.getOutcomesLeaderboard({
				groupBy: ['setupType', 'promptSource'],
				minTrades: 10,
				from: '2026-08-20T00:00:00.000Z',
				to: '2026-08-28T00:00:00.000Z',
			});

			expect(res.ranked).toHaveLength(1);
			expect(res.ranked[0].key).toBe('pullback:langfuse');
			expect(res.ranked[0].components).toEqual({
				setupType: 'pullback',
				promptSource: 'langfuse',
			});
			expect(getLeaderboardCacheSize()).toBe(1);

			// Recording a new signal persists promptProvenance and invalidates cached leaderboard
			const recordedId = await SignalOutcomeService.recordSignal({
				requestId: 'req-prov-1',
				source: 'webhook-alert',
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				setupType: 'pullback',
				side: 'BUY',
				price: 60000,
				promptProvenance: { name: 'alert', source: 'local', schemaDriftDetected: false },
			});
			expect(recordedId).toBeTruthy();
			expect(getLeaderboardCacheSize()).toBe(0);
			const saved = docsMap.get(recordedId);
			expect(saved.promptProvenance).toEqual({
				name: 'alert',
				source: 'local',
				schemaDriftDetected: false,
			});
		});
	});
});
