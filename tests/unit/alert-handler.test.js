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
			technical_levels: { supports: [], resistances: [] },
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
			technical_levels: { supports: [], resistances: [] },
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

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

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
			technical_levels: { supports: ['64000'], resistances: ['69000'] },
			sources: [{ title: 'Source 1', url: 'https://example.com' }],
			truncated: false,
			modelUsed: 'gemini-2.5-flash',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalled();
		expect(groundAlert).toHaveBeenCalled();
		expect(result.sentiment).toBe('BULLISH');
		expect(result.sentiment_score).toBe(0.8);
		expect(result.insights).toEqual(expect.arrayContaining(['Gemini insight', 'MCP insight']));
		expect(result.technical_levels.supports).toEqual(expect.arrayContaining(['64000', '65000']));
		expect(result.technical_levels.resistances).toEqual(expect.arrayContaining(['68000', '69000']));
		expect(result.sources).toEqual([{ title: 'Source 1', url: 'https://example.com' }]);
		expect(result.extraText).toContain('*Model used*: `gemini-2.5-flash`');
		expect(result.extraText).toContain(`*Grounding*: \`${GROUNDING_MODEL_NAME}\`, \`tradingview-mcp\``);
		expect((result.extraText.match(/\*Model used\*:/g) || []).length).toBe(1);

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

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de VENTA' });

		expect(result).toEqual(mcpEnriched);
		expect(tradingViewMcpService.enrichFromAlertText).toHaveBeenCalled();
		expect(groundAlert).toHaveBeenCalled();

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});
});