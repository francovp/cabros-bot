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

function filterScannerCandidates(items, scanType) {
	if (!Array.isArray(items)) {
		return [];
	}

	if (scanType === 'top_gainers') {
		return items.filter((item) => typeof item?.changePercent === 'number' && item.changePercent > 0);
	}

	if (scanType === 'top_losers') {
		return items
			.map((item) => {
				if (typeof item?.changePercent === 'number') {
					return { ...item, changePercent: -Math.abs(item.changePercent) };
				}
				return item;
			})
			.filter((item) => typeof item?.changePercent === 'number' && item.changePercent < 0);
	}

	return items;
}

async function enrichScannerItemsWithTrendConfluence(items, parsed, signal) {
	if (!Array.isArray(items) || items.length === 0) {
		return items;
	}

	const scanType = parsed?.scanType || parsed?.scan;
	const candidateItems = filterScannerCandidates(items, scanType);
	if (candidateItems.length === 0) {
		return [];
	}

	const enrichedItems = [];
	for (const item of candidateItems) {
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
	filterScannerCandidates,
	isAbortTriggered,
};

