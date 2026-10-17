'use strict';

const ENTRY_PRICE_PROVIDERS = Object.freeze(['mcp', 'binance', 'twelve-data', 'gemini']);
const DEFAULT_CRYPTO_ENTRY_PRICE_SOURCES = Object.freeze(['mcp', 'binance', 'gemini']);
const DEFAULT_EQUITY_ENTRY_PRICE_SOURCES = Object.freeze(['twelve-data']);

function parseEntryPriceSources(value) {
	if (value === undefined || value === null || String(value).trim() === '') {
		return null;
	}

	const sources = String(value)
		.split(',')
		.map((source) => source.trim().toLowerCase())
		.filter(Boolean);
	const invalid = sources.filter((source) => !ENTRY_PRICE_PROVIDERS.includes(source));
	if (sources.length === 0 || invalid.length > 0) {
		throw new Error(`Unknown signal outcome entry-price provider(s): ${invalid.join(', ') || 'empty list'}`);
	}

	return [...new Set(sources)];
}

function getEntryPriceSourceChains(value) {
	const configured = parseEntryPriceSources(value);
	return {
		configured: configured !== null,
		crypto: configured || [...DEFAULT_CRYPTO_ENTRY_PRICE_SOURCES],
		equity: configured || [...DEFAULT_EQUITY_ENTRY_PRICE_SOURCES],
	};
}

module.exports = {
	ENTRY_PRICE_PROVIDERS,
	DEFAULT_CRYPTO_ENTRY_PRICE_SOURCES,
	DEFAULT_EQUITY_ENTRY_PRICE_SOURCES,
	parseEntryPriceSources,
	getEntryPriceSourceChains,
};
