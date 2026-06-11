const {
	VolumeConfirmationRequestError,
	parseVolumeConfirmationRequest,
	getVolumeDecision,
} = require('../../src/services/tradingview/volumeConfirmationRequest');

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

	it('parses a valid request and normalizes the timeframe', () => {
		const result = parseVolumeConfirmationRequest({
			body: {
				symbol: 'binance:btcusdt',
				timeframe: '240',
			},
		});

		expect(result).toEqual({
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			rawSymbol: 'BINANCE:BTCUSDT',
			timeframe: '4h',
		});
	});

	it('throws for malformed symbol identifiers', () => {
		expect(() => parseVolumeConfirmationRequest({
			body: { symbol: 'BTCUSDT' },
		})).toThrow(VolumeConfirmationRequestError);
	});

	it('accepts one-character TradingView symbols', () => {
		expect(parseVolumeConfirmationRequest({
			body: { symbol: 'NYSE:F' },
		})).toEqual({
			exchange: 'NYSE',
			symbol: 'F',
			rawSymbol: 'NYSE:F',
			timeframe: '4h',
		});
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
