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
	});
});
