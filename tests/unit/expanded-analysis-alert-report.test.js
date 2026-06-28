const {
	parseExpandedAnalysisAlertRequest,
	buildExpandedAnalysisAlertReport,
} = require('../../src/services/tradingview/expandedAnalysisAlertReport');

describe('Expanded Analysis Alert report', () => {
	const originalEnv = process.env;

	afterEach(() => {
		process.env = originalEnv;
	});

	it('uses request body symbols before EXPANDED_ANALYSIS_ALERT_SYMBOLS', () => {
		process.env = {
			...originalEnv,
			EXPANDED_ANALYSIS_ALERT_SYMBOLS: 'NASDAQ:MSFT',
			TRADINGVIEW_MCP_DEFAULT_TIMEFRAME: '4h',
		};

		const parsed = parseExpandedAnalysisAlertRequest({
			body: {
				symbols: [' BINANCE:BTCUSDT ', 'NASDAQ:NVDA'],
				timeframe: '1D',
			},
		});

		expect(parsed).toEqual({
			symbols: [
				{ raw: 'BINANCE:BTCUSDT', exchange: 'BINANCE', symbol: 'BTCUSDT' },
				{ raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
			],
			timeframe: '1D',
			includeMultiTimeframe: false,
			analysisMode: 'standard',
		});
	});

	it('falls back to EXPANDED_ANALYSIS_ALERT_SYMBOLS and returns a clear error when none exist', () => {
		process.env = {
			...originalEnv,
			EXPANDED_ANALYSIS_ALERT_SYMBOLS: 'NASDAQ:AAPL, BINANCE:ETHUSDC',
		};

		expect(parseExpandedAnalysisAlertRequest({ body: {} }).symbols).toEqual([
			{ raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
			{ raw: 'BINANCE:ETHUSDC', exchange: 'BINANCE', symbol: 'ETHUSDC' },
		]);

		process.env = {
			...originalEnv,
			EXPANDED_ANALYSIS_ALERT_SYMBOLS: '',
		};

		expect(() => parseExpandedAnalysisAlertRequest({ body: {} })).toThrow('No expanded analysis symbols provided');
	});

	it('rejects non-object request bodies before using env fallback symbols', () => {
		process.env = {
			...originalEnv,
			EXPANDED_ANALYSIS_ALERT_SYMBOLS: 'NASDAQ:AAPL',
		};

		expect(() => parseExpandedAnalysisAlertRequest({ body: 'NASDAQ:NVDA' }))
			.toThrow('request body must be a JSON object');
	});

	it('rejects symbols that are not EXCHANGE:SYMBOL identifiers', () => {
		expect(() => parseExpandedAnalysisAlertRequest({
			body: { symbols: ['NVDA'], timeframe: '1D' },
		})).toThrow('Symbol must use EXCHANGE:SYMBOL format: NVDA');
	});

	it('rejects unsupported timeframes instead of silently falling back', () => {
		expect(() => parseExpandedAnalysisAlertRequest({
			body: { symbols: ['NASDAQ:NVDA'], timeframe: '2h' },
		})).toThrow('Unsupported timeframe: 2h');
	});

	it('rejects non-string timeframes instead of silently falling back', () => {
		expect(() => parseExpandedAnalysisAlertRequest({
			body: { symbols: ['NASDAQ:NVDA'], timeframe: 60 },
		})).toThrow('timeframe must be a string');
	});

	it('builds a grouped Spanish markdown report from analyzed symbols', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
				analysis: {
					price_data: {
						current_price: 219.51,
						change_percent: -1.8,
						volume: 70213090,
					},
					technical_indicators: {
						rsi: 57.8,
						sma20: 214.1,
						macd: 6.1,
						macd_signal: 7.2,
						atr: 7.69,
					},
				},
			},
			{
				input: { raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
				analysis: {
					price_data: {
						current_price: 304.99,
						change_percent: 0.9,
						volume: 10230000,
					},
					technical_indicators: {
						rsi: 76.2,
						sma20: 296.5,
						macd: 2.3,
						macd_signal: 1.1,
						atr: 5.91,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('📊 *ANÁLISIS AMPLIADO — Friday 22/05/2026*');
		expect(report).toContain('*🟡 NEUTROS*');
		expect(report).toContain('NVDA $219.51 (-1.8%) | RSI 57.8');
		expect(report).toContain('- *Tendencia (SMA20):* Alcista | *MACD:* Bearish');
		expect(report).toContain('- *Volumen:* Normal | *ATR:* $7.69');
		expect(report).toContain('- *Stop Loss sugerido:* $207.98');
		expect(report).toContain('*🔴 SOBRECOMPRADOS*');
		expect(report).toContain('AAPL $304.99 (+0.9%) | RSI 76.2');
		expect(report).toContain('- *Sugerencia:* VENDER / TOMAR GANANCIAS');
	});

	it('formats the current MCP top-level indicator schema', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
				analysis: {
					price_data: {
						current_price: 216.14,
						change_percent: -2.157,
						volume: 107015953,
					},
					rsi: {
						value: 54.45,
						signal: 'Neutral',
					},
					macd: {
						macd_line: 6.970568,
						signal_line: 7.789632,
						crossover: 'Bearish',
					},
					sma: {
						sma20: 214.786,
					},
					bollinger_bands: {
						lower: 194.2218,
					},
					volume_analysis: {
						signal: 'Normal',
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('NVDA $216.14 (-2.2%) | RSI 54.5');
		expect(report).toContain('- *Tendencia (SMA20):* Alcista | *MACD:* Bearish');
		expect(report).toContain('- *Volumen:* Normal');
		expect(report).toContain('- *Stop Loss sugerido:* $194.22');
	});

	it('renders target, risk reward, and invalidation for deterministic ATR-based setups', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:AMD', exchange: 'NASDAQ', symbol: 'AMD' },
				analysis: {
					price_data: {
						current_price: 100,
						change_percent: 2.5,
					},
					technical_indicators: {
						rsi: 54.2,
						sma20: 98,
						macd: 1.2,
						macd_signal: 0.8,
						atr: 4,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('- *Target sugerido:* $112.00');
		expect(report).toContain('- *Risk/Reward:* 2.00x · Setup favorable');
		expect(report).toContain('- *Invalidación:* $6.00 por debajo del precio actual');
	});

	it('renders target, risk reward, and invalidation for deterministic Bollinger-based setups', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
				analysis: {
					price_data: {
						current_price: 100,
						change_percent: 2.5,
					},
					technical_indicators: {
						rsi: 54.2,
						sma20: 98,
						macd: 1.2,
						macd_signal: 0.8,
						atr: 4,
					},
					bollinger_bands: {
						upper: 112,
						lower: 94,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('- *Target sugerido:* $112.00');
		expect(report).toContain('- *Risk/Reward:* 2.00x · Setup favorable');
		expect(report).toContain('- *Invalidación:* $6.00 por debajo del precio actual');
	});

	it('prefers nearest resistance over Bollinger and ATR targets', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
				analysis: {
					price_data: {
						current_price: 200,
						change_percent: 1.2,
					},
					technical_indicators: {
						rsi: 58,
						sma20: 198,
						macd: 1.5,
						macd_signal: 1.2,
						atr: 5,
					},
					bollinger_bands: {
						upper: 210,
						lower: 190,
					},
					support_resistance: {
						nearest_resistance: 215,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('- *Target sugerido:* $215.00');
		expect(report).toContain('- *Risk/Reward:* 2.00x · Setup favorable');
	});

	it('omits target and risk reward when the report lacks enough data', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:TSLA', exchange: 'NASDAQ', symbol: 'TSLA' },
				analysis: {
					price_data: {
						current_price: 250,
						change_percent: -0.4,
					},
					technical_indicators: {
						rsi: 49.5,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).not.toContain('Target sugerido');
		expect(report).not.toContain('Risk/Reward');
		expect(report).not.toContain('Invalidación');
	});

	it('omits long target output for overbought sell setups', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:AAPL', exchange: 'NASDAQ', symbol: 'AAPL' },
				analysis: {
					price_data: {
						current_price: 304.99,
						change_percent: 0.9,
					},
					technical_indicators: {
						rsi: 76.2,
						sma20: 296.5,
						macd: 2.3,
						macd_signal: 1.1,
						atr: 5.91,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('- *Sugerencia:* VENDER / TOMAR GANANCIAS');
		expect(report).not.toContain('Target sugerido');
		expect(report).not.toContain('Risk/Reward');
	});

	it('omits invalidation when the stop loss is above the current price', () => {
		const report = buildExpandedAnalysisAlertReport([
			{
				input: { raw: 'NASDAQ:NVDA', exchange: 'NASDAQ', symbol: 'NVDA' },
				analysis: {
					price_data: {
						current_price: 100,
						change_percent: -1.1,
					},
					technical_indicators: {
						rsi: 45,
						sma20: 102,
						macd: -0.4,
						macd_signal: -0.6,
					},
					bollinger_bands: {
						lower: 105,
						upper: 120,
					},
				},
			},
		], { now: new Date('2026-05-22T12:00:00Z') });

		expect(report).toContain('- *Stop Loss sugerido:* $105.00');
		expect(report).not.toContain('Invalidación');
		expect(report).not.toContain('Risk/Reward');
	});

	describe('includeMultiTimeframe updates', () => {
		it('parses includeMultiTimeframe and include_multi_timeframe correctly', () => {
			const parsed1 = parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					includeMultiTimeframe: true,
				},
			});
			expect(parsed1.includeMultiTimeframe).toBe(true);

			const parsed2 = parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					include_multi_timeframe: 'true',
				},
			});
			expect(parsed2.includeMultiTimeframe).toBe(true);

			const parsed3 = parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
				},
			});
			expect(parsed3.includeMultiTimeframe).toBe(false);
		});

		it('throws request error if includeMultiTimeframe is not a boolean', () => {
			expect(() => parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					includeMultiTimeframe: 'invalid',
				},
			})).toThrow('includeMultiTimeframe must be a boolean');
		});

		it('formats the report with multi-timeframe alignment correctly', () => {
			const report = buildExpandedAnalysisAlertReport([
				{
					input: { raw: 'BINANCE:BTCUSDT', exchange: 'BINANCE', symbol: 'BTCUSDT' },
					analysis: {
						price_data: { current_price: 68000, change_percent: 1.5 },
						technical_indicators: { rsi: 50 },
					},
					multiTimeframe: {
						timeframes: {
							'1W': { bias: 'Bullish', rsi: { value: 58.2 } },
							'1D': { bias: 'Bearish', rsi: { value: 42.4 } },
						},
						alignment: { status: 'MIXED', confidence: 'Low' },
						recommendation: { action: 'HOLD' },
					},
				},
			], { now: new Date('2026-05-22T12:00:00Z') });

			expect(report).toContain('- *Alineación Multi-TF:*');
			expect(report).toContain('• *Semanal (1W):* Alcista (RSI 58.2)');
			expect(report).toContain('• *Diario (1D):* Bajista (RSI 42.4)');
			expect(report).toContain('• *Confluencia:* MIXED (Confianza: Low)');
			expect(report).toContain('• *Recomendación:* HOLD');
		});
	});

	describe('analysisMode request validation', () => {
		it('parses analysisMode and analysis_mode correctly', () => {
			const parsed1 = parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					analysisMode: 'combined',
				},
			});
			expect(parsed1.analysisMode).toBe('combined');

			const parsed2 = parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					analysis_mode: 'standard',
				},
			});
			expect(parsed2.analysisMode).toBe('standard');

			const parsed3 = parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
				},
			});
			expect(parsed3.analysisMode).toBe('standard');
		});

		it('throws request error if analysisMode is not a string', () => {
			expect(() => parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					analysisMode: true,
				},
			})).toThrow('analysisMode must be a string');
		});

		it('throws request error if analysisMode is invalid value', () => {
			expect(() => parseExpandedAnalysisAlertRequest({
				body: {
					symbols: ['BINANCE:BTCUSDT'],
					analysisMode: 'invalid_mode',
				},
			})).toThrow('analysisMode must be either "standard" or "combined"');
		});
	});

	describe('combined analysis report formatting', () => {
		it('formats the report with Reddit sentiment, confluence, and news correctly', () => {
			const report = buildExpandedAnalysisAlertReport([
				{
					input: { raw: 'BINANCE:BTCUSDT', exchange: 'BINANCE', symbol: 'BTCUSDT' },
					analysis: {
						technical: {
							price_data: { current_price: 68000, change_percent: 1.5 },
							technical_indicators: { rsi: 50 },
						},
						sentiment: {
							sentiment_label: 'Bullish',
							sentiment_score: 0.45,
							posts_analyzed: 12,
						},
						confluence: {
							recommendation: 'STRONG BUY',
							confidence: 'high',
							signals_agree: true,
						},
						news: {
							latest: [
								{ title: 'Bitcoin surges past 68k', url: 'https://coindesk.com/btc', source: 'CoinDesk' },
								{ title: 'Crypto market gains momentum', url: 'https://bloomberg.com/crypto' },
							],
						},
					},
				},
			], { now: new Date('2026-05-22T12:00:00Z') });

			expect(report).toContain('BTCUSDT $68,000.00 (+1.5%) | RSI 50.0');
			expect(report).toContain('- *Sentimiento Reddit:* 🐂 Alcista (Score: 0.45, 12 posts)');
			expect(report).toContain('- *Confluencia:* 🟢 STRONG BUY · Señales Alineadas ✅ (Confianza: high)');
			expect(report).toContain('- *Últimas Noticias:*');
			expect(report).toContain('  • Bitcoin surges past 68k (CoinDesk)');
			expect(report).toContain('  • Crypto market gains momentum (bloomberg.com)');
		});
	});
});
