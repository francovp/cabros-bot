/**
 * Domain Quality and Freshness Classifier
 * Deterministic, conservative tier classification for grounding search sources.
 *
 * Used by calibrateNewsConfidence to derive actual source-quality and
 * source-freshness scores from the SearchResult[] returned by the grounded
 * search provider. Avoids hard-coded allow/deny lists in the first iteration;
 * tiers are transparent and explainable.
 */

const { SourceQualityTier } = require('./qualityTiers');

const DEFAULT_MAX_AGE_HOURS = 72;

function normalizeDomain(source) {
	if (!source) return null;
	if (typeof source === 'string') {
		try {
			return new URL(source).hostname.toLowerCase().replace(/^www\./, '');
		} catch (_) {
			return source.toLowerCase().replace(/^www\./, '');
		}
	}
	if (typeof source === 'object') {
		const candidate = source.sourceDomain || source.domain || (source.url ? (() => {
			try {
				return new URL(source.url).hostname;
			} catch (_) {
				return null;
			}
		})() : null);
		return candidate ? String(candidate).toLowerCase().replace(/^www\./, '') : null;
	}
	return null;
}

function getTierForDomain(domain) {
	if (!domain) return SourceQualityTier.UNKNOWN;
	const labels = require('./qualityTiers').DOMAIN_TIER_MAP;
	for (const tier of [SourceQualityTier.HIGH, SourceQualityTier.MEDIUM, SourceQualityTier.LOW]) {
		if (labels[tier] && labels[tier].has(domain)) {
			return tier;
		}
		const suffix = labels[tier] && labels[tier].SUFFIXES;
		if (suffix && suffix.some(s => domain.endsWith(s))) {
			return tier;
		}
	}
	return inferTierFromTld(domain);
}

function inferTierFromTld(domain) {
	const aggregatedSuffixes = require('./qualityTiers').LOW_TLD_SUFFIXES;
	if (aggregatedSuffixes && aggregatedSuffixes.some(s => domain.endsWith(s))) {
		return SourceQualityTier.LOW;
	}
	return SourceQualityTier.UNKNOWN;
}

function tierToScore(tier) {
	switch (tier) {
		case SourceQualityTier.HIGH: return 0.9;
		case SourceQualityTier.MEDIUM: return 0.65;
		case SourceQualityTier.LOW: return 0.3;
		case SourceQualityTier.UNKNOWN:
		default: return 0.5;
	}
}

function parseDate(value) {
	if (!value) return null;
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function deriveSourceAgeHours(source, now) {
	const candidates = [
		source && source.publishedAt,
		source && source.published_at,
		source && source.datePublished,
		source && source.date,
		source && source.metadata && source.metadata.date,
	];
	for (const candidate of candidates) {
		const parsed = parseDate(candidate);
		if (parsed) {
			const ageMs = now.getTime() - parsed.getTime();
			return ageMs / (1000 * 60 * 60);
		}
	}
	return null;
}

/**
 * Score source quality from a SearchResult or list of SearchResults.
 * Returns the average tier score across sources (0..1).
 *
 * @param {Array|Object|null} sources
 * @returns {{
 *   count: number,
 *   domains: string[],
 *   tierCounts: Record<string, number>,
 *   qualityScore: number,
 *   knownDomains: number,
 *   unknownDomains: number
 * }}
 */
function scoreQuality(sources) {
	const list = Array.isArray(sources) ? sources : (sources ? [sources] : []);
	const tierCounts = {
		[SourceQualityTier.HIGH]: 0,
		[SourceQualityTier.MEDIUM]: 0,
		[SourceQualityTier.LOW]: 0,
		[SourceQualityTier.UNKNOWN]: 0,
	};
	const domains = [];
	if (list.length === 0) {
		return {
			count: 0,
			domains,
			tierCounts,
			qualityScore: 0,
			knownDomains: 0,
			unknownDomains: 0,
		};
	}
	let scoreSum = 0;
	let knownDomains = 0;
	let unknownDomains = 0;
	for (const source of list) {
		const domain = normalizeDomain(source);
		if (!domain) {
			tierCounts[SourceQualityTier.UNKNOWN] += 1;
			unknownDomains += 1;
			continue;
		}
		domains.push(domain);
		const tier = getTierForDomain(domain);
		tierCounts[tier] = (tierCounts[tier] || 0) + 1;
		scoreSum += tierToScore(tier);
		if (tier === SourceQualityTier.UNKNOWN) {
			unknownDomains += 1;
		} else {
			knownDomains += 1;
		}
	}
	const qualityScore = list.length === 0 ? 0 : scoreSum / list.length;
	return {
		count: list.length,
		domains,
		tierCounts,
		qualityScore,
		knownDomains,
		unknownDomains,
	};
}

/**
 * Score source freshness from a SearchResult list.
 * Returns:
 *  - freshness: 0..1 score when dates are available
 *  - freshnessReason: explanation string for confidence_reason
 *  - hasExplicitDates: boolean, false when freshness is unknown
 *  - staleSources: number of sources older than maxAgeHours
 *
 * @param {Array<Object>|Object|null} sources
 * @param {Object} [options]
 * @param {Date} [options.now]
 * @param {number} [options.maxAgeHours]
 */
function scoreFreshness(sources, options = {}) {
	const now = options.now instanceof Date && !Number.isNaN(options.now.getTime())
		? options.now
		: new Date();
	const maxAgeHours = Number.isFinite(options.maxAgeHours) ? options.maxAgeHours : DEFAULT_MAX_AGE_HOURS;
	const list = Array.isArray(sources) ? sources : (sources ? [sources] : []);
	if (list.length === 0) {
		return {
			freshness: 0,
			freshnessReason: 'no grounding sources returned',
			hasExplicitDates: false,
			staleSources: 0,
			totalDated: 0,
		};
	}
	let datedCount = 0;
	let staleCount = 0;
	let scoreSum = 0;
	for (const source of list) {
		const ageHours = deriveSourceAgeHours(source, now);
		if (ageHours == null) continue;
		datedCount += 1;
		if (ageHours > maxAgeHours) {
			staleCount += 1;
			scoreSum += 0;
		} else {
			const bounded = Math.max(0, ageHours);
			const freshness = Math.max(0, Math.min(1, 1 - (bounded / maxAgeHours)));
			scoreSum += freshness;
		}
	}
	if (datedCount === 0) {
		return {
			freshness: 0,
			freshnessReason: 'unknown freshness (no dates on grounding sources)',
			hasExplicitDates: false,
			staleSources: 0,
			totalDated: 0,
		};
	}
	return {
		freshness: scoreSum / datedCount,
		freshnessReason: staleCount > 0 ? 'some sources are stale' : 'fresh',
		hasExplicitDates: true,
		staleSources: staleCount,
		totalDated: datedCount,
	};
}

module.exports = {
	normalizeDomain,
	getTierForDomain,
	tierToScore,
	scoreQuality,
	scoreFreshness,
	deriveSourceAgeHours,
	DEFAULT_MAX_AGE_HOURS,
};
