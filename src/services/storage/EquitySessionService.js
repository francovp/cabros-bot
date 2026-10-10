'use strict';

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

/**
 * Supported equity exchanges for session classification.
 * Matches US equity venues known to Twelve Data and TradingView.
 */
const EQUITY_EXCHANGES = Object.freeze(new Set([
	'BATS',
	'NASDAQ',
	'NYSE',
	'AMEX',
	'NYSE ARCA',
	'NYSE_ARCA',
	'ARCA',
	'CBOE',
]));

const CRYPTO_EXCHANGES = Object.freeze(new Set([
	'BINANCE',
	'BYBIT',
	'COINBASE',
	'OKX',
	'KRAKEN',
	'BITFINEX',
	'KUCOIN',
	'KUCOINSPOT',
	'MEXC',
]));

/**
 * US Equity Market Holidays (NYSE / NASDAQ) for 2024-2027 (full-day closures).
 * Dates in YYYY-MM-DD (UTC/US Eastern calendar day).
 */
const US_EQUITY_HOLIDAYS = Object.freeze(new Set([
	// 2024
	'2024-01-01', // New Year's Day
	'2024-01-15', // Martin Luther King Jr. Day
	'2024-02-19', // Washington's Birthday (Presidents' Day)
	'2024-03-29', // Good Friday
	'2024-05-27', // Memorial Day
	'2024-06-19', // Juneteenth National Independence Day
	'2024-07-04', // Independence Day
	'2024-09-02', // Labor Day
	'2024-11-28', // Thanksgiving Day
	'2024-12-25', // Christmas Day

	// 2025
	'2025-01-01', // New Year's Day
	'2025-01-20', // Martin Luther King Jr. Day
	'2025-02-17', // Washington's Birthday
	'2025-04-18', // Good Friday
	'2025-05-26', // Memorial Day
	'2025-06-19', // Juneteenth
	'2025-07-04', // Independence Day
	'2025-09-01', // Labor Day
	'2025-11-27', // Thanksgiving Day
	'2025-12-25', // Christmas Day

	// 2026
	'2026-01-01', // New Year's Day
	'2026-01-19', // Martin Luther King Jr. Day
	'2026-02-16', // Washington's Birthday
	'2026-04-03', // Good Friday
	'2026-05-25', // Memorial Day
	'2026-06-19', // Juneteenth
	'2026-07-03', // Independence Day (observed)
	'2026-09-07', // Labor Day
	'2026-11-26', // Thanksgiving Day
	'2026-12-25', // Christmas Day

	// 2027
	'2027-01-01', // New Year's Day
	'2027-01-18', // Martin Luther King Jr. Day
	'2027-02-15', // Washington's Birthday
	'2027-03-26', // Good Friday
	'2027-05-31', // Memorial Day
	'2027-06-18', // Juneteenth (observed)
	'2027-07-05', // Independence Day (observed)
	'2027-09-06', // Labor Day
	'2027-11-25', // Thanksgiving Day
	'2027-12-24', // Christmas Day (observed)
]));

function lookupUsEquityHolidays() {
	return US_EQUITY_HOLIDAYS;
}

function normalizeExchange(exchange) {
	if (!exchange || typeof exchange !== 'string') {
		return null;
	}
	let normalized = exchange.trim().toUpperCase();
	if (normalized.endsWith('_DLY')) {
		normalized = normalized.slice(0, -4);
	}
	if (normalized === 'NYSE_ARCA' || normalized === 'ARCA') {
		return 'NYSE ARCA';
	}
	return normalized;
}

function isEquityExchange(exchange) {
	const normalized = normalizeExchange(exchange);
	return Boolean(normalized && EQUITY_EXCHANGES.has(normalized));
}

function isCryptoExchange(exchange) {
	if (!exchange || typeof exchange !== 'string') return false;
	const normalized = exchange.trim().toUpperCase();
	return CRYPTO_EXCHANGES.has(normalized);
}

const SESSION_TIME_ZONE = 'America/New_York';

function getLocalDateParts(date) {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: SESSION_TIME_ZONE,
		calendar: 'gregory',
		weekday: 'short',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(date).reduce((result, part) => {
		if (part.type !== 'literal') result[part.type] = part.value;
		return result;
	}, {});

	return {
		year: Number(parts.year),
		month: Number(parts.month),
		day: Number(parts.day),
		weekday: parts.weekday,
		hour: Number(parts.hour),
		minute: Number(parts.minute),
	};
}

/**
 * Classifies an equity signal's timestamp into a session state:
 * - 'regular': 13:30 - 20:00 UTC (09:30 - 16:00 ET) (Mon-Fri, excluding holidays)
 * - 'pre': 08:00 - 13:30 UTC (04:00 - 09:30 ET) (Mon-Fri, excluding holidays)
 * - 'post': 20:00 - 00:00 UTC (16:00 - 20:00 ET) (Mon-Fri, excluding holidays)
 * - 'closed': 00:00 - 08:00 UTC (20:00 - 04:00 ET), weekends, and full-day US holidays
 *
 * For crypto venues or symbols: returns '24/7'.
 * For unknown non-equity venues: returns '24/7'.
 *
 * @param {Object} params
 * @param {string} [params.exchange]
 * @param {string} [params.symbol]
 * @param {Date|string|number} [params.timestamp]
 * @param {boolean} [params.useEasternTime] - If true, computes against America/New_York clock
 * @returns {'regular'|'pre'|'post'|'closed'|'24/7'}
 */
function classifySession(params = {}) {
	const { exchange, symbol, timestamp, useEasternTime } = params;
	const normalizedExchange = normalizeExchange(exchange);

	// Check if crypto
	if (isCryptoExchange(normalizedExchange)) {
		return '24/7';
	}
	if (!normalizedExchange && typeof symbol === 'string') {
		const s = symbol.trim().toUpperCase();
		if (s.endsWith('USDT') || s.endsWith('USDC') || s.endsWith('BUSD') || s.endsWith('PERP')) {
			return '24/7';
		}
	}

	if (!isEquityExchange(normalizedExchange)) {
		// Non-equity venue (or null/unknown)
		return '24/7';
	}

	const date = timestamp ? new Date(timestamp) : new Date();
	const validDate = Number.isFinite(date.getTime()) ? date : new Date();

	if (useEasternTime) {
		const local = getLocalDateParts(validDate);
		const isoDate = `${local.year}-${String(local.month).padStart(2, '0')}-${String(local.day).padStart(2, '0')}`;
		if (US_EQUITY_HOLIDAYS.has(isoDate)) {
			return 'closed';
		}
		const dayOfWeek = (['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(local.weekday));
		if (dayOfWeek === 0 || dayOfWeek === 6) {
			return 'closed';
		}

		const minutes = local.hour * 60 + local.minute;
		// 04:00 to 09:30 ET = 240 to 570 min (Pre)
		// 09:30 to 16:00 ET = 570 to 960 min (Regular)
		// 16:00 to 20:00 ET = 960 to 1200 min (Post)
		// 20:00 to 04:00 ET = Closed
		if (minutes >= 570 && minutes < 960) {
			return 'regular';
		}
		if (minutes >= 240 && minutes < 570) {
			return 'pre';
		}
		if (minutes >= 960 && minutes < 1200) {
			return 'post';
		}
		return 'closed';
	}

	// Default UTC classification per issue #804 specification:
	// Check day of week in UTC (0 = Sunday, 6 = Saturday)
	const dayOfWeek = validDate.getUTCDay();
	if (dayOfWeek === 0 || dayOfWeek === 6) {
		return 'closed';
	}

	// Check US holiday in UTC YYYY-MM-DD
	const isoDate = validDate.toISOString().slice(0, 10);
	if (US_EQUITY_HOLIDAYS.has(isoDate)) {
		return 'closed';
	}

	const utcHours = validDate.getUTCHours();
	const utcMinutes = validDate.getUTCMinutes();
	const minutesFromMidnight = utcHours * 60 + utcMinutes;

	// Pre-market: 08:00 UTC (480 min) to 13:30 UTC (810 min)
	// Regular: 13:30 UTC (810 min) to 20:00 UTC (1200 min)
	// Post-market: 20:00 UTC (1200 min) to 00:00 UTC (1440 min)
	// Closed: 00:00 to 08:00 UTC (0 to 480 min)

	if (minutesFromMidnight >= 810 && minutesFromMidnight < 1200) {
		return 'regular';
	}
	if (minutesFromMidnight >= 480 && minutesFromMidnight < 810) {
		return 'pre';
	}
	if (minutesFromMidnight >= 1200 && minutesFromMidnight < 1440) {
		return 'post';
	}

	return 'closed';
}

function isEquitySessionTagEnabled() {
	try {
		const config = getRuntimeConfig();
		if (typeof config.ENABLE_EQUITY_SESSION_TAG === 'boolean') {
			return config.ENABLE_EQUITY_SESSION_TAG;
		}
		if (process.env.ENABLE_EQUITY_SESSION_TAG !== undefined) {
			return process.env.ENABLE_EQUITY_SESSION_TAG === 'true';
		}
	} catch (_) {
		// Fallback safely to true
	}
	return true;
}

const SESSION_SPANISH_LABELS = Object.freeze({
	regular: 'regular',
	pre: 'pre',
	post: 'post',
	closed: 'cerrado',
	'24/7': '24/7',
});

function formatSessionLabelSpanish(session) {
	if (!session || typeof session !== 'string') return null;
	const normalized = session.trim().toLowerCase();
	return SESSION_SPANISH_LABELS[normalized] || normalized;
}

/**
 * Formats the session line for notification delivery:
 * 🌐 Sesión: <regular|pre|post|cerrado>
 * Only returns a string if isEquitySessionTagEnabled() is true and session is a recognized equity session.
 * For crypto '24/7' or unknown, returns null.
 *
 * @param {string} session - 'regular' | 'pre' | 'post' | 'closed'
 * @param {Object} [options]
 * @param {boolean} [options.markdownV2=false] - Whether to escape for Telegram MarkdownV2
 * @returns {string|null}
 */
function formatSessionLine(session, options = {}) {
	if (!isEquitySessionTagEnabled()) {
		return null;
	}
	if (!session || typeof session !== 'string') {
		return null;
	}
	const normalized = session.trim().toLowerCase();
	if (normalized === '24/7' || normalized === 'unknown') {
		return null;
	}
	const label = formatSessionLabelSpanish(normalized);
	if (!label) {
		return null;
	}
	const text = `🌐 Sesión: ${label}`;
	if (options.markdownV2) {
		const { smartEscapeMarkdownV2 } = require('../notification/formatters/markdownV2Formatter');
		return smartEscapeMarkdownV2(text);
	}
	return text;
}

module.exports = {
	EQUITY_EXCHANGES,
	US_EQUITY_HOLIDAYS,
	lookupUsEquityHolidays,
	isEquityExchange,
	isCryptoExchange,
	classifySession,
	isEquitySessionTagEnabled,
	formatSessionLabelSpanish,
	formatSessionLine,
};

