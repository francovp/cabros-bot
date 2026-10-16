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

		it('excludes market-scanner technical scores and legacy unproven confidence from calibration', () => {
			const docs = Array.from({ length: 20 }, (_, i) => ({
				id: `market-scanner-${i}`,
				source: 'market-scanner',
				score: 0.85,
				confidenceScore: i < 10 ? null : 0.85,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 1.5, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(false);
			expect(result.totalScoredAlerts).toBe(0);
		});

		it('excludes scanner-preset technical scores from calibration', () => {
			const docs = Array.from({ length: 20 }, (_, i) => ({
				id: `scanner-preset-${i}`,
				source: 'scanner-preset',
				score: 0.85,
				confidenceScore: 0.85,
				outcomes: {
					'4h': { status: 'evaluated', return: 1.5, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(false);
			expect(result.totalScoredAlerts).toBe(0);
		});

		it('keeps legacy market-scanner confidence when stored values prove it was explicit', () => {
			const docs = Array.from({ length: 20 }, (_, i) => ({
				id: `market-scanner-proven-${i}`,
				source: 'market-scanner',
				score: i < 7 ? null : i < 14 ? 2 : 0.85,
				confidenceScore: 0.72,
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 1.5, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(20);
			expect(result.buckets.find((bucket) => bucket.range === '0.70-0.75').count).toBe(20);
		});

		it('includes market-scanner confidence only when its explicit provenance is recorded', () => {
			const docs = Array.from({ length: 20 }, (_, i) => ({
				id: `market-scanner-explicit-${i}`,
				source: 'market-scanner',
				score: 0.85,
				confidenceScore: 0.82,
				confidenceScoreOrigin: 'explicit',
				outcomeEvaluated: true,
				outcomes: {
					'4h': { status: 'evaluated', return: 1.5, targetHit: true },
				},
			}));

			const result = SignalOutcomeService.computeCalibration(docs);

			expect(result.available).toBe(true);
			expect(result.totalScoredAlerts).toBe(20);
			expect(result.buckets.find((bucket) => bucket.range === '0.80-0.85').count).toBe(20);
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

		it('limits the first Firestore page to the requested calibration sample', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');
			const docs = Array.from({ length: 100 }, (_, index) => ({
				id: `eligible-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'news-monitor',
					confidenceScore: 0.72,
					outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			let requestedPageLimit = 0;
			const mockQuery = {
				where: jest.fn().mockReturnThis(),
				orderBy: jest.fn().mockReturnThis(),
				limit: jest.fn(function(limit) {
					requestedPageLimit = limit;
					return this;
				}),
				get: jest.fn(async () => ({
					empty: false,
					docs: docs.slice(0, requestedPageLimit),
				})),
			};
			const mockFirestore = {
				collection: jest.fn().mockReturnValue(mockQuery),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 1 });
				expect(requestedPageLimit).toBe(1);
				expect(mockQuery.get).toHaveBeenCalledTimes(1);
				expect(result.totalScoredAlerts).toBe(1);
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
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

		it('recovers independent source cohorts and legacy explicit scanner confidence after the global scan cap', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');
			const invalidScannerDocs = Array.from({ length: 2000 }, (_, index) => ({
				id: `scanner-score-only-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'market-scanner',
					score: 0.85,
					confidenceScore: 0.85,
					outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			const legacyMarketScannerDocs = Array.from({ length: 5 }, (_, index) => ({
				id: `scanner-legacy-explicit-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - index * 1000),
					source: 'market-scanner',
					score: null,
					confidenceScore: 0.72,
					outcomes: { '4h': { status: 'evaluated', return: 1.5, targetHit: true } },
				}),
			}));
			const legacyScannerPresetDocs = Array.from({ length: 5 }, (_, index) => ({
				id: `scanner-preset-legacy-explicit-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 - index * 1000),
					source: 'scanner-preset',
					score: 0.85,
					confidenceScore: 0.72,
					outcomes: { '4h': { status: 'evaluated', return: 1.5, targetHit: true } },
				}),
			}));
			const nonScannerDocs = Array.from({ length: 20 }, (_, index) => ({
				id: `news-monitor-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - index * 1000),
					source: 'news-monitor',
					confidenceScore: 0.72,
					outcomes: { '4h': { status: 'evaluated', return: 1.5, targetHit: true } },
				}),
			}));
			const explicitScannerDocs = Array.from({ length: 20 }, (_, index) => ({
				id: `scanner-explicit-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - 60 * 60 * 1000 - index * 1000),
					source: 'market-scanner',
					score: 0.85,
					confidenceScore: 0.72,
					confidenceScoreOrigin: 'explicit',
					outcomes: { '4h': { status: 'evaluated', return: 1.5, targetHit: true } },
				}),
			}));
			const explicitScannerPresetDocs = Array.from({ length: 10 }, (_, index) => ({
				id: `scanner-preset-explicit-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - 60 * 60 * 1000 - index * 1000),
					source: 'scanner-preset',
					score: 0.85,
					confidenceScore: 0.72,
					confidenceScoreOrigin: 'explicit',
					outcomes: { '4h': { status: 'evaluated', return: 1.5, targetHit: true } },
				}),
			}));

			const queryFilters = [];
			const mockFirestore = {
				collection: jest.fn().mockImplementation(() => {
					const filters = [];
					let cursor = null;
					let queryLimit = 0;
					return {
						where: jest.fn(function(field, operator, value) {
							filters.push({ field, operator, value });
							return this;
						}),
						orderBy: jest.fn().mockReturnThis(),
						limit: jest.fn(function(limit) {
							queryLimit = limit;
							return this;
						}),
						startAfter: jest.fn(function(doc) {
							cursor = doc;
							return this;
						}),
						get: jest.fn(async () => {
							queryFilters.push(filters);
							const sourceFilter = filters.find(filter => filter.field === 'source');
							const originFilter = filters.find(filter => filter.field === 'confidenceScoreOrigin');
							let docs;
							if (!sourceFilter) {
								docs = invalidScannerDocs;
							} else if (sourceFilter.value === 'news-monitor') {
								docs = nonScannerDocs;
							} else if (sourceFilter.value === 'market-scanner' && originFilter?.value === 'explicit') {
								docs = explicitScannerDocs;
							} else if (sourceFilter.value === 'scanner-preset' && originFilter?.value === 'explicit') {
								docs = explicitScannerPresetDocs;
							} else if (sourceFilter.value === 'market-scanner') {
								docs = [...invalidScannerDocs, ...legacyMarketScannerDocs];
							} else if (sourceFilter.value === 'scanner-preset') {
								docs = [...legacyScannerPresetDocs, ...explicitScannerPresetDocs];
							} else {
								docs = [];
							}
							const start = cursor ? docs.findIndex(doc => doc.id === cursor.id) + 1 : 0;
							const page = docs.slice(Math.max(start, 0), Math.max(start, 0) + queryLimit);
							return { empty: page.length === 0, docs: page };
						}),
					};
				}),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 50 });
				expect(result.available).toBe(true);
				expect(result.totalScoredAlerts).toBe(50);
				expect(queryFilters.some(filters => filters.some(filter => filter.field === 'source' && filter.operator === 'in'))).toBe(false);
				for (const source of ['expanded-analysis', 'news-monitor', 'unknown', 'webhook-alert', 'market-scanner', 'scanner-preset']) {
					expect(queryFilters.some(filters => filters.some(filter => filter.field === 'source' && filter.operator === '==' && filter.value === source))).toBe(true);
				}
				expect(queryFilters.some(filters => filters.some(filter => filter.field === 'source' && filter.value === 'scanner-preset')
					&& filters.some(filter => filter.field === 'confidenceScoreOrigin' && filter.value === 'explicit'))).toBe(true);
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
		});

		it('fails closed when any source recovery query fails after a capped primary scan', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');
			const primaryDocs = Array.from({ length: 2000 }, (_, index) => ({
				id: `primary-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'news-monitor',
					confidenceScore: index < 20 ? 0.72 : null,
					outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			let globalPage = 0;
			const mockFirestore = {
				collection: jest.fn().mockImplementation(() => {
					const filters = [];
					return {
						where: jest.fn(function(field, operator, value) {
							filters.push({ field, operator, value });
							return this;
						}),
						orderBy: jest.fn().mockReturnThis(),
						limit: jest.fn().mockReturnThis(),
						startAfter: jest.fn().mockReturnThis(),
						get: jest.fn(async () => {
							if (filters.some(filter => filter.field === 'source')) {
								throw new Error('recovery index unavailable');
							}
							const start = globalPage * 100;
							globalPage += 1;
							const docs = primaryDocs.slice(start, start + 100);
							return { empty: docs.length === 0, docs };
						}),
					};
				}),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				await expect(SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 40 }))
					.rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
		});

		it('bounds the total documents read by source recovery scans', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');
			const makeDocs = (prefix, source, confidenceScoreOrigin, count = 3000) => Array.from({ length: count }, (_, index) => ({
				id: `${prefix}-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source,
					confidenceScore: confidenceScoreOrigin ? 0.72 : 0.8,
					...(confidenceScoreOrigin ? { confidenceScoreOrigin } : { score: 0.5 }),
					outcomes: { '4h': { status: 'pending' } },
				}),
			}));
			const primaryDocs = makeDocs('primary', 'market-scanner', null, 2000);
			const recoveryDocs = new Map();
			for (const source of ['expanded-analysis', 'news-monitor', 'unknown', 'webhook-alert']) {
				recoveryDocs.set(`${source}:legacy`, makeDocs(source, source, null));
			}
			for (const source of ['market-scanner', 'scanner-preset']) {
				recoveryDocs.set(`${source}:explicit`, makeDocs(`${source}-explicit`, source, 'explicit'));
				recoveryDocs.set(`${source}:legacy`, makeDocs(`${source}-legacy`, source, null));
			}

			let recoveryDocumentsRead = 0;
			let recoveryQueryCalls = 0;
			const recoveryReadsByQuery = new Map();
			const mockFirestore = {
				collection: jest.fn().mockImplementation(() => {
					const filters = [];
					let cursor = null;
					let queryLimit = 0;
					return {
						where: jest.fn(function(field, operator, value) {
							filters.push({ field, operator, value });
							return this;
						}),
						orderBy: jest.fn().mockReturnThis(),
						limit: jest.fn(function(value) {
							queryLimit = value;
							return this;
						}),
						startAfter: jest.fn(function(doc) {
							cursor = doc;
							return this;
						}),
						get: jest.fn(async () => {
							const sourceFilter = filters.find(filter => filter.field === 'source');
							const originFilter = filters.find(filter => filter.field === 'confidenceScoreOrigin');
							const docs = sourceFilter
								? recoveryDocs.get(`${sourceFilter.value}:${originFilter?.value || 'legacy'}`) || []
								: primaryDocs;
							const start = cursor ? docs.findIndex(doc => doc.id === cursor.id) + 1 : 0;
							const page = docs.slice(Math.max(start, 0), Math.max(start, 0) + queryLimit);
							if (sourceFilter) {
								const key = `${sourceFilter.value}:${originFilter?.value || 'legacy'}`;
								recoveryQueryCalls += 1;
								recoveryDocumentsRead += page.length;
								recoveryReadsByQuery.set(key, (recoveryReadsByQuery.get(key) || 0) + page.length);
							}
							return { empty: page.length === 0, docs: page };
						}),
					};
				}),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 1 });
				expect(result.available).toBe(false);
				expect(result.suggestedThresholdRationale).toContain('partial sample');
				expect(recoveryDocumentsRead).toBe(12210);
				expect(recoveryQueryCalls).toBeLessThanOrEqual(132);
				for (const [queryKey, documentsRead] of recoveryReadsByQuery.entries()) {
					const queryBudget = queryKey.endsWith(':explicit')
						? 2000
						: ['market-scanner:legacy', 'scanner-preset:legacy'].includes(queryKey) ? 2105 : 1000;
					expect(documentsRead).toBeLessThanOrEqual(queryBudget);
				}
				expect(recoveryReadsByQuery.size).toBe(8);
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
		});

		it('reports partial counts and suppresses a threshold when a source scan reaches its cap', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');
			const primaryDocs = Array.from({ length: 2000 }, (_, index) => ({
				id: `primary-partial-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'news-monitor',
					confidenceScore: index < 20 ? 0.72 : null,
					outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			const cappedSourceDocs = Array.from({ length: 1000 }, (_, index) => ({
				id: `expanded-unscored-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'expanded-analysis',
					confidenceScore: null,
					outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			let globalPage = 0;
			let recoveryPage = 0;
			const mockFirestore = {
				collection: jest.fn().mockImplementation(() => {
					const filters = [];
					return {
						where: jest.fn(function(field, operator, value) {
							filters.push({ field, operator, value });
							return this;
						}),
						orderBy: jest.fn().mockReturnThis(),
						limit: jest.fn().mockReturnThis(),
						startAfter: jest.fn().mockReturnThis(),
						get: jest.fn(async () => {
							const sourceFilter = filters.find(filter => filter.field === 'source');
							if (sourceFilter?.value === 'expanded-analysis') {
								const start = recoveryPage * 100;
								recoveryPage += 1;
								const docs = cappedSourceDocs.slice(start, start + 100);
								return { empty: docs.length === 0, docs };
							}
							if (sourceFilter) return { empty: true, docs: [] };
							const start = globalPage * 100;
							globalPage += 1;
							const docs = primaryDocs.slice(start, start + 100);
							return { empty: docs.length === 0, docs };
						}),
					};
				}),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 40 });
				expect(result.available).toBe(false);
				expect(result.totalScoredAlerts).toBe(20);
				expect(result.buckets.find(bucket => bucket.range === '0.70-0.75').count).toBe(20);
				expect(result.suggestedThreshold).toBeNull();
				expect(result.suggestedThresholdRationale).toContain('partial sample');
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
		});

		it('accepts a source scan that fills its requested sample on the cap boundary', async () => {
			process.env.ENABLE_SIGNAL_OUTCOME_TRACKING = 'true';
			const AlertStorageService = require('../../src/services/storage/AlertStorageService');
			const primaryDocs = Array.from({ length: 2000 }, (_, index) => ({
				id: `primary-score-only-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'market-scanner',
					score: 0.85,
					confidenceScore: 0.85,
					outcomes: { '4h': { status: 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			const explicitScannerDocs = Array.from({ length: 2000 }, (_, index) => ({
				id: `explicit-scanner-${index}`,
				data: () => ({
					receivedAt: new Date(Date.now() - index * 1000),
					source: 'market-scanner',
					score: 0.85,
					confidenceScore: 0.72,
					confidenceScoreOrigin: 'explicit',
					outcomes: { '4h': { status: index < 1980 ? 'pending' : 'evaluated', return: 1.0, targetHit: true } },
				}),
			}));
			const queryFilters = [];
			const mockFirestore = {
				collection: jest.fn().mockImplementation(() => {
					const filters = [];
					let cursor = null;
					let queryLimit = 0;
					return {
						where: jest.fn(function(field, operator, value) {
							filters.push({ field, operator, value });
							return this;
						}),
						orderBy: jest.fn().mockReturnThis(),
						limit: jest.fn(function(limit) {
							queryLimit = limit;
							return this;
						}),
						startAfter: jest.fn(function(doc) {
							cursor = doc;
							return this;
						}),
						get: jest.fn(async () => {
							queryFilters.push(filters);
							const sourceFilter = filters.find(filter => filter.field === 'source');
							const originFilter = filters.find(filter => filter.field === 'confidenceScoreOrigin');
							const docs = !sourceFilter
								? primaryDocs
								: (sourceFilter.value === 'market-scanner' && originFilter?.value === 'explicit' ? explicitScannerDocs : []);
							const start = cursor ? docs.findIndex(doc => doc.id === cursor.id) + 1 : 0;
							const page = docs.slice(Math.max(start, 0), Math.max(start, 0) + queryLimit);
							return { empty: page.length === 0, docs: page };
						}),
					};
				}),
			};

			jest.spyOn(AlertStorageService, 'getFirestore').mockReturnValue(mockFirestore);

			try {
				const result = await SignalOutcomeService.getOutcomesCalibration({ window: '4h', limit: 20 });
				expect(result.available).toBe(true);
				expect(result.totalScoredAlerts).toBe(20);
				expect(queryFilters.some(filters => filters.some(filter => filter.field === 'confidenceScoreOrigin' && filter.value === 'explicit'))).toBe(true);
			} finally {
				AlertStorageService.getFirestore.mockRestore();
			}
		});
	});
});
