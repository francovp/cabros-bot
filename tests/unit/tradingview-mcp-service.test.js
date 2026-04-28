const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('TradingViewMcpService', () => {
	it('returns null when alert text is not a TradingView signal', async () => {
		const service = new TradingViewMcpService({ maxRetries: 1, logger: { warn: jest.fn(), error: jest.fn() } });
		const result = await service.enrichFromAlertText('Mensaje sin patrón');
		expect(result).toBeNull();
	});

	it('maps coin analysis into webhook enriched alert', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: {
				current_price: 64863.03,
				change_percent: -0.11,
				high: 64997.44,
				low: 64828.62,
			},
			bollinger_analysis: {
				rating: -3,
				bb_upper: 69468.88,
				bb_lower: 65664.11,
				position: 'Below Lower',
			},
			technical_indicators: {
				rsi: 29.38,
				rsi_signal: 'Oversold',
				adx: 15.97,
				trend_strength: 'Weak',
			},
			market_sentiment: {
				momentum: 'Bearish',
			},
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			technical_levels: expect.objectContaining({
				supports: expect.any(Array),
				resistances: expect.any(Array),
			}),
		}));
		expect(result.insights.join(' ')).toContain('BTCUSDT');
		expect(result.insights.join(' ')).toContain('4h');
		expect(result.extraText).toContain('tradingview-mcp');
		expect(service.callCoinAnalysis).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		});
	});

	it('throws a clear error when mcp call fails', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			logger: { warn: jest.fn(), error: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockRejectedValue(new Error('connection refused'));

		await expect(service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA'))
			.rejects
			.toThrow('TradingView MCP call failed');
	});

	it('parses rpc payload from SSE body', () => {
		const service = new TradingViewMcpService();
		const body = [
			'event: message',
			'data: {"jsonrpc":"2.0","id":"abc","result":{"ok":true}}',
			'',
		].join('\n');

		const rpc = service._decodeRpcBody(body, 'text/event-stream', 'abc');
		expect(rpc).toEqual({ jsonrpc: '2.0', id: 'abc', result: { ok: true } });
	});
});
