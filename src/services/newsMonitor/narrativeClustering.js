'use strict';

/**
 * Narrative clustering for news-monitor alerts.
 *
 * Collapses multi-article, multi-symbol bursts about the same underlying
 * story into a single "story" alert. The clustering pass is opt-in
 * (`ENABLE_NEWS_NARRATIVE_CLUSTERING=true`) and always fails open: any
 * internal error returns the original alerts as one cluster per article
 * so the existing per-symbol dedup flow is unchanged.
 *
 * The clustering key is a deterministic hash of the normalized headline
 * (so the same story across two requests receives the same cluster id)
 * and the cluster window is bounded by `DEFAULT_CLUSTER_WINDOW_MS` (10
 * minutes) so out-of-window stories split into independent clusters.
 */

const { createHash } = require('node:crypto');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_CLUSTER_WINDOW_MS = 10 * 60 * 1000;
const MIN_CLUSTER_WINDOW_MS = 60 * 1000;
const MAX_CLUSTER_WINDOW_MS = 60 * 60 * 1000;
const SHINGLE_SIZE = 2;
const MIN_SHINGLE_OVERLAP = 0.6;
const MIN_TICKER_OVERLAP = 1;

// Static regulator/authority entity set used as a fall-back when Gemini
// does not return structured entities. Keep the list short and
// US-centric; non-US regulators surface as organizations instead.
const REGULATOR_TOKENS = Object.freeze([
	'SEC', 'CFTC', 'FCA', 'FINRA', 'ESMA', 'MAS', 'FSA', 'BaFin', 'SFC', 'ASIC',
]);

// Cached / replaceable `extractEntities` so tests can inject failures.
let _extractEntitiesImpl = defaultExtractEntities;

function defaultExtractEntities(text) {
	if (typeof text !== 'string' || text.trim() === '') {
		return { tickers: [], organizations: [], regulators: [] };
	}

	const cleaned = text.replace(/\s+/g, ' ').trim();
	const tickers = new Set();
	const organizations = new Set();
	const regulators = new Set();

	// Explicit crypto-style tickers: AAAA, AAAAUSDT, AAAA.USDT, AAAA/BUSD, AAAA-BUSD.
	const tickerRe = /\b[A-Z]{2,10}(?:\.USDT|\.BUSD|\.USDC|\.BTC|\/USDT|\/BUSD|\/USDC|-USDT|-BUSD|-USDC|USDT|BUSD|USDC|BTC)\b/gi;
	let match;
	while ((match = tickerRe.exec(cleaned)) !== null) {
		tickers.add(match[0].toUpperCase());
	}

	// Uppercase bare tickers (e.g. AAPL, NVDA, TSLA) of length 2-5 in ALL-CAPS form.
	const bareTickerRe = /\b[A-Z]{2,5}\b/g;
	while ((match = bareTickerRe.exec(cleaned)) !== null) {
		const word = match[0];
		if (word === word.toUpperCase() && !REGULATOR_TOKENS.includes(word)) {
			tickers.add(word);
		}
	}

	// Regulator matchers (case-insensitive).
	const upper = cleaned.toUpperCase();
	for (const token of REGULATOR_TOKENS) {
		const tokenRe = new RegExp(`\\b${token}\\b`, 'i');
		if (tokenRe.test(upper)) {
			regulators.add(token);
		}
	}

	// Capitalized words: capture named organizations and projects like
	// Binance, Coinbase, Tether, BlackRock. Filter out common English words.
	const stopWords = new Set([
		'The', 'And', 'For', 'With', 'From', 'This', 'That', 'After', 'Before',
		'Today', 'Yesterday', 'New', 'Old', 'First', 'Last', 'Over', 'Under',
		'After', 'Before', 'Says', 'Told', 'Has', 'Have', 'Had', 'Will', 'Would',
		'Could', 'Should', 'Into', 'Out', 'Via', 'Per', 'Why', 'How', 'What',
		'When', 'Where', 'Which', 'Who', 'Whose',
	]);
	const orgRe = /\b[A-Z][a-zA-Z]{2,}\b/g;
	while ((match = orgRe.exec(cleaned)) !== null) {
		const word = match[0];
		if (stopWords.has(word)) continue;
		if (REGULATOR_TOKENS.includes(word.toUpperCase())) continue;
		organizations.add(word);
	}

	return {
		tickers: Array.from(tickers),
		organizations: Array.from(organizations),
		regulators: Array.from(regulators),
	};
}

function extractEntities(text) {
	try {
		return _extractEntitiesImpl(text);
	} catch (_error) {
		return { tickers: [], organizations: [], regulators: [] };
	}
}

function __setExtractEntitiesForTest(impl) {
	_extractEntitiesImpl = typeof impl === 'function' ? impl : defaultExtractEntities;
}

function tokenize(text) {
	if (typeof text !== 'string') return [];
	const lower = text.toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
	if (lower === '') return [];
	return lower.split(' ');
}

function buildShingles(tokens, size = SHINGLE_SIZE) {
	if (!Array.isArray(tokens) || tokens.length < size) {
		return [];
	}
	const shingles = new Set();
	for (let i = 0; i <= tokens.length - size; i += 1) {
		shingles.add(tokens.slice(i, i + size).join(' '));
	}
	return Array.from(shingles);
}

function jaccard(a, b) {
	if (!a || !b || a.length === 0 || b.length === 0) return 0;
	const setA = new Set(a);
	const setB = new Set(b);
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection += 1;
	}
	const union = setA.size + setB.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

function computeShingleOverlap(a, b) {
	const tokensA = tokenize(a);
	const tokensB = tokenize(b);
	if (tokensA.length === 0 || tokensB.length === 0) return 0;
	const shinglesA = buildShingles(tokensA);
	const shinglesB = buildShingles(tokensB);
	if (shinglesA.length === 0 || shinglesB.length === 0) return 0;
	return jaccard(shinglesA, shinglesB);
}

function tickerOverlap(a, b) {
	if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) {
		return 0;
	}
	const setA = new Set(a.map((t) => String(t).toUpperCase()));
	let count = 0;
	for (const ticker of b) {
		if (setA.has(String(ticker).toUpperCase())) count += 1;
	}
	return count;
}

function normalizeHeadline(headline) {
	if (typeof headline !== 'string') return '';
	return headline
		.replace(/[^\p{L}\p{N}\s]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}

function buildClusterKey(alert = {}) {
	const headline = typeof alert.headline === 'string' ? alert.headline.trim() : '';
	if (!headline) return null;
	return createHash('sha256').update(normalizeHeadline(headline)).digest('hex');
}

function resolveClusterWindowMs() {
	const configured = getRuntimeConfig().NEWS_NARRATIVE_CLUSTER_WINDOW_MS;
	if (!Number.isFinite(configured)) return DEFAULT_CLUSTER_WINDOW_MS;
	return Math.min(Math.max(configured, MIN_CLUSTER_WINDOW_MS), MAX_CLUSTER_WINDOW_MS);
}

function pickPrimary(alerts) {
	return alerts.reduce((best, current) => {
		if (!best) return current;
		const bestScore = (Number(best.confidence) || 0) + (Number(best.sentimentScore) || 0) * 0.1;
		const currentScore = (Number(current.confidence) || 0) + (Number(current.sentimentScore) || 0) * 0.1;
		return currentScore > bestScore ? current : best;
	}, null);
}

function shouldCluster(alerts, now, windowMs) {
	if (alerts.length < 2) return false;
	const first = alerts[0];
	const last = alerts[alerts.length - 1];
	const withinWindow = (now - Number(first.timestamp || now)) <= windowMs
		&& (now - Number(last.timestamp || now)) <= windowMs;
	return withinWindow;
}

function sameStory(a, b) {
	const entitiesA = extractEntities(a.headline);
	const entitiesB = extractEntities(b.headline);
	const tickersShared = tickerOverlap(entitiesA.tickers, entitiesB.tickers);
	const regulatorsShared = tickerOverlap(entitiesA.regulators, entitiesB.regulators);
	const organizationsShared = tickerOverlap(entitiesA.organizations, entitiesB.organizations);
	const overlap = computeShingleOverlap(a.headline, b.headline);
	const matches = [
		tickersShared >= MIN_TICKER_OVERLAP,
		regulatorsShared >= 1,
		organizationsShared >= 1,
		overlap >= MIN_SHINGLE_OVERLAP,
	];
	const matchCount = matches.filter(Boolean).length;
	return matchCount >= 2;
}

function clusterAlerts(alerts, options = {}) {
	if (!Array.isArray(alerts) || alerts.length === 0) return [];
	const now = Number.isFinite(options.now) ? options.now : Date.now();
	const windowMs = resolveClusterWindowMs();

	try {
		// Filter alerts that are eligible for clustering (have a cluster key + timestamp).
		const eligible = alerts
			.filter((alert) => alert && typeof alert === 'object')
			.map((alert) => ({
				...alert,
				__clusterKey: buildClusterKey(alert),
			}))
			.filter((alert) => alert.__clusterKey && Number.isFinite(Number(alert.timestamp)));

		if (eligible.length === 0) return [];

		// Sort by timestamp so the window comparison is straightforward.
		eligible.sort((a, b) => Number(a.timestamp) - Number(b.timestamp));

		// Group alerts by cluster key.
		const groupsByKey = new Map();
		for (const alert of eligible) {
			const list = groupsByKey.get(alert.__clusterKey) || [];
			list.push(alert);
			groupsByKey.set(alert.__clusterKey, list);
		}

		const clusters = [];
		for (const [, group] of groupsByKey.entries()) {
			if (group.length === 0) continue;
			if (!shouldCluster(group, now, windowMs)) {
				// Out of window: emit each alert as its own single-article cluster.
				for (const alert of group) {
					clusters.push(buildClusterFromAlerts([alert]));
				}
				continue;
			}

			// Bucket the group into stories by entity/shingle overlap (within the same headline).
			const stories = [];
			for (const alert of group) {
				let placed = false;
				for (const story of stories) {
					if (sameStory(story[0], alert)) {
						story.push(alert);
						placed = true;
						break;
					}
				}
				if (!placed) {
					stories.push([alert]);
				}
			}

			for (const story of stories) {
				clusters.push(buildClusterFromAlerts(story));
			}
		}

		return clusters;
	} catch (_error) {
		// Fail open: emit one cluster per alert so the existing flow is unchanged.
		return alerts
			.filter((alert) => alert && typeof alert === 'object')
			.map((alert) => buildClusterFromAlerts([alert]));
	}
}

function buildClusterFromAlerts(alerts) {
	const primary = pickPrimary(alerts) || alerts[0];
	const symbols = Array.from(new Set(
		alerts
			.map((alert) => (typeof alert.symbol === 'string' ? alert.symbol : null))
			.filter(Boolean),
	));
	const deliveryChannels = new Set();
	for (const alert of alerts) {
		if (Array.isArray(alert.deliveryResults)) {
			for (const result of alert.deliveryResults) {
				if (result && result.channel) deliveryChannels.add(result.channel);
			}
		}
	}
	const firstSeenAt = alerts.reduce((min, alert) => {
		const ts = Number(alert.timestamp);
		if (!Number.isFinite(ts)) return min;
		return min === null || ts < min ? ts : min;
	}, null);
	return {
		id: primary && primary.__clusterKey ? primary.__clusterKey : null,
		headline: primary && typeof primary.headline === 'string' ? primary.headline : null,
		articleCount: alerts.length,
		primarySymbols: symbols,
		symbols,
		deliveryChannels: Array.from(deliveryChannels),
		firstSeenAt,
		alerts,
		primary,
	};
}

function summarizeClusters(clusters = []) {
	if (!Array.isArray(clusters) || clusters.length === 0) {
		return { clusterCount: 0, articleCount: 0, collapsedCount: 0 };
	}
	const articleCount = clusters.reduce((sum, cluster) => sum + (cluster.articleCount || 0), 0);
	return {
		clusterCount: clusters.length,
		articleCount,
		collapsedCount: Math.max(0, articleCount - clusters.length),
	};
}

function isEnabled() {
	return getRuntimeConfig().ENABLE_NEWS_NARRATIVE_CLUSTERING === true;
}

module.exports = {
	DEFAULT_CLUSTER_WINDOW_MS,
	MIN_CLUSTER_WINDOW_MS,
	MAX_CLUSTER_WINDOW_MS,
	extractEntities,
	computeShingleOverlap,
	buildClusterKey,
	clusterAlerts,
	summarizeClusters,
	isEnabled,
	__setExtractEntitiesForTest,
};
