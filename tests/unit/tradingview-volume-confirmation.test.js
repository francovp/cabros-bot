const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('TradingViewMcpService volume confirmation', () => {
	const originalEnv = process.env;

	beforeEach(() => {
		process.env = { ...originalEnv };
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it('prefixes symbol argument correctly in callVolumeConfirmation', async () => {
		const service = new TradingViewMcpService({ logger: { warn: jest.fn(), error: jest.fn() } });
		service._callTool = jest.fn().mockResolvedValue({
			result: {
				symbol: 'BINANCE:BTCUSDT',
				volume_analysis: { volume_ratio: 1.5, volume_strength: 'HIGH' },
			},
		});

		const result = await service.callVolumeConfirmation({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		});

		expect(service._callTool).toHaveBeenCalledWith('volume_confirmation_analysis', {
			symbol: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		}, expect.any(Object));

		expect(result).toEqual({
			symbol: 'BINANCE:BTCUSDT',
			volume_analysis: { volume_ratio: 1.5, volume_strength: 'HIGH' },
		});
	});

	it('preserves already prefixed symbol in callVolumeConfirmation', async () => {
		const service = new TradingViewMcpService({ logger: { warn: jest.fn(), error: jest.fn() } });
		service._callTool = jest.fn().mockResolvedValue({
			result: {
				symbol: 'BINANCE:BTCUSDT',
			},
		});

		await service.callVolumeConfirmation({
			symbol: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		});

		expect(service._callTool).toHaveBeenCalledWith('volume_confirmation_analysis', {
			symbol: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		}, expect.any(Object));
	});

	it('calls volume confirmation and formats insights when ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION is true', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 64863.03, change_percent: 0.1 },
		});

		service.callVolumeConfirmation = jest.fn().mockResolvedValue({
			volume_analysis: { volume_ratio: 3.25, volume_strength: 'HIGH' },
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(service.callVolumeConfirmation).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
			signal: expect.any(Object),
		});

		expect(result.insights).toContain('Volume confirms: YES (3.3x avg)');
	});

	it('marks volume confirms as NO when volume ratio is less than 1.2', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 64863.03, change_percent: 0.1 },
		});

		service.callVolumeConfirmation = jest.fn().mockResolvedValue({
			volume_analysis: { volume_ratio: 0.82 },
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(result.insights).toContain('Volume confirms: NO (0.8x avg)');
	});

	it('fails open gracefully if callVolumeConfirmation fails', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 64863.03, change_percent: 0.1 },
		});

		service.callVolumeConfirmation = jest.fn().mockRejectedValue(new Error('Volume tool failure'));

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(service.logger.warn).toHaveBeenCalledWith(expect.stringContaining('Volume confirmation failed for BTCUSDT'));
		expect(result).toBeDefined();
		expect(result.insights.join(' ')).not.toContain('Volume confirms');
	});
	it('skips volume confirmation insight if volume_ratio is missing or non-numeric', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 64863.03, change_percent: 0.1 },
		});

		service.callVolumeConfirmation = jest.fn().mockResolvedValue({
			volume_analysis: { volume_ratio: undefined },
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');
		expect(result.insights.join(' ')).not.toContain('Volume confirms');
	});
});
