'use strict';

const SignalOutcomeDailyRollupService = require('../../src/services/storage/SignalOutcomeDailyRollupService');
const RemoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('SignalOutcomeDailyRollupService', () => {
	describe('isOutcomeRollupEnabled()', () => {
		const originalEnv = process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED;
		const originalRcEnv = process.env.ENABLE_FIREBASE_REMOTE_CONFIG;

		afterEach(() => {
			if (originalEnv === undefined) {
				delete process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED;
			} else {
				process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED = originalEnv;
			}
			if (originalRcEnv === undefined) {
				delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			} else {
				process.env.ENABLE_FIREBASE_REMOTE_CONFIG = originalRcEnv;
			}
			RemoteConfigService._resetForTesting();
		});

		it('returns true by default when neither Remote Config nor env is set', () => {
			delete process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED;
			delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			RemoteConfigService._resetForTesting();
			expect(SignalOutcomeDailyRollupService.isOutcomeRollupEnabled()).toBe(true);
		});

		it('returns false when env disables it and Remote Config is unset', () => {
			process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED = 'false';
			delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
			RemoteConfigService._resetForTesting();
			expect(SignalOutcomeDailyRollupService.isOutcomeRollupEnabled()).toBe(false);
		});

		it('honors Remote Config override of true when env is false', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED = 'false';
			RemoteConfigService._setRemoteOverridesForTesting({
				SIGNAL_OUTCOME_ROLLUP_ENABLED: true,
			});
			expect(SignalOutcomeDailyRollupService.isOutcomeRollupEnabled()).toBe(true);
		});

		it('honors Remote Config override of false when env is true', () => {
			process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
			process.env.SIGNAL_OUTCOME_ROLLUP_ENABLED = 'true';
			RemoteConfigService._setRemoteOverridesForTesting({
				SIGNAL_OUTCOME_ROLLUP_ENABLED: false,
			});
			expect(SignalOutcomeDailyRollupService.isOutcomeRollupEnabled()).toBe(false);
		});
	});
	describe('isCohortMature()', () => {
		it('identifies mature and premature cohorts based on Opción C delays', () => {
			const dateStr = '2026-08-20';

			// 1h window: matures at 2026-08-21T01:00:00.000Z
			const before1h = new Date('2026-08-21T00:30:00.000Z');
			const after1h = new Date('2026-08-21T01:05:00.000Z');
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '1h', before1h)).toBe(false);
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '1h', after1h)).toBe(true);

			// 4h window: matures at 2026-08-21T04:00:00.000Z
			const before4h = new Date('2026-08-21T03:30:00.000Z');
			const after4h = new Date('2026-08-21T04:05:00.000Z');
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '4h', before4h)).toBe(false);
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '4h', after4h)).toBe(true);

			// 1D window: matures at 2026-08-22T00:00:00.000Z
			const before1D = new Date('2026-08-21T23:30:00.000Z');
			const after1D = new Date('2026-08-22T00:05:00.000Z');
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '1D', before1D)).toBe(false);
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '1D', after1D)).toBe(true);

			// 1W window: matures at 2026-08-28T00:00:00.000Z
			const before1W = new Date('2026-08-27T23:00:00.000Z');
			const after1W = new Date('2026-08-28T01:00:00.000Z');
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '1W', before1W)).toBe(false);
			expect(SignalOutcomeDailyRollupService.isCohortMature(dateStr, '1W', after1W)).toBe(true);
		});

		it('returns false for invalid date string or unsupported window', () => {
			expect(SignalOutcomeDailyRollupService.isCohortMature('invalid-date', '1D')).toBe(false);
			expect(SignalOutcomeDailyRollupService.isCohortMature('2026-08-20', 'unknown_window')).toBe(false);
		});
	});

	describe('computeDailyMetrics()', () => {
		it('returns zeroed metrics for empty documents array', () => {
			const metrics = SignalOutcomeDailyRollupService.computeDailyMetrics([], '1D');
			expect(metrics).toEqual({
				signals: 0,
				sampleSize: 0,
				wins: 0,
				losses: 0,
				invalidated: 0,
				pending: 0,
				hitRatePercent: null,
				avgMfe: null,
				avgMae: null,
				avgReturnPercent: null,
			});
		});

		it('computes wins, losses, hit rate, and average excursions correctly', () => {
			const docs = [
				{
					// Win via targetHit
					outcomes: {
						'1D': {
							status: 'evaluated',
							targetHit: true,
							stopHit: false,
							maxFavorableExcursion: 3.0,
							maxAdverseExcursion: -0.5,
						},
					},
				},
				{
					// Loss via stopHit
					outcomes: {
						'1D': {
							status: 'evaluated',
							targetHit: false,
							stopHit: true,
							maxFavorableExcursion: 0.5,
							maxAdverseExcursion: -2.0,
						},
					},
				},
				{
					// Win via positive return without targetHit
					outcomes: {
						'1D': {
							status: 'evaluated',
							targetHit: false,
							stopHit: false,
							return: 1.5,
							maxFavorableExcursion: 2.0,
							maxAdverseExcursion: -0.8,
						},
					},
				},
				{
					// Not evaluated for 1D - skipped
					outcomes: {
						'1D': {
							status: 'pending',
						},
					},
				},
			];

			const metrics = SignalOutcomeDailyRollupService.computeDailyMetrics(docs, '1D');
			expect(metrics.sampleSize).toBe(3);
			expect(metrics.wins).toBe(2);
			expect(metrics.losses).toBe(1);
			expect(metrics.hitRatePercent).toBe(66.67);
			// MFE: (3.0 + 0.5 + 2.0) / 3 = 1.833... -> 1.83
			expect(metrics.avgMfe).toBe(1.83);
			// MAE: (-0.5 + -2.0 + -0.8) / 3 = -1.1
			expect(metrics.avgMae).toBe(-1.1);
		});

		it('includes flat evaluated outcomes (zero return) in hit-rate denominator and sampleSize', () => {
			const docs = [
				{
					outcomes: {
						'1D': {
							status: 'evaluated',
							targetHit: false,
							stopHit: false,
							return: 2.0,
							maxFavorableExcursion: 2.5,
							maxAdverseExcursion: -0.5,
						},
					},
				},
				{
					outcomes: {
						'1D': {
							status: 'evaluated',
							targetHit: false,
							stopHit: false,
							return: 0.0,
							maxFavorableExcursion: 0.5,
							maxAdverseExcursion: -0.5,
						},
					},
				},
			];

			const metrics = SignalOutcomeDailyRollupService.computeDailyMetrics(docs, '1D');
			expect(metrics.signals).toBe(2);
			expect(metrics.sampleSize).toBe(2);
			expect(metrics.wins).toBe(1);
			expect(metrics.losses).toBe(0);
			// 1 win out of 2 evaluated outcomes = 50.0%
			expect(metrics.hitRatePercent).toBe(50.0);
		});

		it('excludes records that did not configure the requested window from signals and pending', () => {
			const docs = [
				{
					// Only configured for 1h, omitted from 1D
					outcomes: {
						'1h': {
							status: 'evaluated',
							targetHit: true,
						},
					},
				},
				{
					// Configured for 1D and evaluated
					outcomes: {
						'1D': {
							status: 'evaluated',
							targetHit: true,
							return: 3.0,
						},
					},
				},
			];

			const metrics = SignalOutcomeDailyRollupService.computeDailyMetrics(docs, '1D');
			expect(metrics.signals).toBe(1);
			expect(metrics.sampleSize).toBe(1);
			expect(metrics.wins).toBe(1);
			expect(metrics.pending).toBe(0);
		});
	});

	describe('formatDocId()', () => {
		it('formats document ID with date, bucket, and window', () => {
			expect(SignalOutcomeDailyRollupService.formatDocId('2026-08-20', 'all', '1D')).toBe('2026-08-20_all_1D');
			expect(SignalOutcomeDailyRollupService.formatDocId('2026-08-20', 'crypto', '4h')).toBe('2026-08-20_crypto_4h');
		});
	});

	describe('rollupOutcomesDaily()', () => {
		it('returns skipped results when firestore is null', async () => {
			const result = await SignalOutcomeDailyRollupService.rollupOutcomesDaily({ firestore: null });
			expect(result).toEqual({
				skipped: true,
				reason: 'firestore_unconfigured',
				scannedCohorts: 0,
				finalizedSnapshots: 0,
				skippedCohorts: 0,
			});
		});

		it('skips immature cohorts and cohorts already finalized', async () => {
			const mockCollection = jest.fn();
			const mockBatch = jest.fn();
			const mockFirestore = {
				collection: mockCollection,
				batch: mockBatch,
			};

			const mockDailyDoc = {
				get: jest.fn().mockResolvedValue({
					exists: true,
					data: () => ({ finalized: true }),
				}),
			};

			mockCollection.mockImplementation((name) => {
				if (name === 'tradingSignalOutcomesDaily') {
					return {
						doc: jest.fn().mockReturnValue(mockDailyDoc),
					};
				}
				if (name === 'tradingSignalOutcomes') {
					return {
						where: jest.fn().mockReturnThis(),
						select: jest.fn().mockReturnThis(),
						limit: jest.fn().mockReturnThis(),
						get: jest.fn().mockResolvedValue({
							docs: [
								{ data: () => ({ receivedAt: '2026-08-20T10:00:00.000Z' }) },
							],
						}),
					};
				}
				return {};
			});

			// Now is after maturity of 2026-08-20 1h (e.g. 2026-08-25)
			const now = new Date('2026-08-25T12:00:00.000Z');
			const result = await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				date: '2026-08-20',
			});

			expect(result.scannedCohorts).toBeGreaterThan(0);
			// Because existing daily doc has finalized: true, it should skip
			expect(result.finalizedSnapshots).toBe(0);
			expect(result.skippedCohorts).toBe(result.scannedCohorts);
		});

		it('computes and persists daily rollup for mature cohort and sets TTL', async () => {
			const setCalls = [];
			const batchCommit = jest.fn().mockResolvedValue([]);
			const mockBatch = {
				set: jest.fn((ref, data) => setCalls.push({ ref, data })),
				commit: batchCommit,
			};

			const mockDailyDoc = {
				get: jest.fn().mockResolvedValue({
					exists: false,
					data: () => null,
				}),
			};

			const mockFirestore = {
				collection: (name) => {
					if (name === 'tradingSignalOutcomesDaily') {
						return {
							doc: jest.fn().mockReturnValue(mockDailyDoc),
						};
					}
					if (name === 'tradingSignalOutcomes') {
						return {
							where: jest.fn().mockReturnThis(),
							select: jest.fn().mockReturnThis(),
							limit: jest.fn().mockReturnThis(),
							get: jest.fn().mockImplementation(() => {
								return Promise.resolve({
									docs: [
										{
											data: () => ({
												receivedAt: '2026-08-20T10:00:00.000Z',
												assetClass: 'crypto',
												setupType: 'breakout',
												outcomeEvaluated: true,
												outcomes: {
													'1h': {
														status: 'evaluated',
														targetHit: true,
														stopHit: false,
														maxFavorableExcursion: 2.5,
														maxAdverseExcursion: -0.5,
													},
													'4h': {
														status: 'evaluated',
														targetHit: false,
														stopHit: true,
														maxFavorableExcursion: 0.5,
														maxAdverseExcursion: -2.0,
													},
													'1D': {
														status: 'evaluated',
														targetHit: true,
														stopHit: false,
														maxFavorableExcursion: 4.0,
														maxAdverseExcursion: -1.0,
													},
													'1W': {
														status: 'evaluated',
														targetHit: true,
														stopHit: false,
														maxFavorableExcursion: 6.0,
														maxAdverseExcursion: -1.5,
													},
												},
											}),
										},
									],
								});
							}),
						};
					}
					return {};
				},
				batch: () => mockBatch,
			};

			// Mature for all windows on 2026-08-20 (now is 2026-09-01)
			const now = new Date('2026-09-01T12:00:00.000Z');
			const result = await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				date: '2026-08-20',
				ttlDays: 180,
			});

			expect(result.finalizedSnapshots).toBeGreaterThan(0);
			expect(batchCommit).toHaveBeenCalled();
			expect(setCalls.length).toBeGreaterThan(0);
			const firstWrite = setCalls[0].data;
			expect(firstWrite.finalized).toBe(true);
			expect(firstWrite.expiresAt).toBeDefined();
			expect(firstWrite.sampleSize).toBe(1);
			expect(firstWrite.wins).toBe(1);
			expect(firstWrite.hitRatePercent).toBe(100);
		});

		it('keeps snapshots refreshable (finalized: false) if mature cohort still contains pending outcomes', async () => {
			const setCalls = [];
			const batchCommit = jest.fn().mockResolvedValue([]);
			const mockBatch = {
				set: jest.fn((ref, data) => setCalls.push({ ref, data })),
				commit: batchCommit,
			};

			const mockDailyDoc = {
				get: jest.fn().mockResolvedValue({
					exists: false,
					data: () => null,
				}),
			};

			const mockFirestore = {
				collection: (name) => {
					if (name === 'tradingSignalOutcomesDaily') {
						return {
							doc: jest.fn().mockReturnValue(mockDailyDoc),
						};
					}
					if (name === 'tradingSignalOutcomes') {
						return {
							where: jest.fn().mockReturnThis(),
							select: jest.fn().mockReturnThis(),
							limit: jest.fn().mockReturnThis(),
							get: jest.fn().mockImplementation(() => {
								return Promise.resolve({
									docs: [
										{
											data: () => ({
												receivedAt: '2026-08-20T10:00:00.000Z',
												assetClass: 'crypto',
												setupType: 'breakout',
												outcomeEvaluated: false,
												outcomes: {
													'1D': {
														status: 'pending',
													},
												},
											}),
										},
									],
								});
							}),
						};
					}
					return {};
				},
				batch: () => mockBatch,
			};

			const now = new Date('2026-09-01T12:00:00.000Z');
			const result = await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				date: '2026-08-20',
				window: '1D',
			});

			expect(result.finalizedSnapshots).toBe(0);
			expect(setCalls.length).toBe(3);
			for (const call of setCalls) {
				expect(call.data.finalized).toBe(false);
				expect(call.data.pending).toBe(1);
			}
			expect(setCalls.map((c) => c.data.bucket)).toEqual(['all', 'crypto', 'breakout']);
		});

		it('revisits unfinished historical cohorts (finalized: false) beyond candidate maturity offsets', async () => {
			const setCalls = [];
			const batchCommit = jest.fn().mockResolvedValue([]);
			const mockBatch = {
				set: jest.fn((ref, data) => setCalls.push({ ref, data })),
				commit: batchCommit,
			};

			const mockDailyDoc = {
				get: jest.fn().mockResolvedValue({
					exists: true,
					data: () => ({ finalized: false, date: '2026-08-10' }),
				}),
			};

			const mockFirestore = {
				collection: (name) => {
					if (name === 'tradingSignalOutcomesDaily') {
						return {
							doc: jest.fn().mockReturnValue(mockDailyDoc),
							where: jest.fn().mockReturnThis(),
							limit: jest.fn().mockReturnThis(),
							get: jest.fn().mockResolvedValue({
								docs: [
									{
										data: () => ({ date: '2026-08-10', finalized: false }),
									},
								],
							}),
						};
					}
					if (name === 'tradingSignalOutcomes') {
						return {
							where: jest.fn().mockReturnThis(),
							select: jest.fn().mockReturnThis(),
							limit: jest.fn().mockReturnThis(),
							get: jest.fn().mockResolvedValue({
								docs: [
									{
										data: () => ({
											receivedAt: '2026-08-10T10:00:00.000Z',
											assetClass: 'crypto',
											setupType: 'breakout',
											outcomeEvaluated: true,
											outcomes: {
												'1D': {
													status: 'evaluated',
													targetHit: true,
													stopHit: false,
													return: 2.5,
												},
											},
										}),
									},
								],
							}),
						};
					}
					return {};
				},
				batch: () => mockBatch,
			};

			// now is 2026-09-01; 2026-08-10 is way past days -2 and -3
			const now = new Date('2026-09-01T12:00:00.000Z');
			const result = await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				window: '1D',
			});

			expect(result.success).toBe(true);
			// setCalls should include an update for 2026-08-10
			const updatedDates = setCalls.map((call) => call.data.date);
			expect(updatedDates).toContain('2026-08-10');
			const rollup20260810 = setCalls.find((call) => call.data.date === '2026-08-10');
			expect(rollup20260810.data.finalized).toBe(true);
		});

		it('rotates unfinished historical cohorts query across sweeps using startAfter cursor', async () => {
			SignalOutcomeDailyRollupService._resetForTesting();
			const startAfterCalls = [];
			const firstBatchDocs = Array.from({ length: 10 }, (_, i) => ({
				data: () => ({ date: `2026-08-0${i + 1}`, finalized: false }),
			}));
			const secondBatchDocs = [
				{ data: () => ({ date: '2026-08-11', finalized: false }) },
			];

			let callCount = 0;
			const mockWhere = {
				where: jest.fn().mockReturnThis(),
				startAfter: jest.fn((doc) => {
					startAfterCalls.push(doc);
					return mockWhere;
				}),
				limit: jest.fn().mockReturnThis(),
				get: jest.fn().mockImplementation(() => {
					callCount++;
					return Promise.resolve({
						empty: false,
						docs: callCount === 1 ? firstBatchDocs : secondBatchDocs,
					});
				}),
			};

			const mockFirestore = {
				collection: (name) => {
					if (name === 'tradingSignalOutcomesDaily') {
						return {
							doc: jest.fn().mockReturnValue({
								get: jest.fn().mockResolvedValue({
									exists: true,
									data: () => ({ finalized: false }),
								}),
							}),
							where: mockWhere.where,
						};
					}
					if (name === 'tradingSignalOutcomes') {
						return {
							where: jest.fn().mockReturnThis(),
							get: jest.fn().mockResolvedValue({ docs: [] }),
						};
					}
					return {};
				},
				batch: () => ({
					set: jest.fn(),
					commit: jest.fn().mockResolvedValue([]),
				}),
			};

			const now = new Date('2026-09-01T12:00:00.000Z');
			// Sweep 1
			await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				window: '1D',
				bucket: 'all',
			});
			expect(startAfterCalls.length).toBe(0);

			// Sweep 2 should use startAfter cursor from the end of sweep 1
			await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				window: '1D',
				bucket: 'all',
			});
			expect(startAfterCalls.length).toBe(1);
			expect(startAfterCalls[0]).toBe(firstBatchDocs[9]);
			SignalOutcomeDailyRollupService._resetForTesting();
		});

		it('generates non-default buckets (assetClass, setupType, side) observed in cohort documents', async () => {
			const setCalls = [];
			const batchCommit = jest.fn().mockResolvedValue([]);
			const mockBatch = {
				set: jest.fn((ref, data) => setCalls.push({ ref, data })),
				commit: batchCommit,
			};

			const mockFirestore = {
				collection: (name) => {
					if (name === 'tradingSignalOutcomesDaily') {
						return {
							doc: jest.fn().mockReturnValue({
								get: jest.fn().mockResolvedValue({ exists: false }),
							}),
						};
					}
					if (name === 'tradingSignalOutcomes') {
						return {
							where: jest.fn().mockReturnThis(),
							get: jest.fn().mockResolvedValue({
								docs: [
									{
										data: () => ({
											receivedAt: '2026-08-20T10:00:00.000Z',
											assetClass: 'crypto',
											setupType: 'breakout',
											side: 'buy',
											outcomes: {
												'1D': {
													status: 'evaluated',
													targetHit: true,
													return: 3.5,
												},
											},
										}),
									},
									{
										data: () => ({
											receivedAt: '2026-08-20T11:00:00.000Z',
											assetClass: 'stocks',
											setupType: 'reversal',
											side: 'sell',
											outcomes: {
												'1D': {
													status: 'evaluated',
													stopHit: true,
													return: -1.5,
												},
											},
										}),
									},
								],
							}),
						};
					}
					return {};
				},
				batch: () => mockBatch,
			};

			const now = new Date('2026-09-01T12:00:00.000Z');
			const result = await SignalOutcomeDailyRollupService.rollupOutcomesDaily({
				firestore: mockFirestore,
				now,
				date: '2026-08-20',
				window: '1D',
			});

			expect(result.success).toBe(true);
			const generatedBuckets = setCalls.map((c) => c.data.bucket);
			expect(generatedBuckets).toEqual(expect.arrayContaining(['all', 'crypto', 'stocks', 'breakout', 'reversal', 'buy', 'sell']));

			const cryptoSnapshot = setCalls.find((c) => c.data.bucket === 'crypto').data;
			expect(cryptoSnapshot.sampleSize).toBe(1);
			expect(cryptoSnapshot.wins).toBe(1);
			expect(cryptoSnapshot.hitRatePercent).toBe(100);

			const stocksSnapshot = setCalls.find((c) => c.data.bucket === 'stocks').data;
			expect(stocksSnapshot.sampleSize).toBe(1);
			expect(stocksSnapshot.losses).toBe(1);
			expect(stocksSnapshot.hitRatePercent).toBe(0);

			const allSnapshot = setCalls.find((c) => c.data.bucket === 'all').data;
			expect(allSnapshot.sampleSize).toBe(2);
			expect(allSnapshot.wins).toBe(1);
			expect(allSnapshot.losses).toBe(1);
			expect(allSnapshot.hitRatePercent).toBe(50);
		});
	});

	describe('getOutcomesTrend()', () => {
		it('throws STORAGE_UNAVAILABLE error when firestore is null', async () => {
			await expect(
				SignalOutcomeDailyRollupService.getOutcomesTrend({
					firestore: null,
					window: '1D',
				}),
			).rejects.toThrow('Signal outcome tracking is enabled but Firestore is unavailable.');
		});

		it('queries tradingSignalOutcomesDaily collection and sorts points chronologically', async () => {
			const mockDocs = [
				{
					data: () => ({
						date: '2026-08-22',
						window: '1D',
						evaluationWindow: '1D',
						bucket: 'all',
						sampleSize: 15,
						wins: 10,
						losses: 5,
						hitRatePercent: 66.67,
						avgMfe: 2.2,
						avgMae: -0.9,
						finalized: true,
					}),
				},
				{
					data: () => ({
						date: '2026-08-20',
						window: '1D',
						evaluationWindow: '1D',
						bucket: 'all',
						sampleSize: 10,
						wins: 7,
						losses: 3,
						hitRatePercent: 70.0,
						avgMfe: 2.5,
						avgMae: -0.7,
						finalized: true,
					}),
				},
			];

			const mockFirestore = {
				collection: jest.fn().mockReturnValue({
					where: jest.fn().mockReturnThis(),
					get: jest.fn().mockResolvedValue({ docs: mockDocs }),
				}),
			};

			const result = await SignalOutcomeDailyRollupService.getOutcomesTrend({
				firestore: mockFirestore,
				window: '1D',
				bucket: 'all',
				from: '2026-08-20',
				to: '2026-08-25',
			});

			expect(result.success).toBe(true);
			expect(result.totalDays).toBe(2);
			// Sorted by date ascending
			expect(result.trend[0].date).toBe('2026-08-20');
			expect(result.trend[1].date).toBe('2026-08-22');
		});

		it('throws INVALID_REQUEST when range exceeds MAX_TREND_DAYS (180)', async () => {
			const mockFirestore = {
				collection: jest.fn().mockReturnValue({
					where: jest.fn().mockReturnThis(),
					get: jest.fn().mockResolvedValue({ docs: [] }),
				}),
			};

			await expect(
				SignalOutcomeDailyRollupService.getOutcomesTrend({
					firestore: mockFirestore,
					window: '1D',
					bucket: 'all',
					from: '2025-01-01',
					to: '2026-08-25', // > 180 days
				}),
			).rejects.toThrow('Date range must not exceed 180 days.');
		});

		it('normalizes bucket query parameter (e.g. Crypto -> crypto)', async () => {
			const whereFilters = [];
			const mockFirestore = {
				collection: jest.fn().mockReturnValue({
					where: jest.fn((field, op, val) => {
						whereFilters.push({ field, op, val });
						return mockFirestore.collection();
					}),
					get: jest.fn().mockResolvedValue({ docs: [] }),
				}),
			};

			const result = await SignalOutcomeDailyRollupService.getOutcomesTrend({
				firestore: mockFirestore,
				window: '1D',
				bucket: 'Crypto',
				from: '2026-08-20',
				to: '2026-08-25',
			});

			expect(result.success).toBe(true);
			expect(result.bucket).toBe('crypto');
			const bucketFilter = whereFilters.find((f) => f.field === 'bucket');
			expect(bucketFilter).toEqual({ field: 'bucket', op: '==', val: 'crypto' });
		});
	});
});
