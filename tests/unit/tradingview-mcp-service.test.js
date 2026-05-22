const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('TradingViewMcpService', () => {
	it('returns null when alert text is not a TradingView signal', async () => {
		const service = new TradingViewMcpService({ maxRetries: 1, logger: { warn: jest.fn(), error: jest.fn() } });
		const result = await service.enrichFromAlertText('Mensaje sin patrón');
		expect(result).toBeNull();
	});

	it('maps new coin_analysis schema into webhook enriched alert', async () => {
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
			bollinger_bands: {
				upper: 69468.88,
				lower: 65664.11,
				position: 'Lower Half',
			},
			rsi: {
				value: 29.38,
				signal: 'Oversold',
			},
			adx: {
				value: 15.97,
				trend_strength: 'Weak',
			},
			support_resistance: {
				support_1: 64000.5,
				resistance_1: 66000.2,
			},
			market_structure: {
				trend: 'Bearish',
				trend_score: -3,
			},
			market_sentiment: {
				overall_rating: -2,
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
		expect(result.insights.join(' ')).toContain('Rating -2');
		expect(result.extraText).toContain('tradingview-mcp');
		expect(service.callCoinAnalysis).toHaveBeenCalledWith({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		});
	});

	it('prefers structuredContent when MCP server returns schema-native tool results', async () => {
		const service = new TradingViewMcpService({ logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() } });

		service._rpcRequest = jest
			.fn()
			.mockResolvedValueOnce({ sessionId: 'test-session' })
			.mockResolvedValueOnce({ status: 202 })
			.mockResolvedValueOnce({
				rpc: {
					result: {
						content: [{ type: 'text', text: 'non-json fallback text' }],
						structuredContent: {
							symbol: 'BINANCE:BTCUSDT',
							price_data: { current_price: 70000 },
						},
						isError: false,
					},
				},
			});

		const result = await service._callTool('coin_analysis', { symbol: 'BTCUSDT' });
		expect(result).toEqual({
			symbol: 'BINANCE:BTCUSDT',
			price_data: { current_price: 70000 },
		});
	});

	it('unwraps schema result wrapper from coin_analysis payloads', async () => {
		const service = new TradingViewMcpService({ logger: { warn: jest.fn(), error: jest.fn() } });
		service._callTool = jest.fn().mockResolvedValue({
			result: {
				symbol: 'BINANCE:BTCUSDT',
				price_data: { current_price: 71000 },
			},
		});

		const result = await service.callCoinAnalysis({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		});

		expect(result).toEqual({
			symbol: 'BINANCE:BTCUSDT',
			price_data: { current_price: 71000 },
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
