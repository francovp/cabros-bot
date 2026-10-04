jest.mock('../../src/services/tradingview/fallbackTradePlan', () => ({
	deriveFallbackTradePlan: jest.fn(),
	calculateFallbackRiskLevels: jest.fn(),
	TIMEFRAME_RISK_MAP: {},
	formatDerivedLevel: jest.fn(p => p),
}));

const { deriveFallbackTradePlan, calculateFallbackRiskLevels } = require('../../src/services/tradingview/fallbackTradePlan');
const { enrichAlert } = require('../../src/controllers/webhooks/handlers/alert/grounding');
const { groundAlert } = require('../../src/services/grounding/grounding');
const { GROUNDING_MODEL_NAME } = require('../../src/services/grounding/config');
const { validateAlert } = require('../../src/lib/validation');
const { tradingViewMcpService } = require('../../src/services/tradingview/TradingViewMcpService');
const { computeDeterministicRiskReward } = require('../../src/services/tradingview/riskRewardMath');

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
		deriveFallbackTradePlan.mockResolvedValue(null);
		calculateFallbackRiskLevels.mockReturnValue(null);
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

	it.each([
		[false, null, 100, 'USD', 'gemini-grounding'],
		[true, null, 100, 'USD', 'gemini-grounding'],
		[true, 110, undefined, 'USDT', 'tradingview-mcp'],
	])('preserves Gemini entry price through the adapter (MCP enabled=%s, price=%s)', async (mcpEnabled, mcpPrice, expectedGeminiPrice, expectedCurrency, expectedSource) => {
		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100,
			price_currency: 'USD', invalidation_level: 90, target_level: 130,
			risk_reward_ratio: 3, insights: [], sources: [],
		});
		tradingViewMcpService.isEnabled.mockReturnValue(mcpEnabled);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			current_price: mcpPrice, price_currency: mcpPrice ? 'USDT' : undefined,
			tradingViewEnrichmentApplied: !!mcpPrice,
		});
		const result = await enrichAlert({ text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA' }, { useTradingViewData: mcpEnabled });
		expect(result.current_price).toBe(expectedGeminiPrice ?? mcpPrice);
		expect(result.price_currency).toBe(expectedCurrency);
		expect(result.priceSource).toBe(expectedSource);
	});

	it('keeps fallback quote price and levels together when Gemini has incomplete risk metadata', async () => {
		groundAlert.mockResolvedValue({ current_price: 100, price_currency: 'USD', sentiment: 'BULLISH', sentiment_score: 0.6 });
		deriveFallbackTradePlan.mockResolvedValue({ current_price: 110, price_data: { current_price: 110 }, invalidation_level: 107.25, target_level: 115.5, risk_reward_ratio: 2 });
		const result = await enrichAlert({ text: 'BINANCE:BTCUSDT(60) pasó a señal de COMPRA' });
		expect(result).toMatchObject({ current_price: 110, price_data: { current_price: 110 }, invalidation_level: 107.25, target_level: 115.5, priceSource: 'derived-quote' });
		expect(result).not.toHaveProperty('price_currency');
	});

	// GH-599: `hasCompleteRiskMetadata` also requires `risk_reward_ratio`, so a grounded
	// block that supplies a usable entry price plus BOTH directional levels but omits the
	// optional ratio used to be thrown away wholesale and replaced with a derived-quote
	// heuristic plan. That discarded real grounding data — the exact regression this issue
	// exists to prevent. The ratio is arithmetic, so it must be computed from the grounded
	// levels instead of discarding them.
	const withGroundingOnly = (gemini) => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		tradingViewMcpService.isEnabled.mockReturnValue(false);
		groundAlert.mockResolvedValue({ insights: [], sources: [], ...gemini });
		// A heuristic plan that would be preferred if the grounded block were discarded.
		deriveFallbackTradePlan.mockResolvedValue({
			symbol: 'BTCUSDT',
			side: 'BUY',
			current_price: 110,
			price_data: { current_price: 110 },
			invalidation_level: 107.25,
			target_level: 115.5,
			risk_reward_ratio: 2,
			setup_type: 'trend_continuation',
			levelsSource: 'derived-quote',
		});
	};

	const HEURISTIC_PLAN = {
		current_price: 110,
		price_data: { current_price: 110 },
		invalidation_level: 107.25,
		target_level: 115.5,
		priceSource: 'derived-quote',
		levelsSource: 'derived-quote',
	};

	it.each([
		[
			'BUY', 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA',
			{ sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100, price_currency: 'USD', invalidation_level: 90, target_level: 120, technical_levels: { supports: ['90'], resistances: ['120'] } },
			{ invalidation_level: 90, target_level: 120 },
		],
		[
			'SELL', 'BINANCE:BTCUSDT(60) pasó una señal de VENTA',
			{ sentiment: 'BEARISH', sentiment_score: -0.6, current_price: 100, price_currency: 'USD', invalidation_level: 110, target_level: 80, technical_levels: { supports: ['80'], resistances: ['110'] } },
			{ invalidation_level: 110, target_level: 80 },
		],
	])('preserves grounded entry price and %s levels when only risk_reward_ratio is missing', async (_side, text, gemini, expectedLevels) => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withGroundingOnly(gemini);

		const result = await enrichAlert({ text });

		// Grounded levels win over the heuristic plan even though the ratio is absent.
		expect(result.current_price).toBe(100);
		expect(result.invalidation_level).toBe(expectedLevels.invalidation_level);
		expect(result.target_level).toBe(expectedLevels.target_level);
		expect(result.price_currency).toBe('USD');
		expect(result.levelsSource).toBe('gemini-grounding');
		// The missing ratio is derived arithmetically from the grounded levels:
		// BUY (120-100)/(100-90) = 2, SELL (100-80)/(110-100) = 2.
		expect(result.risk_reward_ratio).toBeCloseTo(2, 4);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('keeps grounded levels for free-text alerts that carry no parseable signal', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withGroundingOnly({
			sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100,
			invalidation_level: 90, target_level: 120,
			technical_levels: { supports: ['90'], resistances: ['120'] },
		});
		// Faithful to production: `deriveFallbackTradePlan` returns null when the text
		// yields no symbol/side, so free text can never get a heuristic plan. `withGroundingOnly`
		// deliberately leaves a heuristic plan mocked in, and this overrides it back to the
		// real behavior so the assertions below test production reality rather than the mock.
		deriveFallbackTradePlan.mockResolvedValue(null);

		const result = await enrichAlert({ text: 'Bitcoin is breaking out above 100k resistance' });

		// Without a side the ratio cannot be computed, but the grounded entry price and
		// levels must still survive rather than be discarded, and no derived-quote
		// provenance may be stamped on them.
		expect(result.current_price).toBe(100);
		expect(result.invalidation_level).toBe(90);
		expect(result.target_level).toBe(120);
		expect(result).not.toHaveProperty('risk_reward_ratio');
		expect(result.priceSource).not.toBe('derived-quote');
		expect(result).not.toHaveProperty('price_currency');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	// GH-599 regression: the merge path (Gemini + MCP) had its own copy of the discard
	// logic, so fixing the Gemini-only branch left the same data loss in place whenever
	// `useTradingViewData=true` — the common production configuration. `hasCompleteRiskMetadata`
	// requiring the ratio meant a grounded block with entry + both levels was overwritten by
	// `calculateFallbackRiskLevels`, a per-timeframe percentage heuristic derived off the MCP
	// price. These two cases cover the realistic degraded-MCP shapes: MCP present but without
	// its own risk block (A), and MCP with no usable price at all (B).
	const withMergePath = ({ gemini, mcp }) => {
		process.env.ENABLE_GEMINI_GROUNDING = 'true';
		tradingViewMcpService.isEnabled.mockReturnValue(true);
		groundAlert.mockResolvedValue({ insights: [], sources: [], ...gemini });
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(mcp);
	};

	it('preserves grounded levels through the merge path when MCP supplies a price but no risk block', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withMergePath({
			gemini: {
				sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100,
				invalidation_level: 90, target_level: 120,
				technical_levels: { supports: ['90'], resistances: ['120'] },
			},
			mcp: { current_price: 110, insights: [], sources: [], tradingViewEnrichmentApplied: true },
		});

		const result = await enrichAlert(
			{ text: 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA' },
			{ useTradingViewData: true },
		);

		// Grounded 90/120 must survive, NOT the 1%-stop/2%-target heuristic off the MCP
		// price of 110 that `calculateFallbackRiskLevels` would produce.
		expect(result.invalidation_level).toBe(90);
		expect(result.target_level).toBe(120);
		expect(result.risk_reward_ratio).toBeCloseTo(2, 4);
		// The emitted entry is the one the ratio was derived from, NOT the MCP quote. Emitting
		// 110 would store a ratio of 2 alongside an entry that makes it 0.5 — a tuple that
		// cannot be recomputed from its own fields, and one `applyDeterministicRiskReward`
		// will not catch because it short-circuits on an already-valid ratio.
		expect(result.current_price).toBe(100);
		expect(result.priceSource).toBe('gemini-grounding');
		// The MCP quote currency described the MCP price, which is no longer emitted, so it
		// must not be attached to the grounded entry.
		expect(result).not.toHaveProperty('price_currency');
		// The internal selection key must never leak into the payload.
		expect(result).not.toHaveProperty('riskLevelsEntryPrice');
		// The load-bearing invariant: the stored tuple must be self-consistent.
		expect(computeDeterministicRiskReward({
			entry: result.current_price,
			invalidation: result.invalidation_level,
			target: result.target_level,
			side: 'BUY',
		})).toBeCloseTo(result.risk_reward_ratio, 4);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('preserves grounded levels and entry price through the merge path when MCP has no usable price', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withMergePath({
			gemini: {
				sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100,
				invalidation_level: 90, target_level: 120,
				technical_levels: { supports: ['90'], resistances: ['120'] },
			},
			// `_toEnrichedAlert` always returns a truthy object; `current_price` is null when
			// the MCP analysis carried no usable price — exactly this degraded case.
			mcp: { current_price: null, price_data: {}, insights: [], sources: [], tradingViewEnrichmentApplied: false },
		});

		const result = await enrichAlert(
			{ text: 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA' },
			{ useTradingViewData: true },
		);

		expect(result.current_price).toBe(100);
		expect(result.invalidation_level).toBe(90);
		expect(result.target_level).toBe(120);
		expect(result.risk_reward_ratio).toBeCloseTo(2, 4);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	// Regression for a merge-path provenance bug: when wrong-side grounded levels are
	// rejected, `calculateFallbackRiskLevels` REPLACES the levels with a heuristic derived
	// off the MCP quote — but the stamp was guarded by `if (!levelsSource)`, which can
	// never be true in that branch because every selected block sets `riskLevelsSource`.
	// The result was heuristic levels advertised as `gemini-grounding`, which
	// `resolveSignalOutcomePriceSource` reads as provider-grounded rather than derived.
	// The Gemini-only equivalent of this case cannot catch it: that branch hardcodes
	// `levelsSource: 'derived-quote'`.
	it('stamps derived-quote when the merge path rejects wrong-side levels for the heuristic plan', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withMergePath({
			gemini: {
				sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100,
				// BUY whose stop sits above entry: no R:R exists, so the grounded block is
				// genuinely unusable and the heuristic plan must take over.
				invalidation_level: 110, target_level: 120,
				technical_levels: { supports: ['110'], resistances: ['120'] },
			},
			mcp: { current_price: 110, insights: [], sources: [], tradingViewEnrichmentApplied: true },
		});
		calculateFallbackRiskLevels.mockReturnValue({
			invalidation_level: 107.25,
			target_level: 115.5,
			risk_reward_ratio: 2,
		});

		const result = await enrichAlert(
			{ text: 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA' },
			{ useTradingViewData: true },
		);

		// The emitted levels ARE the heuristic, so they must say so — not claim the
		// grounded provenance of the block that was just rejected.
		expect(result.invalidation_level).toBe(107.25);
		expect(result.target_level).toBe(115.5);
		expect(result.levelsSource).toBe('derived-quote');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	// Wrong-side levels have no R:R to express: a BUY whose stop sits above entry has
	// negative risk. Rather than divide anyway and emit an inverted ratio, fall back to
	// the heuristic plan, which is directionally correct by construction.
	it.each([
		['BUY stop above entry', 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA', { invalidation_level: 110, target_level: 120 }],
		['BUY target below entry', 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA', { invalidation_level: 90, target_level: 95 }],
		['SELL stop below entry', 'BINANCE:BTCUSDT(60) pasó una señal de VENTA', { invalidation_level: 90, target_level: 80 }],
	])('falls back to the heuristic plan for wrong-side levels (%s)', async (_label, text, levels) => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withGroundingOnly({
			sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100,
			technical_levels: { supports: ['90'], resistances: ['120'] },
			...levels,
		});

		const result = await enrichAlert({ text });

		expect(result.levelsSource).toBe('derived-quote');
		expect(result.current_price).toBe(110);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it.each([
		[
			'omits the levels entirely',
			{ sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100, price_currency: 'USD' },
		],
		[
			'returns non-positive levels',
			{ sentiment: 'BULLISH', sentiment_score: 0.6, current_price: 100, invalidation_level: 0, target_level: -5 },
		],
	])('still derives a heuristic plan when Gemini %s', async (_label, gemini) => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		withGroundingOnly(gemini);

		const result = await enrichAlert({ text: 'BINANCE:BTCUSDT(60) pasó una señal de COMPRA' });

		expect(result).toMatchObject(HEURISTIC_PLAN);

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('should preserve the raw Gemini sentiment score in the mapped alert', async () => {
		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.55,
			sentiment_score_raw: 0.9,
			insights: [],
			sources: [],
			truncated: false,
		});

		const result = await enrichAlert({ text: 'Bitcoin rally' });

		expect(result.sentiment_score).toBe(0.55);
		expect(result.sentiment_score_raw).toBe(0.9);
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

	it('omits Gemini fallback levels entirely when Gemini returns no usable levels during MCP failure on non-signal text', async () => {
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

		const result = await enrichAlert({ text: 'Bitcoin market update and macro overview' }, { useTradingViewData: true });

		expect(result).not.toHaveProperty('technical_levels');
		expect(result).not.toHaveProperty('levelsSource');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('derives fallback trade plan and tags levelsSource as derived-quote when MCP fails and Gemini returns no risk levels for signal', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue(null);

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.7,
			insights: ['Gemini detected breakout'],
			sources: [],
			truncated: false,
		});

		deriveFallbackTradePlan.mockResolvedValue({
			symbol: 'BTCUSDT',
			side: 'BUY',
			current_price: 85000,
			price_data: { current_price: 85000 },
			invalidation_level: 83725,
			target_level: 89250,
			risk_reward_ratio: 2,
			setup_type: 'trend_continuation',
			levelsSource: 'derived-quote',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.levelsSource).toBe('derived-quote');
		expect(result.invalidation_level).toBeDefined();
		expect(result.target_level).toBeDefined();
		expect(result.risk_reward_ratio).toBe(2);
		expect(result.setup_type).toBe('trend_continuation');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('does not let a heuristic fallback-trade-plan MCP block outrank complete Gemini risk levels', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);

		// Gemini produced REAL support/resistance-derived levels.
		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.7,
			insights: ['Gemini detected breakout'],
			sources: [],
			truncated: false,
			invalidation_level: 88,
			target_level: 124,
			risk_reward_ratio: 3,
		});

		// MCP had its ATR rejected, so it fell back to the HEURISTIC plan. That block is
		// numerically complete, but it is a per-timeframe percentage guess and must never
		// displace a real provider level.
		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.6,
			insights: [],
			sources: [],
			truncated: false,
			current_price: 100,
			invalidation_level: 97.5,
			target_level: 105,
			risk_reward_ratio: 2,
			levelsSource: 'fallback-trade-plan',
			tradingViewEnrichmentApplied: false,
			tradingViewEnrichmentStatus: 'failed',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.invalidation_level).toBe(88);
		expect(result.target_level).toBe(124);
		expect(result.risk_reward_ratio).toBe(3);
		// The tag must describe the levels that were actually emitted, not the
		// rejected heuristic MCP block.
		expect(result.levelsSource).toBe('gemini-grounding');
		expect(result).not.toHaveProperty('riskLevelsSource');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('uses the heuristic fallback-trade-plan MCP levels when Gemini has no complete risk block', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'true';

		tradingViewMcpService.isEnabled.mockReturnValue(true);

		groundAlert.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.7,
			insights: [],
			sources: [],
			truncated: false,
		});

		tradingViewMcpService.enrichFromAlertText.mockResolvedValue({
			sentiment: 'BULLISH',
			sentiment_score: 0.6,
			insights: [],
			sources: [],
			truncated: false,
			current_price: 100,
			invalidation_level: 97.5,
			target_level: 105,
			risk_reward_ratio: 2,
			levelsSource: 'fallback-trade-plan',
			tradingViewEnrichmentApplied: false,
			tradingViewEnrichmentStatus: 'failed',
		});

		const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.invalidation_level).toBe(97.5);
		expect(result.target_level).toBe(105);
		expect(result.risk_reward_ratio).toBe(2);
		expect(result.levelsSource).toBe('fallback-trade-plan');

		process.env.ENABLE_GEMINI_GROUNDING = previousGeminiFlag;
	});

	it('derives fallback trade plan when Gemini is disabled and MCP enrichment fails', async () => {
		const previousGeminiFlag = process.env.ENABLE_GEMINI_GROUNDING;
		process.env.ENABLE_GEMINI_GROUNDING = 'false';

		tradingViewMcpService.isEnabled.mockReturnValue(true);
		tradingViewMcpService.enrichFromAlertText.mockRejectedValue(new Error('MCP service timeout'));

		deriveFallbackTradePlan.mockResolvedValue({
			symbol: 'ETHUSDT',
			side: 'BUY',
			current_price: 3200,
			price_data: { current_price: 3200 },
			invalidation_level: 3120,
			target_level: 3360,
			risk_reward_ratio: 2,
			setup_type: 'trend_continuation',
			levelsSource: 'derived-quote',
		});

		const result = await enrichAlert({ text: 'ETHUSDT(60) pasó a señal de COMPRA' }, { useTradingViewData: true });

		expect(result.levelsSource).toBe('derived-quote');
		expect(result.sentiment).toBe('BULLISH');
		expect(result.sentiment_score).toBe(0.55);
		expect(result.invalidation_level).toBeDefined();
		expect(result.target_level).toBeDefined();
		expect(result.risk_reward_ratio).toBe(2);

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
				sentiment_score: 0.55,
				sentiment_score_raw: 0.9,
				insights: ['Positive market tailwinds'],
				sources: [],
				truncated: false,
				modelUsed: 'gemini-2.5-flash',
			});

			const result = await enrichAlert({ text: 'BTCUSDT(240) pasó a señal de COMPRA' }, { useTradingViewData: true });

			expect(result.sentiment).toBe('BULLISH');
			expect(result.sentiment_score).toBe(0.55);
			expect(result.sentiment_score_raw).toBe(0.9);
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
