'use strict';

jest.mock('../../src/services/tradingview/parseTradingViewSignal', () => ({
	parseTradingViewSignal: jest.fn(),
}));

jest.mock('../../src/services/tradingview/fallbackTradePlan', () => ({
	deriveFallbackTradePlan: jest.fn(),
	calculateFallbackRiskLevels: jest.fn(),
}));

const { parseTradingViewSignal } = require('../../src/services/tradingview/parseTradingViewSignal');
const { deriveFallbackTradePlan, calculateFallbackRiskLevels } = require('../../src/services/tradingview/fallbackTradePlan');
const {
	buildMinAlertContext,
	applyMinAlertContext,
	buildFooterPriceSourceLine,
	hasCompleteRiskMetadata,
	hasEntryPrice,
	isMinAlertContextEnabled,
	PROVISIONAL_TAG,
	NO_DATA_TAG,
} = require('../../src/services/alerts/minAlertContext');

function buildRuntimeConfig(overrides = {}) {
	return {
		ENABLE_MIN_ALERT_CONTEXT: true,
		ENABLE_MESSAGE_FOOTER_METADATA: true,
		...overrides,
	};
}

describe('min alert context (GH-581 / CB-269)', () => {
	beforeEach(() => {
		jest.resetAllMocks();
		parseTradingViewSignal.mockReturnValue(null);
		deriveFallbackTradePlan.mockResolvedValue(null);
		calculateFallbackRiskLevels.mockReturnValue(null);
	});

	describe('isMinAlertContextEnabled', () => {
		it('returns false by default', () => {
			expect(isMinAlertContextEnabled({})).toBe(false);
			expect(isMinAlertContextEnabled({ ENABLE_MIN_ALERT_CONTEXT: false })).toBe(false);
			expect(isMinAlertContextEnabled({ ENABLE_MIN_ALERT_CONTEXT: 'false' })).toBe(false);
		});

		it('returns true when explicitly enabled as boolean', () => {
			expect(isMinAlertContextEnabled({ ENABLE_MIN_ALERT_CONTEXT: true })).toBe(true);
		});

		it('returns true when explicitly enabled as string', () => {
			expect(isMinAlertContextEnabled({ ENABLE_MIN_ALERT_CONTEXT: 'true' })).toBe(true);
		});
	});

	describe('hasCompleteRiskMetadata / hasEntryPrice', () => {
		it('detects complete risk metadata', () => {
			expect(hasCompleteRiskMetadata({
				invalidation_level: 95,
				target_level: 105,
			})).toBe(true);
			expect(hasCompleteRiskMetadata({
				invalidation_level: 95,
				target_level: 105,
			})).toBe(true);
		});

		it('rejects partial risk metadata', () => {
			expect(hasCompleteRiskMetadata({ invalidation_level: 95 })).toBe(false);
			expect(hasCompleteRiskMetadata({ target_level: 105 })).toBe(false);
			expect(hasCompleteRiskMetadata({
				invalidation_level: 'not-a-number',
				target_level: 105,
			})).toBe(false);
		});

		it('detects entry price in either shape', () => {
			expect(hasEntryPrice({ current_price: 100 })).toBe(true);
			expect(hasEntryPrice({ price_data: { current_price: 100 } })).toBe(true);
			expect(hasEntryPrice({})).toBe(false);
			expect(hasEntryPrice({ current_price: -1 })).toBe(false);
			expect(hasEntryPrice({ current_price: NaN })).toBe(false);
		});
	});

	describe('buildMinAlertContext — disabled', () => {
		it('skips work when the feature flag is off', async () => {
			const ctx = await buildMinAlertContext({
				text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA',
				enriched: null,
				runtimeConfig: { ENABLE_MIN_ALERT_CONTEXT: false },
			});
			expect(ctx.applied).toBe(false);
			expect(deriveFallbackTradePlan).not.toHaveBeenCalled();
		});
	});

	describe('buildMinAlertContext — provider output wins', () => {
		it('skips when enriched already has price + complete risk', async () => {
			const ctx = await buildMinAlertContext({
				text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA',
				enriched: {
					current_price: 100,
					invalidation_level: 95,
					target_level: 105,
					risk_reward_ratio: 2,
				},
				runtimeConfig: buildRuntimeConfig(),
			});
			expect(ctx.applied).toBe(false);
			expect(deriveFallbackTradePlan).not.toHaveBeenCalled();
		});
	});

	describe('buildMinAlertContext — crypto signal fallback', () => {
		beforeEach(() => {
			parseTradingViewSignal.mockReturnValue({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				side: 'BUY',
			});
			calculateFallbackRiskLevels.mockImplementation((price, timeframe, side) => {
				if (side === 'SELL') {
					return {
						invalidation_level: price * 1.025,
						target_level: price * 0.95,
					};
				}
				return {
					invalidation_level: price * 0.975,
					target_level: price * 1.05,
				};
			});
			deriveFallbackTradePlan.mockResolvedValue({
				symbol: 'BTCUSDT',
				exchange: 'BINANCE',
				timeframe: '1h',
				side: 'BUY',
				current_price: 100,
				price_data: { current_price: 100, source: 'binance' },
				invalidation_level: 97.5,
				target_level: 105,
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
			});
		});

		it('builds a provisional package from Binance price when MCP enrichment fails', async () => {
			const ctx = await buildMinAlertContext({
				text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA',
				enriched: null,
				runtimeConfig: buildRuntimeConfig(),
			});

			expect(ctx.applied).toBe(true);
			expect(ctx.provisional).toBe(true);
			expect(ctx.provisionalTag).toBe(PROVISIONAL_TAG);
			expect(ctx.priceSource).toBe('binance');
			expect(ctx.current_price).toBe(100);
			expect(ctx.invalidation_level).toBeGreaterThan(0);
			expect(ctx.target_level).toBeGreaterThan(ctx.current_price);
			expect(ctx.symbol).toBe('BTCUSDT');
			expect(ctx.exchange).toBe('BINANCE');
			expect(ctx.side).toBe('BUY');
		});

		it('emits directional provisional levels for SELL signals', async () => {
			parseTradingViewSignal.mockReturnValue({
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				timeframe: '4h',
				side: 'SELL',
			});
			deriveFallbackTradePlan.mockResolvedValue({
				symbol: 'ETHUSDT',
				exchange: 'BINANCE',
				timeframe: '4h',
				side: 'SELL',
				current_price: 200,
				price_data: { current_price: 200, source: 'binance' },
				invalidation_level: 205,
				target_level: 190,
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
				levelsSource: 'derived-quote',
			});

			const ctx = await buildMinAlertContext({
				text: 'BINANCE:ETHUSDT(240) pasó a señal de VENTA',
				enriched: null,
				runtimeConfig: buildRuntimeConfig(),
			});

			expect(ctx.applied).toBe(true);
			expect(ctx.provisional).toBe(true);
			expect(ctx.side).toBe('SELL');
			expect(ctx.invalidation_level).toBeGreaterThan(ctx.current_price);
			expect(ctx.target_level).toBeLessThan(ctx.current_price);
		});

		it('falls back to no-data tag when deriveFallbackTradePlan returns null', async () => {
			deriveFallbackTradePlan.mockResolvedValue(null);
			const ctx = await buildMinAlertContext({
				text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA',
				enriched: null,
				runtimeConfig: buildRuntimeConfig(),
			});

			expect(ctx.applied).toBe(true);
			expect(ctx.priceSource).toBe('ninguno');
			expect(ctx.noDataTag).toBe(NO_DATA_TAG);
			expect(ctx.noDataMessage).toContain('sin datos tecnicos');
		});

		it('fails open when deriveFallbackTradePlan throws', async () => {
			deriveFallbackTradePlan.mockRejectedValue(new Error('binance down'));
			const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
			const ctx = await buildMinAlertContext({
				text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA',
				enriched: null,
				runtimeConfig: buildRuntimeConfig(),
			});

			expect(ctx.applied).toBe(true);
			expect(ctx.priceSource).toBe('ninguno');
			expect(ctx.noDataTag).toBe(NO_DATA_TAG);
			expect(warn).toHaveBeenCalled();
			warn.mockRestore();
		});

		it('skips non-signal text when no enriched payload', async () => {
			parseTradingViewSignal.mockReturnValue(null);
			const ctx = await buildMinAlertContext({
				text: 'plain prose with no signal',
				enriched: null,
				runtimeConfig: buildRuntimeConfig(),
			});
			expect(ctx.applied).toBe(false);
		});

		it('does not skip non-signal text when enriched payload already exists', async () => {
			parseTradingViewSignal.mockReturnValue(null);
			const ctx = await buildMinAlertContext({
				text: 'plain prose with no signal',
				enriched: { sentiment: 'NEUTRAL', insights: [] },
				runtimeConfig: buildRuntimeConfig(),
			});
			expect(ctx.applied).toBe(false);
		});
	});

	describe('applyMinAlertContext', () => {
		it('returns enriched unchanged when ctx is not applied', () => {
			const enriched = { insights: ['x'] };
			expect(applyMinAlertContext(enriched, { applied: false })).toBe(enriched);
		});

		it('fills price + risk metadata from the min context', () => {
			const ctx = {
				applied: true,
				provisional: true,
				priceSource: 'binance',
				current_price: 100,
				price_data: { current_price: 100, source: 'binance' },
				invalidation_level: 97.5,
				target_level: 105,
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
			};
			const result = applyMinAlertContext({ insights: ['existing'] }, ctx);

			expect(result.current_price).toBe(100);
			expect(result.price_data).toEqual({ current_price: 100, source: 'binance' });
			expect(result.invalidation_level).toBe(97.5);
			expect(result.target_level).toBe(105);
			expect(result.risk_reward_ratio).toBe(2);
			expect(result.setup_type).toBe('trend_continuation');
			expect(result.priceSource).toBe('binance');
			expect(result.provisionalLevels).toBe(true);
			expect(result.provisionalPrice).toBe(true);
			expect(result.insights.some(i => i.startsWith('Levels provisional'))).toBe(true);
		});

		it('preserves provider-derived fields when they exist', () => {
			const ctx = {
				applied: true,
				provisional: true,
				priceSource: 'binance',
				current_price: 100,
				invalidation_level: 97.5,
				target_level: 105,
				risk_reward_ratio: 2,
				setup_type: 'trend_continuation',
			};
			const enriched = {
				current_price: 110,
				invalidation_level: 105,
				target_level: 120,
				risk_reward_ratio: 1.5,
				setup_type: 'breakout',
				price_data: { current_price: 110, source: 'tradingview-mcp' },
			};
			const result = applyMinAlertContext(enriched, ctx);

			expect(result.current_price).toBe(110);
			expect(result.invalidation_level).toBe(105);
			expect(result.target_level).toBe(120);
			expect(result.risk_reward_ratio).toBe(1.5);
			expect(result.setup_type).toBe('breakout');
		});

		it('attaches the no-data annotation when no price source reachable', () => {
			const ctx = {
				applied: true,
				priceSource: 'ninguno',
				provisional: false,
				noDataTag: NO_DATA_TAG,
				noDataMessage: 'advertencia sin datos tecnicos',
			};
			const result = applyMinAlertContext({ insights: ['existing'] }, ctx);

			expect(result.priceSource).toBe('ninguno');
			expect(result.provisionalLevels).toBe(false);
			expect(result.provisionalPrice).toBe(false);
			expect(result.insights[0]).toContain('sin datos tecnicos');
		});
	});

	describe('buildFooterPriceSourceLine', () => {
		it('emits binance footer when context succeeded via Binance', () => {
			const line = buildFooterPriceSourceLine(
				{ applied: true, priceSource: 'binance' },
				{ ENABLE_MESSAGE_FOOTER_METADATA: true },
			);
			expect(line).toBe('fuente_precio: binance');
		});

		it('emits ninguno footer when no price source reachable', () => {
			const line = buildFooterPriceSourceLine(
				{ applied: true, priceSource: 'ninguno' },
				{ ENABLE_MESSAGE_FOOTER_METADATA: true },
			);
			expect(line).toBe('fuente_precio: ninguno');
		});

		it('returns empty string when footer metadata is disabled', () => {
			const line = buildFooterPriceSourceLine(
				{ applied: true, priceSource: 'binance' },
				{ ENABLE_MESSAGE_FOOTER_METADATA: false },
			);
			expect(line).toBe('');
		});

		it('returns empty string when ctx is not applied', () => {
			const line = buildFooterPriceSourceLine(
				{ applied: false, priceSource: 'binance' },
				{ ENABLE_MESSAGE_FOOTER_METADATA: true },
			);
			expect(line).toBe('');
		});
	});
});
