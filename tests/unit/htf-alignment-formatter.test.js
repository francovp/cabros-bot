'use strict';

const {
	formatHtfAlignment,
	resolveHtfAlignment,
	resolveSide,
} = require('../../src/services/notification/formatters/htfAlignmentFormatter');
const MarkdownV2Formatter = require('../../src/services/notification/formatters/markdownV2Formatter');
const WhatsAppMarkdownFormatter = require('../../src/services/notification/formatters/whatsappMarkdownFormatter');
const remoteConfigService = require('../../src/services/remoteConfig/RemoteConfigService');

describe('HTF Alignment Formatter (Issue #635)', () => {
	describe('resolveSide()', () => {
		it('resolves explicit side property', () => {
			expect(resolveSide({ side: 'BUY' })).toBe('BUY');
			expect(resolveSide({ side: 'sell' })).toBe('SELL');
		});

		it('resolves side from original_text signal pattern', () => {
			expect(resolveSide({ original_text: 'BINANCE:BTCUSDT (1h) pasó a señal de COMPRA' })).toBe('BUY');
			expect(resolveSide({ original_text: 'BINANCE:ETHUSDT (4h) pasó a señal de VENTA' })).toBe('SELL');
			expect(resolveSide({ original_text: 'BTCUSDT(15m) BUY signal detected' })).toBe('BUY');
			expect(resolveSide({ original_text: 'SOLUSDT(1D) SELL signal detected' })).toBe('SELL');
		});

		it('resolves side from setup_type', () => {
			expect(resolveSide({ setup_type: 'BULLISH_BREAKOUT' })).toBe('BUY');
			expect(resolveSide({ setup_type: 'BEARISH_DIVERGENCE' })).toBe('SELL');
		});

		it('resolves side from sentiment fallback', () => {
			expect(resolveSide({ sentiment: 'BULLISH' })).toBe('BUY');
			expect(resolveSide({ sentiment: 'BEARISH' })).toBe('SELL');
			expect(resolveSide({ sentiment: 'NEUTRAL' })).toBeNull();
		});

		it('returns null when side cannot be determined', () => {
			expect(resolveSide({})).toBeNull();
			expect(resolveSide({ original_text: 'Mensaje sin direccion' })).toBeNull();
		});
	});

	describe('resolveHtfAlignment() direction-aware classification', () => {
		it('classifies BUY with positive net_score as ALINEADO', () => {
			const enriched = {
				side: 'BUY',
				multiTimeframeData: {
					alignment: {
						status: 'aligned',
						net_score: 2,
						confidence: 85,
						divergent_timeframes: ['15m'],
					},
				},
			};
			const result = resolveHtfAlignment(enriched);
			expect(result).not.toBeNull();
			expect(result.classification).toBe('aligned');
			expect(result.label).toBe('ALINEADO');
			expect(result.netScore).toBe(2);
			expect(result.divergentTimeframes).toEqual(['15m']);
			expect(result.text).toBe('📈 HTF: ALINEADO (net +2) · Divergentes: 15m');
		});

		it('classifies BUY with negative net_score as EN CONTRA', () => {
			const enriched = {
				side: 'BUY',
				multiTimeframeData: {
					alignment: {
						status: 'counter-trend',
						net_score: -3,
						confidence: 70,
						divergent_timeframes: ['1D', '4h'],
					},
				},
			};
			const result = resolveHtfAlignment(enriched);
			expect(result).not.toBeNull();
			expect(result.classification).toBe('counter-trend');
			expect(result.label).toBe('EN CONTRA');
			expect(result.netScore).toBe(-3);
			expect(result.divergentTimeframes).toEqual(['1D', '4h']);
			expect(result.text).toBe('📉 HTF: EN CONTRA (net -3) · Divergentes: 1D, 4h');
		});

		it('classifies SELL with negative net_score as ALINEADO (bearish alignment)', () => {
			const enriched = {
				side: 'SELL',
				multiTimeframeData: {
					alignment: {
						status: 'aligned',
						net_score: -2,
						confidence: 80,
						divergent_timeframes: [],
					},
				},
			};
			const result = resolveHtfAlignment(enriched);
			expect(result).not.toBeNull();
			expect(result.classification).toBe('aligned');
			expect(result.label).toBe('ALINEADO');
			expect(result.netScore).toBe(-2);
			expect(result.divergentTimeframes).toEqual([]);
			expect(result.text).toBe('📈 HTF: ALINEADO (net -2)');
		});

		it('classifies SELL with positive net_score as EN CONTRA (bullish counter-trend)', () => {
			const enriched = {
				side: 'SELL',
				multiTimeframeData: {
					alignment: {
						status: 'counter-trend',
						net_score: 3,
						confidence: 75,
					},
				},
			};
			const result = resolveHtfAlignment(enriched);
			expect(result).not.toBeNull();
			expect(result.classification).toBe('counter-trend');
			expect(result.label).toBe('EN CONTRA');
			expect(result.netScore).toBe(3);
			expect(result.text).toBe('📉 HTF: EN CONTRA (net +3)');
		});

		it('classifies net_score 0 as MIXTO', () => {
			const enriched = {
				side: 'BUY',
				multiTimeframeData: {
					alignment: {
						net_score: 0,
						divergent_timeframes: ['1h'],
					},
				},
			};
			const result = resolveHtfAlignment(enriched);
			expect(result).not.toBeNull();
			expect(result.classification).toBe('mixed');
			expect(result.label).toBe('MIXTO');
			expect(result.netScore).toBe(0);
			expect(result.text).toBe('⚖️ HTF: MIXTO (net 0) · Divergentes: 1h');
		});

		it('handles qualitative status without net_score', () => {
			const alignedResult = resolveHtfAlignment({
				side: 'BUY',
				multiTimeframeData: {
					alignment: { status: 'aligned' },
				},
			});
			expect(alignedResult.text).toBe('📈 HTF: ALINEADO');

			const counterResult = resolveHtfAlignment({
				side: 'BUY',
				multiTimeframeData: {
					alignment: { status: 'counter-trend' },
				},
			});
			expect(counterResult.text).toBe('📉 HTF: EN CONTRA');

			const mixedResult = resolveHtfAlignment({
				side: 'BUY',
				multiTimeframeData: {
					alignment: { status: 'mixed' },
				},
			});
			expect(mixedResult.text).toBe('⚖️ HTF: MIXTO');
		});

		it('handles trendConfluence and flat alignment objects fail-open', () => {
			const flatResult = resolveHtfAlignment({
				original_text: 'BTCUSDT(60) VENTA',
				trendConfluence: {
					status: 'aligned',
					direction: 'bearish',
				},
			});
			expect(flatResult.text).toBe('📈 HTF: ALINEADO');
		});

		it('returns null when multiTimeframeData is missing or empty', () => {
			expect(resolveHtfAlignment({})).toBeNull();
			expect(resolveHtfAlignment({ multiTimeframeData: null })).toBeNull();
			expect(resolveHtfAlignment({ multiTimeframeData: {} })).toBeNull();
		});
	});

	describe('formatHtfAlignment() with RemoteConfig gating', () => {
		let savedEnv;

		beforeEach(() => {
			savedEnv = { ...process.env };
			remoteConfigService._resetForTesting();
		});

		afterEach(() => {
			Object.keys(process.env).forEach((key) => delete process.env[key]);
			Object.assign(process.env, savedEnv);
			remoteConfigService._resetForTesting();
		});

		it('returns formatted text when ENABLE_ALERT_HTF_RENDER is default (true)', () => {
			const enriched = {
				side: 'BUY',
				multiTimeframeData: {
					alignment: {
						net_score: 2,
						divergent_timeframes: ['15m'],
					},
				},
			};
			expect(formatHtfAlignment(enriched)).toBe('📈 HTF: ALINEADO (net +2) · Divergentes: 15m');
		});

		it('returns null when ENABLE_ALERT_HTF_RENDER is disabled (false)', () => {
			process.env.ENABLE_ALERT_HTF_RENDER = 'false';
			const enriched = {
				side: 'BUY',
				multiTimeframeData: {
					alignment: {
						net_score: 2,
					},
				},
			};
			expect(formatHtfAlignment(enriched)).toBeNull();
		});
	});

	describe('MarkdownV2Formatter integration', () => {
		const formatter = new MarkdownV2Formatter();

		it('renders HTF line in Telegram MarkdownV2 formatted alert with proper escaping', () => {
			const enriched = {
				original_text: 'BINANCE:BTCUSDT (4h) pasó a señal de COMPRA',
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				insights: ['Señal detectada: COMPRA para BTCUSDT'],
				technical_levels: { supports: ['65,000'], resistances: ['70,000'] },
				multiTimeframeData: {
					alignment: {
						net_score: 2,
						divergent_timeframes: ['15m'],
					},
				},
			};

			const output = formatter.formatWebhookAlert(enriched);
			expect(output).toContain('Sentiment: BULLISH 🚀 \\(0\\.85\\)');
			expect(output).toContain('📈 HTF: ALINEADO \\(net \\+2\\) · Divergentes: 15m');
		});

		it('renders byte-identically to baseline when multiTimeframeData is absent', () => {
			const enriched = {
				original_text: 'BINANCE:BTCUSDT (4h) pasó a señal de COMPRA',
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				insights: ['Señal detectada: COMPRA para BTCUSDT'],
				technical_levels: { supports: ['65,000'], resistances: ['70,000'] },
			};

			const output = formatter.formatWebhookAlert(enriched);
			expect(output).not.toContain('HTF:');
			expect(output).toContain('Sentiment: BULLISH 🚀 \\(0\\.85\\)');
			expect(output).toContain('*Technical Levels*');
		});
	});

	describe('WhatsAppMarkdownFormatter integration', () => {
		const formatter = new WhatsAppMarkdownFormatter();

		it('renders HTF line in WhatsApp formatted alert', async () => {
			const enriched = {
				original_text: 'BINANCE:BTCUSDT (4h) pasó a señal de VENTA',
				sentiment: 'BEARISH',
				sentiment_score: -0.75,
				insights: ['Señal detectada: VENTA para BTCUSDT'],
				technical_levels: { supports: ['65,000'], resistances: ['70,000'] },
				multiTimeframeData: {
					alignment: {
						net_score: -3,
						divergent_timeframes: ['1D'],
					},
				},
			};

			const output = await formatter.formatWebhookAlert(enriched);
			expect(output).toContain('Sentiment: BEARISH 🔻 (-0.75)');
			expect(output).toContain('📈 HTF: ALINEADO (net -3) · Divergentes: 1D');
		});

		it('renders byte-identically to baseline when multiTimeframeData is absent', async () => {
			const enriched = {
				original_text: 'BINANCE:BTCUSDT (4h) pasó a señal de VENTA',
				sentiment: 'BEARISH',
				sentiment_score: -0.75,
				insights: ['Señal detectada: VENTA para BTCUSDT'],
				technical_levels: { supports: ['65,000'], resistances: ['70,000'] },
			};

			const output = await formatter.formatWebhookAlert(enriched);
			expect(output).not.toContain('HTF:');
			expect(output).toContain('Sentiment: BEARISH 🔻 (-0.75)');
			expect(output).toContain('*Technical Levels*');
		});
	});
});
