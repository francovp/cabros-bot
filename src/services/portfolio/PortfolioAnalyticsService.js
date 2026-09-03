'use strict';

/**
 * PortfolioAnalyticsService — aggregates the bot's own emitted signals into an
 * implied-paper portfolio snapshot for the operator. No real broker/position
 * integration; every value is derived from stored alert documents.
 *
 * The snapshot answers the operator's question: "what is my open exposure
 * across all the signals I have received in the last N hours, and is it
 * overconcentrated, over-shorted, or stale?"
 *
 * Data flow (fail-open, never blocks delivery):
 *   1. Read recent alerts from AlertStorageService within the configured window
 *   2. Aggregate per-symbol BUY/SELL counts, weighted average entry, and notional
 *   3. Optional current-price resolver maps to unrealized P&L (fan-out bounded)
 *   4. Emit a structured snapshot with risk flags (HHI concentration, side tilt,
 *      missing market data, etc.)
 */

const alertStorageService = require('../storage/AlertStorageService');

const STORAGE_UNAVAILABLE_CODE = 'STORAGE_UNAVAILABLE';

const DEFAULT_WINDOW_HOURS = 168; // 1 week
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 8760; // 1 year

const DEFAULT_MAX_ALERTS = 200;
const MIN_MAX_ALERTS = 1;
const MAX_MAX_ALERTS = 1000;

const DEFAULT_PAPER_NOTIONAL = 1000; // USD-equivalent per signal
const MIN_PAPER_NOTIONAL = 0.01;
const MAX_PAPER_NOTIONAL = 1_000_000;

const DEFAULT_CONCENTRATION_THRESHOLD = 0.25; // HHI
const MIN_CONCENTRATION_THRESHOLD = 0.01;
const MAX_CONCENTRATION_THRESHOLD = 1;

const DEFAULT_MAX_SYMBOLS = 25;
const MIN_MAX_SYMBOLS = 1;
const MAX_MAX_SYMBOLS = 100;

const SIDE_BUY = 'BUY';
const SIDE_SELL = 'SELL';
const SIDE_NEUTRAL = 'NEUTRAL';

const RISK_FLAGS = Object.freeze({
	CONCENTRATION_HIGH: 'concentration_high',
	OPEN_SELLS_OVERWEIGHT: 'open_sells_overweight',
	NO_MARKET_DATA: 'no_market_data',
	STALE_SIGNALS: 'stale_signals',
});

function isEnabled() {
	return process.env.ENABLE_PORTFOLIO_ANALYTICS === 'true';
}

function parseWindowHours(rawValue) {
	const fallback = DEFAULT_WINDOW_HOURS;
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return fallback;
	}
	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.max(MIN_WINDOW_HOURS, Math.min(MAX_WINDOW_HOURS, Math.round(parsed)));
}

function parseMaxAlerts(rawValue) {
	const fallback = DEFAULT_MAX_ALERTS;
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return fallback;
	}
	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed < MIN_MAX_ALERTS || parsed > MAX_MAX_ALERTS) {
		return fallback;
	}
	return Math.round(parsed);
}

function parsePaperNotional(rawValue) {
	const fallback = DEFAULT_PAPER_NOTIONAL;
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return fallback;
	}
	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.max(MIN_PAPER_NOTIONAL, Math.min(MAX_PAPER_NOTIONAL, parsed));
}

function parseConcentrationThreshold(rawValue) {
	const fallback = DEFAULT_CONCENTRATION_THRESHOLD;
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return fallback;
	}
	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
		return fallback;
	}
	return Math.max(MIN_CONCENTRATION_THRESHOLD, Math.min(MAX_CONCENTRATION_THRESHOLD, parsed));
}

function parseMaxSymbols(rawValue) {
	const fallback = DEFAULT_MAX_SYMBOLS;
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return fallback;
	}
	const parsed = Number(rawValue);
	if (!Number.isFinite(parsed) || parsed < MIN_MAX_SYMBOLS || parsed > MAX_MAX_SYMBOLS) {
		return fallback;
	}
	return Math.round(parsed);
}

function resolveEnvironmentConfig(overrides = {}) {
	return {
		windowHours: overrides.windowHours !== undefined
			? parseWindowHours(overrides.windowHours)
			: parseWindowHours(process.env.PORTFOLIO_ANALYTICS_WINDOW_HOURS),
		maxAlerts: overrides.maxAlerts !== undefined
			? parseMaxAlerts(overrides.maxAlerts)
			: parseMaxAlerts(process.env.PORTFOLIO_ANALYTICS_MAX_ALERTS),
		paperNotional: overrides.paperNotional !== undefined
			? parsePaperNotional(overrides.paperNotional)
			: parsePaperNotional(process.env.PORTFOLIO_ANALYTICS_PAPER_NOTIONAL),
		concentrationThreshold: overrides.concentrationThreshold !== undefined
			? parseConcentrationThreshold(overrides.concentrationThreshold)
			: parseConcentrationThreshold(process.env.PORTFOLIO_ANALYTICS_CONCENTRATION_THRESHOLD),
		maxSymbols: overrides.maxSymbols !== undefined
			? parseMaxSymbols(overrides.maxSymbols)
			: parseMaxSymbols(process.env.PORTFOLIO_ANALYTICS_MAX_SYMBOLS),
	};
}

function buildStorageUnavailableError() {
	const err = new Error(
		'Alert storage is not enabled or unavailable. Set ENABLE_FIRESTORE_ALERT_STORAGE=true to use portfolio analytics.',
	);
	err.code = STORAGE_UNAVAILABLE_CODE;
	return err;
}

function deriveAlertSide(alert) {
	if (!alert || typeof alert !== 'object') {
		return null;
	}
	const enrichment = alert.enrichmentData;
	if (enrichment && typeof enrichment === 'object') {
		if (typeof enrichment.signal_side === 'string') {
			const normalized = enrichment.signal_side.trim().toUpperCase();
			if (normalized === SIDE_BUY || normalized === SIDE_SELL) {
				return normalized;
			}
		}
		if (typeof enrichment.side === 'string') {
			const normalized = enrichment.side.trim().toUpperCase();
			if (normalized === SIDE_BUY || normalized === SIDE_SELL) {
				return normalized;
			}
		}
		if (typeof enrichment.signalClass === 'string') {
			const normalized = enrichment.signalClass.trim().toUpperCase();
			if (normalized.includes(SIDE_BUY) || normalized.includes('LONG') || normalized.includes('COMPRA')) {
				return SIDE_BUY;
			}
			if (normalized.includes(SIDE_SELL) || normalized.includes('SHORT') || normalized.includes('VENTA')) {
				return SIDE_SELL;
			}
		}
		if (typeof enrichment.sentiment === 'string') {
			const normalized = enrichment.sentiment.trim().toUpperCase();
			if (normalized === 'BULLISH') {
				return SIDE_BUY;
			}
			if (normalized === 'BEARISH') {
				return SIDE_SELL;
			}
		}
	}
	if (typeof alert.text === 'string') {
		const upper = alert.text.toUpperCase();
		if (/\b(BUY|LONG|COMPRA)\b/.test(upper)) {
			return SIDE_BUY;
		}
		if (/\b(SELL|SHORT|VENTA)\b/.test(upper)) {
			return SIDE_SELL;
		}
	}
	return null;
}

function extractEntryPrice(alert) {
	if (!alert || typeof alert !== 'object') {
		return null;
	}
	const enrichment = alert.enrichmentData;
	if (enrichment && typeof enrichment === 'object') {
		const candidates = [
			enrichment.price,
			enrichment.entry,
			enrichment.entry_price,
			enrichment.technical_levels && enrichment.technical_levels.entry,
		];
		for (const candidate of candidates) {
			const numeric = Number(candidate);
			if (Number.isFinite(numeric) && numeric > 0) {
				return numeric;
			}
		}
	}
	return null;
}

function extractSetupType(alert) {
	if (!alert || typeof alert !== 'object') {
		return null;
	}
	const enrichment = alert.enrichmentData;
	if (enrichment && typeof enrichment === 'object' && typeof enrichment.setup_type === 'string') {
		const trimmed = enrichment.setup_type.trim();
		if (trimmed) {
			return trimmed;
		}
	}
	return null;
}

function extractExchange(alert) {
	if (!alert || typeof alert !== 'object') {
		return null;
	}
	if (typeof alert.exchange === 'string' && alert.exchange.trim()) {
		return alert.exchange.trim().toUpperCase();
	}
	const enrichment = alert.enrichmentData;
	if (enrichment && typeof enrichment === 'object' && typeof enrichment.exchange === 'string' && enrichment.exchange.trim()) {
		return enrichment.exchange.trim().toUpperCase();
	}
	return null;
}

function resolveSymbolKey(alert) {
	if (!alert || typeof alert !== 'object') {
		return null;
	}
	if (typeof alert.symbol === 'string' && alert.symbol.trim()) {
		return alert.symbol.trim().toUpperCase();
	}
	const enrichment = alert.enrichmentData;
	if (enrichment && typeof enrichment === 'object') {
		const candidates = [
			enrichment.symbol,
			enrichment.ticker,
			enrichment.asset,
			enrichment.original_symbol,
		];
		const found = candidates.find((c) => typeof c === 'string' && c.trim());
		if (found) {
			const normalized = found.trim().toUpperCase();
			if (normalized.includes(':')) {
				const parts = normalized.split(':');
				if (parts.length === 2 && parts[1].trim()) {
					return parts[1].trim();
				}
			}
			return normalized;
		}
	}
	return null;
}

function computeNetSide(buyCount, sellCount) {
	if (buyCount === 0 && sellCount === 0) {
		return 'neutral';
	}
	if (buyCount > sellCount) {
		return 'long';
	}
	if (sellCount > buyCount) {
		return 'short';
	}
	return 'neutral';
}

function computeHerfindahlIndex(shares) {
	let sum = 0;
	for (const value of shares) {
		sum += value;
	}
	if (sum <= 0) {
		return 0;
	}
	let hhi = 0;
	for (const value of shares) {
		const ratio = value / sum;
		hhi += ratio * ratio;
	}
	return Math.min(1, Math.max(0, hhi));
}

function emptyTotals() {
	return {
		totalAlerts: 0,
		openCount: 0,
		netSide: 'neutral',
		notional: 0,
		unrealizedPnl: 0,
		concentrationIndex: 0,
	};
}

function ensureFiniteNumber(value, fallback = 0) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return fallback;
	}
	return numeric;
}

/**
 * Build the implied-paper portfolio snapshot.
 *
 * @param {Object} [options]
 * @param {number} [options.windowHours]
 * @param {number} [options.maxAlerts]
 * @param {number} [options.paperNotional]
 * @param {number} [options.concentrationThreshold]
 * @param {number} [options.maxSymbols]
 * @param {Function} [options.fetchCurrentPrice] async (symbol, exchange) => { price: number, source: string } | null
 * @param {Object} [options.alertStorageService] override (used in tests)
 * @returns {Promise<Object>} snapshot
 */
async function buildPortfolioSnapshot(options = {}) {
	if (!isEnabled()) {
		const err = new Error(
			'Portfolio analytics is disabled. Set ENABLE_PORTFOLIO_ANALYTICS=true to enable.',
		);
		err.code = 'FEATURE_DISABLED';
		throw err;
	}

	const storage = options.alertStorageService || alertStorageService;
	if (!storage || !storage.isEnabled || !storage.isEnabled()) {
		throw buildStorageUnavailableError();
	}

	const config = resolveEnvironmentConfig(options);

	const to = new Date();
	const from = new Date(to.getTime() - config.windowHours * 60 * 60 * 1000);

	const fetchResult = await storage.listAlerts({ limit: config.maxAlerts, before: to.toISOString() });
	const alerts = Array.isArray(fetchResult && fetchResult.alerts) ? fetchResult.alerts : [];
	const filtered = alerts.filter((alert) => {
		const receivedAt = alert && alert.receivedAt ? new Date(alert.receivedAt) : null;
		if (!receivedAt || Number.isNaN(receivedAt.getTime())) {
			return false;
		}
		return receivedAt >= from && receivedAt <= to;
	});

	const symbolMap = new Map();
	let processedAlerts = 0;
	for (const alert of filtered) {
		const symbol = resolveSymbolKey(alert);
		if (!symbol) {
			continue;
		}
		const side = deriveAlertSide(alert);
		if (!side) {
			continue;
		}
		processedAlerts += 1;
		const exchange = extractExchange(alert);
		const key = `${symbol}::${exchange || ''}`;
		let entry = symbolMap.get(key);
		if (!entry) {
			entry = {
				symbol,
				exchange: exchange || null,
				openCount: 0,
				buyCount: 0,
				sellCount: 0,
				notional: 0,
				notionalWeightedPriceSum: 0,
				notionalWeightTotal: 0,
				priceSamples: 0,
				setupTypeBreakdown: {},
				lastSignalAt: null,
			};
			symbolMap.set(key, entry);
		}
		entry.buyCount += side === SIDE_BUY ? 1 : 0;
		entry.sellCount += side === SIDE_SELL ? 1 : 0;
		entry.openCount = entry.buyCount - entry.sellCount;
		entry.notional += config.paperNotional;

		const price = extractEntryPrice(alert);
		if (price !== null) {
			entry.notionalWeightedPriceSum += price * config.paperNotional;
			entry.notionalWeightTotal += config.paperNotional;
			entry.priceSamples += 1;
		}

		const setupType = extractSetupType(alert);
		if (setupType) {
			entry.setupTypeBreakdown[setupType] = (entry.setupTypeBreakdown[setupType] || 0) + 1;
		}

		const receivedAt = alert.receivedAt ? new Date(alert.receivedAt) : null;
		if (receivedAt && !Number.isNaN(receivedAt.getTime())) {
			if (!entry.lastSignalAt || receivedAt > entry.lastSignalAt) {
				entry.lastSignalAt = receivedAt;
			}
		}
	}

	const symbols = [];
	for (const entry of symbolMap.values()) {
		const averageEntry = entry.notionalWeightTotal > 0
			? entry.notionalWeightedPriceSum / entry.notionalWeightTotal
			: null;
		symbols.push({
			symbol: entry.symbol,
			exchange: entry.exchange,
			openCount: entry.openCount,
			buyCount: entry.buyCount,
			sellCount: entry.sellCount,
			netSide: computeNetSide(entry.buyCount, entry.sellCount),
			notional: roundToFinite(entry.notional),
			averageEntry: averageEntry === null ? null : roundToFinite(averageEntry),
			currentPrice: null,
			unrealizedReturnPct: null,
			unrealizedPnl: null,
			setupTypeBreakdown: entry.setupTypeBreakdown,
			lastSignalAt: entry.lastSignalAt ? entry.lastSignalAt.toISOString() : null,
		});
	}

	symbols.sort((a, b) => Math.abs(b.notional) - Math.abs(a.notional));

	const topSymbols = symbols.slice(0, config.maxSymbols);
	const truncated = symbols.length > topSymbols.length;
	const truncatedNotional = symbols
		.slice(config.maxSymbols)
		.reduce((acc, sym) => acc + Math.abs(sym.notional), 0);

	const totals = emptyTotals();
	totals.totalAlerts = processedAlerts;
	totals.openCount = topSymbols.reduce((acc, sym) => acc + sym.openCount, 0);
	const totalBuys = topSymbols.reduce((acc, sym) => acc + sym.buyCount, 0);
	const totalSells = topSymbols.reduce((acc, sym) => acc + sym.sellCount, 0);
	totals.netSide = computeNetSide(totalBuys, totalSells);
	totals.notional = roundToFinite(topSymbols.reduce((acc, sym) => acc + sym.notional, 0));
	totals.concentrationIndex = roundToFinite(
		computeHerfindahlIndex(topSymbols.map((sym) => Math.max(0, sym.notional))),
		4,
	);

	const riskFlags = [];
	if (totals.concentrationIndex > config.concentrationThreshold) {
		riskFlags.push(RISK_FLAGS.CONCENTRATION_HIGH);
	}
	if (totals.netSide === 'short') {
		riskFlags.push(RISK_FLAGS.OPEN_SELLS_OVERWEIGHT);
	}

	let noMarketDataSeen = false;
	if (topSymbols.length > 0) {
		if (typeof options.fetchCurrentPrice === 'function') {
			await Promise.all(topSymbols.map(async (sym) => {
				try {
					const quote = await options.fetchCurrentPrice(sym.symbol, sym.exchange);
					if (quote && Number.isFinite(Number(quote.price)) && Number(quote.price) > 0) {
						const currentPrice = Number(quote.price);
						sym.currentPrice = roundToFinite(currentPrice);
						if (sym.averageEntry && sym.averageEntry > 0) {
							const signedReturn = (currentPrice - sym.averageEntry) / sym.averageEntry;
							sym.unrealizedReturnPct = roundToFinite(signedReturn * 100, 4);
							// Long-only P&L for the implied book: sign by open count direction.
							const direction = sym.openCount >= 0 ? 1 : -1;
							sym.unrealizedPnl = roundToFinite(signedReturn * direction * sym.notional, 2);
						}
					} else {
						noMarketDataSeen = true;
					}
				} catch (error) {
					noMarketDataSeen = true;
				}
			}));
			if (noMarketDataSeen) {
				riskFlags.push(RISK_FLAGS.NO_MARKET_DATA);
			}
			totals.unrealizedPnl = roundToFinite(
				topSymbols.reduce((acc, sym) => acc + (sym.unrealizedPnl || 0), 0),
				2,
			);
		} else {
			riskFlags.push(RISK_FLAGS.NO_MARKET_DATA);
		}
	}

	if (truncated && truncatedNotional > 0) {
		riskFlags.push(RISK_FLAGS.STALE_SIGNALS);
	}

	return {
		mode: 'implied_paper',
		window: {
			from: from.toISOString(),
			to: to.toISOString(),
			hours: config.windowHours,
		},
		config: {
			paperNotional: roundToFinite(config.paperNotional, 2),
			concentrationThreshold: config.concentrationThreshold,
			maxSymbols: config.maxSymbols,
			maxAlerts: config.maxAlerts,
		},
		totals,
		symbols: topSymbols,
		topSymbols: topSymbols.map((sym) => sym.symbol),
		riskFlags,
		generatedAt: new Date().toISOString(),
	};
}

function roundToFinite(value, decimals = 2) {
	const numeric = Number(value);
	if (!Number.isFinite(numeric)) {
		return 0;
	}
	const factor = 10 ** decimals;
	return Math.round(numeric * factor) / factor;
}

function escapeMarkdownV2(value) {
	if (value === null || value === undefined) {
		return '—';
	}
	return String(value).replace(/([_*[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

function formatNumber(value, decimals = 2) {
	if (value === null || value === undefined || !Number.isFinite(Number(value))) {
		return '—';
	}
	return Number(value).toFixed(decimals);
}

function formatMarkdownSnapshot(snapshot) {
	if (!snapshot || typeof snapshot !== 'object') {
		return 'Sin datos de portafolio.';
	}
	if (!Array.isArray(snapshot.symbols) || snapshot.symbols.length === 0) {
		return [
			'*Portafolio implícito*',
			'Sin señales registradas en la ventana de evaluación.',
			`Ventana: ${snapshot.window && snapshot.window.hours ? `${snapshot.window.hours}h` : '—'}.`,
		].join('\n');
	}

	const lines = [];
	lines.push('*Portafolio implícito* (sin dinero real)');
	lines.push(`Ventana: ${snapshot.window.hours}h · Señales: ${snapshot.totals.totalAlerts} · Notional: $${formatNumber(snapshot.totals.notional, 2)}`);
	lines.push(`Lado neto: ${escapeMarkdownV2(snapshot.totals.netSide)} · P\\&L no realizado: $${formatNumber(snapshot.totals.unrealizedPnl, 2)}`);

	if (Array.isArray(snapshot.riskFlags) && snapshot.riskFlags.length > 0) {
		lines.push('Alertas: ' + snapshot.riskFlags.map((flag) => escapeMarkdownV2(flag)).join(', '));
	} else {
		lines.push('Sin alertas de riesgo activas.');
	}

	lines.push('');
	lines.push('*Top símbolos:*');
	for (const sym of snapshot.symbols) {
		const sideMarker = sym.openCount > 0 ? '🟢' : sym.openCount < 0 ? '🔴' : '⚪';
		const exchangeTag = sym.exchange ? ` \\(${escapeMarkdownV2(sym.exchange)}\\)` : '';
		lines.push(
			`${sideMarker} ${escapeMarkdownV2(sym.symbol)}${exchangeTag} · net ${sym.openCount} · $${formatNumber(sym.notional, 2)} · entry ${formatNumber(sym.averageEntry)} · now ${formatNumber(sym.currentPrice)} · PnL $${formatNumber(sym.unrealizedPnl)}`,
		);
	}

	return lines.join('\n');
}

module.exports = {
	buildPortfolioSnapshot,
	parseWindowHours,
	parseMaxAlerts,
	parsePaperNotional,
	parseConcentrationThreshold,
	parseMaxSymbols,
	formatMarkdownSnapshot,
	isEnabled,
	resolveEnvironmentConfig,
	STORAGE_UNAVAILABLE_CODE,
	RISK_FLAGS,
};
