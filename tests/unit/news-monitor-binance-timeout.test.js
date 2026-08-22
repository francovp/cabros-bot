'use strict';

const mockGetAvgPrice = jest.fn();
const mockGetKlines = jest.fn();

jest.mock('binance', () => {
	return {
		MainClient: jest.fn().mockImplementation(() => {
			return {
				getAvgPrice: mockGetAvgPrice,
				getKlines: mockGetKlines,
			};
		}),
	};
});

// Mock gemini to prevent actual network calls during test setup
jest.mock('../../src/services/grounding/gemini', () => ({
	analyzeNewsForSymbol: jest.fn(),
}));

const { NewsAnalyzer } = require('../../src/controllers/webhooks/handlers/newsMonitor/analyzer');

describe('NewsAnalyzer - fetchBinancePrice timeout decoupling', () => {
	let analyzer;

	beforeEach(() => {
		jest.clearAllMocks();
		process.env.BINANCE_FETCH_TIMEOUT_MS = '50';
		analyzer = new NewsAnalyzer();
	});

	afterEach(() => {
		delete process.env.BINANCE_FETCH_TIMEOUT_MS;
	});

	it('should return Binance price with null indicators when getKlines hangs and times out', async () => {
		mockGetAvgPrice.mockResolvedValue({ price: '65000.50' });
		// getKlines hangs indefinitely
		mockGetKlines.mockReturnValue(new Promise(() => {}));

		const result = await analyzer.fetchBinancePrice('BTCUSDT');

		expect(result).not.toBeNull();
		expect(result.price).toBe(65000.50);
		expect(result.volumeRatio).toBeNull();
		expect(result.rsi).toBeNull();
		expect(result.source).toBe('binance');
	});

	it('should return null when getAvgPrice hangs and times out', async () => {
		// getAvgPrice hangs indefinitely
		mockGetAvgPrice.mockReturnValue(new Promise(() => {}));
		mockGetKlines.mockResolvedValue([]);

		const result = await analyzer.fetchBinancePrice('BTCUSDT');

		expect(result).toBeNull();
	});

	it('should return Binance price with indicators when both price and klines succeed', async () => {
		mockGetAvgPrice.mockResolvedValue({ price: '65000.50' });

		const klines = Array.from({ length: 20 }, (_, i) => ({
			volume: '100',
			close: (100 + i).toString(),
		}));
		klines.push({ volume: '200', close: '120' });
		mockGetKlines.mockResolvedValue(klines);

		const result = await analyzer.fetchBinancePrice('BTCUSDT');

		expect(result).not.toBeNull();
		expect(result.price).toBe(65000.50);
		expect(result.volumeRatio).toBeGreaterThan(0);
		expect(result.source).toBe('binance');
	});

	it('should calculate 24h change from the close 25 hourly candles back', async () => {
		mockGetAvgPrice.mockResolvedValue({ price: '110' });
		const klines = Array.from({ length: 30 }, (_, index) => ({
			volume: '100',
			close: index === 5 ? '100' : '105',
		}));
		mockGetKlines.mockResolvedValue(klines);

		const result = await analyzer.fetchBinancePrice('BTCUSDT');

		expect(result.change24h).toBe(10);
	});

	it('should return Binance price with null indicators when getKlines rejects with an error', async () => {
		mockGetAvgPrice.mockResolvedValue({ price: '65000.50' });
		mockGetKlines.mockRejectedValue(new Error('Binance rate limit'));

		const result = await analyzer.fetchBinancePrice('BTCUSDT');

		expect(result).not.toBeNull();
		expect(result.price).toBe(65000.50);
		expect(result.volumeRatio).toBeNull();
		expect(result.rsi).toBeNull();
	});
});
