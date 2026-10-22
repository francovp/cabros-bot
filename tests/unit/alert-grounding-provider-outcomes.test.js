/* global jest, describe, it, beforeEach, expect */

jest.mock('../../src/lib/validation', () => ({
	validateAlert: jest.fn((text) => ({ text })),
}));

jest.mock('../../src/services/grounding/grounding', () => ({
	groundAlert: jest.fn(),
}));

jest.mock('../../src/services/remoteConfig/RemoteConfigService', () => ({
	getRuntimeConfig: jest.fn(() => ({
		ENABLE_GEMINI_GROUNDING: true,
		ENABLE_MESSAGE_FOOTER_METADATA: false,
	})),
}));

jest.mock('../../src/services/tradingview/TradingViewMcpService', () => ({
	tradingViewMcpService: {
		isEnabled: jest.fn(() => true),
		enrichFromAlertText: jest.fn(),
	},
}));

jest.mock('../../src/services/tradingview/fallbackTradePlan', () => ({
	deriveFallbackTradePlan: jest.fn().mockResolvedValue(null),
	calculateFallbackRiskLevels: jest.fn(),
}));

jest.mock('../../src/lib/tokenUsage', () => ({
	tokenCostBudgetService: { isBudgetExceeded: jest.fn(() => false) },
}));

const { groundAlert } = require('../../src/services/grounding/grounding');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { getRuntimeConfig } = require('../../src/services/remoteConfig/RemoteConfigService');
const { deriveFallbackTradePlan } = require('../../src/services/tradingview/fallbackTradePlan');
const { enrichAlert, ENRICHMENT_PROVIDER_OUTCOMES } = require('../../src/controllers/webhooks/handlers/alert/grounding');

describe('alert provider outcome metadata', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		groundAlert.mockRejectedValue(new Error('Gemini grounding unavailable'));
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			tradingViewEnrichmentApplied: true,
			tradingViewEnrichmentStatus: 'full',
			sentiment: 'BULLISH',
			sentiment_score: 0.8,
			insights: [],
		});
	});

	it('preserves a Gemini failure when TradingView MCP supplies the fallback result', async () => {
		const result = await enrichAlert({ text: 'BINANCE:BTCUSDT (1h) BUY' }, { useTradingViewData: true });

		expect(result[ENRICHMENT_PROVIDER_OUTCOMES]).toEqual({
			gemini: { status: 'failed' },
			tradingViewMcp: { status: 'full' },
		});
		expect(Object.prototype.propertyIsEnumerable.call(result, ENRICHMENT_PROVIDER_OUTCOMES)).toBe(false);
		expect(JSON.stringify(result)).not.toContain('enrichment-provider-outcomes');
	});

	it('preserves both provider failures when no enrichment fallback is available', async () => {
		tradingViewMcpService.enrichFromAlertText.mockRejectedValue(new Error('MCP unavailable'));
		deriveFallbackTradePlan.mockResolvedValue(null);

		const error = await enrichAlert({ text: 'BINANCE:BTCUSDT (1h) BUY' }, { useTradingViewData: true })
			.then(() => null, (caught) => caught);

		expect(error[ENRICHMENT_PROVIDER_OUTCOMES]).toEqual({
			gemini: { status: 'failed' },
			tradingViewMcp: { status: 'failed' },
		});
	});

	it('preserves MCP failure when MCP returns no result and Gemini is disabled', async () => {
		getRuntimeConfig.mockReturnValueOnce({ ENABLE_GEMINI_GROUNDING: false });
		tradingViewMcpService.enrichFromAlertText.mockResolvedValueOnce(null);
		deriveFallbackTradePlan.mockResolvedValueOnce(null);

		const error = await enrichAlert({ text: 'BINANCE:BTCUSDT (1h) BUY' }, { useTradingViewData: true })
			.then(() => null, (caught) => caught);

		expect(error[ENRICHMENT_PROVIDER_OUTCOMES]).toEqual({
			tradingViewMcp: { status: 'failed' },
		});
	});
});
