'use strict';

const SignalOutcomeDailyRollupService = require('../../src/services/storage/SignalOutcomeDailyRollupService');

describe('SignalOutcomeDailyRollupService', () => {
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
	});
});
