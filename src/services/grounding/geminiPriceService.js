'use strict';

const config = require('./config');
const genaiClient = require('./genaiClient');
const geminiQuotaManager = require('./geminiQuotaManager');
const { getPromptService, PromptKeys } = require('../prompts');

const {
	ENABLE_NEWS_MONITOR_TEST_MODE,
	GROUNDING_MODEL_NAME,
} = config;

const DEFAULT_PRICE_FETCH_TIMEOUT_MS = 10000;

function isGeminiQuotaError(error) {
	return geminiQuotaManager.isQuotaError(error);
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

	let timeoutHandle = null;

	try {
		const promptService = getPromptService();
		const timeoutPromise = new Promise((_, reject) => {
			timeoutHandle = setTimeout(() => reject(new Error(`Gemini price fetch timeout (${timeoutMs}ms)`)), timeoutMs);
		});

		const { text: priceQuery } = await promptService.getTextPrompt(
			PromptKeys.MARKET_PRICE_FETCH,
			{ symbol: cleanSymbol },
		);

		const priceSearchPromise = genaiClient.search({
			query: priceQuery,
			maxResults: 3,
			rethrowQuotaErrors: true,
			signal: options.signal,
		});

		const priceSearchResult = await Promise.race([priceSearchPromise, timeoutPromise]);
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = null;
		}

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
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
			timeoutHandle = null;
		}
		if (options.rethrowQuotaErrors && isGeminiQuotaError(error)) {
			throw error;
		}
		console.warn(`[geminiPriceService] Gemini price fetch failed for ${cleanSymbol}: ${error.message}`);
		return null;
	}
}

module.exports = {
	fetchGeminiPrice,
	extractPriceJson,
	isGeminiQuotaError,
	DEFAULT_PRICE_FETCH_TIMEOUT_MS,
};
