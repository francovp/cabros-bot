'use strict';

const signalOutcomeService = require('../../services/storage/SignalOutcomeService');
const sentryService = require('../../services/monitoring/SentryService');
const { classifyPriceQuery, fetchCryptoPrice, fetchEquityPrice } = require('../commands/handlers/core/fetchPriceCryptoSymbol');
const SPECIAL_CHARS_PATTERN = /([_*[\]()~`>#+\-=|{}.!\\])/g;

function escapeMarkdownV2(value) {
	return String(value == null ? '' : value).replace(SPECIAL_CHARS_PATTERN, '\\$1');
}

const PRETRADE_CHECK_DEFAULT_HIT_RATE_LIMIT = 200;
const PRETRADE_CHECK_MAX_HIT_RATE_LIMIT = 1000;
const PRETRADE_CHECK_HIT_RATE_DAYS = 7;
const PRETRADE_CHECK_WINDOWS = ['1h', '4h', '1D', '1W'];

function parseSymbol(rawSymbol) {
	const value = String(rawSymbol || '').trim();
	if (!value) return null;
	const classification = classifyPriceQuery(value);
	if (!classification || !classification.valid) return null;
	return {
		raw: value,
		symbol: classification.symbol,
		exchange: classification.exchange || null,
		assetClass: classification.assetClass,
	};
}

function parseLimit(rawLimit, fallback, max) {
	if (rawLimit === undefined) return fallback;
	const parsed = Number.parseInt(rawLimit, 10);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) return null;
	return parsed;
}

function computeHitRate(outcomes) {
	const counts = { total: 0, evaluated: 0, wins: 0 };
	if (!Array.isArray(outcomes)) return counts;
	outcomes.forEach((outcome) => {
		if (!outcome || !outcome.outcomes) return;
		PRETRADE_CHECK_WINDOWS.forEach((windowKey) => {
			const win = outcome.outcomes[windowKey];
			if (!win || win.status !== 'evaluated') return;
			counts.total += 1;
			counts.evaluated += 1;
			if (Number.isFinite(win.return) && win.return > 0) {
				counts.wins += 1;
			}
		});
	});
	return counts;
}

function summarizeHitRate(counts) {
	if (!counts || counts.total === 0) {
		return { available: false };
	}
	const hitRatePercent = Number(((counts.wins / counts.total) * 100).toFixed(2));
	return {
		available: true,
		evaluatedWindows: counts.evaluated,
		winWindows: counts.wins,
		hitRatePercent,
	};
}

async function loadPrice(parsedSymbol) {
	if (parsedSymbol.assetClass === 'unsupported') {
		return { available: false, reason: parsedSymbol.reason || 'Exchange not supported.' };
	}
	try {
		if (parsedSymbol.assetClass === 'equity') {
			const result = await fetchEquityPrice(parsedSymbol.symbol, parsedSymbol.exchange || undefined);
			return {
				available: true,
				price: result.price,
				change: result.change,
				percentChange: result.percentChange,
				currency: result.currency || 'USD',
				assetClass: 'equity',
				symbol: result.symbol,
				exchange: result.exchange,
			};
		}
		const result = await fetchCryptoPrice(parsedSymbol.symbol);
		return {
			available: true,
			price: result.price,
			assetClass: 'crypto',
			symbol: result.symbol,
		};
	} catch (error) {
		const reason = (error && error.userMessage) ? error.userMessage : 'No price data available.';
		return { available: false, reason };
	}
}

async function loadOutcomeHitRate(parsedSymbol, limit) {
	if (!signalOutcomeService.isEnabled()) {
		return { available: false, reason: 'Signal outcome tracking is disabled.' };
	}
	const cutoffMs = Date.now() - (PRETRADE_CHECK_HIT_RATE_DAYS * 24 * 60 * 60 * 1000);
	try {
		const result = await signalOutcomeService.listOutcomes({
			symbol: parsedSymbol.symbol,
			exchange: parsedSymbol.exchange || undefined,
			limit,
			status: 'evaluated',
			from: new Date(cutoffMs).toISOString(),
		});
		const outcomes = Array.isArray(result && result.outcomes) ? result.outcomes : [];
		const counts = computeHitRate(outcomes);
		const summary = summarizeHitRate(counts);
		return {
			...summary,
			sampleSize: outcomes.length,
			windowDays: PRETRADE_CHECK_HIT_RATE_DAYS,
		};
	} catch (error) {
		return {
			available: false,
			reason: (error && error.message) ? error.message : 'Outcome store read failed.',
		};
	}
}

async function composePretradeCheck({ parsedSymbol, limit, requestId }) {
	const startedAt = Date.now();
	const [price, hitRate] = await Promise.all([
		loadPrice(parsedSymbol),
		loadOutcomeHitRate(parsedSymbol, limit),
	]);
	return {
		symbol: parsedSymbol.raw,
		normalized: {
			symbol: parsedSymbol.symbol,
			exchange: parsedSymbol.exchange,
			assetClass: parsedSymbol.assetClass,
		},
		price,
		hitRate,
		requestId: requestId || null,
		generatedAt: new Date().toISOString(),
		durationMs: Date.now() - startedAt,
	};
}

function formatPretradeCheckMessage(payload) {
	const lines = [`*Pre-trade check — ${escapeMarkdownV2(payload.symbol)}*`, ''];

	if (payload.price && payload.price.available) {
		const priceStr = Number.isFinite(payload.price.price) ? `$${payload.price.price}` : 'n/d';
		const changeLine = Number.isFinite(payload.price.percentChange)
			? ` (${payload.price.percentChange >= 0 ? '+' : ''}${payload.price.percentChange.toFixed(2)}% 24h)`
			: '';
		lines.push(`Precio: ${escapeMarkdownV2(priceStr)}${changeLine}`);
	} else if (payload.price) {
		lines.push(`Precio: ${escapeMarkdownV2(payload.price.reason || 'No disponible')}`);
	}

	if (payload.hitRate && payload.hitRate.available) {
		lines.push(
			`Hit-rate (${escapeMarkdownV2(String(payload.hitRate.windowDays))}d): ${escapeMarkdownV2(String(payload.hitRate.hitRatePercent))}% (${escapeMarkdownV2(String(payload.hitRate.winWindows))}/${escapeMarkdownV2(String(payload.hitRate.evaluatedWindows))} ventanas)`,
		);
	} else if (payload.hitRate) {
		lines.push(`Hit-rate: ${escapeMarkdownV2(payload.hitRate.reason || 'No disponible')}`);
	}

	lines.push('');
	lines.push(`_Generado en ${payload.durationMs}ms_`);
	return lines.join('\n');
}

function getPretradeCheckHandler({ requestIdFn } = {}) {
	return async function handlePretradeCheck(req, res) {
		const symbol = req && req.query ? req.query.symbol : undefined;
		const parsed = parseSymbol(symbol);
		if (!parsed) {
			return res.status(400).json({
				error: 'Invalid symbol. Use a TradingView-style symbol like BINANCE:BTCUSDT or a bare ticker (BTCUSDT, NVDA).',
				code: 'INVALID_REQUEST',
			});
		}

		const limit = parseLimit(
			req && req.query ? req.query.limit : undefined,
			PRETRADE_CHECK_DEFAULT_HIT_RATE_LIMIT,
			PRETRADE_CHECK_MAX_HIT_RATE_LIMIT,
		);
		if (limit === null) {
			return res.status(400).json({
				error: `Invalid limit. Use an integer between 1 and ${PRETRADE_CHECK_MAX_HIT_RATE_LIMIT}.`,
				code: 'INVALID_REQUEST',
			});
		}

		try {
			const payload = await composePretradeCheck({
				parsedSymbol: parsed,
				limit,
				requestId: requestIdFn ? requestIdFn(req) : null,
			});
			return res.status(200).json({
				success: true,
				pretradeCheck: payload,
			});
		} catch (error) {
			console.error('[pretradeCheck] request failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'pretrade-check',
				error,
				http: {
					endpoint: '/api/pretrade-check',
					method: req.method,
				},
			});
			return res.status(500).json({
				error: 'Internal error while composing pre-trade check.',
				code: 'INTERNAL_ERROR',
			});
		}
	};
}

module.exports = {
	parseSymbol,
	computeHitRate,
	summarizeHitRate,
	composePretradeCheck,
	formatPretradeCheckMessage,
	getPretradeCheckHandler,
	PRETRADE_CHECK_DEFAULT_HIT_RATE_LIMIT,
	PRETRADE_CHECK_MAX_HIT_RATE_LIMIT,
	PRETRADE_CHECK_HIT_RATE_DAYS,
};
