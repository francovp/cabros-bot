'use strict';

const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('TradingViewMcpService.callStrategyResearch', () => {
	let service;

	beforeEach(() => {
		service = new TradingViewMcpService({
			url: 'https://tradingview-mcp.mock/mcp',
			timeoutMs: 5000,
			maxRetries: 0,
		});
	});

	it('calls _callTool with expected arguments and unwraps result', async () => {
		const mockResponse = {
			result: {
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				strategies: [
					{ strategy: 'rsi', win_rate: 0.65, profit_factor: 1.8 },
					{ strategy: 'macd', win_rate: 0.55, profit_factor: 1.3 },
				],
			},
		};

		service._callTool = jest.fn().mockResolvedValue(mockResponse);

		const result = await service.callStrategyResearch('compare_strategies', {
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			interval: '1h',
			period: '1y',
		});

		expect(service._callTool).toHaveBeenCalledWith(
			'compare_strategies',
			{
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				interval: '1h',
				period: '1y',
			},
			{ signal: undefined }
		);

		expect(result).toEqual(mockResponse.result);
		expect(service.strategyResearchRuntimeStatus.status).toBe('ready');
		expect(service.strategyResearchRuntimeStatus.successCount).toBe(1);
	});

	it('propagates error and updates strategyResearchRuntimeStatus on failure', async () => {
		service._callTool = jest.fn().mockRejectedValue(new Error('Rate limit exceeded (429)'));

		await expect(
			service.callStrategyResearch('walk_forward_backtest_strategy', {
				symbol: 'ETHUSDT',
				strategy: 'rsi',
			})
		).rejects.toThrow('TradingView MCP strategy research walk_forward_backtest_strategy failed');

		expect(service.strategyResearchRuntimeStatus.status).toBe('degraded');
		expect(service.strategyResearchRuntimeStatus.failureCount).toBe(1);
	});
});
