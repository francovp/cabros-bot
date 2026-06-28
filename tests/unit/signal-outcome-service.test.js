'use strict';

/**
 * Unit tests for SignalOutcomeService — metadata normalization and outcome math.
 */

const { normalizeSignal, computeMetrics, OUTCOME_WINDOWS } = require('../../src/services/storage/SignalOutcomeService');

describe('SignalOutcomeService', () => {
	describe('normalizeSignal()', () => {
		it('normalizes a complete raw signal', () => {
			const raw = {
				requestId: 'req-123',
				source: 'news-monitor',
				symbol: 'btcusdt',
				exchange: 'binance',
				timeframe: '4h',
				setupType: 'breakout',
				side: 'long',
				score: 0.82,
				entryPrice: 67500,
				stopPrice: 65000,
				targetPrice: 72000,
				alertText: 'BTC breakout confirmed on 4h',
			};

			const result = normalizeSignal(raw);

			expect(result.requestId).toBe('req-123');
			expect(result.source).toBe('news-monitor');
			expect(result.symbol).toBe('BTCUSDT');
			expect(result.exchange).toBe('BINANCE');
			expect(result.timeframe).toBe('4h');
			expect(result.setupType).toBe('breakout');
			expect(result.side).toBe('long');
			expect(result.score).toBe(0.82);
			expect(result.entryPrice).toBe(67500);
			expect(result.stopPrice).toBe(65000);
			expect(result.targetPrice).toBe(72000);
			expect(result.alertText).toBe('BTC breakout confirmed on 4h');
			expect(result.shadowMode).toBe(true);
			expect(result.evaluated).toBe(false);
		});

		it('initializes all outcome windows as null', () => {
			const result = normalizeSignal({ source: 'webhook', symbol: 'ETHUSDT' });

			for (const window of OUTCOME_WINDOWS) {
				expect(result.outcomes[window]).toBeNull();
			}
		});

		it('normalizes missing optional fields to null', () => {
			const result = normalizeSignal({ source: 'scanner' });

			expect(result.requestId).toBeNull();
			expect(result.symbol).toBeNull();
			expect(result.exchange).toBeNull();
			expect(result.timeframe).toBeNull();
			expect(result.setupType).toBeNull();
			expect(result.side).toBeNull();
			expect(result.score).toBeNull();
			expect(result.entryPrice).toBeNull();
			expect(result.stopPrice).toBeNull();
			expect(result.targetPrice).toBeNull();
			expect(result.alertText).toBeNull();
		});

		it('rejects invalid side values', () => {
			expect(normalizeSignal({ side: 'buy' }).side).toBeNull();
			expect(normalizeSignal({ side: 'sell' }).side).toBeNull();
			expect(normalizeSignal({ side: 'long' }).side).toBe('long');
			expect(normalizeSignal({ side: 'short' }).side).toBe('short');
			expect(normalizeSignal({ side: 'neutral' }).side).toBe('neutral');
		});

		it('rejects score outside 0–1 range', () => {
			expect(normalizeSignal({ score: 1.5 }).score).toBeNull();
			expect(normalizeSignal({ score: -0.1 }).score).toBeNull();
			expect(normalizeSignal({ score: 0 }).score).toBe(0);
			expect(normalizeSignal({ score: 1 }).score).toBe(1);
			expect(normalizeSignal({ score: 0.75 }).score).toBe(0.75);
		});

		it('truncates alertText to 500 characters', () => {
			const longText = 'X'.repeat(600);
			const result = normalizeSignal({ alertText: longText });
			expect(result.alertText).toHaveLength(500);
		});

		it('uppercases symbol and exchange', () => {
			const result = normalizeSignal({ symbol: 'ethusdt', exchange: 'coinbase' });
			expect(result.symbol).toBe('ETHUSDT');
			expect(result.exchange).toBe('COINBASE');
		});

		it('handles null/undefined raw gracefully', () => {
			expect(() => normalizeSignal(null)).not.toThrow();
			expect(() => normalizeSignal(undefined)).not.toThrow();
			const result = normalizeSignal(null);
			expect(result.source).toBe('unknown');
			expect(result.shadowMode).toBe(true);
		});
	});

	describe('computeMetrics()', () => {
		it('returns no-measurements message for empty records', () => {
			const metrics = computeMetrics([]);
			expect(metrics.total).toBe(0);
			expect(metrics.message).toBe('No measurements found');
			expect(metrics.hitRate).toBeNull();
			expect(metrics.averageReturn).toBeNull();
		});

		it('correctly computes pending vs evaluated counts', () => {
			const records = [
				{ evaluated: false, outcomes: {} },
				{ evaluated: false, outcomes: {} },
				{ evaluated: true, outcomes: { '1h': { returnPct: 2.5 }, '4h': null, '1D': null, '1W': null } },
			];

			const metrics = computeMetrics(records);
			expect(metrics.total).toBe(3);
			expect(metrics.evaluated).toBe(1);
			expect(metrics.pending).toBe(2);
		});

		it('computes correct hit rate for 1h window', () => {
			const records = [
				{
					evaluated: true,
					source: 'news-monitor',
					outcomes: { '1h': { returnPct: 3.2 }, '4h': null, '1D': null, '1W': null },
				},
				{
					evaluated: true,
					source: 'news-monitor',
					outcomes: { '1h': { returnPct: -1.5 }, '4h': null, '1D': null, '1W': null },
				},
				{
					evaluated: true,
					source: 'news-monitor',
					outcomes: { '1h': { returnPct: 0.8 }, '4h': null, '1D': null, '1W': null },
				},
			];

			const metrics = computeMetrics(records);
			// 2 out of 3 returns are positive → hit rate = 2/3
			expect(metrics.windows['1h'].count).toBe(3);
			expect(metrics.windows['1h'].hitRate).toBeCloseTo(2 / 3);
			expect(metrics.windows['1h'].averageReturn).toBeCloseTo((3.2 - 1.5 + 0.8) / 3);
			expect(metrics.windows['1h'].maxFavorableExcursion).toBe(3.2);
			expect(metrics.windows['1h'].maxAdverseExcursion).toBe(-1.5);
		});

		it('marks window with no data as count 0 and null metrics', () => {
			const records = [
				{ evaluated: true, source: 'scanner', outcomes: { '1h': null, '4h': null, '1D': null, '1W': null } },
			];

			const metrics = computeMetrics(records);
			expect(metrics.windows['1h'].count).toBe(0);
			expect(metrics.windows['1h'].hitRate).toBeNull();
		});

		it('groups records by source', () => {
			const records = [
				{ evaluated: false, source: 'scanner', outcomes: {} },
				{ evaluated: false, source: 'scanner', outcomes: {} },
				{ evaluated: false, source: 'news-monitor', outcomes: {} },
			];

			const metrics = computeMetrics(records);
			expect(metrics.bySource.scanner).toBe(2);
			expect(metrics.bySource['news-monitor']).toBe(1);
		});

		it('handles missing market data (null returnPct) as unavailable, not zero', () => {
			const records = [
				{
					evaluated: true,
					source: 'webhook',
					outcomes: {
						'1h': { returnPct: null },
						'4h': null,
						'1D': null,
						'1W': null,
					},
				},
			];

			const metrics = computeMetrics(records);
			// null returnPct should be filtered out — not counted as 0
			expect(metrics.windows['1h'].count).toBe(1);
			expect(metrics.windows['1h'].hitRate).toBeNull(); // no valid returns to compute
		});
	});
});
