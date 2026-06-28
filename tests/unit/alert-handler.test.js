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
			original_text: 'BTCUSDT(240) pasó a señal de VENTA',
			sentiment: 'BEARISH',
			sentiment_score: -0.6,
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
			sources: [{ title: 'Source 1', url: 'https://example.com' }],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' }, { useTradingViewData: true });

		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalled();
		expect(groundAlert).toHaveBeenCalled();
		expect(result.sentiment).toBe('BULLISH');
		expect(result.sentiment_score).toBe(0.8);
		expect(result.insights).toEqual(expect.arrayContaining(['Gemini insight', 'MCP insight']));
		expect(result.technical_levels.supports).toEqual(['65000']);
		expect(result.technical_levels.resistances).toEqual(['68000']);
		expect(result.sources).toEqual([{ title: 'Source 1', url: 'https://example.com' }]);
		expect(result.extraText).toContain('*Model used*: `gemini-2.5-flash`');
		expect(result.extraText).toContain(`*Grounding*: \`${GROUNDING_MODEL_NAME}\`, \`tradingview-mcp\``);
		expect((result.extraText.match(/\*Model used\*:/g) || []).length).toBe(1);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
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
		expect(result.sentiment_score).toBe(0.1);
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
});
