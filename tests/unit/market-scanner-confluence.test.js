const { filterScannerCandidates, enrichScannerItemsWithTrendConfluence } = require('../../src/services/tradingview/marketScannerConfluence');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('Market Scanner Confluence', () => {
	describe('filterScannerCandidates', () => {
		it('filters top gainers to only include items with positive changePercent', () => {
			const items = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
				{ symbol: 'BINANCE:ETHUSDT', changePercent: -2.1 },
				{ symbol: 'BINANCE:SOLUSDT', changePercent: 'invalid' },
				{ symbol: 'BINANCE:ADAUSDT', changePercent: 0 },
			];
			const filtered = filterScannerCandidates(items, 'top_gainers');
			expect(filtered).toHaveLength(1);
			expect(filtered[0].symbol).toBe('BINANCE:BTCUSDT');
		});

		it('filters top losers to only include valid numeric changePercent items', () => {
			const items = [
				{ symbol: 'BINANCE:ETHUSDT', changePercent: -2.1 },
				{ symbol: 'BINANCE:SOLUSDT', changePercent: 'invalid' },
				{ symbol: 'BINANCE:ADAUSDT', changePercent: null },
			];
			const filtered = filterScannerCandidates(items, 'top_losers');
			expect(filtered).toHaveLength(1);
			expect(filtered[0].symbol).toBe('BINANCE:ETHUSDT');
			expect(filtered[0].changePercent).toBe(-2.1);
		});

		it('returns all items unchanged for non-gainer/loser scans', () => {
			const items = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
				{ symbol: 'BINANCE:ETHUSDT', changePercent: -2.1 },
			];
			const filtered = filterScannerCandidates(items, 'volume_breakout_scanner');
			expect(filtered).toHaveLength(2);
		});
	});

	describe('enrichScannerItemsWithTrendConfluence', () => {
		it('skips multi-timeframe calls for candidates filtered out by scanType', async () => {
			const spy = jest.spyOn(tradingViewMcpService, 'callMultiTimeframeAnalysis').mockResolvedValue({
				status: 'aligned',
				direction: 'bullish',
			});

			const items = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
				{ symbol: 'BINANCE:ETHUSDT', changePercent: -2.1 },
			];

			const enriched = await enrichScannerItemsWithTrendConfluence(items, { exchange: 'BINANCE', scanType: 'top_gainers' });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy).toHaveBeenCalledWith(expect.objectContaining({ symbol: 'BTCUSDT' }));
			expect(enriched).toHaveLength(1);
			expect(enriched[0].symbol).toBe('BINANCE:BTCUSDT');

			spy.mockRestore();
		});

		it('executes multi-timeframe calls with bounded concurrency and preserves result order', async () => {
			let activeCalls = 0;
			let maxConcurrent = 0;

			const spy = jest.spyOn(tradingViewMcpService, 'callMultiTimeframeAnalysis').mockImplementation(async ({ symbol }) => {
				activeCalls += 1;
				maxConcurrent = Math.max(maxConcurrent, activeCalls);
				await new Promise((resolve) => setTimeout(resolve, 20));
				activeCalls -= 1;
				return { status: 'aligned', direction: 'bullish', symbol };
			});

			const items = Array.from({ length: 12 }, (_, i) => ({
				symbol: `BINANCE:COIN${i}USDT`,
				changePercent: 1.0 + i,
			}));

			const enriched = await enrichScannerItemsWithTrendConfluence(
				items,
				{ exchange: 'BINANCE', scanType: 'top_gainers' },
				null,
				{ concurrency: 4 },
			);

			expect(spy).toHaveBeenCalledTimes(12);
			expect(maxConcurrent).toBe(4);
			expect(enriched).toHaveLength(12);
			enriched.forEach((item, i) => {
				expect(item.symbol).toBe(`BINANCE:COIN${i}USDT`);
				expect(item.trendConfluence).toEqual({
					status: 'aligned',
					direction: 'bullish',
					symbol: `COIN${i}USDT`,
				});
			});

			spy.mockRestore();
		});

		it('deduplicates symbols within the same scan to avoid duplicate MCP calls', async () => {
			const spy = jest.spyOn(tradingViewMcpService, 'callMultiTimeframeAnalysis').mockResolvedValue({
				status: 'aligned',
				direction: 'bullish',
			});

			const items = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 4.8 },
				{ symbol: 'BINANCE:ETHUSDT', changePercent: 3.1 },
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.0 },
			];

			const enriched = await enrichScannerItemsWithTrendConfluence(items, { exchange: 'BINANCE', scanType: 'top_gainers' });
			expect(spy).toHaveBeenCalledTimes(2);
			expect(enriched).toHaveLength(4);
			expect(enriched[0].trendConfluence).toBeDefined();
			expect(enriched[1].trendConfluence).toBeDefined();
			expect(enriched[2].trendConfluence).toBeDefined();
			expect(enriched[3].trendConfluence).toBeDefined();

			spy.mockRestore();
		});

		it('reuses shared symbolCache across multiple scan passes', async () => {
			const spy = jest.spyOn(tradingViewMcpService, 'callMultiTimeframeAnalysis').mockResolvedValue({
				status: 'aligned',
				direction: 'bullish',
			});

			const symbolCache = new Map();
			const gainers = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
			];
			const breakouts = [
				{ symbol: 'BINANCE:BTCUSDT', volume_ratio: 2.5 },
				{ symbol: 'BINANCE:SOLUSDT', volume_ratio: 3.0 },
			];

			const enrichedGainers = await enrichScannerItemsWithTrendConfluence(
				gainers,
				{ exchange: 'BINANCE', scanType: 'top_gainers' },
				null,
				{ symbolCache },
			);
			const enrichedBreakouts = await enrichScannerItemsWithTrendConfluence(
				breakouts,
				{ exchange: 'BINANCE', scanType: 'volume_breakout_scanner' },
				null,
				{ symbolCache },
			);

			expect(spy).toHaveBeenCalledTimes(2);
			expect(enrichedGainers[0].trendConfluence).toBeDefined();
			expect(enrichedBreakouts[0].trendConfluence).toBeDefined();
			expect(enrichedBreakouts[1].trendConfluence).toBeDefined();

			spy.mockRestore();
		});

		it('fails open when an individual symbol confluence call rejects', async () => {
			const spy = jest.spyOn(tradingViewMcpService, 'callMultiTimeframeAnalysis').mockImplementation(async ({ symbol }) => {
				if (symbol === 'ETHUSDT') {
					throw new Error('MCP service unavailable for ETH');
				}
				return { status: 'aligned', direction: 'bullish' };
			});

			const items = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
				{ symbol: 'BINANCE:ETHUSDT', changePercent: 3.0 },
				{ symbol: 'BINANCE:SOLUSDT', changePercent: 2.1 },
			];

			const enriched = await enrichScannerItemsWithTrendConfluence(items, { exchange: 'BINANCE', scanType: 'top_gainers' });
			expect(enriched).toHaveLength(3);
			expect(enriched[0].trendConfluence).toBeDefined();
			expect(enriched[1].trendConfluence).toBeUndefined();
			expect(enriched[1].symbol).toBe('BINANCE:ETHUSDT');
			expect(enriched[2].trendConfluence).toBeDefined();

			spy.mockRestore();
		});

		it('propagates abort error when signal is aborted', async () => {
			const controller = new AbortController();
			controller.abort(new Error('Deadline exceeded'));

			const items = [
				{ symbol: 'BINANCE:BTCUSDT', changePercent: 5.2 },
			];

			await expect(
				enrichScannerItemsWithTrendConfluence(items, { exchange: 'BINANCE', scanType: 'top_gainers' }, controller.signal),
			).rejects.toThrow();
		});

		it('drains active in-flight calls and clears queued calls before rethrowing abort error', async () => {
			const controller = new AbortController();
			let activeCalls = 0;
			let settledCalls = 0;
			let totalStarted = 0;

			const spy = jest.spyOn(tradingViewMcpService, 'callMultiTimeframeAnalysis').mockImplementation(async ({ signal }) => {
				totalStarted += 1;
				activeCalls += 1;
				await new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						activeCalls -= 1;
						settledCalls += 1;
						resolve({ status: 'aligned' });
					}, 20);
					if (signal) {
						signal.addEventListener('abort', () => {
							clearTimeout(timer);
							activeCalls -= 1;
							settledCalls += 1;
							const err = new Error('AbortError');
							err.name = 'AbortError';
							reject(err);
						});
					}
				});
			});

			const items = Array.from({ length: 8 }, (_, i) => ({
				symbol: `BINANCE:COIN${i}USDT`,
				changePercent: 1.0 + i,
			}));

			// Concurrency 2: start first 2, then abort
			const enrichmentPromise = enrichScannerItemsWithTrendConfluence(
				items,
				{ exchange: 'BINANCE', scanType: 'top_gainers' },
				controller.signal,
				{ concurrency: 2 },
			);

			// Give tick for first 2 to start
			await new Promise((r) => setTimeout(r, 5));
			controller.abort(new Error('Scanner timeout'));

			await expect(enrichmentPromise).rejects.toThrow();
			expect(activeCalls).toBe(0);
			expect(totalStarted).toBe(2);
			expect(settledCalls).toBe(2);

			spy.mockRestore();
		});
	});
});

