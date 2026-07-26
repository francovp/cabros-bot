const mockGetAvgPrice = jest.fn();
const mockGetKlines = jest.fn();

jest.mock('binance', () => ({
	MainClient: jest.fn().mockImplementation(() => ({
		getAvgPrice: mockGetAvgPrice,
		getKlines: mockGetKlines,
	})),
}));

const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

describe('News Monitor Analyzer - Binance timeout isolation', () => {
	beforeEach(() => {
		process.env.ENABLE_BINANCE_PRICE_CHECK = 'true';
		mockGetAvgPrice.mockResolvedValue({ price: '42000' });
		mockGetKlines.mockReturnValue(new Promise(() => {}));
		jest.useFakeTimers();
	});

	afterEach(() => {
		delete process.env.ENABLE_BINANCE_PRICE_CHECK;
		jest.useRealTimers();
		jest.clearAllMocks();
	});

	it('returns a successful Binance price when optional klines exceed their timeout', async () => {
		const analyzer = new NewsAnalyzer();
		analyzer.fetchGeminiPrice = jest.fn();

		const contextPromise = analyzer.getMarketContext('BTCUSDT');
		await jest.advanceTimersByTimeAsync(5001);

		await expect(contextPromise).resolves.toEqual(expect.objectContaining({
			price: 42000,
			source: 'binance',
			volumeRatio: null,
			rsi: null,
		}));
		expect(analyzer.fetchGeminiPrice).not.toHaveBeenCalled();
	});
});
