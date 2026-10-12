const { parseVolumeConfirmationRequest, getVolumeDecision } = require('../../src/services/tradingview/volumeConfirmationRequest');

describe('volumeConfirmationRequest', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = {
			...originalEnv,
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '4h',
		};
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('accepts one-character TradingView symbols', () => {
		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'NYSE:F' },
		})).toEqual({
			exchange: 'NYSE',
			symbol: 'F',
			rawSymbol: 'NYSE:F',
			timeframe: '4h',
			includeMultiTimeframe: false,
			side: null,
			direction: null,
			breakoutType: null,
			tradingRecommendation: null,
		});
	});

	it('parses boolean and string variants for includeMultiTimeframe', () => {
		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: true },
		}).includeMultiTimeframe).toBe(true);

		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: 'true' },
		}).includeMultiTimeframe).toBe(true);

		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', include_multi_timeframe: true },
		}).includeMultiTimeframe).toBe(true);

		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: false },
		}).includeMultiTimeframe).toBe(false);

		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: 'false' },
		}).includeMultiTimeframe).toBe(false);
	});

	it('throws VolumeConfirmationRequestError when includeMultiTimeframe is not a boolean', () => {
		expect(() => parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: 'not-a-bool' },
		})).toThrow('includeMultiTimeframe must be a boolean');

		expect(() => parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: 123 },
		})).toThrow('includeMultiTimeframe must be a boolean');

		expect(() => parseVolumeConfirmationRequest({
			body: { symbol: 'BINANCE:BTCUSDT', includeMultiTimeframe: {} },
		})).toThrow('includeMultiTimeframe must be a boolean');
	});

	it('parses optional directional hints if supplied in the body', () => {
		expect(parseVolumeConfirmationRequest({
			body: {
				symbol: 'BINANCE:BTCUSDT',
				side: 'BUY',
				direction: 'bullish',
				breakoutType: 'bullish',
				tradingRecommendation: 'BUY',
			},
		})).toEqual(expect.objectContaining({
			side: 'BUY',
			direction: 'bullish',
			breakoutType: 'bullish',
			tradingRecommendation: 'BUY',
		}));
	});

	it('derives confirm and deny decisions from volume_ratio', () => {
		expect(getVolumeDecision({
			volume_analysis: { volume_ratio: 1.25 },
		})).toEqual({
			confirmed: true,
			decision: 'confirm',
			volumeRatio: 1.25,
		});

		expect(getVolumeDecision({
			volume_analysis: { volume_ratio: 0.95 },
		})).toEqual({
			confirmed: false,
			decision: 'deny',
			volumeRatio: 0.95,
		});
	});

	it('treats null or missing volume ratios as unknown', () => {
		expect(getVolumeDecision({
			volume_analysis: { volume_ratio: null },
		})).toEqual({
			confirmed: null,
			decision: 'unknown',
			volumeRatio: null,
		});

		expect(getVolumeDecision({
			volume_analysis: {},
		})).toEqual({
			confirmed: null,
			decision: 'unknown',
			volumeRatio: null,
		});
	});
});
