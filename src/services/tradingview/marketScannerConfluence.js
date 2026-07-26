'use strict';

const { tradingViewMcpService } = require('./TradingViewMcpService');

function parseScannerSymbol(value, defaultExchange) {
	if (typeof value !== 'string' || !value.trim()) {
		return null;
	}

	const raw = value.trim().toUpperCase();
	const separatorIndex = raw.indexOf(':');
	if (separatorIndex === -1) {
		return { exchange: defaultExchange, symbol: raw };
	}

	const exchange = raw.slice(0, separatorIndex).trim();
	const symbol = raw.slice(separatorIndex + 1).trim();
	if (!exchange || !symbol) {
		return null;
	}

	return { exchange, symbol };
}

function isAbortTriggered(signal, error) {
	return Boolean(
		(signal && signal.aborted)
		|| (error && error.name === 'AbortError')
		|| (error && error.name === 'AbortSignalError'),
	);
}

async function enrichScannerItemsWithTrendConfluence(items, parsed, signal) {
	if (!Array.isArray(items) || items.length === 0) {
		return items;
	}

	const enrichedItems = [];
	for (const item of items) {
		const parsedSymbol = parseScannerSymbol(item?.symbol, parsed.exchange);
		if (!parsedSymbol) {
			enrichedItems.push(item);
			continue;
		}

		try {
			const trendConfluence = await tradingViewMcpService.callMultiTimeframeAnalysis({
				symbol: parsedSymbol.symbol,
				exchange: parsedSymbol.exchange,
				signal,
			});
			enrichedItems.push(
				trendConfluence && typeof trendConfluence === 'object'
					? { ...item, trendConfluence }
					: item,
			);
		} catch (error) {
			if (isAbortTriggered(signal, error)) {
				throw error;
			}

			console.warn('[MarketScanner] Higher-timeframe enrichment failed:', parsedSymbol.symbol, error.message);
			enrichedItems.push(item);
		}
	}

	return enrichedItems;
}

module.exports = {
	enrichScannerItemsWithTrendConfluence,
	isAbortTriggered,
};
