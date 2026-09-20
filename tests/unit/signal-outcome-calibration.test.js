'use strict';

const SignalOutcomeService = require('../../src/services/storage/SignalOutcomeService');

describe('Signal Outcome Confidence Calibration', () => {
	describe('computeCalibration()', () => {
		it('returns available: false when fewer than 20 evaluated scored outcomes exist', () => {
			const docs = Array.from({ length: 15 }, (_, i) => ({
				id: `doc-${i}`,
				source: 'news-monitor',
				confidenceScore: 0.72,
				outcomeEvaluated: true,
				outcomes: {
					'1h': { status: 'evaluated', return: 0.5, targetHit: false },
					'4h': { status: 'evaluated', return: 1.0, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(false);
			expect(result.totalScoredAlerts).toBe(15);
			expect(result.suggestedThreshold).toBeNull();
			expect(result.suggestedThresholdRationale).toContain('Insufficient data');
			expect(result.suggestedThresholdRationale).toContain('fewer than 20');
			expect(result.suggestedThresholdRationale).toContain('15');
			expect(result.buckets).toHaveLength(5);
		});

		it('correctly aggregates buckets, average returns, and target hit rates for >= 20 outcomes', () => {
			const docs = [];

			// Bucket 0.70-0.75: 45 items, avg return 1h: 0.3%, avg return 4h: 0.8%, target hit rate: 0.42 (19 hits / 45)
			for (let i = 0; i < 45; i++) {
				const isHit = i < 19; // 19 / 45 = 0.4222... -> 0.42
				docs.push({
					id: `doc-b1-${i}`,
					source: 'news-monitor',
					confidenceScore: 0.72,
					target: 100,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 0.3, targetHit: false },
						'4h': { status: 'evaluated', return: 0.8, targetHit: isHit },
					},
				});
			}

			// Bucket 0.75-0.80: 38 items, avg return 1h: 0.5%, avg return 4h: 1.2%, target hit rate: 0.55 (21 hits / 38 = 0.5526 -> 0.55)
			for (let i = 0; i < 38; i++) {
				const isHit = i < 21;
				docs.push({
					id: `doc-b2-${i}`,
					source: 'news-monitor',
					confidenceScore: 0.78,
					target: 100,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 0.5, targetHit: false },
						'4h': { status: 'evaluated', return: 1.2, targetHit: isHit },
					},
				});
			}

			// Bucket 0.80-0.85: 32 items, target hit rate 0.63 (20 / 32 = 0.625 -> 0.63)
			for (let i = 0; i < 32; i++) {
				const isHit = i < 20;
				docs.push({
					id: `doc-b3-${i}`,
					source: 'news-monitor',
					confidenceScore: 0.82,
					target: 100,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 0.7, targetHit: false },
						'4h': { status: 'evaluated', return: 1.5, targetHit: isHit },
					},
				});
			}

			// Bucket 0.85-0.90: 22 items, target hit rate 0.71 (16 / 22 = 0.727 -> 0.73)
			for (let i = 0; i < 22; i++) {
				const isHit = i < 16;
				docs.push({
					id: `doc-b4-${i}`,
					source: 'news-monitor',
					confidenceScore: 0.87,
					target: 100,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 1.1, targetHit: false },
						'4h': { status: 'evaluated', return: 2.0, targetHit: isHit },
					},
				});
			}

			// Bucket 0.90-1.00: 13 items, target hit rate 0.77 (10 / 13 = 0.769 -> 0.77)
			for (let i = 0; i < 13; i++) {
				const isHit = i < 10;
				docs.push({
					id: `doc-b5-${i}`,
					source: 'news-monitor',
					confidenceScore: 0.95,
					target: 100,
					outcomeEvaluated: true,
					outcomes: {
						'1h': { status: 'evaluated', return: 1.4, targetHit: false },
						'4h': { status: 'evaluated', return: 2.5, targetHit: isHit },
					},
				});
			}

			const result = SignalOutcomeService.computeCalibration(docs, { window: '4h' });

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(150);

			const b1 = result.buckets.find((b) => b.range === '0.70-0.75');
			expect(b1).toBeDefined();
			expect(b1.count).toBe(45);
			expect(b1.avgReturn1h).toBe(0.3);
			expect(b1.avgReturn4h).toBe(0.8);
			expect(b1.targetHitRate).toBe(0.42);

			const b2 = result.buckets.find((b) => b.range === '0.75-0.80');
			expect(b2).toBeDefined();
			expect(b2.count).toBe(38);
			expect(b2.avgReturn1h).toBe(0.5);
			expect(b2.avgReturn4h).toBe(1.2);
			expect(b2.targetHitRate).toBe(0.55);

			// Interpolated suggestion: 0.75 + ((0.50 - 0.42) / (0.55 - 0.42)) * 0.05 = 0.78
			expect(result.suggestedThreshold).toBe(0.78);
			expect(result.suggestedThresholdRationale).toBe('Alerts at 0.78+ show 64%+ target hit rate at 4h window');
		});

		it('falls back to doc.score when doc.confidenceScore is undefined for news-monitor source', () => {
			const docs = Array.from({ length: 25 }, (_, i) => ({
				id: `doc-${i}`,
				source: 'news-monitor',
				score: 0.76,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 1.5, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(25);
			const b = result.buckets.find((x) => x.range === '0.75-0.80');
			expect(b.count).toBe(25);
			expect(b.targetHitRate).toBe(1);
			expect(result.suggestedThreshold).toBe(0.75);
		});

		it('extracts confidence score from doc.confidenceScore or doc.score for non-news-monitor sources', () => {
			const docs = Array.from({ length: 20 }, (_, i) => ({
				id: `doc-${i}`,
				source: 'webhook-alert',
				confidenceScore: 0.82,
				score: -0.82,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 2.1, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(20);
			const b = result.buckets.find((x) => x.range === '0.80-0.85');
			expect(b.count).toBe(20);
			expect(b.targetHitRate).toBe(1);
		});

		it('returns suggestedThreshold: null when no bucket reaches 50% target hit rate', () => {
			const docs = Array.from({ length: 25 }, (_, i) => ({
				id: `doc-${i}`,
				source: 'news-monitor',
				confidenceScore: 0.82,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: -1.0, targetHit: false },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(true);
			expect(result.suggestedThreshold).toBeNull();
			expect(result.suggestedThresholdRationale).toBe('No confidence threshold achieved ≥50% cumulative target hit rate at 4h window');
		});

		it('returns suggestedThreshold: null when individual bucket hit rate is >= 50% but cumulative hit rate falls below 50%', () => {
			// Bucket 0.70-0.75 has 12/20 (60%) hit rate
			const bucket70 = Array.from({ length: 20 }, (_, i) => ({
				id: `doc-70-${i}`,
				source: 'webhook-alert',
				confidenceScore: 0.72,
				outcomes: {
					'4h': { status: 'evaluated', return: i < 12 ? 2.0 : -1.0, targetHit: i < 12 },
				},
			}));
			// Bucket 0.90-1.00 has 0/100 (0%) hit rate
			const bucket90 = Array.from({ length: 100 }, (_, i) => ({
				id: `doc-90-${i}`,
				source: 'webhook-alert',
				confidenceScore: 0.95,
				outcomes: {
					'4h': { status: 'evaluated', return: -2.0, targetHit: false },
				},
			}));

			const result = SignalOutcomeService.computeCalibration([...bucket70, ...bucket90]);

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(120);
			// Cumulative hit rate at 0.70+ is 12 / 120 = 10% (< 50%), so 0.70 must not be recommended
			expect(result.suggestedThreshold).toBeNull();
		});

		it('excludes records where the target window status is unavailable or not evaluated', () => {
			const evaluatedDocs = Array.from({ length: 5 }, (_, i) => ({
				id: `doc-eval-${i}`,
				source: 'news-monitor',
				confidenceScore: 0.85,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 1.0, targetHit: true },
				},
			}));
			const unavailableDocs = Array.from({ length: 20 }, (_, i) => ({
				id: `doc-unavail-${i}`,
				source: 'news-monitor',
				confidenceScore: 0.85,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'unavailable' },
					'1h': { status: 'evaluated', return: 0.5, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration([...evaluatedDocs, ...unavailableDocs], { window: '4h' });

			// Unavailable outcomes for 4h are excluded from 4h calibration sample
			expect(result.totalScoredAlerts).toBe(5);
			expect(result.available).toBe(false);
		});

		it('ignores unscored or unevaluated outcomes', () => {
			const docs = [
				{
					id: 'doc-unevaluated',
					source: 'news-monitor',
					confidenceScore: 0.85,
					outcomeEvaluated: false,
					outcomes: { '4h': { status: 'pending' } },
				},
				{
					id: 'doc-unscored',
					source: 'tradingview-mcp',
					outcomeEvaluated: true,
					outcomes: { '4h': { status: 'evaluated', return: 2.0, targetHit: true } },
				},
			];

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(false);
			expect(result.totalScoredAlerts).toBe(0);
		});

		it('supports return > 0 fallback when signal target is null', () => {
			const docs = Array.from({ length: 20 }, (_, i) => ({
				id: `doc-${i}`,
				source: 'news-monitor',
				confidenceScore: 0.77,
				target: null,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: i < 12 ? 1.5 : -1.0, targetHit: false },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(true);
			const b = result.buckets.find((x) => x.range === '0.75-0.80');
			expect(b.targetHitRate).toBe(0.6); // 12 / 20 = 0.60
			expect(result.suggestedThreshold).toBe(0.75);
		});

		it('rejects confidence and score values outside [0, 1] (or [-1, 1]) and excludes them from totalScoredAlerts', () => {
			const docs = [
				{
					id: 'doc-invalid-conf-4',
					source: 'expanded-analysis',
					confidenceScore: 4,
					score: 4,
					outcomeEvaluated: true,
					outcomes: { '4h': { status: 'evaluated', return: 2.0, targetHit: true } },
				},
				{
					id: 'doc-invalid-conf-70',
					source: 'market-scanner',
					confidenceScore: 70,
					score: 70,
					outcomeEvaluated: true,
					outcomes: { '4h': { status: 'evaluated', return: 2.0, targetHit: true } },
				},
				{
					id: 'doc-invalid-neg',
					source: 'expanded-analysis',
					confidenceScore: -2.5,
					score: -2.5,
					outcomeEvaluated: true,
					outcomes: { '4h': { status: 'evaluated', return: 2.0, targetHit: true } },
				},
			];

			const result = SignalOutcomeService.computeCalibration(docs);
			expect(result.available).toBe(false);
			expect(result.totalScoredAlerts).toBe(0);
		});

		it('requires a minimum sample size on candidate threshold population before recommending a threshold', () => {
			const misses = Array.from({ length: 19 }, (_, i) => ({
				id: `miss-${i}`,
				source: 'news-monitor',
				confidenceScore: 0.72,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: -1.5, targetHit: false },
				},
			}));
			const hit = {
				id: 'hit-0',
				source: 'news-monitor',
				confidenceScore: 0.95,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 3.0, targetHit: true },
				},
			};

			const result = SignalOutcomeService.computeCalibration([...misses, hit], { window: '4h' });

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(20);
			expect(result.suggestedThreshold).toBeNull();
			expect(result.suggestedThresholdRationale).toBe('No confidence threshold achieved ≥50% cumulative target hit rate at 4h window');
		});
	});

	describe('getOutcomesCalibration()', () => {
		const originalEnv = process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;

		afterEach(() => {
			if (originalEnv !== undefined) {
				process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = originalEnv;
			} else {
				delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;
			}
		});

		it('throws FEATURE_DISABLED when signal outcome tracking is disabled', async () => {
			delete process.env.ENABLE_SIGNAL_OUTCOME_TRACKING;

			await expect(SignalOutcomeService.getOutcomesCalibration()).rejects.toMatchObject({
				code: 'FEATURE_DISABLED',
			});
		});

		it('returns computed calibration when enabled', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';

			const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h' });
			expect(result).toBeDefined();
			expect(typeof result.available).toBe('boolean');
			expect(Array.isArray(result.buckets)).toBe(true);
		});

		it('scans until calibration-eligible outcomes meet targetLimit or scan cap is reached', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');

			const mockDocs = [
				{
					id: 'doc-pending-1',
					data: () => ({
						receivedAt: new Date(),
						outcomeEvaluated: false,
						confidenceScore: 0.85,
						outcomes: { '4h': { status: 'pending' } },
					}),
				},
				{
					id: 'doc-unscored-1',
					data: () => ({
						receivedAt: new Date(),
						outcomeEvaluated: true,
						confidenceScore: null,
						outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
					}),
				},
				{
					id: 'doc-eligible-1',
					data: () => ({
						receivedAt: new Date(),
						outcomeEvaluated: true,
						confidenceScore: 0.85,
						outcomes: { '4h': { status: 'evaluated', return: 2.0, targetHit: true } },
					}),
				},
				{
					id: 'doc-eligible-2',
					data: () => ({
						receivedAt: new Date(),
						outcomeEvaluated: true,
						confidenceScore: 0.75,
						outcomes: { '4h': { status: 'evaluated', return: 1.5, targetHit: true } },
					}),
				},
			];

			const mockQuery = {
				where: jest.fn().mockReturnThis(),
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn().mockReturnThis(),
				startAfter: jest.fn().mockReturnThis(),
				get: jest.fn().mockResolvedValue({
					empty: false,
					docs: mockDocs,
				}),
			};

			const mockFirestore = {
				collection: jest.fn().mockReturnValue(mockQuery),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 2 });
				// Only eligible docs (doc-eligible-1 and doc-eligible-2) were selected, ignoring pending and unscored
				expect(result.totalScoredAlerts).toBe(2);
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
		});
	});
});
