'use strict';

const config = require('./config');
const genaiClient = require('./genaiClient');
const geminiQuotaManager = require('./geminiQuotaManager');
const { getPromptService, PromptKeys } = require('../prompts');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const {
	GROUNDING_MODEL_NAME,
} = config;

const DEFAULT_PRICE_FETCH_TIMEOUT_MS = 10000;

function isGeminiQuotaError(error) {
	return geminiQuotaManager.isQuotaError(error);
}

function isGeminiGroundingEnabled(options = {}) {
	if (config.ENABLE_NEWS_MONITOR_TEST_MODE || process.env.ENABLE_NEWS_MONITOR_TEST_MODE === 'true') {
		return true;
	}
	const isGrounding = (() => {
		try {
			return Boolean(getRuntimeConfig().ENABLE_GEMINI_GROUNDING);
		} catch {
			return process.env.ENABLE_GEMINI_GROUNDING === 'true';
		}
	})();

	if (options.requireGroundingFlag) {
		return isGrounding;
	}

	const isNewsMonitor = process.env.ENABLE_NEWS_MONITOR === 'true';
	return isGrounding || isNewsMonitor;
}

/**
 * Extracts JSON with price data from search text.
 * @param {string} text
 * @returns {object|null}
 */
function extractPriceJson(text) {
	if (!text || typeof text !== 'string') {
		return null;
	}

	const jsonPatterns = [
		/{[^{}]*"price"[^{}]*}/, // Look for object with "price" property first
		/{[\s\S]*}/, // Fallback to any JSON-like structure
	];

	for (const pattern of jsonPatterns) {
		const jsonMatch = text.match(pattern);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[0]);
				if (parsed && typeof parsed === 'object') {
					return parsed;
				}
			} catch {
				continue;
			}
		}
	}

	return null;
}

/**
 * Fetch price via Gemini GoogleSearch / grounding.
 * @param {string} symbol - Financial symbol (e.g. BTCUSDT, BTC/USDT, AAPL)
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Timeout in milliseconds
 * @param {object} [options.tokenUsage] - TokenUsageTracker instance
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @param {boolean} [options.rethrowQuotaErrors=false] - Whether to rethrow quota errors
 * @param {boolean} [options.requireGroundingFlag=false] - Whether to strictly require ENABLE_GEMINI_GROUNDING
 * @returns {Promise<{ price: number, change24h: number|null, source: string, timestamp: number, context: string, sources: string[] }|null>}
 */
async function fetchGeminiPrice(symbol, options = {}) {
	if (config.ENABLE_NEWS_MONITOR_TEST_MODE || process.env.ENABLE_NEWS_MONITOR_TEST_MODE === 'true') {
		console.debug(`[geminiPriceService] Test mode enabled - returning mock Gemini price for ${symbol}`);
		return {
			price: 123.45,
			change24h: 1.23,
			source: 'gemini-grounding-test-mode',
			timestamp: Date.now(),
			context: 'Mocked price data for testing purposes.',
			sources: ['https://example.com/mock-price'],
		};
	}

	if (!isGeminiGroundingEnabled(options)) {
		return null;
	}

	if (!symbol || typeof symbol !== 'string' || symbol.trim() === '' || symbol.toUpperCase() === 'UNKNOWN') {
		return null;
	}

	const cleanSymbol = symbol.trim();
	const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
		? options.timeoutMs
		: DEFAULT_PRICE_FETCH_TIMEOUT_MS;

	// Support legacy signature or tokenUsage passed as options.tokenUsage
	let tokenUsage = options.tokenUsage;
	if (options && typeof options.addUsage === 'function') {
		tokenUsage = options;
	}

	const controller = new AbortController();
	let onParentAbort = null;
	if (options.signal) {
		if (options.signal.aborted) {
			controller.abort(options.signal.reason);
		} else {
			onParentAbort = () => controller.abort(options.signal.reason);
			options.signal.addEventListener('abort', onParentAbort, { once: true });
		}
	}

	let timerId = null;
	if (timeoutMs > 0) {
		timerId = setTimeout(() => {
			controller.abort(new Error(`Gemini price fetch timeout (${timeoutMs}ms)`));
		}, timeoutMs);
	}

	const abortPromise = new Promise((_, reject) => {
		if (controller.signal.aborted) {
			reject(controller.signal.reason || new Error(`Gemini price fetch timeout (${timeoutMs}ms)`));
		} else {
			controller.signal.addEventListener('abort', () => {
				reject(controller.signal.reason || new Error(`Gemini price fetch timeout (${timeoutMs}ms)`));
			}, { once: true });
		}
	});

	try {
		const promptService = getPromptService();
		const promptPromise = promptService.getTextPrompt(
			PromptKeys.MARKET_PRICE_FETCH,
			{ symbol: cleanSymbol },
		);

		const { text: priceQuery } = await Promise.race([
			promptPromise,
			abortPromise,
		]);

		const priceSearchResult = await Promise.race([
			genaiClient.search({
				query: priceQuery,
				maxResults: 3,
				rethrowQuotaErrors: true,
				signal: controller.signal,
			}),
			abortPromise,
		]);

		if (tokenUsage && priceSearchResult && priceSearchResult.usage) {
			tokenUsage.addUsage(priceSearchResult.usage, GROUNDING_MODEL_NAME);
		}

		const parsedJson = extractPriceJson(priceSearchResult?.searchResultText);
		if (!parsedJson) {
			throw new Error('No valid JSON found in price search response');
		}

		const rawPrice = parsedJson.price;
		const parsedPrice = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice));
		if (!Number.isFinite(parsedPrice) || parsedPrice <= 0) {
			throw new Error(`Invalid parsed price: ${rawPrice}`);
		}

		let change24h = null;
		if (parsedJson.change_24h !== undefined && parsedJson.change_24h !== null) {
			const parsedChange = typeof parsedJson.change_24h === 'number'
				? parsedJson.change_24h
				: parseFloat(String(parsedJson.change_24h));
			if (Number.isFinite(parsedChange)) {
				change24h = parsedChange;
			}
		}

		console.debug(`[geminiPriceService] Grounded price fetched for ${cleanSymbol}: price=$${parsedPrice}, change24h=${change24h}%`);
		return {
			price: parsedPrice,
			change24h,
			source: 'gemini-grounding',
			timestamp: Date.now(),
			context: typeof parsedJson.context === 'string' ? parsedJson.context : '',
			sources: Array.isArray(parsedJson.sources) ? parsedJson.sources : [],
		};
	} catch (error) {
		if (options.rethrowQuotaErrors && isGeminiQuotaError(error)) {
			throw error;
		}
		console.warn(`[geminiPriceService] Gemini price fetch failed for ${cleanSymbol}: ${error.message}`);
		return null;
	} finally {
		if (timerId) clearTimeout(timerId);
		if (options.signal && onParentAbort) {
			options.signal.removeEventListener('abort', onParentAbort);
		}
	}
}

module.exports = {
	fetchGeminiPrice,
	extractPriceJson,
	isGeminiQuotaError,
	isGeminiGroundingEnabled,
	DEFAULT_PRICE_FETCH_TIMEOUT_MS,
};
