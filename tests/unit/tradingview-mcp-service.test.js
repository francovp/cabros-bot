const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

describe('TradingViewMcpService', () => {
	afterEach(() => {
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT;
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME;
	});

	it('returns null when alert text is not a TradingView signal', async () => {
		const service = new TradingViewMcpService({ maxRetries: 1, logger: { warn: jest.fn(), error: jest.fn() } });
		const result = await service.enrichFromAlertText('Mensaje sin patrón');
		expect(result).toBeNull();
	});

	it('maps new coin_analysis schema into webhook enriched alert', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'false';
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
		expect(service.callCoinAnalysis).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '4h',
		}));
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

	it('retries report symbol analysis before returning a transient MCP failure', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 2,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn()
			.mockRejectedValueOnce(new Error('Analysis failed: Expecting value: line 1 column 1 (char 0)'))
			.mockResolvedValueOnce({
				price_data: { current_price: 219.51 },
				technical_indicators: { rsi: 57.8 },
			});

		const result = await service.analyzeSymbolIdentifier({
			raw: 'NASDAQ:NVDA',
			exchange: 'NASDAQ',
			symbol: 'NVDA',
			timeframe: '1D',
		});

		expect(result).toEqual(expect.objectContaining({
			requested_symbol: 'NASDAQ:NVDA',
			price_data: { current_price: 219.51 },
			technical_indicators: { rsi: 57.8 },
		}));
		expect(service.callCoinAnalysis).toHaveBeenCalledTimes(2);
	});

	it('stops retrying report symbol analysis when the deadline is aborted', async () => {
		const controller = new AbortController();
		const service = new TradingViewMcpService({
			maxRetries: 3,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn().mockImplementation(async () => {
			controller.abort(new Error('Expanded analysis alert timeout after 60000ms'));
			throw new Error('Expanded analysis alert timeout after 60000ms');
		});

		await expect(service.analyzeSymbolIdentifier({
			raw: 'NASDAQ:NVDA',
			exchange: 'NASDAQ',
			symbol: 'NVDA',
			timeframe: '1D',
			signal: controller.signal,
		})).rejects.toThrow('TradingView MCP call failed for NASDAQ:NVDA');

		expect(service.callCoinAnalysis).toHaveBeenCalledTimes(1);
	});

	it('aborts MCP enrichment when budget timeout is exceeded', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 3,
			enrichmentBudgetMs: 50,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockImplementation(async ({ signal } = {}) => {
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => resolve({ price_data: { current_price: 100 } }), 500);
				if (signal) {
					signal.addEventListener('abort', () => {
						clearTimeout(timer);
						reject(new DOMException('TradingView MCP enrichment budget exceeded', 'AbortError'));
					}, { once: true });
				}
			});
		});

		await expect(service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA'))
			.rejects
			.toThrow('TradingView MCP call failed');

		expect(service.callCoinAnalysis).toHaveBeenCalledTimes(1);
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

	it('calls combined_analysis tool and unwraps result in callCombinedAnalysis', async () => {
		const service = new TradingViewMcpService({ logger: { warn: jest.fn(), error: jest.fn() } });
		service._callTool = jest.fn().mockResolvedValue({
			result: {
				technical: { price_data: { current_price: 65000 } },
				sentiment: { score: 0.8 },
				news: { latest: [] },
			},
		});

		const result = await service.callCombinedAnalysis({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1h',
		});

		expect(service._callTool).toHaveBeenCalledWith('combined_analysis', {
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1h',
		}, expect.anything());
		expect(result).toEqual({
			technical: { price_data: { current_price: 65000 } },
			sentiment: { score: 0.8 },
			news: { latest: [] },
		});
	});

	it('routes to callCombinedAnalysis in analyzeSymbolIdentifier when analysisMode is combined', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCombinedAnalysis = jest.fn().mockResolvedValue({
			technical: { price_data: { current_price: 65000 } },
			sentiment: { score: 0.8 },
		});
		service.callCoinAnalysis = jest.fn();

		const result = await service.analyzeSymbolIdentifier({
			raw: 'BINANCE:BTCUSDT',
			exchange: 'BINANCE',
			symbol: 'BTCUSDT',
			timeframe: '1h',
			analysisMode: 'combined',
		});

		expect(service.callCombinedAnalysis).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1h',
		}));
		expect(service.callCoinAnalysis).not.toHaveBeenCalled();
		expect(result).toEqual(expect.objectContaining({
			requested_symbol: 'BINANCE:BTCUSDT',
			technical: { price_data: { current_price: 65000 } },
			sentiment: { score: 0.8 },
		}));
	});

	it('downgrades bullish webhook enrichment when confluence contradicts the signal', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 65000 },
			market_sentiment: { overall_rating: 4, momentum: 'Bullish' },
			market_structure: { trend: 'Bullish', trend_score: 4 },
		});
		service.callCombinedAnalysis = jest.fn().mockResolvedValue({
			confluence: {
				recommendation: 'SELL',
				confidence: 81,
				signals_agree: false,
			},
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(result.sentiment).toBe('NEUTRAL');
		expect(Math.abs(result.sentiment_score)).toBeLessThanOrEqual(0.15);
		expect(result.insights.join(' ')).toContain('Confluencia contradictoria');
		expect(result.confluenceData.confluence.recommendation).toBe('SELL');
	});

	it('fails open to coin analysis when confluence analysis is unavailable', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'true';
		const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger,
		});
		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 65000 },
			market_sentiment: { overall_rating: 4, momentum: 'Bullish' },
			market_structure: { trend: 'Bullish', trend_score: 4 },
		});
		service.callCombinedAnalysis = jest.fn().mockRejectedValue(new Error('combined_analysis timeout'));

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(result.sentiment).toBe('BULLISH');
		expect(result.confluenceData).toBeNull();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Confluence enrichment failed'));
	});

	it('adds multi-timeframe metadata when confluence multi-timeframe mode is configured', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'true';
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 65000 },
			market_sentiment: { overall_rating: 4, momentum: 'Bullish' },
			market_structure: { trend: 'Bullish', trend_score: 4 },
		});
		service.callCombinedAnalysis = jest.fn().mockResolvedValue({
			confluence: {
				recommendation: 'BUY',
				confidence: 77,
				signals_agree: true,
			},
		});
		service.callMultiTimeframeAnalysis = jest.fn().mockResolvedValue({
			alignment: { status: 'bullish', confidence: 78 },
			recommendation: { action: 'BUY' },
			confluences: ['Weekly and Daily aligned'],
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(service.callMultiTimeframeAnalysis).toHaveBeenCalledWith(expect.objectContaining({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
		}));
		expect(result.multiTimeframeData).toEqual({
			alignment: { status: 'bullish', confidence: 78 },
			recommendation: { action: 'BUY' },
			confluences: ['Weekly and Daily aligned'],
		});
		expect(result.insights).toContain('Multi-timeframe: bullish');
		expect(result.insights.join(' ')).not.toContain('[object Object]');
	});
});
