'use strict';

const { tradingViewMcpService } = require('./TradingViewMcpService');

const DEFAULT_CONFLUENCE_CONCURRENCY = 4;

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

function createConcurrencyLimiter(limit) {
	let activeCount = 0;
	const queue = [];

	const next = () => {
		if (activeCount < limit && queue.length > 0) {
			activeCount += 1;
			const { fn, resolve, reject } = queue.shift();
			Promise.resolve()
				.then(fn)
				.then(
					(val) => {
						activeCount -= 1;
						resolve(val);
						next();
					},
					(err) => {
						activeCount -= 1;
						reject(err);
						next();
					},
				);
		}
	};

	const limiter = (fn) => new Promise((resolve, reject) => {
		queue.push({ fn, resolve, reject });
		next();
	});

	limiter.clear = (err) => {
		while (queue.length > 0) {
			const { reject } = queue.shift();
			reject(err);
		}
	};

	return limiter;
}

async function fetchTrendConfluence(parsedSymbol, signal) {
	if (signal && signal.aborted) {
		const abortError = signal.reason instanceof Error ? signal.reason : new Error('Market scanner aborted');
		abortError.name = 'AbortError';
		throw abortError;
	}

	try {
		const trendConfluence = await tradingViewMcpService.callMultiTimeframeAnalysis({
			symbol: parsedSymbol.symbol,
			exchange: parsedSymbol.exchange,
			signal,
		});
		return (trendConfluence && typeof trendConfluence === 'object') ? trendConfluence : null;
	} catch (error) {
		if (isAbortTriggered(signal, error)) {
			throw error;
		}

		console.warn('[MarketScanner] Higher-timeframe enrichment failed:', parsedSymbol.symbol, error.message);
		return null;
	}
}

async function enrichScannerItemsWithTrendConfluence(items, parsed = {}, signal, options = {}) {
	if (!Array.isArray(items) || items.length === 0) {
		return items;
	}

	if (signal && signal.aborted) {
		const abortError = signal.reason instanceof Error ? signal.reason : new Error('Market scanner aborted');
		abortError.name = 'AbortError';
		throw abortError;
	}

	const scanType = parsed?.scanType || parsed?.scan;
	const candidateItems = filterScannerCandidates(items, scanType);
	if (candidateItems.length === 0) {
		return [];
	}

	const concurrencyRaw = options.concurrency ?? parsed.concurrency ?? DEFAULT_CONFLUENCE_CONCURRENCY;
	const concurrency = Math.max(1, parseInt(concurrencyRaw, 10) || DEFAULT_CONFLUENCE_CONCURRENCY);
	const limiter = createConcurrencyLimiter(concurrency);
	const symbolCache = options.symbolCache ?? options.sharedCache ?? parsed.symbolCache ?? new Map();

	if (signal) {
		const onAbort = () => {
			const abortError = signal.reason instanceof Error ? signal.reason : new Error('Market scanner aborted');
			abortError.name = 'AbortError';
			limiter.clear(abortError);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	const promises = candidateItems.map(async (item) => {
		const parsedSymbol = parseScannerSymbol(item?.symbol, parsed.exchange);
		if (!parsedSymbol) {
			return item;
		}

		const cacheKey = `${parsedSymbol.exchange}:${parsedSymbol.symbol}`;
		let confluencePromise = symbolCache.get(cacheKey);
		if (!confluencePromise) {
			confluencePromise = limiter(() => fetchTrendConfluence(parsedSymbol, signal));
			symbolCache.set(cacheKey, confluencePromise);
		}

		const trendConfluence = await confluencePromise;
		return (trendConfluence && typeof trendConfluence === 'object')
			? { ...item, trendConfluence }
			: item;
	});

	const settledResults = await Promise.allSettled(promises);

	let firstAbortError = null;
	for (const result of settledResults) {
		if (result.status === 'rejected') {
			if (isAbortTriggered(signal, result.reason)) {
				firstAbortError = firstAbortError || result.reason;
			} else {
				throw result.reason;
			}
		}
	}

	if (firstAbortError || (signal && signal.aborted)) {
		const abortError = firstAbortError
			|| (signal.reason instanceof Error ? signal.reason : new Error('Market scanner aborted'));
		if (!abortError.name || abortError.name === 'Error') {
			abortError.name = 'AbortError';
		}
		throw abortError;
	}

	return settledResults.map((r) => r.value);
}

module.exports = {
	DEFAULT_CONFLUENCE_CONCURRENCY,
	createConcurrencyLimiter,
	enrichScannerItemsWithTrendConfluence,
	filterScannerCandidates,
	isAbortTriggered,
	parseScannerSymbol,
};

