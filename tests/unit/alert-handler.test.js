/* global jest, describe, it, expect, beforeEach */

const { enrichAlert } = require('../../src/controllers/webhooks/handlers/alert/grounding');
const { groundAlert } = require('../../src/services/grounding/grounding');
const { GROUNDING_MODEL_NAME } = require('../../src/services/grounding/config');
const { validateAlert } = require('../../src/lib/validation');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');

jest.mock('../../src/services/grounding/grounding');
jest.mock('../../src/lib/validation');
jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		isEnabled: jest.fn(() => false),
		enrichFromAlertText: jest.fn(),
	},
}));

describe('Alert Handler', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		// Return the text directly, not wrapped in an object
		validateAlert.mockImplementation(text => text);
	});

	it('should enrich alert with grounded content', async () => {
		const alert = { text: 'Bitcoin breaks $50,000 mark' };
		const groundedContent = {
			sentiment: 'BULLISH',
			sentiment_score: 0.9,
			insights: ['Market update: BTC reaches 50k milestone'],
			sources: [
				{
					title: 'Test Source',
					snippet: 'Test snippet',
					url: 'https://test.com',
					sourceDomain: 'test.com',
				},
			],
			truncated: false,
		};

		groundAlert.mockResolvedValue(groundedContent);

		const result = await enrichAlert(alert);

		expect(result.original_text).toBe(alert.text);
		expect(result.insights).toEqual(groundedContent.insights);
		expect(result.sources).toEqual(groundedContent.sources);
		expect(result.truncated).toBe(false);
		expect(result).not.toHaveProperty('technical_levels');

		expect(groundAlert).toHaveBeenCalledWith({
			text: alert.text,
			options: expect.objectContaining({
				preserveLanguage: true,
			}),
		});
	});

	it('should handle empty text', async () => {
		validateAlert.mockImplementation(() => {
			throw new Error('Alert text is required');
		});

		await expect(enrichAlert({ text: '' }))
			.rejects.toThrow('Alert text is required');
	});

	it('should handle grounding failures', async () => {
		const alert = { text: 'Test alert' };
		groundAlert.mockRejectedValue(new Error('Grounding failed'));

		await expect(enrichAlert(alert))
			.rejects.toThrow('Alert enrichment failed: Grounding failed');
	});

	it('should handle grounding timeouts', async () => {
		const alert = { text: 'Test alert' };
		groundAlert.mockRejectedValue(new Error('Grounding timeout'));

		await expect(enrichAlert(alert))
			.rejects.toThrow('Alert enrichment failed: Grounding timeout');
	});

	it('should preserve truncation status', async () => {
		const alert = { text: 'A'.repeat(5000) };
		const groundedContent = {
			sentiment: 'NEUTRAL',
			sentiment_score: 0,
			insights: ['Summary of long text'],
			sources: [],
			truncated: true,
		};

		groundAlert.mockResolvedValue(groundedContent);

		const result = await enrichAlert(alert);
		expect(result.truncated).toBe(true);
	});

	it('should prioritize TradingView MCP enrichment when enabled and matched', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'false';

		const mcpEnriched = {
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			sentiment_score: -0.7,
			insights: ['Señal detectada'],
			technical_levels: { supports: ['65000'], resistances: ['68000'] },
			sources: [],
			truncated: false,
			extraText: '*Model used*: `tradingview-mcp`',
		};

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(mcpEnriched);

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

		expect(result).toEqual(mcpEnriched);
		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalled();
		expect(groundAlert).not.toHaveBeenCalled();

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should use TradingView MCP as complementary source when Gemini is enabled', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
			sentiment: 'BULLISH',
			sentiment_score: 0.6,
			insights: ['MCP insight'],
			technical_levels: { supports: ['65000'], resistances: ['68000'] },
			sources: [],
			truncated: false,
			extraText: '*Model used*: `tradingview-mcp`',
		});

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: ['Gemini insight'],
			invalidation_level: '$65000',
			target_level: '$70000',
			setup_type: 'trend_continuation',
			risk_reward_ratio: 2,
			sources: [{ title: 'Source 1', url: 'https://example.com' }],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalled();
		expect(groundAlert).toHaveBeenCalled();
		expect(result.sentiment).toBe('BULLISH');
		expect(result.sentiment_score).toBe(0.8);
		expect(result.insights).toEqual(expect.arrayContaining(['Gemini insight', 'MCP insight']));
		expect(result.technical_levels.supports).toEqual(['65000']);
		expect(result.technical_levels.resistances).toEqual(['68000']);
		expect(result.invalidation_level).toBe('$65000');
		expect(result.target_level).toBe('$70000');
		expect(result.setup_type).toBe('trend_continuation');
		expect(result.risk_reward_ratio).toBe(2);
		expect(result.sources).toEqual([{ title: 'Source 1', url: 'https://example.com' }]);
		expect(result.extraText).toContain('*Model used*: `gemini-2.5-flash`');
		expect(result.extraText).toContain(`*Grounding*: \`${GROUNDING_MODEL_NAME}\`, \`tradingview-mcp\``);
		expect((result.extraText.match(/\*Model used\*:/g) || []).length).toBe(1);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('keeps MCP risk levels and ratio together when Gemini provides a partial risk block', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			insights: ['MCP insight'],
			sources: [],
			invalidation_level: 94,
			target_level: 112,
			setup_type: 'trend_continuation',
			risk_reward_ratio: 2,
		});
		groundAlert.mockResolvedValue({
			insights: ['Gemini insight'],
			sources: [],
			invalidation_level: 90,
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result).toEqual(expect.objectContaining({
			invalidation_level: 94,
			target_level: 112,
			setup_type: 'trend_continuation',
			risk_reward_ratio: 2,
		}));

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('preserves a valid standalone setup type without a complete numeric risk block', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			insights: ['MCP insight'],
			sources: [],
		});
		groundAlert.mockResolvedValue({
			insights: ['Gemini insight'],
			sources: [],
			setup_type: 'breakout',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.setup_type).toBe('breakout');
		expect(result).not.toHaveProperty('invalidation_level');
		expect(result).not.toHaveProperty('target_level');
		expect(result).not.toHaveProperty('risk_reward_ratio');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should suppress combined enrichment footer when message metadata is disabled', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		const previousFooterFlag = process.env.ENABLE_MESSAGE_FOOTER_METADATA;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		process.env.ENABLE_MESSAGE_FOOTER_METADATA = 'false';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			insights: ['MCP insight'],
			sources: [],
			technical_levels: { supports: [], resistances: [] },
		});
		groundAlert.mockResolvedValue({
			insights: ['Gemini insight'],
			sources: [],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

		expect(result.extraText).toBe('');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		process.env.ENABLE_MESSAGE_FOOTER_METADATA = previousFooterFlag;
	});

	it('should preserve signed MCP sentiment score when Gemini score is missing', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			sentiment_score: -0.6,
			insights: ['MCP bearish insight'],
			technical_levels: { supports: ['65000'], resistances: ['68000'] },
			sources: [],
			truncated: false,
		});

		groundAlert.mockResolvedValue({
			insights: ['Gemini insight without score'],
			sources: [{ title: 'Source 1', url: 'https://example.com' }],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

		expect(result.sentiment).toBe('BEARISH');
		expect(result.sentiment_score).toBe(-0.6);
		expect(result.insights).toEqual(expect.arrayContaining(['Gemini insight without score', 'MCP bearish insight']));
		expect(result.technical_levels).toEqual({ supports: ['65000'], resistances: ['68000'] });

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should prioritize TradingView confluence insight when Gemini already fills the insight cap', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
			sentiment: 'BULLISH',
			sentiment_score: 0.7,
			insights: ['Confluencia: ALINEADA · Señales Alineadas YES · Confianza: 82', 'MCP secondary insight'],
			confluenceData: { recommendation: 'ALINEADA', confidence: 82, signals_agree: true },
			sources: [],
			truncated: false,
		});

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: [
				'Gemini insight 1',
				'Gemini insight 2',
				'Gemini insight 3',
				'Gemini insight 4',
				'Gemini insight 5',
				'Gemini insight 6',
			],
			sources: [{ title: 'Source 1', url: 'https://example.com' }],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.insights).toHaveLength(6);
		expect(result.insights[0]).toBe('Confluencia: ALINEADA · Señales Alineadas YES · Confianza: 82');
		expect(result.insights).toContain('Gemini insight 1');
		expect(result.insights).toContain('Gemini insight 5');
		expect(result.insights).not.toContain('Gemini insight 6');
		expect(result.insights).not.toContain('MCP secondary insight');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should prioritize contradictory confluence insight and preserve raw MCP metadata when Gemini fills the insight cap', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
			sentiment: 'NEUTRAL',
			sentiment_score: 0.1,
			insights: ['Confluencia contradictoria: SELL · Señales Mixtas ⚠️ · Confianza: 81', 'MCP secondary insight'],
			confluenceData: { confluence: { recommendation: 'SELL', confidence: 81, signals_agree: false } },
			multiTimeframeData: { alignment: 'bearish' },
			sources: [],
			truncated: false,
		});

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: [
				'Gemini insight 1',
				'Gemini insight 2',
				'Gemini insight 3',
				'Gemini insight 4',
				'Gemini insight 5',
				'Gemini insight 6',
			],
			sources: [{ title: 'Source 1', url: 'https://example.com' }],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.sentiment).toBe('NEUTRAL');
		expect(result.sentiment_score).toBe(0);
		expect(result.insights).toHaveLength(6);
		expect(result.insights[0]).toBe('Confluencia contradictoria: SELL · Señales Mixtas ⚠️ · Confianza: 81');
		expect(result.insights).not.toContain('Gemini insight 6');
		expect(result.confluenceData).toEqual({ confluence: { recommendation: 'SELL', confidence: 81, signals_agree: false } });
		expect(result.multiTimeframeData).toEqual({ alignment: 'bearish' });

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should fallback to MCP enrichment when Gemini fails', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		const mcpEnriched = {
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			sentiment_score: -0.5,
			insights: ['MCP fallback insight'],
			technical_levels: { supports: ['65000'], resistances: ['68000'] },
			sources: [],
			truncated: false,
		};

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(mcpEnriched);
		groundAlert.mockRejectedValue(new Error('Grounding API unavailable'));

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

		expect(result).toEqual(mcpEnriched);
		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalled();
		expect(groundAlert).toHaveBeenCalled();

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should ignore TradingView MCP enrichment when useTradingViewData is not true', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'false';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			sentiment_score: -0.7,
			insights: ['MCP insight'],
			technical_levels: { supports: ['65000'], resistances: ['68000'] },
			sources: [],
			truncated: false,
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

		expect(result).toBeNull();
		expect(tradingViewMcpService.enrichFromAlertText).not.toHaveBeenCalled();
		expect(groundAlert).not.toHaveBeenCalled();

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('emits Gemini technical levels when MCP enrichment fails and tags gemini provenance', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockRejectedValue(new Error('MCP unavailable'));

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: ['Gemini insight'],
			technical_levels: { supports: ['79,500'], resistances: ['$82,300', '83,000'] },
			sources: [],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.technical_levels).toEqual({ supports: ['79,500'], resistances: ['$82,300', '83,000'] });
		expect(result.levelsSource).toBe('gemini-grounding');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('emits Gemini technical levels on the Gemini-only path with provenance tag', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(false);

		groundAlert.mockResolvedValue({
			sentiment: 'BEARISH',
			sentiment_score: -0.6,
			insights: ['Gemini only'],
			technical_levels: { supports: ['100k'], resistances: [] },
			sources: [],
			truncated: false,
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

		expect(result.technical_levels).toEqual({ supports: ['100k'], resistances: [] });
		expect(result.levelsSource).toBe('gemini-grounding');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('keeps behavior identical to today when MCP succeeds and provides its own levels', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
			tradingViewEnrichmentApplied: true,
			tradingViewEnrichmentStatus: 'full',
			sentiment: 'BULLISH',
			sentiment_score: 0.6,
			insights: ['MCP insight'],
			technical_levels: { supports: ['65000'], resistances: ['68000'] },
			sources: [],
			truncated: false,
		});

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: ['Gemini insight'],
			technical_levels: { supports: ['79000'], resistances: ['83000'] },
			sources: [],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.tradingViewEnrichmentApplied).toBe(true);
		expect(result.tradingViewEnrichmentStatus).toBe('full');
		expect(result.technical_levels.supports).toContain('65000');
		expect(result.technical_levels.resistances).toContain('68000');
		expect(result.levelsSource).toBeUndefined();

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('suppresses Gemini fallback levels on a partial MCP enrichment that already carries levels', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
			tradingViewEnrichmentApplied: true,
			tradingViewEnrichmentStatus: 'partial',
			sentiment: 'BULLISH',
			sentiment_score: 0.6,
			insights: ['MCP insight'],
			technical_levels: { supports: ['65000'], resistances: [] },
			sources: [],
			truncated: false,
		});

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: ['Gemini insight'],
			technical_levels: { supports: ['79000'], resistances: ['83000'] },
			sources: [],
			truncated: false,
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.technical_levels).toEqual({ supports: ['65000'], resistances: [] });
		expect(result.levelsSource).toBeUndefined();

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('omits Gemini fallback levels entirely when Gemini returns no usable levels during MCP failure', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(null);

		groundAlert.mockResolvedValue({
			sentiment: 'NEUTRAL',
			sentiment_score: 0,
			insights: ['No levels available'],
			sources: [],
			truncated: false,
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result).not.toHaveProperty('technical_levels');
		expect(result).not.toHaveProperty('levelsSource');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should preserve structured MCP current_price and price_data when merged with Gemini enrichment', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			current_price: 64863.03,
			price_data: { current_price: 64863.03, high: 65000, low: 64000 },
			insights: ['MCP insight 1'],
			sources: [],
			truncated: false,
		});

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.9,
			insights: ['Gemini insight 1'],
			sources: [],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.current_price).toBe(64863.03);
		expect(result.price_data).toEqual({ current_price: 64863.03, high: 65000, low: 64000 });

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	describe('Sentiment and score merge coherence and sign-coherence guard', () => {
		it('prefers MCP when Gemini and MCP conflict, selecting sentiment and score atomically and tagging conflict', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

			tradingViewMcpService.isEnabled.mockReturnValue(true);
			tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
				original_text: 'BTCUSDT(240) pasó a señal de VENTA',
				tradingViewEnrichmentApplied: true,
				sentiment: 'BEARISH',
				sentiment_score: -0.65,
				insights: ['Technical breakdown confirmed'],
				sources: [],
				truncated: false,
			});

			groundAlert.mockResolvedValue({
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				insights: ['Gemini bullish news overview'],
				sources: [{ title: 'News', url: 'https://news.com' }],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

			expect(result.sentiment).toBe('BEARISH');
			expect(result.sentiment_score).toBe(-0.65);
			expect(result.sentimentConflict).toBe(true);
			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining('[Alert] Sentiment conflict between Gemini and TradingView MCP; selecting MCP indicators over LLM prose')
			);

			warnSpy.mockRestore();
			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('selects Gemini sentiment and score atomically when providers agree without conflict tag', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(true);
			tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
				original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
				tradingViewEnrichmentApplied: true,
				sentiment: 'BULLISH',
				sentiment_score: 0.6,
				insights: ['Technical breakout'],
				sources: [],
				truncated: false,
			});

			groundAlert.mockResolvedValue({
				sentiment: 'BULLISH',
				sentiment_score: 0.82,
				insights: ['Positive market tailwinds'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

			expect(result.sentiment).toBe('BULLISH');
			expect(result.sentiment_score).toBe(0.82);
			expect(result.sentimentConflict).toBeUndefined();

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('triggers MCP selection when structured confluence data signals disagree, even without insight text prefix', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(true);
			tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
				original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
				tradingViewEnrichmentApplied: true,
				sentiment: 'BEARISH',
				sentiment_score: -0.4,
				insights: ['Custom insight text without prefix'],
				confluenceData: {
					confluence: {
						signals_agree: false,
						recommendation: 'SELL',
						confidence: 85,
					},
				},
				sources: [],
				truncated: false,
			});

			groundAlert.mockResolvedValue({
				sentiment: 'BULLISH',
				sentiment_score: 0.75,
				insights: ['Gemini bullish news'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

			expect(result.sentiment).toBe('BEARISH');
			expect(result.sentiment_score).toBe(-0.4);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('enforces post-merge sign-coherence guard so BEARISH never carries a positive score', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(false);

			groundAlert.mockResolvedValue({
				sentiment: 'BEARISH',
				sentiment_score: 0.9, // positive score with BEARISH label
				insights: ['Bearish technical analysis'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

			expect(result.sentiment).toBe('BEARISH');
			expect(result.sentiment_score).toBe(-0.9);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('enforces post-merge sign-coherence guard so BULLISH never carries a negative score', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(false);

			groundAlert.mockResolvedValue({
				sentiment: 'BULLISH',
				sentiment_score: -0.85, // negative score with BULLISH label
				insights: ['Bullish rally'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' });

			expect(result.sentiment).toBe('BULLISH');
			expect(result.sentiment_score).toBe(0.85);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('enforces post-merge sign-coherence guard so NEUTRAL always carries a score of 0', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(false);

			groundAlert.mockResolvedValue({
				sentiment: 'NEUTRAL',
				sentiment_score: 0.55,
				insights: ['Consolidation'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

			expect(result.sentiment).toBe('NEUTRAL');
			expect(result.sentiment_score).toBe(0);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('enforces sign-coherence guard on MCP-only execution path when Gemini is disabled', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'false';

			tradingViewMcpService.isEnabled.mockReturnValue(true);
			tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
				original_text: 'BTCUSDT(240) pasó a señal de VENTA',
				tradingViewEnrichmentApplied: true,
				sentiment: 'BEARISH',
				sentiment_score: 0.7, // positive on BEARISH
				insights: ['Bearish indicators'],
				sources: [],
				truncated: false,
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

			expect(result.sentiment).toBe('BEARISH');
			expect(result.sentiment_score).toBe(-0.7);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('enforces sign-coherence guard on Gemini failure fallback-to-MCP path', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(true);
			tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
				original_text: 'BTCUSDT(240) pasó a señal de COMPRA',
				tradingViewEnrichmentApplied: true,
				sentiment: 'BULLISH',
				sentiment_score: -0.8, // negative on BULLISH
				insights: ['Bullish breakout'],
				sources: [],
				truncated: false,
			});

			groundAlert.mockRejectedValue(new Error('Gemini service unavailable'));

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

			expect(result.sentiment).toBe('BULLISH');
			expect(result.sentiment_score).toBe(0.8);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('clamps out-of-bounds sentiment scores to [-1.0, 1.0] while enforcing direction', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(false);

			groundAlert.mockResolvedValue({
				sentiment: 'BULLISH',
				sentiment_score: 2.5,
				insights: ['Super bullish'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' });

			expect(result.sentiment).toBe('BULLISH');
			expect(result.sentiment_score).toBe(1.0);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});

		it('provides fallback signed score when score is missing or 0 for directional sentiments', async () => {
			const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
			process.env.ENABLE_GEMINI_GROUNDING = 'true';

			tradingViewMcpService.isEnabled.mockReturnValue(false);

			groundAlert.mockResolvedValue({
				sentiment: 'BEARISH',
				sentiment_score: 0,
				insights: ['Bearish trend'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

			expect(result.sentiment).toBe('BEARISH');
			expect(result.sentiment_score).toBe(-0.5);

			process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
		});
	});
});
