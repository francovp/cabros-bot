const { TradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('TradingViewMcpService', () => {
	afterEach(() => {
		delete process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT;
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT;
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME;
		delete process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION;
		delete process.env.ENABLE_MESSAGE_FOOTER_METADATA;
		delete process.env.ENABLE_FIREBASE_REMOTE_CONFIG;
		delete process.env.TRADINGVIEW_MCP_URL;
		remoteConfigService._resetForTesting();
	});

	it('uses the active TradingView MCP host when no URL is configured', () => {
		delete process.env.TRADINGVIEW_MCP_URL;

		const service = new TradingViewMcpService();

		expect(service.getConfig().url).toBe('https://tradingview-mcp-yp6b.onrender.com/mcp');
	});

	it('reports unknown, ready, and degraded runtime state without exposing provider errors', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		expect(service.getStatus()).toEqual(expect.objectContaining({
			configured: true,
			ready: false,
			status: 'unknown',
			lastCheckedAt: null,
			lastErrorCategory: null,
			successCount: 0,
			failureCount: 0,
		}));

		service._callTool = jest.fn().mockRejectedValueOnce(new Error('TradingView MCP HTTP 503: Service Suspended: provider body omitted'));
		await expect(service.callCoinAnalysis({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1D',
		})).rejects.toThrow('HTTP 503');

		expect(service.getStatus()).toEqual(expect.objectContaining({
			ready: false,
			status: 'degraded',
			lastErrorCategory: 'http_5xx',
			successCount: 0,
			failureCount: 1,
		}));
		expect(JSON.stringify(service.getStatus())).not.toContain('Service Suspended');

		service._callTool = jest.fn().mockResolvedValueOnce({ price_data: { current_price: 70000 } });
		await service.callCoinAnalysis({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1D',
		});

		expect(service.getStatus()).toEqual(expect.objectContaining({
			ready: true,
			status: 'ready',
			lastErrorCategory: null,
			successCount: 1,
			failureCount: 1,
		}));
	});

	it('reports rolling alert-path enrichment rates for the last 24 hours', () => {
		const service = new TradingViewMcpService();

		service._recordEnrichmentStatus('full');
		service._recordEnrichmentStatus('partial');
		service._recordEnrichmentStatus('failed');

		expect(service.getStatus().enrichment.alertPath).toEqual(expect.objectContaining({
			windowMs: 86400000,
			totalCount: 3,
			appliedCount: 2,
			failedCount: 1,
			appliedRate24h: 66.67,
			failureRate24h: 33.33,
		}));
	});

	it('does not degrade runtime readiness for caller-cancelled MCP requests', async () => {
		process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
		const service = new TradingViewMcpService({
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		const cancellation = new Error('Job cancelled by user');
		const controller = new AbortController();
		controller.abort(cancellation);
		service._callTool = jest.fn().mockRejectedValue(cancellation);

		await expect(service.callCoinAnalysis({
			symbol: 'BTCUSDT',
			exchange: 'BINANCE',
			timeframe: '1D',
			signal: controller.signal,
		})).rejects.toThrow('Job cancelled by user');

		expect(service.getStatus()).toEqual(expect.objectContaining({
			ready: false,
			status: 'unknown',
			successCount: 0,
			failureCount: 0,
		}));
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
			current_price: 64863.03,
			price_data: expect.objectContaining({
				current_price: 64863.03,
			}),
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

	it('derives directional risk metadata from MCP price, ATR, and support/resistance data', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 100 },
			technical_indicators: { atr: 4 },
			support_resistance: {
				nearest_support: 88,
				nearest_resistance: 112,
			},
			market_structure: { trend: 'Bullish' },
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(result).toEqual(expect.objectContaining({
			invalidation_level: 94,
			target_level: 112,
			setup_type: 'trend_continuation',
			risk_reward_ratio: 2,
		}));
	});

	it('omits setup type when MCP provides no setup evidence', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 100 },
			technical_indicators: { atr: 4 },
			support_resistance: { nearest_resistance: 112 },
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(result).toEqual(expect.objectContaining({
			invalidation_level: 94,
			target_level: 112,
			risk_reward_ratio: 2,
		}));
		expect(result).not.toHaveProperty('setup_type');
	});

	it('inverts calculated invalidation and target levels for sell signals', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 100 },
			technical_indicators: { atr: 4 },
			support_resistance: { nearest_support: 88 },
			market_structure: { trend: 'Bearish' },
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({
			invalidation_level: 106,
			target_level: 88,
			setup_type: 'trend_continuation',
			risk_reward_ratio: 2,
		}));
	});

	it('omits risk metadata when ATR-derived levels are invalid', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 0.01 },
			technical_indicators: { atr: 0.02 },
		});

		const result = await service.enrichFromAlertText('SHIBUSDT(240) pasó a señal de COMPRA');

		expect(result).not.toHaveProperty('invalidation_level');
		expect(result).not.toHaveProperty('target_level');
		expect(result).not.toHaveProperty('risk_reward_ratio');
		expect(result).not.toHaveProperty('setup_type');
	});

	it('omits the full risk block when rejected ATR leaves a valid alternate target', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 0.01 },
			technical_indicators: { atr: 0.02 },
			support_resistance: { nearest_resistance: 0.03 },
		});

		const result = await service.enrichFromAlertText('SHIBUSDT(240) pasó a señal de COMPRA');

		expect(result).not.toHaveProperty('invalidation_level');
		expect(result).not.toHaveProperty('target_level');
		expect(result).not.toHaveProperty('risk_reward_ratio');
		expect(result).not.toHaveProperty('setup_type');
	});

	it('treats string-valued ATR as supplied when validating risk metadata', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 0.01 },
			technical_indicators: { atr: '0.02' },
			support_resistance: { nearest_resistance: 0.03 },
		});

		const result = await service.enrichFromAlertText('SHIBUSDT(240) pasó a señal de COMPRA');

		expect(result).not.toHaveProperty('invalidation_level');
		expect(result).not.toHaveProperty('target_level');
		expect(result).not.toHaveProperty('risk_reward_ratio');
		expect(result).not.toHaveProperty('setup_type');
	});

	it('only infers mean reversion when Bollinger position aligns with signal side', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn()
			.mockResolvedValueOnce({
				price_data: { current_price: 100 },
				technical_indicators: { atr: 4 },
				bollinger_bands: { position: 'Upper Half' },
				support_resistance: { nearest_resistance: 112 },
			})
			.mockResolvedValueOnce({
				price_data: { current_price: 100 },
				technical_indicators: { atr: 4 },
				bollinger_bands: { position: 'Lower Half' },
				support_resistance: { nearest_support: 88 },
			});

		const buyResult = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');
		const sellResult = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(buyResult).not.toHaveProperty('setup_type');
		expect(sellResult).not.toHaveProperty('setup_type');
	});

	it('preserves an explicit setup type without complete numeric risk data', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 1,
			defaultExchange: 'BINANCE',
			defaultTimeframe: '1h',
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});

		service.callCoinAnalysis = jest.fn().mockResolvedValue({
			price_data: { current_price: 100 },
			setup_type: 'breakout',
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(result.setup_type).toBe('breakout');
		expect(result).not.toHaveProperty('invalidation_level');
		expect(result).not.toHaveProperty('target_level');
		expect(result).not.toHaveProperty('risk_reward_ratio');
	});

	it('suppresses the metadata footer when explicitly disabled', async () => {
		process.env.ENABLE_MESSAGE_FOOTER_METADATA = 'false';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn().mockResolvedValue({});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(result.extraText).toBe('');
	});

	it('uses cached Remote Config values for runtime timeout and retry settings', () => {
		process.env.ENABLE_FIREBASE_REMOTE_CONFIG = 'true';
		remoteConfigService._setRemoteOverridesForTesting({
			TRADINGVIEW_MCP_TIMEOUT_MS: 5000,
			TRADINGVIEW_MCP_MAX_RETRIES: 1,
		});

		const service = new TradingViewMcpService();

		expect(service.getConfig()).toEqual(expect.objectContaining({
			timeoutMs: 5000,
			maxRetries: 1,
		}));
	});

	it('keeps environment-derived MCP timing values finite and positive', () => {
		process.env.TRADINGVIEW_MCP_TIMEOUT_MS = 'not-a-number';
		process.env.TRADINGVIEW_MCP_MAX_RETRIES = '0';
		process.env.TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS = '-10';

		const config = new TradingViewMcpService().getConfig();

		expect(config).toEqual(expect.objectContaining({
			timeoutMs: 12000,
			maxRetries: 3,
			enrichmentBudgetMs: 12000,
		}));
		expect([config.timeoutMs, config.maxRetries, config.enrichmentBudgetMs]
			.every(value => Number.isFinite(value) && value > 0)).toBe(true);
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
		expect(service.getStatus().enrichment).toEqual(expect.objectContaining({
			lastStatus: 'failed',
			failedCount: 1,
		}));
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
			maxRetries: 1,
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

	it('retries base analysis inside a sub-budget after the first attempt times out', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 2,
			timeoutMs: 5000,
			enrichmentBudgetMs: 3000,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		let attempts = 0;
		service.callCoinAnalysis = jest.fn().mockImplementation(async ({ signal } = {}) => {
			attempts += 1;
			if (attempts === 1) {
				return new Promise((resolve, reject) => {
					if (signal) {
						signal.addEventListener('abort', () => reject(new Error('base attempt timeout')), { once: true });
					}
				});
			}

			return { price_data: { current_price: 100 } };
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({
			tradingViewEnrichmentApplied: true,
			current_price: 100,
		}));
		expect(service.callCoinAnalysis).toHaveBeenCalledTimes(2);
	});

	it('caps exponential retry delays so later attempts fit inside the base budget', async () => {
		const service = new TradingViewMcpService({
			maxRetries: 3,
			timeoutMs: 5000,
			enrichmentBudgetMs: 4000,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		let attempts = 0;
		service.callCoinAnalysis = jest.fn().mockImplementation(async ({ signal } = {}) => {
			attempts += 1;
			if (attempts < 3) {
				return new Promise((resolve, reject) => {
					signal.addEventListener('abort', () => reject(new Error('base attempt timeout')), { once: true });
				});
			}

			return { price_data: { current_price: 100 } };
		});

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({ tradingViewEnrichmentApplied: true, current_price: 100 }));
		expect(service.callCoinAnalysis).toHaveBeenCalledTimes(3);
	});

	it('uses the full budget when optional enrichment is disabled', async () => {
		delete process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION;
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT;
		const service = new TradingViewMcpService({
			maxRetries: 1,
			timeoutMs: 5000,
			enrichmentBudgetMs: 1200,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn().mockImplementation(() => new Promise(resolve => {
			setTimeout(() => resolve({ price_data: { current_price: 100 } }), 1000);
		}));

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(result).toEqual(expect.objectContaining({ tradingViewEnrichmentApplied: true, current_price: 100 }));
	});

	it('keeps base enrichment when optional volume confirmation exhausts the remaining budget', async () => {
		process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION = 'true';
		const service = new TradingViewMcpService({
			maxRetries: 1,
			enrichmentBudgetMs: 80,
			logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
		});
		service.callCoinAnalysis = jest.fn().mockResolvedValue({ price_data: { current_price: 100 } });
		service.callVolumeConfirmation = jest.fn().mockImplementation(({ signal } = {}) => new Promise((resolve, reject) => {
			signal.addEventListener('abort', () => reject(new Error('volume timeout')), { once: true });
		}));

		const startedAt = Date.now();
		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de VENTA');

		expect(Date.now() - startedAt).toBeLessThan(500);
		expect(result).toEqual(expect.objectContaining({
			tradingViewEnrichmentApplied: true,
			tradingViewEnrichmentStatus: 'partial',
			current_price: 100,
		}));
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

	it('classifies malformed JSON MCP responses as invalid responses', () => {
		const service = new TradingViewMcpService();

		let error;
		try {
			service._decodeRpcBody('{"jsonrpc":', 'application/json', 'abc');
		} catch (caught) {
			error = caught;
		}

		expect(error).toEqual(expect.objectContaining({
			message: 'TradingView MCP returned invalid JSON response',
		}));
		expect(service._getErrorCategory(error)).toBe('invalid_response');
	});

	it('classifies MCP protocol violations as invalid responses', () => {
		const service = new TradingViewMcpService();

		let nonSseError;
		try {
			service._decodeRpcBody('maintenance text', 'text/plain', 'abc');
		} catch (error) {
			nonSseError = error;
		}

		expect(service._getErrorCategory(nonSseError)).toBe('invalid_response');
		expect(service._getErrorCategory(new Error('TradingView MCP did not return mcp-session-id header')))
			.toBe('invalid_response');
	});

	it('classifies HTTP errors before timeout text in provider responses', () => {
		const service = new TradingViewMcpService();

		expect(service._getErrorCategory(new Error('TradingView MCP HTTP 504: Gateway Timeout'))).toBe('http_5xx');
		expect(service._getErrorCategory(new Error('TradingView MCP HTTP 503: provider timeout'))).toBe('http_5xx');
		expect(service._getErrorCategory(new Error('TradingView MCP HTTP 408: request timeout'))).toBe('http_4xx');
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

	it('skips confluence enrichment by default when ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT is unset', async () => {
		delete process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT;
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
		service.callCombinedAnalysis = jest.fn();

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(service.callCombinedAnalysis).not.toHaveBeenCalled();
		expect(result.confluenceData).toBeNull();
	});

	it('skips confluence enrichment when ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT is explicitly false', async () => {
		process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT = 'false';
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
		service.callCombinedAnalysis = jest.fn();

		const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');

		expect(service.callCombinedAnalysis).not.toHaveBeenCalled();
		expect(result.confluenceData).toBeNull();
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

	describe('circuit breaker and operator paging', () => {
		let originalAdminChatId;

		beforeEach(() => {
			originalAdminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
			delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		});

		afterEach(() => {
			if (originalAdminChatId !== undefined) {
				process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = originalAdminChatId;
			} else {
				delete process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
			}
		});

		it('initializes in closed state with 0 consecutive failures', () => {
			const service = new TradingViewMcpService();
			const status = service.getCircuitBreakerStatus();
			expect(status).toEqual({
				state: 'closed',
				consecutiveFailures: 0,
				openedAt: null,
				lastStateChangeAt: null,
				failureThreshold: 5,
				cooldownMs: 600000,
			});
			expect(service.isBreakerOpen()).toBe(false);
		});

		it('opens circuit breaker after reaching failure threshold and reports degraded in status', async () => {
			const notifyAdmin = jest.fn().mockResolvedValue(undefined);
			const service = new TradingViewMcpService({
				breakerThreshold: 3,
				breakerCooldownMs: 60000,
				pageCooldownMs: 300000,
				notifyAdmin,
			});

			for (let i = 1; i <= 2; i++) {
				await expect(service._withRuntimeStatus(async () => {
					throw new Error('HTTP 502 Bad Gateway');
				})).rejects.toThrow('HTTP 502 Bad Gateway');
				expect(service.getBreakerState()).toBe('closed');
				expect(service.isBreakerOpen()).toBe(false);
			}

			expect(notifyAdmin).not.toHaveBeenCalled();

			// 3rd failure hits threshold
			await expect(service._withRuntimeStatus(async () => {
				throw new Error('HTTP 503 Service Unavailable');
			})).rejects.toThrow('HTTP 503 Service Unavailable');

			expect(service.getBreakerState()).toBe('open');
			expect(service.isBreakerOpen()).toBe(true);

			const cbStatus = service.getCircuitBreakerStatus();
			expect(cbStatus.state).toBe('open');
			expect(cbStatus.consecutiveFailures).toBe(3);
			expect(cbStatus.openedAt).toBeTruthy();

			const overallStatus = service.getStatus({ enabled: true });
			expect(overallStatus.status).toBe('degraded');
			expect(overallStatus.ready).toBe(false);
			expect(overallStatus.circuitBreaker.state).toBe('open');

			expect(notifyAdmin).toHaveBeenCalledTimes(1);
			expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({
				type: 'degradation',
				consecutiveFailures: 3,
				errorCategory: 'http_5xx',
			}));
		});

		it('fails open immediately in enrichFromSignal without making outbound calls when breaker is open', async () => {
			const service = new TradingViewMcpService({
				breakerThreshold: 2,
				breakerCooldownMs: 60000,
			});
			service.callCoinAnalysis = jest.fn();

			service._recordFailure(new Error('timeout'));
			service._recordFailure(new Error('timeout'));

			expect(service.isBreakerOpen()).toBe(true);

			const result = await service.enrichFromAlertText('BTCUSDT(240) pasó a señal de COMPRA');
			expect(result).toBeNull();
			expect(service.callCoinAnalysis).not.toHaveBeenCalled();
			expect(service.runtimeStatus.enrichment.failedCount).toBe(1);
		});

		it('throws circuit_breaker_open in _withRuntimeStatus without executing operation when breaker is open', async () => {
			const service = new TradingViewMcpService({
				breakerThreshold: 1,
				breakerCooldownMs: 60000,
			});
			service._recordFailure(new Error('outage'));

			const operation = jest.fn();
			await expect(service._withRuntimeStatus(operation)).rejects.toThrow('TradingView MCP circuit breaker is OPEN');
			expect(operation).not.toHaveBeenCalled();
		});

		it('respects pageCooldownMs and does not spam admin notifications during sustained outages', async () => {
			const notifyAdmin = jest.fn().mockResolvedValue(undefined);
			const service = new TradingViewMcpService({
				breakerThreshold: 2,
				breakerCooldownMs: 60000,
				pageCooldownMs: 3600000,
				notifyAdmin,
			});

			// Failures 1 and 2
			service._recordFailure(new Error('HTTP 500'));
			service._recordFailure(new Error('HTTP 500'));
			expect(notifyAdmin).toHaveBeenCalledTimes(1);

			// Additional failures during outage within page cooldown
			service._recordFailure(new Error('HTTP 500'));
			service._recordFailure(new Error('HTTP 500'));
			expect(notifyAdmin).toHaveBeenCalledTimes(1);
		});

		it('transitions from open to half-open after breakerCooldownMs has elapsed', () => {
			const service = new TradingViewMcpService({
				breakerThreshold: 2,
				breakerCooldownMs: 10000,
			});

			service._recordFailure(new Error('fail'));
			service._recordFailure(new Error('fail'));
			expect(service.getBreakerState()).toBe('open');

			// Fast forward time past cooldown
			service.breakerOpenedAt = new Date(Date.now() - 15000).toISOString();
			expect(service.getBreakerState()).toBe('half-open');
			expect(service.isBreakerOpen()).toBe(false);
		});

		it('recovers to closed and sends recovery page on successful trial probe in half-open state', async () => {
			const notifyAdmin = jest.fn().mockResolvedValue(undefined);
			const service = new TradingViewMcpService({
				breakerThreshold: 2,
				breakerCooldownMs: 10000,
				notifyAdmin,
			});

			service._recordFailure(new Error('fail'));
			service._recordFailure(new Error('fail'));
			expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({ type: 'degradation' }));
			notifyAdmin.mockClear();

			// Simulate half-open
			service.breakerOpenedAt = new Date(Date.now() - 15000).toISOString();
			expect(service.getBreakerState()).toBe('half-open');

			// Successful operation executes
			await service._withRuntimeStatus(async () => ({ success: true }));

			expect(service.getBreakerState()).toBe('closed');
			expect(service.consecutiveFailures).toBe(0);
			expect(service.breakerOpenedAt).toBeNull();
			expect(notifyAdmin).toHaveBeenCalledWith(expect.objectContaining({ type: 'recovery' }));
		});

		it('re-opens breaker if trial probe fails in half-open state', async () => {
			const service = new TradingViewMcpService({
				breakerThreshold: 2,
				breakerCooldownMs: 10000,
			});

			service._recordFailure(new Error('fail'));
			service._recordFailure(new Error('fail'));

			// Simulate half-open
			service.breakerOpenedAt = new Date(Date.now() - 15000).toISOString();
			expect(service.getBreakerState()).toBe('half-open');

			// Trial probe fails
			await expect(service._withRuntimeStatus(async () => {
				throw new Error('HTTP 504 Gateway Timeout');
			})).rejects.toThrow('HTTP 504 Gateway Timeout');

			expect(service.getBreakerState()).toBe('open');
			expect(service.consecutiveFailures).toBe(3);
		});

		it('pages admin via TelegramService when notifyAdmin callback is omitted but TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID is set', async () => {
			process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID = '-100998877';
			const sendMock = jest.fn().mockResolvedValue({ message_id: 123 });
			const notificationManager = {
				channels: new Map([
					['telegram', { isEnabled: () => true, send: sendMock }],
				]),
			};

			const service = new TradingViewMcpService({
				breakerThreshold: 1,
				breakerCooldownMs: 60000,
				notificationManager,
			});

			service._recordFailure(new Error('HTTP 503'));
			expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
				telegramChatId: '-100998877',
				text: expect.stringContaining('TradingView MCP Sustained Outage Alert'),
			}));
		});

		it('catches and logs warning if notifyAdmin throws, without bubbling error to caller', async () => {
			const logger = { warn: jest.fn(), error: jest.fn(), log: jest.fn() };
			const notifyAdmin = jest.fn().mockRejectedValue(new Error('telegram network down'));
			const service = new TradingViewMcpService({
				breakerThreshold: 1,
				breakerCooldownMs: 60000,
				notifyAdmin,
				logger,
			});

			service._recordFailure(new Error('mcp down'));
			// Allow microtask resolution
			await new Promise((r) => setTimeout(r, 10));

			expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('telegram network down'));
		});

		it('_resetForTesting clears all circuit breaker state', () => {
			const service = new TradingViewMcpService();
			service.consecutiveFailures = 8;
			service.breakerState = 'open';
			service.breakerOpenedAt = new Date().toISOString();
			service.hasActiveOutagePage = true;

			service._resetForTesting();

			expect(service.consecutiveFailures).toBe(0);
			expect(service.breakerState).toBe('closed');
			expect(service.breakerOpenedAt).toBeNull();
			expect(service.hasActiveOutagePage).toBe(false);
		});
	});

	describe('exchange alias and deterministic-miss classification', () => {
		it('aliases BATS to NASDAQ for coin_analysis calls', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			const callTool = jest.fn().mockResolvedValueOnce({
				price_data: { current_price: 348.95 },
			});

			const service = new TradingViewMcpService({
				maxRetries: 1,
				callToolFn: callTool,
				logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
			});
			service._callTool = callTool;

			await service.callCoinAnalysis({ symbol: 'TSLA', exchange: 'BATS', timeframe: '1D' });

			expect(callTool).toHaveBeenCalledWith('coin_analysis', expect.objectContaining({
				symbol: 'TSLA',
				exchange: 'NASDAQ',
			}), expect.any(Object));
		});

		it('keeps the original exchange on the request envelope when aliases are applied via enrichFromSignal', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			const callTool = jest.fn().mockResolvedValueOnce({
				price_data: { current_price: 200 },
				technical_indicators: { rsi: 50 },
			});
			const service = new TradingViewMcpService({
				maxRetries: 1,
				enrichmentBudgetMs: 5000,
				callToolFn: callTool,
				logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
			});
			service._callTool = callTool;

			const result = await service.enrichFromAlertText('BATS:TSLA(D) cambió a señal de COMPRA');

			expect(callTool).toHaveBeenCalledWith('coin_analysis', expect.objectContaining({
				exchange: 'NASDAQ',
			}), expect.any(Object));
			expect(result).toEqual(expect.objectContaining({
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
			}));
		});

		it('classifies "No data found" responses as deterministic misses', () => {
			const service = new TradingViewMcpService();
			expect(service._isDeterministicMissError(new Error('No data found for TSLA on KUCOIN'))).toBe(true);
			expect(service._isDeterministicMissError(new Error('No data found for QCOM on KUCOIN'))).toBe(true);
			expect(service._isDeterministicMissError(new Error('symbol not supported'))).toBe(true);
			expect(service._isDeterministicMissError(new Error('HTTP 503 Service Suspended'))).toBe(false);
			expect(service._isDeterministicMissError(new Error('timeout after 12000ms'))).toBe(false);
		});

		it('short-circuits retries when the first attempt returns a deterministic miss', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			const callTool = jest.fn().mockRejectedValue(new Error('No data found for TSLA on KUCOIN'));
			const service = new TradingViewMcpService({
				maxRetries: 3,
				callToolFn: callTool,
				logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
			});
			service._callTool = callTool;

			await expect(service.callCoinAnalysis({
				symbol: 'TSLA',
				exchange: 'BATS',
				timeframe: '1D',
			})).rejects.toThrow('No data found for TSLA on KUCOIN');

			expect(callTool).toHaveBeenCalledTimes(1);
		});

		it('still retries when the first attempt is a transient timeout', async () => {
			process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT = 'true';
			const callTool = jest.fn().mockRejectedValue(new Error('TradingView MCP timeout after 12000ms'));
			const service = new TradingViewMcpService({
				maxRetries: 3,
				callToolFn: callTool,
				logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
			});
			service._callTool = callTool;

			await expect(service.callCoinAnalysis({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1D',
			})).rejects.toThrow(/timeout/);

			expect(callTool.mock.calls.length).toBeGreaterThan(1);
		});
	});
});
