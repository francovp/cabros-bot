/**
 * Conservative domain tiers for source quality calibration.
 *
 * Tier definitions:
 *   HIGH   — major, editorially-controlled outlets and primary regulators.
 *   MEDIUM — recognizable crypto/finance/news outlets not on the high tier.
 *   LOW    — aggregator-style or low-editorial-control TLDs (.blog, .buzz).
 *
 * The lists are explicitly conservative: prefer under-classification (unknown)
 * over false positives on the high tier.
 */

const SourceQualityTier = Object.freeze({
	HIGH: 'high',
	MEDIUM: 'medium',
	LOW: 'low',
	UNKNOWN: 'unknown',
});

const HIGH_TIER_DOMAINS = new Set([
	// Wire services / major financial press
	'reuters.com',
	'reuters.org',
	'ap.org',
	'apnews.com',
	'bloomberg.com',
	'bloomberg.co.jp',
	'cnbc.com',
	'ft.com',
	'wsj.com',
	'nytimes.com',
	'washingtonpost.com',
	'bbc.com',
	'bbc.co.uk',
	'economist.com',
	// Crypto-specific authoritative outlets
	'coindesk.com',
	'cointelegraph.com',
	'coingecko.com',
	'coinmarketcap.com',
	'theblock.co',
	// Regulators / primary filings
	'sec.gov',
	'cftc.gov',
	'federalreserve.gov',
	'ecb.europa.eu',
	'esma.europa.eu',
	'fca.org.uk',
	'finra.org',
	// Exchanges / operator disclosures
	'binance.com',
	'binance.us',
	'coinbase.com',
	'kraken.com',
	'okx.com',
]);

const MEDIUM_TIER_DOMAINS = new Set([
	'forbes.com',
	'cnn.com',
	'guardian.com',
	'theguardian.com',
	'foxbusiness.com',
	'investopedia.com',
	'marketwatch.com',
	'nasdaq.com',
	'decrypt.co',
	'cryptonews.com',
	'cryptoslate.com',
	'bitcoinmagazine.com',
	'beincrypto.com',
	'cryptopotato.com',
	'cryptopolitan.com',
	'forkast.news',
	'thestreet.com',
	'yahoo.com',
	'finance.yahoo.com',
	'reuters.com.br',
]);

const LOW_TIER_DOMAINS = new Set([
	'medium.com',
	'substack.com',
	'reddit.com',
	'twitter.com',
	'x.com',
]);

const LOW_TLD_SUFFIXES = [
	'.blog',
	'.buzz',
	'.click',
	'.info',
	'.xyz',
	'.top',
	'.loan',
	'.review',
	'.download',
];

const DOMAIN_TIER_MAP = {
	[SourceQualityTier.HIGH]: HIGH_TIER_DOMAINS,
	[SourceQualityTier.MEDIUM]: MEDIUM_TIER_DOMAINS,
	[SourceQualityTier.LOW]: LOW_TIER_DOMAINS,
};

module.exports = {
	SourceQualityTier,
	HIGH_TIER_DOMAINS,
	MEDIUM_TIER_DOMAINS,
	LOW_TIER_DOMAINS,
	LOW_TLD_SUFFIXES,
	DOMAIN_TIER_MAP,
};
