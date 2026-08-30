'use strict';

/**
 * Minimum viable alert context (GH-581 / CB-269).
 *
 * When TradingView MCP enrichment fails and the alert is a parseable trading
 * signal, this module synthesizes a degraded-but-honest decision package
 * (entry reference + provisional invalidation/target) so the alert stays
 * falsifiable for downstream outcome tracking and gives recipients
 * something actionable. The package is always tagged `provisional: true`
 * so downstream consumers can distinguish it from provider-derived levels.
 *
 * Fail-open contract:
 *   - Binance / Twelve Data failures never throw
 *   - When no price source is reachable, returns `{ applied: false, priceSource: 'ninguno' }`
 *     so callers can append `sin datos tecnicos` instead of emitting naked text.
 *   - When both the alert has no parseable TradingView signal AND no usable
 *     Gemini/MCP data, returns `{ applied: false, priceSource: null }` so callers
 *     can fall through to existing delivery paths.
 */

const { parseTradingViewSignal } = require('../tradingview/parseTradingViewSignal');
const { deriveFallbackTradePlan, calculateFallbackRiskLevels } = require('../tradingview/fallbackTradePlan');

const PROVISIONAL_TAG = 'provisional';
const NO_DATA_TAG = 'sin_datos_tecnicos';
const NO_DATA_MESSAGE_ES = 'advertencia sin datos tecnicos';

function hasCompleteRiskMetadata(value = {}) {
	return ['invalidation_level', 'target_level']
		.every(field => (
			(typeof value[field] === 'number' && Number.isFinite(value[field]) && value[field] > 0)
			|| (typeof value[field] === 'string' && Number.isFinite(Number(value[field])) && Number(value[field]) > 0)
		));
}

function hasEntryPrice(value = {}) {
	const price = value.current_price ?? (value.price_data && value.price_data.current_price);
	return typeof price === 'number' && Number.isFinite(price) && price > 0;
}

function isMinAlertContextEnabled(runtimeConfig = {}) {
	const flag = runtimeConfig.ENABLE_MIN_ALERT_CONTEXT;
	return flag === true || flag === 'true';
}

function formatProvisionalPercent(side, key) {
	const probe = side === 'SELL'
		? calculateFallbackRiskLevels(100, '1h', 'SELL')
		: calculateFallbackRiskLevels(100, '1h', 'BUY');
	if (!probe) {
		return null;
	}
	if (key === 'invalidation') {
		return Number((((probe.invalidation_level - 100) / 100) * 100).toFixed(2));
	}
	if (key === 'target') {
		return Number((((probe.target_level - 100) / 100) * 100).toFixed(2));
	}
	return null;
}

async function buildMinAlertContext({ text, enriched, runtimeConfig = {} } = {}) {
	if (!isMinAlertContextEnabled(runtimeConfig)) {
		return { applied: false, priceSource: null, provisional: false };
	}

	if (enriched && hasCompleteRiskMetadata(enriched) && hasEntryPrice(enriched)) {
		return { applied: false, priceSource: enriched.levelsSource || null, provisional: false };
	}

	const parsed = typeof text === 'string' ? parseTradingViewSignal(text) : null;
	if (!parsed || !parsed.symbol || !parsed.side) {
		if (!enriched) {
			return { applied: false, priceSource: null, provisional: false };
		}
		return { applied: false, priceSource: null, provisional: false };
	}

	let currentPrice = (enriched && typeof enriched.current_price === 'number' && Number.isFinite(enriched.current_price) && enriched.current_price > 0)
		? enriched.current_price
		: null;

	let derivedPlan = null;
	if (currentPrice === null) {
		try {
			derivedPlan = await deriveFallbackTradePlan(text);
		} catch (error) {
			if (typeof console !== 'undefined' && console.warn) {
				console.warn('[MinAlertContext] deriveFallbackTradePlan failed:', error && error.message);
			}
		}
	}

	if (derivedPlan && Number.isFinite(derivedPlan.current_price) && derivedPlan.current_price > 0) {
		currentPrice = derivedPlan.current_price;
	}

	if (currentPrice === null) {
		return {
			applied: true,
			priceSource: 'ninguno',
			provisional: false,
			noDataTag: NO_DATA_TAG,
			noDataMessage: NO_DATA_MESSAGE_ES,
			symbol: parsed.symbol,
			exchange: parsed.exchange || 'BINANCE',
			side: parsed.side,
			timeframe: parsed.timeframe || '1h',
		};
	}

	const invalidationPercent = formatProvisionalPercent(parsed.side, 'invalidation');
	const targetPercent = formatProvisionalPercent(parsed.side, 'target');

	const invalidation_level = parsed.side === 'SELL'
		? currentPrice * (1 + Math.abs(invalidationPercent) / 100)
		: currentPrice * (1 - Math.abs(invalidationPercent) / 100);
	const target_level = parsed.side === 'SELL'
		? currentPrice * (1 - Math.abs(targetPercent) / 100)
		: currentPrice * (1 + Math.abs(targetPercent) / 100);

	const risk = Math.abs(currentPrice - invalidation_level);
	const reward = Math.abs(target_level - currentPrice);
	const risk_reward_ratio = risk > 0 ? Number((reward / risk).toFixed(2)) : 2.0;

	const priceSource = derivedPlan ? 'binance' : 'gemini';

	return {
		applied: true,
		priceSource,
		provisional: true,
		provisionalTag: PROVISIONAL_TAG,
		current_price: currentPrice,
		price_data: { current_price: currentPrice, source: priceSource },
		invalidation_level: Number(invalidation_level.toFixed(8)),
		target_level: Number(target_level.toFixed(8)),
		risk_reward_ratio,
		setup_type: 'trend_continuation',
		levelsSource: 'derived-quote',
		invalidationPercent,
		targetPercent,
		symbol: parsed.symbol,
		exchange: parsed.exchange || 'BINANCE',
		side: parsed.side,
		timeframe: parsed.timeframe || '1h',
	};
}

function applyMinAlertContext(enriched, ctx) {
	if (!ctx || !ctx.applied) {
		return enriched || null;
	}

	const base = (enriched && typeof enriched === 'object') ? { ...enriched } : {};

	if (ctx.noDataTag) {
		const noDataInsight = ctx.noDataMessage + ' direccion unicamente';
		const insights = Array.isArray(base.insights) ? [...base.insights] : [];
		if (!insights.includes(noDataInsight)) {
			insights.unshift(noDataInsight);
		}
		base.insights = insights;
		base.priceSource = ctx.priceSource || 'ninguno';
		base.provisionalLevels = false;
		base.provisionalPrice = false;
		return base;
	}

	if (!hasEntryPrice(base) && typeof ctx.current_price === 'number') {
		base.current_price = ctx.current_price;
		if (!base.price_data) {
			base.price_data = ctx.price_data;
		} else if (!base.price_data.current_price) {
			base.price_data = { ...base.price_data, current_price: ctx.current_price };
		}
	}

	if (!hasCompleteRiskMetadata(base) && typeof ctx.invalidation_level === 'number') {
		base.invalidation_level = ctx.invalidation_level;
	}
	if (!hasCompleteRiskMetadata(base) && typeof ctx.target_level === 'number') {
		base.target_level = ctx.target_level;
	}
	if ((!hasCompleteRiskMetadata(base) || typeof base.risk_reward_ratio !== 'number')
		&& typeof ctx.risk_reward_ratio === 'number') {
		base.risk_reward_ratio = ctx.risk_reward_ratio;
	}
	if (!base.setup_type && ctx.setup_type) {
		base.setup_type = ctx.setup_type;
	}

	base.priceSource = ctx.priceSource;
	base.provisionalLevels = ctx.provisional === true;
	base.provisionalPrice = ctx.provisional === true;
	if (ctx.provisional) {
		const tag = 'Levels ' + PROVISIONAL_TAG + ' (' + ctx.priceSource + ')';
		const insights = Array.isArray(base.insights) ? [...base.insights] : [];
		if (!insights.some(insight => typeof insight === 'string' && insight.startsWith('Levels provisional'))) {
			insights.push(tag);
		}
		base.insights = insights;
	}

	return base;
}

function buildFooterPriceSourceLine(ctx, runtimeConfig = {}) {
	if (!runtimeConfig.ENABLE_MESSAGE_FOOTER_METADATA) {
		return '';
	}
	if (!ctx || !ctx.applied) {
		return '';
	}
	if (ctx.priceSource === 'binance') {
		return 'fuente_precio: binance';
	}
	if (ctx.priceSource === 'gemini') {
		return 'fuente_precio: gemini';
	}
	if (ctx.priceSource === 'ninguno') {
		return 'fuente_precio: ninguno';
	}
	return '';
}

module.exports = {
	buildMinAlertContext,
	applyMinAlertContext,
	buildFooterPriceSourceLine,
	hasCompleteRiskMetadata,
	hasEntryPrice,
	isMinAlertContextEnabled,
	PROVISIONAL_TAG,
	NO_DATA_TAG,
	NO_DATA_MESSAGE_ES,
};
