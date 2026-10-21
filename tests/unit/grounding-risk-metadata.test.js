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
const { deriveFallbackTradePlan, calculateFallbackRiskLevels } = require('../../src/services/tradingview/fallbackTradePlan');
const {
	enrichAlert,
	_selectRiskMetadataForTesting: selectRiskMetadata,
	_mergeEnrichmentDataForTesting: mergeEnrichmentData,
	_sanitizeSetupPairingForTesting: sanitizeSetupPairing,
} = require('../../src/controllers/webhooks/handlers/alert/grounding');

describe('Grounding risk metadata setup_type and setup_evidence pairing (Issue #1393)', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		getRuntimeConfig.mockReturnValue({
			ENABLE_GEMINI_GROUNDING: true,
			ENABLE_MESSAGE_FOOTER_METADATA: false,
		});
	});

	describe('sanitizeSetupPairing helper', () => {
		it('preserves paired valid setup_type and non-empty setup_evidence', () => {
			const input = {
				setup_type: 'breakout',
				setup_evidence: 'High volume range breakout',
				otherField: 123,
			};
			const result = sanitizeSetupPairing(input);
			expect(result.setup_type).toBe('breakout');
			expect(result.setup_evidence).toBe('High volume range breakout');
			expect(result.otherField).toBe(123);
		});

		it('trims whitespace on valid setup_evidence', () => {
			const input = {
				setup_type: 'mean_reversion',
				setup_evidence: '  Bounced off 200 SMA  \n',
			};
			const result = sanitizeSetupPairing(input);
			expect(result.setup_type).toBe('mean_reversion');
			expect(result.setup_evidence).toBe('Bounced off 200 SMA');
		});

		it('omits setup_type when setup_evidence is missing or undefined', () => {
			const input = { setup_type: 'breakout', otherField: 123 };
			const result = sanitizeSetupPairing(input);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
			expect(result.otherField).toBe(123);
		});

		it('omits setup_type when setup_evidence is empty string or only whitespace', () => {
			for (const emptyEvidence of ['', '   ', '\t\n ']) {
				const result = sanitizeSetupPairing({
					setup_type: 'breakout',
					setup_evidence: emptyEvidence,
				});
				expect(result).not.toHaveProperty('setup_type');
				expect(result).not.toHaveProperty('setup_evidence');
			}
		});

		it('omits setup_type when setup_evidence is not a string', () => {
			for (const invalidEvidence of [null, 12345, true, {}, []]) {
				const result = sanitizeSetupPairing({
					setup_type: 'breakout',
					setup_evidence: invalidEvidence,
				});
				expect(result).not.toHaveProperty('setup_type');
				expect(result).not.toHaveProperty('setup_evidence');
			}
		});

		it('omits setup_evidence when setup_type is missing or undefined', () => {
			const input = { setup_evidence: 'Some structural rationale', otherField: 123 };
			const result = sanitizeSetupPairing(input);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
			expect(result.otherField).toBe(123);
		});

		it('omits setup_evidence when setup_type is not an allowed enum', () => {
			for (const invalidType of ['random_setup', 'invalid', 'BUY', '', null, 123]) {
				const result = sanitizeSetupPairing({
					setup_type: invalidType,
					setup_evidence: 'Valid structural evidence',
				});
				expect(result).not.toHaveProperty('setup_type');
				expect(result).not.toHaveProperty('setup_evidence');
			}
		});
	});

	describe('selectRiskMetadata bidirectional pairing', () => {
		it('omits setup_type when MCP provides setup_type without setup_evidence', () => {
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 100,
				invalidation_level: 95,
				target_level: 110,
				risk_reward_ratio: 2,
				setup_type: 'breakout',
			};
			const gemini = {};

			const result = selectRiskMetadata(gemini, mcp);
			expect(result.invalidation_level).toBe(95);
			expect(result.target_level).toBe(110);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
		});

		it('preserves paired setup when MCP provides both setup_type and setup_evidence', () => {
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 100,
				invalidation_level: 95,
				target_level: 110,
				risk_reward_ratio: 2,
				setup_type: 'breakout',
				setup_evidence: 'Price broke resistance band with heavy volume',
			};
			const gemini = {};

			const result = selectRiskMetadata(gemini, mcp);
			expect(result.setup_type).toBe('breakout');
			expect(result.setup_evidence).toBe('Price broke resistance band with heavy volume');
		});

		it('corroborates MCP setup_type with Gemini setup_evidence when types match', () => {
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 100,
				invalidation_level: 95,
				target_level: 110,
				risk_reward_ratio: 2,
				setup_type: 'breakout',
			};
			const gemini = {
				setup_type: 'breakout',
				setup_evidence: 'Volume confirmed breakout of key level',
			};

			const result = selectRiskMetadata(gemini, mcp);
			expect(result.setup_type).toBe('breakout');
			expect(result.setup_evidence).toBe('Volume confirmed breakout of key level');
		});

		it('preserves Gemini paired setup when MCP setup_type lacks evidence and types differ', () => {
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 100,
				invalidation_level: 95,
				target_level: 110,
				risk_reward_ratio: 2,
				setup_type: 'breakout', // uncorroborated, lacks evidence
			};
			const gemini = {
				setup_type: 'trend_continuation',
				setup_evidence: 'Pullback held 20 EMA in primary trend',
			};

			const result = selectRiskMetadata(gemini, mcp);
			expect(result.setup_type).toBe('trend_continuation');
			expect(result.setup_evidence).toBe('Pullback held 20 EMA in primary trend');
		});

		it('omits setup metadata when neither source has evidence', () => {
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 100,
				invalidation_level: 95,
				target_level: 110,
				risk_reward_ratio: 2,
				setup_type: 'reversal',
			};
			const gemini = {
				setup_type: 'reversal',
			};

			const result = selectRiskMetadata(gemini, mcp);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
		});

		it('omits setup metadata on no-source branch when setup_evidence is missing', () => {
			const mcp = {};
			const gemini = {
				setup_type: 'breakout',
			};

			const result = selectRiskMetadata(gemini, mcp);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
		});
	});

	describe('mergeEnrichmentData bidirectional pairing', () => {
		it('does not emit setup_type in merged alert when MCP has unpaired setup_type', () => {
			const gemini = {
				sentiment: 'BULLISH',
				sentiment_score: 0.8,
				insights: ['Gemini insight'],
			};
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 50000,
				invalidation_level: 48000,
				target_level: 54000,
				risk_reward_ratio: 2,
				setup_type: 'breakout', // unpaired
			};

			const merged = mergeEnrichmentData('BTC BUY', gemini, mcp);
			expect(merged).not.toHaveProperty('setup_type');
			expect(merged).not.toHaveProperty('setup_evidence');
		});

		it('preserves paired setup_type and setup_evidence in merged alert', () => {
			const gemini = {
				sentiment: 'BULLISH',
				sentiment_score: 0.8,
				setup_type: 'breakout',
				setup_evidence: 'Grounded article notes resistance break',
			};
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				current_price: 50000,
				invalidation_level: 48000,
				target_level: 54000,
				risk_reward_ratio: 2,
			};

			const merged = mergeEnrichmentData('BTC BUY', gemini, mcp);
			expect(merged.setup_type).toBe('breakout');
			expect(merged.setup_evidence).toBe('Grounded article notes resistance break');
		});

		it('strips setup_type when calculateFallbackRiskLevels replaces levels without evidence', () => {
			calculateFallbackRiskLevels.mockReturnValueOnce({
				invalidation_level: 47500,
				target_level: 55000,
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation', // fallback without evidence
			});

			const gemini = {
				sentiment: 'BULLISH',
				sentiment_score: 0.8,
			};
			const mcp = {
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'partial',
				current_price: 50000,
				// Missing invalidation_level, target_level, risk_reward_ratio to trigger fallback
			};

			const merged = mergeEnrichmentData('BINANCE:BTCUSDT (1h) BUY', gemini, mcp, {
				side: 'BUY',
				timeframe: '1h',
			});
			expect(merged.invalidation_level).toBe(47500);
			expect(merged.target_level).toBe(55000);
			expect(merged).not.toHaveProperty('setup_type');
			expect(merged).not.toHaveProperty('setup_evidence');
		});
	});

	describe('enrichAlert end-to-end fallback paths', () => {
		it('omits setup_type when TradingView MCP supplies fallback result with unpaired setup_type', async () => {
			groundAlert.mockRejectedValueOnce(new Error('Gemini offline'));
			tradingViewMcpService.enrichFromAlertText.mockResolvedValueOnce({
				tradingViewEnrichmentApplied: true,
				tradingViewEnrichmentStatus: 'full',
				sentiment: 'BULLISH',
				sentiment_score: 0.85,
				current_price: 65000,
				invalidation_level: 63000,
				target_level: 70000,
				risk_reward_ratio: 2.5,
				setup_type: 'breakout', // unpaired from MCP
				insights: ['MCP analysis'],
			});

			const result = await enrichAlert({ text: 'BINANCE:BTCUSDT (1h) BUY' }, { useTradingViewData: true });
			expect(result.current_price).toBe(65000);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
		});

		it('omits setup_type when deriveFallbackTradePlan supplies plan with setup_type but no evidence', async () => {
			getRuntimeConfig.mockReturnValueOnce({
				ENABLE_GEMINI_GROUNDING: false,
			});
			tradingViewMcpService.enrichFromAlertText.mockResolvedValueOnce(null);
			deriveFallbackTradePlan.mockResolvedValueOnce({
				side: 'BUY',
				symbol: 'BTCUSDT',
				current_price: 65000,
				invalidation_level: 63000,
				target_level: 70000,
				risk_reward_ratio: 2.5,
				setup_type: 'breakout', // unpaired from fallbackTradePlan
				price_data: { current_price: 65000 },
			});

			const result = await enrichAlert({ text: 'BINANCE:BTCUSDT (1h) BUY' }, { useTradingViewData: true });
			expect(result.current_price).toBe(65000);
			expect(result).not.toHaveProperty('setup_type');
			expect(result).not.toHaveProperty('setup_evidence');
		});
	});
});
