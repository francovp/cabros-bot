'use strict';

const { binanceOrderService, getConfig } = require('./BinanceOrderService');
const { TIMEFRAME_BAR_MS } = require('../alerts/signalRepeatCooldown');
const sentryService = require('../monitoring/SentryService');

const DEFAULT_MAX_NOTIONAL = 100;
const DEFAULT_MIN_ABS_SENTIMENT = 0.3;
const DEFAULT_COOLDOWN_BARS = 1;
const MAX_TRACKED_ENTRIES = 500;

// Process-local cooldown for auto-trade. Deliberately separate from the
// notification signalRepeatCooldown store so order suppression can never
// interfere with alert delivery suppression (or the reverse).
const autoTradeCooldown = new Map();

// Mirrors resolveCooldownBars() in signalRepeatCooldown.js: out-of-range integers
// are clamped to the documented bounds rather than discarded, so an operator typo
// degrades to a safe value instead of silently reverting to the default.
function readIntEnv(name, fallback, { min, max }) {
	const raw = process.env[name];
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const parsed = Number(String(raw).trim());
	if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) return fallback;
	if (min !== undefined && parsed < min) return min;
	if (max !== undefined && parsed > max) return max;
	return parsed;
}

function readFloatEnv(name, fallback, { min, max }) {
	const raw = process.env[name];
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const parsed = Number(String(raw).trim());
	if (!Number.isFinite(parsed)) return fallback;
	if (min !== undefined && parsed < min) return fallback;
	if (max !== undefined && parsed > max) return fallback;
	return parsed;
}

function readBoolEnv(name, fallback = false) {
	const raw = process.env[name];
	if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
	const normalized = String(raw).trim().toLowerCase();
	if (normalized === 'true') return true;
	if (normalized === 'false') return false;
	return fallback;
}

function getAutoTradeConfig() {
	return {
		enabled: readBoolEnv('ENABLE_AUTO_TRADE'),
		// Dry-run is the safe default; live submission requires an explicit opt-out.
		dryRun: readBoolEnv('AUTO_TRADE_DRY_RUN', true),
		maxNotional: readFloatEnv('AUTO_TRADE_MAX_NOTIONAL', DEFAULT_MAX_NOTIONAL, { min: 1e-8, max: 1000000 }),
		minAbsSentiment: readFloatEnv('AUTO_TRADE_MIN_ABS_SENTIMENT', DEFAULT_MIN_ABS_SENTIMENT, { min: 0, max: 1 }),
		cooldownBars: readIntEnv('AUTO_TRADE_COOLDOWN_BARS', DEFAULT_COOLDOWN_BARS, { min: 1, max: 10 }),
		// Repeat suppression is the mechanism that prevents duplicate live orders,
		// so it must be on before any non-dry-run submission is allowed.
		requireRepeatSuppression: readBoolEnv('ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION', false),
	};
}

function isEnabled() {
	return getAutoTradeConfig().enabled;
}

// Namespaced by side so an opposite-side flip is never suppressed, mirroring the
// notification repeat-cooldown semantics.
function buildAutoTradeKey({ exchange, symbol, timeframe, side }) {
	if (!symbol || !side) return null;
	return [
		'autotrade',
		String(exchange || 'BINANCE').toUpperCase(),
		String(symbol).toUpperCase(),
		String(timeframe || '').toLowerCase(),
		String(side).toUpperCase(),
	].join('|');
}

function isInCooldown(key, bars) {
	const entry = autoTradeCooldown.get(key);
	if (!entry) return false;
	const barMs = TIMEFRAME_BAR_MS[entry.timeframe];
	if (!Number.isFinite(barMs)) return false;
	return Date.now() - entry.firedAt < bars * barMs;
}

function recordAutoTradeFire(key, timeframe) {
	if (autoTradeCooldown.size >= MAX_TRACKED_ENTRIES) {
		const oldest = autoTradeCooldown.keys().next();
		if (!oldest.done) autoTradeCooldown.delete(oldest.value);
	}
	autoTradeCooldown.set(key, { firedAt: Date.now(), timeframe });
}

function toPositiveNumber(value) {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
	if (typeof value === 'string' && String(value).trim() !== '') {
		const parsed = Number(String(value).trim());
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return null;
}

/**
 * Map an enriched alert + parsed TradingView signal to a Binance order intent.
 * Pure function: no I/O, never throws.
 *
 * @returns {{order: object, side: string, symbol: string}|{skip: string}}
 */
function deriveOrderIntent({ alert, parsed, config }) {
	const enriched = alert && typeof alert.enriched === 'object' && alert.enriched !== null ? alert.enriched : null;
	if (!enriched) return { skip: 'NO_ENRICHED_ALERT' };

	const symbol = parsed && typeof parsed.symbol === 'string' ? parsed.symbol.trim().toUpperCase() : '';
	if (!symbol) return { skip: 'NO_SYMBOL' };

	// Only a parsed TradingView signal carries an explicit side. Inferring one from
	// sentiment would risk silently inverting a trader's intent.
	const side = parsed && typeof parsed.side === 'string' ? parsed.side.trim().toUpperCase() : '';
	if (side !== 'BUY' && side !== 'SELL') return { skip: 'NO_PARSED_SIDE' };

	const rawScore = typeof enriched.sentiment_score === 'number' && Number.isFinite(enriched.sentiment_score)
		? enriched.sentiment_score
		: 0;
	if (Math.abs(rawScore) < config.minAbsSentiment) return { skip: 'SENTIMENT_BELOW_THRESHOLD' };

	if (side === 'SELL') {
		// No balance/holdings lookup exists, so a SELL cannot be sized safely and
		// could oversell. Phase 1 intentionally defers this to #955 Phase 2.
		return { skip: 'SELL_NOT_SUPPORTED_PENDING_BALANCE_LOOKUP' };
	}

	// Require an observed price so the caller has a defensible record of the
	// conditions that triggered execution.
	const currentPrice = toPositiveNumber(enriched.current_price)
		|| toPositiveNumber(enriched.price_data && enriched.price_data.current_price);
	if (currentPrice === null) return { skip: 'NO_CURRENT_PRICE' };

	const binanceConfig = getConfig();
	const candidates = [
		config.maxNotional,
		binanceConfig.maxNotional,
	].filter((value) => Number.isFinite(value) && value > 0);
	if (candidates.length === 0) return { skip: 'INVALID_MAX_NOTIONAL' };
	const maxNotional = Math.min(...candidates);

	return {
		symbol,
		side,
		order: {
			symbol,
			side,
			type: 'MARKET',
			quoteOrderQty: maxNotional,
			dryRun: config.dryRun,
		},
	};
}

/**
 * Bridge an enriched alert signal to a Binance Spot order.
 *
 * Fail-open by contract: never throws, so the calling webhook alert handler can
 * keep delivering notifications regardless of trading state.
 */
async function routeAlertToOrder({ alert, parsed, requestId }) {
	if (!isEnabled()) {
		return { executed: false, reason: 'AUTO_TRADE_DISABLED' };
	}

	const config = getAutoTradeConfig();
	const binanceConfig = getConfig();
	if (!binanceConfig.enabled || !binanceConfig.configured) {
		return { executed: false, reason: 'BINANCE_TRADING_NOT_CONFIGURED' };
	}

	const intent = deriveOrderIntent({ alert, parsed, config });
	if (intent.skip) {
		return { executed: false, reason: intent.skip };
	}

	const { symbol, side, order } = intent;

	if (!binanceConfig.allowedSymbols.includes(symbol)) {
		return { executed: false, reason: 'SYMBOL_NOT_ALLOWED' };
	}

	const timeframe = parsed && typeof parsed.timeframe === 'string' ? parsed.timeframe.trim().toLowerCase() : '';
	if (!config.dryRun) {
		// A live order is only safe when we can bound duplicate submissions.
		// The auto-trade cooldown is expressed in bars, so an unresolvable
		// timeframe means no dedup window at all.
		if (!Number.isFinite(TIMEFRAME_BAR_MS[timeframe])) {
			return { executed: false, reason: 'UNKNOWN_TIMEFRAME_CANNOT_DEDUPLICATE' };
		}
		// Defense in depth: the process-wide alert repeat suppression is a second,
		// independent dedup layer. Without it a notification retry storm could
		// drive repeated live submissions for the same signal.
		if (!config.requireRepeatSuppression) {
			return { executed: false, reason: 'LIVE_ORDER_REQUIRES_REPEAT_SUPPRESSION' };
		}
	}

	const cooldownKey = buildAutoTradeKey({ exchange: parsed.exchange, symbol, timeframe, side });
	if (cooldownKey && isInCooldown(cooldownKey, config.cooldownBars)) {
		return { executed: false, reason: 'COOLDOWN_ACTIVE' };
	}

	// The idempotency key MUST be derived from the signal itself, never from the
	// per-request id. resolveRequestId() returns a fresh randomUUID() whenever the
	// caller omits x-request-id (TradingView does not send one), so a key built
	// from requestId would differ on every webhook retry and the existing
	// reconcile-before-submit path in placeOrder() would never match — letting a
	// retried alert submit a second live order.
	//
	// Keying on exchange|symbol|timeframe|side means retries of the same signal
	// collapse onto one Binance clientOrderId, and a genuinely new signal on the
	// same key correctly reconciles against the prior order instead of stacking.
	const idempotencyKey = `auto-trade:${cooldownKey || symbol}`;

	try {
		const result = await binanceOrderService.placeOrder(order, { idempotencyKey });

		if (cooldownKey) recordAutoTradeFire(cooldownKey, timeframe);

		console.info('[AlertSignalRouter] auto-trade order submitted', {
			symbol,
			side,
			// requestId is log-correlation only; it is deliberately NOT part of
			// idempotencyKey above. See the comment there.
			requestId: requestId || null,
			dryRun: Boolean(result && result.dryRun),
			environment: result && result.environment,
			orderId: result && result.order ? result.order.orderId : null,
		});

		return {
			executed: true,
			symbol,
			side,
			dryRun: Boolean(result && result.dryRun),
			environment: result && result.environment,
			orderId: result && result.order ? result.order.orderId : null,
		};
	} catch (error) {
		console.warn('[AlertSignalRouter] auto-trade order failed (fail-open)', {
			symbol,
			side,
			code: error && error.code,
			message: error && error.message,
		});
		sentryService.captureRuntimeError({
			channel: 'alert-signal-router',
			error,
			http: {
				endpoint: '/api/webhook/alert',
				method: 'POST',
				statusCode: error && error.statusCode,
			},
		});
		return { executed: false, reason: 'ORDER_FAILED', code: error && error.code };
	}
}

module.exports = {
	routeAlertToOrder,
	deriveOrderIntent,
	buildAutoTradeKey,
	getAutoTradeConfig,
	isEnabled,
	__resetForTesting: () => {
		autoTradeCooldown.clear();
	},
};
