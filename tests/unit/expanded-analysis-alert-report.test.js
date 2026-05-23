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
});
