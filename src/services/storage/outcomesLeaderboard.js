'use strict';

/**
 * Ranked, statistically-guarded outcomes leaderboard helper (#826).
 *
 * Aggregates evaluated window outcomes over the existing bounded
 * `tradingSignalOutcomes` scan (max 31 days, max 1000 documents) without
 * creating a new Firestore collection or worker.
 *
 * Statistical notes:
 * - `hitRateCI95` uses the two-sided Wilson score 95% interval (z = 1.96).
 * - `expectancyRCI95` uses a normal-approximation 95% confidence interval
 *   (`expectancyR ± 1.96 * sampleStdDevR / sqrt(n)`) and is null when < 2
 *   trades have finite R-multiples. Never conflated with Wilson score.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const LEADERBOARD_GROUP_BY_AXES = Object.freeze([
	'setupType',
	'symbol',
	'exchange',
	'side',
	'promptSource',
]);
const MAX_LEADERBOARD_GROUP_BY_AXES = 3;
const DEFAULT_LEADERBOARD_GROUP_BY = Object.freeze(['setupType']);
const LEADERBOARD_WINDOWS = Object.freeze(['1h', '4h', '1D', '1W']);
const DEFAULT_LEADERBOARD_WINDOW = '1D';
const DEFAULT_MIN_TRADES = 10;
const MAX_MIN_TRADES = 1000;
const LEADERBOARD_SORTS = Object.freeze(['expectancy', 'hitRate', 'sampleSize', 'consistency']);
const DEFAULT_LEADERBOARD_SORT = 'expectancy';
const LEADERBOARD_ORDERS = Object.freeze(['asc', 'desc']);
const DEFAULT_LEADERBOARD_ORDER = 'desc';
const DEFAULT_LEADERBOARD_LIMIT = 20;
const MAX_LEADERBOARD_LIMIT = 100;
const DEFAULT_LEADERBOARD_LOOKBACK_DAYS = 30;
const MAX_LEADERBOARD_LOOKBACK_DAYS = 31;
const MAX_LEADERBOARD_SCAN_DOCS = 1000;
const MIN_RELIABLE_TRADES = 30;
const Z_95 = 1.96;
const LEADERBOARD_CACHE_TTL_MS = 60 * 1000;
const MAX_LEADERBOARD_CACHE_ENTRIES = 128;
const MAX_UNRELIABLE_COHORTS_RETURNED = 50;

const WINDOW_NORMALIZATION_MAP = Object.freeze({
	'1h': '1h',
	'4h': '4h',
	'1d': '1D',
	'1w': '1W',
});

const DEFAULT_RANGE_SENTINEL = '__DEFAULT__';

const leaderboardCache = new Map();

function createInvalidRequestError(message) {
	const error = new Error(message);
	error.code = 'INVALID_REQUEST';
	error.statusCode = 400;
	return error;
}

function roundTo(value, decimals = 4) {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return null;
	}
	const rounded = parseFloat(value.toFixed(decimals));
	return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Normalize and validate `groupBy` query/CLI axes (1 to 3 unique axes).
 * @param {string|string[]|undefined|null} rawGroupBy
 * @returns {string[]}
 */
function normalizeLeaderboardGroupBy(rawGroupBy) {
	if (rawGroupBy === undefined || rawGroupBy === null || rawGroupBy === '') {
		return [...DEFAULT_LEADERBOARD_GROUP_BY];
	}

	const rawTokens = Array.isArray(rawGroupBy)
		? rawGroupBy
		: typeof rawGroupBy === 'string'
			? rawGroupBy.split(',')
			: null;

	if (!rawTokens) {
		throw createInvalidRequestError(
			`Invalid groupBy. Supported axes: ${LEADERBOARD_GROUP_BY_AXES.join(', ')}.`,
		);
	}

	const normalized = [];
	const seen = new Set();

	for (const item of rawTokens) {
		if (typeof item !== 'string') {
			throw createInvalidRequestError(
				`Invalid groupBy. Supported axes: ${LEADERBOARD_GROUP_BY_AXES.join(', ')}.`,
			);
		}
		const parts = item.split(',');
		for (const part of parts) {
			const axis = part.trim();
			if (!axis || !LEADERBOARD_GROUP_BY_AXES.includes(axis)) {
				throw createInvalidRequestError(
					`Unsupported groupBy axis '${axis}'. Supported axes: ${LEADERBOARD_GROUP_BY_AXES.join(', ')}.`,
				);
			}
			if (!seen.has(axis)) {
				seen.add(axis);
				normalized.push(axis);
			}
		}
	}

	if (normalized.length === 0) {
		return [...DEFAULT_LEADERBOARD_GROUP_BY];
	}

	if (normalized.length > MAX_LEADERBOARD_GROUP_BY_AXES) {
		throw createInvalidRequestError(
			`At most ${MAX_LEADERBOARD_GROUP_BY_AXES} groupBy axes are supported.`,
		);
	}

	return normalized;
}

/**
 * Normalize and validate evaluation horizon window (`1h`, `4h`, `1D`, `1W`).
 * @param {string|undefined|null} rawWindow
 * @returns {string}
 */
function normalizeLeaderboardWindow(rawWindow) {
	if (rawWindow === undefined || rawWindow === null || rawWindow === '') {
		return DEFAULT_LEADERBOARD_WINDOW;
	}
	if (typeof rawWindow !== 'string') {
		throw createInvalidRequestError(
			`Invalid window. Supported values: ${LEADERBOARD_WINDOWS.join(', ')}.`,
		);
	}
	const normalized = WINDOW_NORMALIZATION_MAP[rawWindow.trim().toLowerCase()];
	if (!normalized) {
		throw createInvalidRequestError(
			`Invalid window '${rawWindow}'. Supported values: ${LEADERBOARD_WINDOWS.join(', ')}.`,
		);
	}
	return normalized;
}

function normalizePositiveBoundedInt(rawValue, { name, defaultValue, min = 1, max }) {
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return defaultValue;
	}

	let parsed;
	if (typeof rawValue === 'number') {
		parsed = rawValue;
	} else if (typeof rawValue === 'string' && /^\d+$/.test(rawValue.trim())) {
		parsed = Number(rawValue.trim());
	} else {
		throw createInvalidRequestError(
			`Invalid ${name}. Expected an integer between ${min} and ${max}.`,
		);
	}

	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw createInvalidRequestError(
			`Invalid ${name}. Expected an integer between ${min} and ${max}.`,
		);
	}

	return parsed;
}

function normalizeEnumOption(rawValue, allowed, defaultValue, name) {
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return defaultValue;
	}
	if (typeof rawValue !== 'string') {
		throw createInvalidRequestError(
			`Invalid ${name}. Supported values: ${allowed.join(', ')}.`,
		);
	}
	const trimmed = rawValue.trim();
	if (!allowed.includes(trimmed)) {
		throw createInvalidRequestError(
			`Invalid ${name} '${trimmed}'. Supported values: ${allowed.join(', ')}.`,
		);
	}
	return trimmed;
}

function parseTimestampParam(rawValue, fieldName) {
	if (rawValue === undefined || rawValue === null || rawValue === '') {
		return null;
	}
	if (rawValue instanceof Date) {
		if (Number.isNaN(rawValue.getTime())) {
			throw createInvalidRequestError(`Invalid ${fieldName} timestamp.`);
		}
		return new Date(rawValue.getTime());
	}
	if (typeof rawValue !== 'string') {
		throw createInvalidRequestError(`Invalid ${fieldName} timestamp. Use ISO-8601 format.`);
	}
	const parsed = new Date(rawValue.trim());
	if (Number.isNaN(parsed.getTime())) {
		throw createInvalidRequestError(`Invalid ${fieldName} timestamp. Use ISO-8601 format.`);
	}
	return parsed;
}

function resolveLeaderboardDateRange(rawFrom, rawTo, nowMs = Date.now()) {
	const parsedFrom = parseTimestampParam(rawFrom, 'from');
	const parsedTo = parseTimestampParam(rawTo, 'to');
	const maxSpanMs = MAX_LEADERBOARD_LOOKBACK_DAYS * DAY_MS;
	const defaultLookbackMs = DEFAULT_LEADERBOARD_LOOKBACK_DAYS * DAY_MS;

	const effectiveTo = parsedTo || new Date(nowMs);
	const effectiveFrom = parsedFrom || new Date(effectiveTo.getTime() - defaultLookbackMs);

	if (effectiveFrom.getTime() > effectiveTo.getTime()) {
		throw createInvalidRequestError('from must be before or equal to to.');
	}

	if (effectiveTo.getTime() - effectiveFrom.getTime() > maxSpanMs) {
		throw createInvalidRequestError(
			`Date range cannot exceed ${MAX_LEADERBOARD_LOOKBACK_DAYS} days.`,
		);
	}

	return {
		parsedFrom: effectiveFrom,
		parsedTo: effectiveTo,
		fromCacheKey: parsedFrom ? parsedFrom.toISOString() : DEFAULT_RANGE_SENTINEL,
		toCacheKey: parsedTo ? parsedTo.toISOString() : DEFAULT_RANGE_SENTINEL,
	};
}

/**
 * Parse and validate all leaderboard query options (date bounds default to 30 days, max 31 days).
 * @param {Object} [options]
 * @param {number} [nowMs]
 * @returns {Object}
 */
function normalizeLeaderboardOptions(options = {}, nowMs = Date.now()) {
	const groupBy = normalizeLeaderboardGroupBy(options.groupBy);
	const window = normalizeLeaderboardWindow(options.window);
	const minTrades = normalizePositiveBoundedInt(options.minTrades, {
		name: 'minTrades',
		defaultValue: DEFAULT_MIN_TRADES,
		min: 1,
		max: MAX_MIN_TRADES,
	});
	const sort = normalizeEnumOption(
		options.sort,
		LEADERBOARD_SORTS,
		DEFAULT_LEADERBOARD_SORT,
		'sort',
	);
	const order = normalizeEnumOption(
		options.order,
		LEADERBOARD_ORDERS,
		DEFAULT_LEADERBOARD_ORDER,
		'order',
	);
	const limit = normalizePositiveBoundedInt(options.limit, {
		name: 'limit',
		defaultValue: DEFAULT_LEADERBOARD_LIMIT,
		min: 1,
		max: MAX_LEADERBOARD_LIMIT,
	});
	const range = resolveLeaderboardDateRange(options.from, options.to, nowMs);

	return {
		groupBy,
		window,
		minTrades,
		sort,
		order,
		limit,
		...range,
	};
}

/**
 * Compute two-sided Wilson score 95% confidence interval (`z = 1.96`) for hit rate.
 * @param {number} wins
 * @param {number} trades
 * @param {number} [z]
 * @returns {{ lower: number, upper: number }}
 */
function computeWilsonCI95(wins, trades, z = Z_95) {
	if (!Number.isFinite(trades) || trades <= 0) {
		return { lower: 0, upper: 0 };
	}

	const boundedWins = Math.max(0, Math.min(trades, wins));
	const p = boundedWins / trades;
	const z2 = z * z;
	const denom = 1 + (z2 / trades);
	const center = (p + (z2 / (2 * trades))) / denom;
	const margin = (z * Math.sqrt(((p * (1 - p)) / trades) + (z2 / (4 * trades * trades)))) / denom;

	return {
		lower: roundTo(Math.max(0, Math.min(1, center - margin)), 4),
		upper: roundTo(Math.max(0, Math.min(1, center + margin)), 4),
	};
}

/**
 * Compute normal-approximation 95% confidence interval for expectancy R
 * (`expectancyR ± 1.96 * sampleStdDevR / sqrt(n)`). Returns `expectancyRCI95: null` when n < 2.
 * @param {number[]} rValues
 * @param {number} [z]
 * @returns {{ expectancyR: number|null, expectancyRCI95: { lower: number, upper: number }|null, stdDevR: number|null, count: number }}
 */
function computeExpectancyNormalCI95(rValues, z = Z_95) {
	const finiteValues = Array.isArray(rValues)
		? rValues.filter((val) => typeof val === 'number' && Number.isFinite(val))
		: [];
	const count = finiteValues.length;

	if (count === 0) {
		return {
			expectancyR: null,
			expectancyRCI95: null,
			stdDevR: null,
			count: 0,
		};
	}

	const sum = finiteValues.reduce((acc, val) => acc + val, 0);
	const mean = sum / count;

	if (count < 2) {
		return {
			expectancyR: roundTo(mean, 4),
			expectancyRCI95: null,
			stdDevR: null,
			count,
		};
	}

	const sqDiffSum = finiteValues.reduce((acc, val) => {
		const diff = val - mean;
		return acc + (diff * diff);
	}, 0);
	const sampleVariance = sqDiffSum / (count - 1);
	const stdDevR = Math.sqrt(sampleVariance);
	const margin = z * (stdDevR / Math.sqrt(count));

	return {
		expectancyR: roundTo(mean, 4),
		expectancyRCI95: {
			lower: roundTo(mean - margin, 4),
			upper: roundTo(mean + margin, 4),
		},
		stdDevR,
		count,
	};
}

/**
 * Evaluate whether a cohort meets statistical reliability (`trades >= 30` and zero-excluding R CI).
 * @param {number} trades
 * @param {Object} rStats
 * @returns {{ isStatisticallyReliable: boolean, reliabilityNote: string }}
 */
function evaluateStatisticalReliability(trades, rStats) {
	const rCI = rStats.expectancyRCI95;
	if (trades < MIN_RELIABLE_TRADES) {
		return {
			isStatisticallyReliable: false,
			reliabilityNote: `n=${trades} < ${MIN_RELIABLE_TRADES} minimum reliable sample.`,
		};
	}

	if (rCI === null) {
		return {
			isStatisticallyReliable: false,
			reliabilityNote: `n=${trades} >= ${MIN_RELIABLE_TRADES}, but insufficient R-multiple data (rCount=${rStats.count}).`,
		};
	}

	if (rCI.lower > 0) {
		return {
			isStatisticallyReliable: true,
			reliabilityNote: `n=${trades} >= ${MIN_RELIABLE_TRADES}; normal 95% CI excludes zero (net-positive).`,
		};
	}

	if (rCI.upper < 0) {
		return {
			isStatisticallyReliable: true,
			reliabilityNote: `n=${trades} >= ${MIN_RELIABLE_TRADES}; normal 95% CI excludes zero (net-negative).`,
		};
	}

	return {
		isStatisticallyReliable: false,
		reliabilityNote: `n=${trades} >= ${MIN_RELIABLE_TRADES}, but normal 95% CI crosses zero (${rCI.lower} to ${rCI.upper}).`,
	};
}

function extractAxisValue(doc, axis) {
	if (!doc || typeof doc !== 'object') {
		return null;
	}

	switch (axis) {
	case 'setupType':
		return typeof doc.setupType === 'string' && doc.setupType.trim()
			? doc.setupType.trim()
			: null;
	case 'symbol':
		return typeof doc.symbol === 'string' && doc.symbol.trim()
			? doc.symbol.trim().toUpperCase()
			: null;
	case 'exchange':
		return typeof doc.exchange === 'string' && doc.exchange.trim()
			? doc.exchange.trim().toUpperCase()
			: null;
	case 'side': {
		const rawSide = typeof doc.side === 'string' ? doc.side.trim().toUpperCase() : '';
		return rawSide === 'BUY' || rawSide === 'SELL' ? rawSide : null;
	}
	case 'promptSource': {
		const provenance = (doc.promptProvenance && typeof doc.promptProvenance === 'object')
			? doc.promptProvenance
			: (doc.prompt_provenance && typeof doc.prompt_provenance === 'object' ? doc.prompt_provenance : null);
		return provenance && typeof provenance.source === 'string' && provenance.source.trim()
			? provenance.source.trim()
			: null;
	}
	default:
		return null;
	}
}

function buildCohortDescriptor(doc, axes) {
	const components = {};
	const keyParts = [];
	const internalKeyParts = [];

	for (const axis of axes) {
		const val = extractAxisValue(doc, axis);
		components[axis] = val;
		keyParts.push(val === null ? 'unknown' : String(val));
		internalKeyParts.push(val === null ? `${axis}=__NULL__` : `${axis}=V:${String(val)}`);
	}

	return {
		internalKey: internalKeyParts.join('|'),
		key: keyParts.join(':'),
		components,
	};
}

function classifyFirstHit(outcome) {
	if (outcome.firstHit === 'target') {
		return 'target';
	}
	if (outcome.firstHit === 'stop') {
		return 'stop';
	}
	if (outcome.firstHit !== 'stop' && outcome.targetHit === true && outcome.stopHit !== true) {
		return 'target';
	}
	if (outcome.firstHit !== 'target' && outcome.stopHit === true && outcome.targetHit !== true) {
		return 'stop';
	}
	return 'neither';
}

function classifyOutcomeResult(outcome, firstHit) {
	if (typeof outcome.return === 'number' && Number.isFinite(outcome.return)) {
		if (outcome.return > 0) return 'win';
		if (outcome.return < 0) return 'loss';
		return 'breakeven';
	}
	if (firstHit === 'target') return 'win';
	if (firstHit === 'stop') return 'loss';
	return 'breakeven';
}

function createCohortBucket(descriptor) {
	return {
		_internalKey: descriptor.internalKey,
		key: descriptor.key,
		components: descriptor.components,
		trades: 0,
		wins: 0,
		losses: 0,
		breakeven: 0,
		firstHitBreakdown: { target: 0, stop: 0, neither: 0 },
		rValues: [],
		returns: [],
		maes: [],
		mfes: [],
	};
}

function accumulateCohortTrade(bucket, outcome) {
	bucket.trades += 1;
	const firstHit = classifyFirstHit(outcome);
	bucket.firstHitBreakdown[firstHit] += 1;

	const classification = classifyOutcomeResult(outcome, firstHit);
	if (classification === 'win') bucket.wins += 1;
	else if (classification === 'loss') bucket.losses += 1;
	else bucket.breakeven += 1;

	if (typeof outcome.rMultiple === 'number' && Number.isFinite(outcome.rMultiple)) {
		bucket.rValues.push(outcome.rMultiple);
	}
	if (typeof outcome.return === 'number' && Number.isFinite(outcome.return)) {
		bucket.returns.push(outcome.return);
	}
	if (typeof outcome.maxAdverseExcursion === 'number' && Number.isFinite(outcome.maxAdverseExcursion)) {
		bucket.maes.push(outcome.maxAdverseExcursion);
	}
	if (typeof outcome.maxFavorableExcursion === 'number' && Number.isFinite(outcome.maxFavorableExcursion)) {
		bucket.mfes.push(outcome.maxFavorableExcursion);
	}
}

function computeMean(values) {
	if (!Array.isArray(values) || values.length === 0) {
		return null;
	}
	const sum = values.reduce((acc, val) => acc + val, 0);
	return roundTo(sum / values.length, 4);
}

function finalizeCohortBucket(bucket) {
	const hitRate = bucket.trades > 0 ? roundTo(bucket.wins / bucket.trades, 4) : 0;
	const hitRateCI95 = computeWilsonCI95(bucket.wins, bucket.trades);
	const rStats = computeExpectancyNormalCI95(bucket.rValues);
	const reliability = evaluateStatisticalReliability(bucket.trades, rStats);

	// Keep R-multiple confidence interval units pure; cohorts without >=2 R values remain null
	// and sort after finite R-CI cohorts (with Wilson lower bound as tie-breaker when all lack R-CI).
	const consistencyScore = rStats.expectancyRCI95 !== null
		? rStats.expectancyRCI95.lower
		: null;

	return {
		key: bucket.key,
		components: bucket.components,
		trades: bucket.trades,
		wins: bucket.wins,
		losses: bucket.losses,
		breakeven: bucket.breakeven,
		hitRate,
		hitRateCI95,
		expectancyR: rStats.expectancyR,
		expectancyRCI95: rStats.expectancyRCI95,
		averageMAEPercent: computeMean(bucket.maes),
		averageMFEPercent: computeMean(bucket.mfes),
		averageReturnPercent: computeMean(bucket.returns),
		firstHitBreakdown: { ...bucket.firstHitBreakdown },
		isStatisticallyReliable: reliability.isStatisticallyReliable,
		reliabilityNote: reliability.reliabilityNote,
		_consistencyScore: consistencyScore,
		_internalKey: bucket._internalKey,
	};
}

function getSortMetric(cohort, sort) {
	switch (sort) {
	case 'expectancy':
		return cohort.expectancyR;
	case 'hitRate':
		return cohort.hitRate;
	case 'sampleSize':
		return cohort.trades;
	case 'consistency':
		return cohort._consistencyScore;
	default:
		return cohort.expectancyR;
	}
}

function compareCohorts(a, b, sort, order) {
	const aVal = getSortMetric(a, sort);
	const bVal = getSortMetric(b, sort);
	const aFinite = typeof aVal === 'number' && Number.isFinite(aVal);
	const bFinite = typeof bVal === 'number' && Number.isFinite(bVal);

	// Always push missing metrics (e.g. null expectancyR or null consistency R-CI) after finite metrics.
	if (aFinite !== bFinite) {
		return aFinite ? -1 : 1;
	}

	if (aFinite && bFinite && aVal !== bVal) {
		return order === 'asc' ? aVal - bVal : bVal - aVal;
	}

	// When ranking by consistency and neither cohort has finite R-CI, order by Wilson lower bound.
	if (sort === 'consistency' && !aFinite && !bFinite && a.hitRateCI95.lower !== b.hitRateCI95.lower) {
		return order === 'asc'
			? a.hitRateCI95.lower - b.hitRateCI95.lower
			: b.hitRateCI95.lower - a.hitRateCI95.lower;
	}

	if (a.trades !== b.trades) {
		return b.trades - a.trades;
	}

	const keyOrder = a.key.localeCompare(b.key);
	if (keyOrder !== 0) {
		return keyOrder;
	}

	return String(a._internalKey || '').localeCompare(String(b._internalKey || ''));
}

function buildLeaderboardCacheKey(normalized) {
	return JSON.stringify({
		groupBy: normalized.groupBy,
		window: normalized.window,
		from: normalized.fromCacheKey,
		to: normalized.toCacheKey,
		minTrades: normalized.minTrades,
		sort: normalized.sort,
		order: normalized.order,
		limit: normalized.limit,
	});
}

/**
 * Clear all memoized leaderboard responses (e.g. on outcome write/evaluation or test reset).
 */
function clearLeaderboardCache() {
	leaderboardCache.clear();
}

/**
 * Return the current count of entries stored in the in-process leaderboard cache.
 * @returns {number}
 */
function getLeaderboardCacheSize() {
	return leaderboardCache.size;
}

/**
 * Compute ranked cohorts, unreliable cohorts, coverage metrics, and warnings from in-memory outcome docs.
 * @param {Object[]} docs
 * @param {Object} normalized
 * @param {string|null} [requestId]
 * @returns {Object}
 */
function buildOutcomesLeaderboardFromDocs(docs, normalized, requestId = null) {
	const cohortsMap = new Map();
	let docsWithEvaluatedWindow = 0;

	for (const doc of docs) {
		const outcome = doc && doc.outcomes ? doc.outcomes[normalized.window] : null;
		if (!outcome || outcome.status !== 'evaluated') {
			continue;
		}
		docsWithEvaluatedWindow += 1;

		const descriptor = buildCohortDescriptor(doc, normalized.groupBy);
		if (!cohortsMap.has(descriptor.internalKey)) {
			cohortsMap.set(descriptor.internalKey, createCohortBucket(descriptor));
		}
		accumulateCohortTrade(cohortsMap.get(descriptor.internalKey), outcome);
	}

	const eligible = [];
	const belowThreshold = [];

	for (const bucket of cohortsMap.values()) {
		if (bucket.trades >= normalized.minTrades) {
			eligible.push(finalizeCohortBucket(bucket));
		} else {
			belowThreshold.push(bucket);
		}
	}

	eligible.sort((a, b) => compareCohorts(a, b, normalized.sort, normalized.order));
	const ranked = eligible.slice(0, normalized.limit).map((cohort, idx) => {
		const { _consistencyScore, _internalKey, ...publicFields } = cohort;
		return {
			rank: idx + 1,
			...publicFields,
		};
	});

	belowThreshold.sort((a, b) => {
		if (b.trades !== a.trades) return b.trades - a.trades;
		const keyOrder = a.key.localeCompare(b.key);
		if (keyOrder !== 0) return keyOrder;
		return String(a._internalKey || '').localeCompare(String(b._internalKey || ''));
	});
	const unreliableCohorts = belowThreshold
		.slice(0, MAX_UNRELIABLE_COHORTS_RETURNED)
		.map((cohort) => ({
			key: cohort.key,
			components: cohort.components,
			trades: cohort.trades,
			reason: `below minTrades=${normalized.minTrades}`,
		}));

	const scannedDocs = docs.length;
	const docsWithoutEvaluatedWindow = Math.max(0, scannedDocs - docsWithEvaluatedWindow);
	const truncatedByScanLimit = scannedDocs >= MAX_LEADERBOARD_SCAN_DOCS;
	const warnings = [];

	if (truncatedByScanLimit) {
		warnings.push(
			`Scan reached ${MAX_LEADERBOARD_SCAN_DOCS}-document cap; leaderboard reflects a bounded sample of documents in range rather than the full date range.`,
		);
	}
	if (docsWithoutEvaluatedWindow > 0) {
		warnings.push(
			`${docsWithoutEvaluatedWindow} of ${scannedDocs} scanned signals lack an evaluated '${normalized.window}' outcome and were excluded from cohort metrics.`,
		);
	}
	if (belowThreshold.length > MAX_UNRELIABLE_COHORTS_RETURNED) {
		warnings.push(
			`Showing top ${MAX_UNRELIABLE_COHORTS_RETURNED} of ${belowThreshold.length} below-threshold cohorts.`,
		);
	}

	return {
		success: true,
		groupBy: [...normalized.groupBy],
		window: normalized.window,
		from: normalized.parsedFrom.toISOString(),
		to: normalized.parsedTo.toISOString(),
		minTradesApplied: normalized.minTrades,
		sort: normalized.sort,
		order: normalized.order,
		limit: normalized.limit,
		ranked,
		excludedBelowThreshold: belowThreshold.length,
		unreliableCohorts,
		coverage: {
			scannedDocs,
			docsWithEvaluatedWindow,
			docsWithoutEvaluatedWindow,
			totalCohorts: cohortsMap.size,
			unreliableCohortsCount: belowThreshold.length,
			maxScanDocs: MAX_LEADERBOARD_SCAN_DOCS,
			truncatedByScanLimit,
		},
		warnings,
		requestId: requestId || null,
	};
}

/**
 * Execute normalized leaderboard query with 60-second filter-keyed in-process memoization.
 * @param {Object} [options]
 * @param {Object} deps
 * @param {Function} deps.fetchDocs
 * @param {number} [deps.nowMs]
 * @param {number} [deps.cacheTtlMs]
 * @returns {Promise<Object>}
 */
async function queryOutcomesLeaderboard(options = {}, { fetchDocs, nowMs = Date.now(), cacheTtlMs = LEADERBOARD_CACHE_TTL_MS } = {}) {
	if (typeof fetchDocs !== 'function') {
		throw new Error('fetchDocs function is required');
	}

	const effectiveNowMs = Number.isFinite(options.nowMs) ? options.nowMs : nowMs;
	const normalized = normalizeLeaderboardOptions(options, effectiveNowMs);
	const cacheKey = buildLeaderboardCacheKey(normalized);
	const cachedEntry = cacheTtlMs > 0 ? leaderboardCache.get(cacheKey) : null;

	if (cachedEntry && cachedEntry.expiresAt > effectiveNowMs) {
		const cloned = structuredClone(cachedEntry.payload);
		cloned.requestId = options.requestId || null;
		return cloned;
	}

	const docs = await fetchDocs(normalized.parsedFrom, normalized.parsedTo, options.signal || null);
	const payload = buildOutcomesLeaderboardFromDocs(
		Array.isArray(docs) ? docs : [],
		normalized,
		options.requestId || null,
	);

	if (cacheTtlMs > 0) {
		for (const [key, entry] of leaderboardCache.entries()) {
			if (entry.expiresAt <= effectiveNowMs) {
				leaderboardCache.delete(key);
			}
		}
		if (leaderboardCache.size >= MAX_LEADERBOARD_CACHE_ENTRIES) {
			const oldestKey = leaderboardCache.keys().next().value;
			if (oldestKey !== undefined) {
				leaderboardCache.delete(oldestKey);
			}
		}
		const cachedPayload = structuredClone(payload);
		cachedPayload.requestId = null;
		leaderboardCache.set(cacheKey, {
			expiresAt: effectiveNowMs + cacheTtlMs,
			payload: cachedPayload,
		});
	}

	return payload;
}

module.exports = {
	LEADERBOARD_GROUP_BY_AXES,
	MAX_LEADERBOARD_GROUP_BY_AXES,
	LEADERBOARD_WINDOWS,
	DEFAULT_LEADERBOARD_WINDOW,
	DEFAULT_MIN_TRADES,
	MAX_MIN_TRADES,
	LEADERBOARD_SORTS,
	DEFAULT_LEADERBOARD_SORT,
	LEADERBOARD_ORDERS,
	DEFAULT_LEADERBOARD_ORDER,
	DEFAULT_LEADERBOARD_LIMIT,
	MAX_LEADERBOARD_LIMIT,
	DEFAULT_LEADERBOARD_LOOKBACK_DAYS,
	MAX_LEADERBOARD_LOOKBACK_DAYS,
	MAX_LEADERBOARD_SCAN_DOCS,
	MIN_RELIABLE_TRADES,
	Z_95,
	LEADERBOARD_CACHE_TTL_MS,
	normalizeLeaderboardGroupBy,
	normalizeLeaderboardWindow,
	normalizeLeaderboardOptions,
	computeWilsonCI95,
	computeExpectancyNormalCI95,
	evaluateStatisticalReliability,
	buildOutcomesLeaderboardFromDocs,
	queryOutcomesLeaderboard,
	clearLeaderboardCache,
	getLeaderboardCacheSize,
};
