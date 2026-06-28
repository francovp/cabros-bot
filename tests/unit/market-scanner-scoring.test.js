const { scoreScannerItem, rankScannerItems } = require('../../src/services/tradingview/marketScannerScoring');

describe('Market Scanner Scoring', () => {
	describe('scoreScannerItem', () => {
		it('scores a top gainer with strong RSI and high volume', () => {
			const item = {
				symbol: 'BINANCE:BTCUSDT',
				changePercent: 5.2,
				indicators: { close: 50000, RSI: 65 },
				volume_ratio: 2.1,
				breakout_type: 'bullish',
			};
			const result = scoreScannerItem(item, 'top_gainers');
			expect(result.score).toBeGreaterThanOrEqual(60);
			expect(result.score).toBeLessThanOrEqual(100);
			expect(result.reason).toContain('+5.2%');
			expect(result.reason).toContain('RSI 65');
			expect(result.reason).toContain('Vol 2.1');
		});

		it('penalizes top gainer with overheated RSI and low volume', () => {
			const item = {
				symbol: 'BINANCE:SOLUSDT',
				changePercent: 8.0,
				indicators: { close: 150, RSI: 82 },
				volume_ratio: 0.8,
				breakout_type: 'bullish',
			};
			const result = scoreScannerItem(item, 'top_gainers');
			expect(result.reason).toContain('chase');
			// Score should be penalized
			expect(result.score).toBeLessThan(60);
		});

		it('scores a top loser with moderate RSI and volume confirmation', () => {
			const item = {
				symbol: 'BINANCE:ETHUSDT',
				changePercent: -4.1,
				indicators: { close: 3000, RSI: 35 },
				volume_ratio: 1.8,
				breakout_type: 'bearish',
			};
			const result = scoreScannerItem(item, 'top_losers');
			expect(result.score).toBeGreaterThanOrEqual(50);
			expect(result.score).toBeLessThanOrEqual(100);
			expect(result.reason).toContain('-4.1%');
		});

		it('penalizes top loser with oversold RSI and low volume', () => {
			const item = {
				symbol: 'BINANCE:ADAUSDT',
				changePercent: -6.5,
				indicators: { close: 0.5, RSI: 18 },
				volume_ratio: 0.7,
				breakout_type: 'bearish',
			};
			const result = scoreScannerItem(item, 'top_losers');
			expect(result.reason).toContain('chase');
			expect(result.score).toBeLessThan(55);
		});

		it('scores a volume breakout with bullish confluence', () => {
			const item = {
				symbol: 'BINANCE:DOTUSDT',
				changePercent: 3.2,
				indicators: { close: 8, RSI: 62 },
				volume_ratio: 2.5,
				breakout_type: 'bullish',
			};
			const result = scoreScannerItem(item, 'volume_breakout_scanner');
			expect(result.score).toBeGreaterThanOrEqual(55);
		});

		it('scores a smart volume item with no breakout info conservatively', () => {
			const item = {
				symbol: 'BINANCE:LINKUSDT',
				changePercent: 1.5,
				indicators: { close: 15, RSI: 55 },
				volume_ratio: 1.3,
			};
			const result = scoreScannerItem(item, 'smart_volume_scanner');
			expect(result.score).toBeGreaterThanOrEqual(20);
			expect(result.score).toBeLessThanOrEqual(80);
		});

		it('handles missing fields safely', () => {
			const item = {
				symbol: 'BINANCE:UNIUSDT',
				indicators: {},
			};
			const result = scoreScannerItem(item, 'top_gainers');
			expect(result.score).toBeGreaterThanOrEqual(0);
			expect(result.score).toBeLessThanOrEqual(50);
			// No change data means no numeric reason tokens
			expect(typeof result.reason).toBe('string');
		});

		it('scores a Bollinger squeeze item higher on low BBW', () => {
			const item = {
				symbol: 'BINANCE:AVAXUSDT',
				indicators: { close: 30, RSI: 52 },
				bbw: 0.03,
			};
			const result = scoreScannerItem(item, 'bollinger_scan');
			// Squeeze detection should boost score
			expect(result.score).toBeGreaterThanOrEqual(20);
		});

		it('returns 0-100 bounded score always', () => {
			const items = [
				{ symbol: 'A', changePercent: 999, indicators: { close: 1, RSI: 99 }, volume_ratio: 10, breakout_type: 'bullish' },
				{ symbol: 'B' },
				{ symbol: 'C', changePercent: -999, indicators: { close: 1, RSI: 1 }, volume_ratio: 0, breakout_type: 'bearish' },
			];
			for (const item of items) {
				const result = scoreScannerItem(item, 'top_gainers');
				expect(result.score).toBeGreaterThanOrEqual(0);
				expect(result.score).toBeLessThanOrEqual(100);
			}
		});

		it('reports scores as integers', () => {
			const item = {
				symbol: 'BINANCE:ATOMUSDT',
				changePercent: 2.5,
				indicators: { close: 10, RSI: 60 },
				volume_ratio: 1.5,
			};
			const result = scoreScannerItem(item, 'top_gainers');
			expect(Number.isInteger(result.score)).toBe(true);
		});
	});

	describe('rankScannerItems', () => {
		const gainerItems = [
			{ symbol: 'A', changePercent: 8, indicators: { RSI: 82 }, volume_ratio: 0.5, breakout_type: 'bullish' },
			{ symbol: 'B', changePercent: 5, indicators: { RSI: 65 }, volume_ratio: 2.0, breakout_type: 'bullish' },
			{ symbol: 'C', changePercent: 3, indicators: { RSI: 55 }, volume_ratio: 1.2 },
		];

		it('sorts items by score descending', () => {
			const ranked = rankScannerItems(gainerItems, 'top_gainers');
			expect(ranked).toHaveLength(3);
			expect(ranked[0]._score).toBeGreaterThanOrEqual(ranked[1]._score);
			expect(ranked[1]._score).toBeGreaterThanOrEqual(ranked[2]._score);
		});

		it('attaches _score and _scoreReason to each item', () => {
			const ranked = rankScannerItems(gainerItems, 'top_gainers');
			for (const item of ranked) {
				expect(typeof item._score).toBe('number');
				expect(typeof item._scoreReason).toBe('string');
			}
		});

		it('returns empty array for null/undefined input', () => {
			expect(rankScannerItems(null, 'top_gainers')).toEqual([]);
			expect(rankScannerItems(undefined, 'top_gainers')).toEqual([]);
			expect(rankScannerItems('not-array', 'top_gainers')).toEqual([]);
		});

		it('returns empty array for empty input', () => {
			expect(rankScannerItems([], 'top_gainers')).toEqual([]);
		});

		it('does not mutate the original items', () => {
			const itemsCopy = gainerItems.map((item) => ({ ...item }));
			rankScannerItems(gainerItems, 'top_gainers');
			expect(gainerItems).toEqual(itemsCopy);
		});
	});
});
