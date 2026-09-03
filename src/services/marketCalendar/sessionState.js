'use strict';

/**
 * Market Calendar session-state classifier.
 *
 * Resolves a `(exchange, symbol, timestamp)` triple to one of:
 *   - `regular`  : regular trading hours on a normal business day
 *   - `pre`      : pre-market session (before regular open)
 *   - `post`     : post-market / after-hours session (after regular close)
 *   - `closed`   : weekday outside any session window (e.g. very early morning or late evening)
 *   - `holiday`  : venue closed for a full-day holiday
 *   - `half_day` : half-day trading day (early close at 13:00 ET)
 *   - `unknown`  : exchange not recognized, or data unavailable (fail-open)
 */

const usMarketHolidays = require('./data/usMarketHolidays.json');

const US_EQUITY_VENUES = new Set(
	Array.isArray(usMarketHolidays && usMarketHolidays.venues)
		? usMarketHolidays.venues
		: ['BATS', 'NASDAQ', 'NYSE', 'AMEX', 'NYSE ARCA', 'NYSE_ARCA', 'ARCA', 'CBOE'],
);

const CRYPTO_VENUES = new Set([
	'BINANCE', 'COINBASE', 'KRAKEN', 'BITSTAMP', 'BITFINEX', 'KUCOIN', 'OKX',
	'BYBIT', 'MEXC', 'GATEIO', 'HUOBI', 'CRYPTO', 'BINANCEUS',
]);

const SESSION_STATES = Object.freeze({
	REGULAR: 'regular',
	PRE: 'pre',
	POST: 'post',
	CLOSED: 'closed',
	HOLIDAY: 'holiday',
	HALF_DAY: 'half_day',
	UNKNOWN: 'unknown',
});

const DEFAULT_TIMEZONE = 'America/New_York';
const ET_TIMEZONE = (usMarketHolidays && usMarketHolidays.timezone) || DEFAULT_TIMEZONE;

function parseTimeOfDay(hhmm) {
	if (typeof hhmm !== 'string') return null;
	const match = hhmm.match(/^(\d{1,2}):(\d{2})$/);
	if (!match) return null;
	const hh = Number(match[1]);
	const mm = Number(match[2]);
	if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
	if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
	return hh * 60 + mm;
}

function resolveEasternParts(date) {
	if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
	try {
		const fmt = new Intl.DateTimeFormat('en-US', {
			timeZone: ET_TIMEZONE,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			weekday: 'short',
			hour12: false,
		});
		const parts = fmt.formatToParts(date);
		const lookup = {};
		for (const p of parts) {
			if (p.type !== 'literal') lookup[p.type] = p.value;
		}
		const year = lookup.year;
		const month = lookup.month;
		const day = lookup.day;
		const hour = Number(lookup.hour);
		const minute = Number(lookup.minute);
		const weekdayStr = lookup.weekday;
		const normalizedHour = hour === 24 ? 0 : hour;
		if (!year || !month || !day || !Number.isFinite(normalizedHour) || !Number.isFinite(minute)) {
			return null;
		}
		const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
		const dayOfWeek = weekdayMap[weekdayStr];
		if (dayOfWeek === undefined) return null;
		return {
			yearKey: year,
			dateKey: `${year}-${month}-${day}`,
			minuteOfDay: normalizedHour * 60 + minute,
			dayOfWeek,
		};
	} catch (error) {
		console.warn('[marketCalendar] resolveEasternParts failed:', error.message);
		return null;
	}
}

function findHoliday(dateKey, yearKey) {
	const yearHolidays = usMarketHolidays && usMarketHolidays.holidays;
	if (!yearHolidays || typeof yearHolidays !== 'object') return null;
	const candidates = [];
	if (yearHolidays[yearKey]) candidates.push(...yearHolidays[yearKey]);
	const yearNum = Number(yearKey);
	if (Number.isFinite(yearNum)) {
		const prev = String(yearNum - 1);
		const next = String(yearNum + 1);
		if (yearHolidays[prev]) candidates.push(...yearHolidays[prev]);
		if (yearHolidays[next]) candidates.push(...yearHolidays[next]);
	}
	return candidates.find((h) => h && h.date === dateKey) || null;
}

function getSessionState(input = {}) {
	const exchange = typeof input.exchange === 'string' ? input.exchange.toUpperCase() : '';
	const timestamp = input.timestamp instanceof Date
		? input.timestamp
		: input.timestamp
		? new Date(input.timestamp)
		: new Date();

	const baseResult = {
		state: SESSION_STATES.UNKNOWN,
		venueKind: 'unknown',
		timezone: ET_TIMEZONE,
		dateKey: null,
		holiday: null,
		halfDay: false,
		suppressDelivery: false,
	};

	if (!exchange) return baseResult;

	if (CRYPTO_VENUES.has(exchange)) {
		return {
			...baseResult,
			state: SESSION_STATES.REGULAR,
			venueKind: 'crypto',
		};
	}

	if (!US_EQUITY_VENUES.has(exchange)) {
		return baseResult;
	}

	const parts = resolveEasternParts(timestamp);
	if (!parts) {
		console.warn(`[marketCalendar] Could not resolve ET parts for exchange=${exchange}; returning unknown`);
		return { ...baseResult, venueKind: 'us_equity' };
	}

	const { yearKey, dateKey, minuteOfDay, dayOfWeek } = parts;
	const holiday = findHoliday(dateKey, yearKey);

	if (dayOfWeek === 0 || dayOfWeek === 6) {
		return {
			...baseResult,
			state: SESSION_STATES.CLOSED,
			venueKind: 'us_equity',
			dateKey,
			holiday,
			suppressDelivery: true,
		};
	}

	if (holiday) {
		if (holiday.type === 'half_day') {
			const openMin = parseTimeOfDay('09:30');
			const halfCloseMin = parseTimeOfDay((usMarketHolidays && usMarketHolidays.earlyCloseET) || '13:00');
			const inHalfDay = Number.isFinite(openMin) && Number.isFinite(halfCloseMin)
				&& minuteOfDay >= openMin && minuteOfDay < halfCloseMin;
			return {
				...baseResult,
				state: inHalfDay ? SESSION_STATES.REGULAR : SESSION_STATES.CLOSED,
				venueKind: 'us_equity',
				dateKey,
				holiday,
				halfDay: inHalfDay,
				suppressDelivery: !inHalfDay,
			};
		}
		return {
			...baseResult,
			state: SESSION_STATES.HOLIDAY,
			venueKind: 'us_equity',
			dateKey,
			holiday,
			suppressDelivery: true,
		};
	}

	const hours = (usMarketHolidays && usMarketHolidays.regularHoursET) || {};
	const preOpen = parseTimeOfDay(hours.preOpen || '04:00');
	const openMin = parseTimeOfDay(hours.open || '09:30');
	const closeMin = parseTimeOfDay(hours.close || '16:00');
	const postClose = parseTimeOfDay(hours.postClose || '20:00');

	if (
		!Number.isFinite(preOpen) || !Number.isFinite(openMin) ||
		!Number.isFinite(closeMin) || !Number.isFinite(postClose)
	) {
		console.warn('[marketCalendar] Dataset missing regularHoursET; returning closed for safety');
		return {
			...baseResult,
			state: SESSION_STATES.CLOSED,
			venueKind: 'us_equity',
			dateKey,
			suppressDelivery: true,
		};
	}

	if (minuteOfDay >= openMin && minuteOfDay < closeMin) {
		return {
			...baseResult,
			state: SESSION_STATES.REGULAR,
			venueKind: 'us_equity',
			dateKey,
		};
	}
	if (minuteOfDay >= preOpen && minuteOfDay < openMin) {
		return {
			...baseResult,
			state: SESSION_STATES.PRE,
			venueKind: 'us_equity',
			dateKey,
		};
	}
	if (minuteOfDay >= closeMin && minuteOfDay < postClose) {
		return {
			...baseResult,
			state: SESSION_STATES.POST,
			venueKind: 'us_equity',
			dateKey,
		};
	}
	return {
		...baseResult,
		state: SESSION_STATES.CLOSED,
		venueKind: 'us_equity',
		dateKey,
		suppressDelivery: true,
	};
}

function shouldSuppressDelivery(input = {}) {
	const result = getSessionState(input);
	return Boolean(result && result.suppressDelivery);
}

function getDatasetMetadata() {
	return {
		datasetVersion: (usMarketHolidays && usMarketHolidays.datasetVersion) || 'unknown',
		lastUpdated: (usMarketHolidays && usMarketHolidays.lastUpdated) || 'unknown',
		timezone: ET_TIMEZONE,
		venues: Array.from(US_EQUITY_VENUES),
		supportedYears: usMarketHolidays && usMarketHolidays.holidays
			? Object.keys(usMarketHolidays.holidays)
			: [],
	};
}

module.exports = {
	getSessionState,
	shouldSuppressDelivery,
	getDatasetMetadata,
	SESSION_STATES,
	US_EQUITY_VENUES,
	CRYPTO_VENUES,
};
