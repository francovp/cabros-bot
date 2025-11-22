/**
 * News Analyzer Orchestrator
 * Manages parallel symbol analysis with timeout handling
 * Integrates Gemini, Binance, and notification services
 * 003-news-monitor: User Stories 1-6
 */

const { analyzeNewsForSymbol } = require('../../../../services/grounding/gemini');
const { getCacheInstance } = require('./cache');
const { getEnrichmentService } = require('../../../../services/inference/enrichmentService');
const { AnalysisStatus, EventCategory } = require('./constants');
const { GROUNDING_MODEL_NAME, ENABLE_NEWS_MONITOR_TEST_MODE } = require('../../../../services/grounding/config');
const { MainClient } = require('binance');

// Placeholder for NotificationManager - will be injected
let notificationManager = null;

// Binance client singleton
let binanceClient = null;

function getBinanceClient() {
	if (!binanceClient) {
		binanceClient = new MainClient({
			beautifyResponses: true,
		});
	}
	return binanceClient;
}

function setNotificationManager(manager) {
	notificationManager = manager;
}

function getNotificationManager() {
	return notificationManager;
}

class NewsAnalyzer {
	constructor() {
		this.cache = getCacheInstance();
		this.enrichmentService = getEnrichmentService();
		// Do NOT store notificationManager in constructor - get it dynamically
		// to handle delayed initialization in tests and app startup
		// Per-symbol timeout
		this.timeout = parseInt(process.env.NEWS_TIMEOUT_MS || 60000);
		this.alertThreshold = parseFloat(process.env.NEWS_ALERT_THRESHOLD || 0.7);
		this.enableBinance = process.env.ENABLE_BINANCE_PRICE_CHECK === 'true';
	}

	/**
   * Analyze multiple symbols in parallel
   * Returns results even if some timeout or error
   * @param {string[]} symbols - Financial symbols to analyze
   * @param {string} requestId - Correlation ID for tracing
   * @returns {Promise<Object[]>} Array of AnalysisResult objects
   */
	async analyzeSymbols(symbols, requestId) {
		const analysisPromises = symbols.map(symbol =>
			this.analyzeSymbol(symbol, requestId).catch(error => ({
				symbol,
				status: AnalysisStatus.ERROR,
				error: {
					code: 'ANALYSIS_ERROR',
					message: error.message,
				},
				totalDurationMs: 0,
				cached: false,
				requestId,
			})),
		);

		// Use Promise.allSettled to continue even if some fail
		const results = await Promise.allSettled(analysisPromises);

		return results.map(result => {
			if (result.status === 'fulfilled') {
				return result.value;
			}
			// Should not happen due to catch above, but handle just in case
			return {
				status: AnalysisStatus.ERROR,
				error: {
					code: 'UNKNOWN_ERROR',
					message: (result.reason && result.reason.message) || 'Unknown error',
				},
				totalDurationMs: 0,
				cached: false,
				requestId,
			};
		});
	}

	/**
   * Analyze single symbol with timeout
   * Checks cache first, then runs full analysis if cache miss
   * @param {string} symbol - Financial symbol
   * @param {string} requestId - Correlation ID
   * @returns {Promise<Object>} AnalysisResult object
   */
	async analyzeSymbol(symbol, requestId) {
		const startTime = Date.now();
		const analysis = {
			symbol,
			status: AnalysisStatus.ANALYZED,
			totalDurationMs: 0,
			cached: false,
			requestId,
		};

		try {
			// Attempt to run analysis with timeout
			const result = await Promise.race([
				this.analyzeSymbolInternal(symbol, requestId),
				this.timeoutPromise(this.timeout),
			]);

			return {
				...analysis,
				...result,
				totalDurationMs: Date.now() - startTime,
			};
		} catch (error) {
			if (error.message === 'TIMEOUT') {
				console.warn('[Analyzer] Symbol analysis timeout:', symbol);
				return {
					...analysis,
					status: AnalysisStatus.TIMEOUT,
					error: {
						code: 'ANALYSIS_TIMEOUT',
						message: `Analysis exceeded ${this.timeout}ms budget`,
					},
					totalDurationMs: Date.now() - startTime,
				};
			}
			throw error;
		}
	}

	/**
   * Internal symbol analysis (with full flow)
   * @param {string} symbol - Financial symbol
   * @param {string} requestId - Correlation ID
   * @returns {Promise<Object>} Partial AnalysisResult (status, alert, etc.)
   */
	async analyzeSymbolInternal(symbol, requestId) {
		// Try cache first
		for (const category of Object.values(EventCategory)) {
			if (category === EventCategory.NONE) continue;

			const cached = this.cache.get(symbol, category);
			if (cached) {
				console.debug('[Analyzer] Returning cached result:', symbol, category);
				return {
					status: AnalysisStatus.CACHED,
					alert: cached.alert,
					deliveryResults: cached.deliveryResults,
					cached: true,
				};
			}
		}

		// Fetch market context (price, 24h change, etc.)
		const marketContext = await this.getMarketContext(symbol);
		console.debug('[Analyzer] Market context for', symbol, ':', marketContext);

		// Build analysis context for Gemini
		const analysisContext = this.buildAnalysisContext(symbol, marketContext);
		console.debug('[Analyzer] Analysis context for', symbol, ':', analysisContext);

		// Call Gemini for sentiment analysis
		console.debug('[Analyzer] Calling Gemini for symbol:', symbol);
		const geminiAnalysis = await analyzeNewsForSymbol(symbol, analysisContext);
		console.debug('[Analyzer] Gemini analysis result for', symbol, ':', geminiAnalysis);

		// If no event detected, cache and return
		if (geminiAnalysis.event_category === EventCategory.NONE) {
			console.debug('[Analyzer] No event detected for', symbol);
			this.cache.set(symbol, EventCategory.NONE, {
				alert: null,
				analysisResult: {
					symbol,
					status: AnalysisStatus.ANALYZED,
					cached: false,
					requestId,
				},
			});
			return {
				status: AnalysisStatus.ANALYZED,
				alert: null,
				cached: false,
			};
		}

		// Check confidence threshold
		console.debug('[Analyzer] Checking threshold for', symbol, '- confidence:', geminiAnalysis.confidence.toFixed(2), 'threshold:', this.alertThreshold);
		if (geminiAnalysis.confidence < this.alertThreshold) {
			console.info('[Analyzer] Confidence below threshold:', symbol, '- confidence:', geminiAnalysis.confidence.toFixed(2), '< threshold:', this.alertThreshold);
			this.cache.set(symbol, geminiAnalysis.event_category, {
				alert: null,
				analysisResult: {
					symbol,
					status: AnalysisStatus.ANALYZED,
					cached: false,
					requestId,
				},
			});
			return {
				status: AnalysisStatus.ANALYZED,
				alert: null,
				cached: false,
			};
		}

		// Optional LLM enrichment
		let enrichmentMetadata = null;
		if (this.enrichmentService.isEnabled() && ENABLE_NEWS_MONITOR_TEST_MODE !== true) {
			enrichmentMetadata = await this.enrichmentService.enrichAlert(geminiAnalysis);
			if (enrichmentMetadata && enrichmentMetadata.enriched_confidence < this.alertThreshold) {
				console.debug('[Analyzer] Enrichment lowered confidence below threshold');
				return {
					status: AnalysisStatus.ANALYZED,
					alert: null,
					cached: false,
				};
			}
		}

		// Build alert object
		const alert = this.buildAlert(symbol, geminiAnalysis, marketContext, enrichmentMetadata);
		console.info('[Analyzer] Alert built for', symbol, '- confidence:', alert.confidence.toFixed(2), 'event:', alert.eventCategory);

		// Send to all notification channels
		console.info('[Analyzer] Sending alert to notification channels for', symbol);
		const notificationMgr = getNotificationManager();
		console.debug('[Analyzer] Using NotificationManager:', notificationMgr);
		if (!notificationMgr) {
			console.warn('[Analyzer] NotificationManager not initialized - skipping alert delivery');
			return {
				status: AnalysisStatus.ANALYZED,
				alert,
				deliveryResults: [],
				cached: false,
			};
		}
		const deliveryResults = await notificationMgr.sendToAll(alert);
		console.info('[Analyzer] Alert delivery results for', symbol, ':', JSON.stringify(deliveryResults));

		// Cache the result
		this.cache.set(symbol, geminiAnalysis.event_category, {
			alert,
			analysisResult: {
				symbol,
				status: AnalysisStatus.ANALYZED,
				cached: false,
				requestId,
			},
			deliveryResults,
		});

		return {
			status: AnalysisStatus.ANALYZED,
			alert,
			deliveryResults,
			cached: false,
		};
	}

	/**
   * Get market context (price, 24h change) from Binance or Gemini
   * @param {string} symbol - Financial symbol
   * @returns {Promise<Object|null>} MarketContext or null if unavailable
   */
	async getMarketContext(symbol) {
		// Try Binance if enabled
		if (this.enableBinance) {
			try {
				const binanceContext = await this.fetchBinancePrice(symbol);
				if (binanceContext) return binanceContext;
			} catch (error) {
				console.debug('[Analyzer] Binance fetch failed, trying Gemini:', error.message);
			}
		}

		// Fall back to Gemini
		try {
			return await this.fetchGeminiPrice(symbol);
		} catch (error) {
			console.warn('[Analyzer] Price context fetch failed:', error.message);
			return null;
		}
	}

	/**
	 * Fetch price from Binance API (crypto only)
	 * @param {string} symbol - Crypto symbol (e.g., BTCUSDT)
	 * @returns {Promise<Object>} MarketContext or null
	 */
	async fetchBinancePrice(symbol) {
		try {
			// Wrapper with timeout (~5s)
			const timeoutMs = 5000;
			const timeoutPromise = new Promise((_, reject) =>
				setTimeout(() => reject(new Error('Binance fetch timeout')), timeoutMs)
			);

			const client = getBinanceClient();
			const pricePromise = client.getAvgPrice({ symbol });

			// Race between the fetch and timeout
			const data = await Promise.race([pricePromise, timeoutPromise]);

			console.debug(`[Analyzer] Binance price fetched for ${symbol}: $${data.price}`);
			return {
				price: parseFloat(data.price),
				change24h: null, // Binance getAvgPrice doesn't return 24h change, would need additional call
				source: 'binance',
				timestamp: Date.now(),
			};
		} catch (error) {
			console.debug(`[Analyzer] Binance fetch failed for ${symbol}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Fetch price via Gemini GoogleSearch
	 * Extracts numeric price data from grounded search snippets
	 * @param {string} symbol - Financial symbol
	 * @returns {Promise<Object>} MarketContext with parsed price/change or null
	 */
	async fetchGeminiPrice(symbol) {

		if (ENABLE_NEWS_MONITOR_TEST_MODE) {
			console.debug(`[Analyzer] Test mode enabled - returning mock Gemini price for ${symbol}`);
			return {
				price: 123.45,
				change24h: 1.23,
				source: 'gemini-grounding-test-mode',
				timestamp: Date.now(),
				context: 'Mocked price data for testing purposes.',
				sources: ['https://example.com/mock-price'],
			};
		}

		const genaiClient = require('../../../../services/grounding/genaiClient');
		let { price, change24h } = { price: null, change24h: null };

		try {
			// Timeout wrapper (~20s for Gemini)
			const timeoutMs = 30000;
			let timeoutHandle;
			const timeoutPromise = new Promise((_, reject) => {
				timeoutHandle = setTimeout(() => reject(new Error('Gemini fetch timeout')), timeoutMs);
			});

			// Use Gemini GoogleSearch to fetch current price
			const priceSearchPromise = genaiClient.search({
				query: `Get current price of ${symbol} today in USD and respond with ONLY valid JSON. Example format (respond with similar structure but with actual numbers):
{
  "price": 150.25,
  "change_24h": 2.5,
  "context": "detailed context about price and market",
  "sources": ["url1", "url2"]
}`,
				maxResults: 3,
			});

			const priceSearchResult = await Promise.race([priceSearchPromise, timeoutPromise]);
			clearTimeout(timeoutHandle);

			// Extract JSON from response - try to find valid JSON
			let priceSearchResultParsed = null;
			if (priceSearchResult.searchResultText) {
				// Try multiple patterns to extract JSON
				const jsonPatterns = [
					/{[^{}]*"price"[^{}]*}/,  // Look for object with "price" property first
					/{[\s\S]*}/,              // Fallback to any JSON-like structure
				];

				for (const pattern of jsonPatterns) {
					const jsonMatch = priceSearchResult.searchResultText.match(pattern);
					if (jsonMatch) {
						try {
							priceSearchResultParsed = JSON.parse(jsonMatch[0]);
							break;
						} catch (parseErr) {
							// Continue to next pattern if this one fails
							continue;
						}
					}
				}
			}

			if (!priceSearchResultParsed) {
				throw new Error('No valid JSON found in price search response');
			}
			price = parseFloat(priceSearchResultParsed.price);
			change24h = parseFloat(priceSearchResultParsed.change_24h);

			console.debug(`[Analyzer] Gemini GoogleSearch market context fetched for ${symbol}: price=$${price}, change24h=${change24h}%`);
			return {
				price,
				change24h,
				source: 'gemini-grounding',
				timestamp: Date.now(),
				context: priceSearchResultParsed.context || '',
				sources: priceSearchResultParsed.sources || [],
			};
		} catch (error) {
			console.warn(`[Analyzer] Gemini price fetch failed for ${symbol}: ${error.message}`);
			return null;
		}
	}

	/**
	 * Build analysis context for Gemini
	 * @param {string} symbol - Financial symbol
	 * @param {Object} marketContext - Optional market context
	 * @returns {string} Analysis context string
	 */
	buildAnalysisContext(symbol, marketContext) {
		let context = `Analyze recent news and market sentiment for ${symbol}.`;

		if (marketContext) {
			context += `\n\nCurrent Market Data:
- Price: $${marketContext.price}
- 24h Change: ${marketContext.change24h}%
- Context: ${marketContext.context || 'N/A'}`;
		}

		context += '\n\nDetect any significant market-moving events.';
		return context;
	}

	/**
   * Build NewsAlert from analysis result
   * @param {string} symbol - Financial symbol
   * @param {Object} geminiAnalysis - Gemini analysis result
   * @param {Object} marketContext - Optional market context
   * @param {Object} enrichmentMetadata - Optional enrichment metadata
   * @returns {Object} NewsAlert object
   */
	buildAlert(symbol, geminiAnalysis, marketContext, enrichmentMetadata) {
		// Use enriched confidence if available
		const finalConfidence = enrichmentMetadata
			? enrichmentMetadata.enriched_confidence
			: geminiAnalysis.confidence;

		// Build the title/original text
		const eventLabel = this.eventCategoryLabel(geminiAnalysis.event_category);
		const headline = (geminiAnalysis.headline && geminiAnalysis.headline.trim())
				? geminiAnalysis.headline 
				: `${eventLabel} event detected`;
		const alertTitle = `${symbol}: ${headline}`;

		// Build the context (includes sentiment, confidence, price context)
		const sentimentScore = geminiAnalysis.sentiment_score ?? 0;
		const confidense = (finalConfidence * 100).toFixed(0);

		let context = (geminiAnalysis.description && geminiAnalysis.description.trim())
			? `${geminiAnalysis.description}\n\n`
			: '';
		
		context += `*Sentiment:* ${this.sentimentLabel(sentimentScore)} (${sentimentScore.toFixed(2)})`;
		
		if (marketContext && marketContext.price) {
			const change = marketContext.change24h ?? 0;
			context += `\n*Price:* $${marketContext.price} (${change > 0 ? '+' : ''}${change.toFixed(1)}%)`;
		}

		// Build citations from sources
		const citations = [];
		if (geminiAnalysis.sources && Array.isArray(geminiAnalysis.sources)) {
			geminiAnalysis.sources.slice(0, 3).forEach(source => {
				if (typeof source === 'object' && source.title && source.url) {
					citations.push({
						title: source.title,
						url: source.url,
					});
				} else if (typeof source === 'string') {
					// Fallback for plain URLs
					citations.push({
						title: source,
						url: source,
					});
				}
			});
		}

		// Build enriched object for formatEnriched methods
		const enriched = {
			originalText: alertTitle,
			summary: context,
			citations,
			extraText: `_Model Confidence: ${confidense}%_\n_Model used: ${GROUNDING_MODEL_NAME}_`,
		};

		return {
			symbol,
			eventCategory: geminiAnalysis.event_category,
			headline: geminiAnalysis.headline,
			sentimentScore: geminiAnalysis.sentiment_score,
			confidence: finalConfidence,
			sources: geminiAnalysis.sources,
			text: alertTitle,
			enriched,
			timestamp: Date.now(),
			marketContext: marketContext || undefined,
			enrichmentMetadata: enrichmentMetadata || undefined,
		};
	}

	/**
   * Format alert message for notification channels
   * @param {string} symbol - Financial symbol
   * @param {Object} analysis - Analysis result
   * @param {Object} marketContext - Optional market context
   * @returns {string} Formatted message
   */
	formatAlertMessage(symbol, analysis, marketContext) {
		// Defensive checks for undefined properties
		if (!analysis) {
			return `*${symbol} Alert*\n\nNo analysis data available`;
		}

		let message = `*${symbol} Alert*\n\n`;
		
		// Use headline from analysis; provide sensible defaults if missing
		const eventLabel = this.eventCategoryLabel(analysis.event_category);
		const headline = (analysis.headline && analysis.headline.trim()) 
			? analysis.headline 
			: `${eventLabel} event detected`;
		message += `Event: ${headline}\n`;
		
		const sentimentScore = analysis.sentiment_score ?? 0;
		message += `Sentiment: ${this.sentimentLabel(sentimentScore)} (${sentimentScore.toFixed(2)})\n`;
		
		const confidence = analysis.confidence ?? 0;
		message += `Confidence: ${(confidence * 100).toFixed(0)}%\n`;

		if (marketContext && marketContext.price) {
			const change = marketContext.change24h ?? 0;
			message += `Price: $${marketContext.price} (${change > 0 ? '+' : ''}${change.toFixed(1)}%)\n`;
		}

		if (analysis.sources && Array.isArray(analysis.sources) && analysis.sources.length > 0) {
			const formattedSources = analysis.sources
				.slice(0, 3)
				.map(source => {
					// Handle both full SearchResult objects and plain URLs for backward compatibility
					if (typeof source === 'object' && source.title && source.url) {
						// Escape special chars in title for MarkdownV2
						const escapedTitle = (source.title || 'Source').replace(/[_*\[\]()~`>#+-=|{}.!]/g, '\\$&');
						return `[${escapedTitle}](${source.url})`;
					}
					// Fallback for plain URLs
					return source;
				})
				.join(' | ');
			message += `Sources: ${formattedSources}\n`;
		}

		return message;
	}

	/**
	 * Get event category label
	 * @param {string} category - Event category
	 * @returns {string} Label
	 */
	eventCategoryLabel(category) {
		const labels = {
			price_surge: 'Bullish',
			price_decline: 'Bearish',
			public_figure: 'Public figure mention',
			regulatory: 'Regulatory',
			none: 'Market',
		};
		return labels[category] || 'Market';
	}

	/**
   * Get sentiment label from score
   * @param {number} score - Sentiment score [-1, 1]
   * @returns {string} Label
   */
	sentimentLabel(score) {
		if (score > 0.5) return 'Bullish 🚀';
		if (score > 0) return 'Positive 📈';
		if (score < -0.5) return 'Bearish 📉';
		if (score < 0) return 'Negative 📉';
		return 'Neutral ➡️';
	}

	/**
   * Helper for timeout promise
   * @param {number} ms - Timeout milliseconds
   * @returns {Promise} Promise that rejects after timeout
   */
	timeoutPromise(ms) {
		return new Promise((_, reject) =>
			setTimeout(() => reject(new Error('TIMEOUT')), ms),
		);
	}
}

// Singleton instance
let instance = null;

function getAnalyzer() {
	if (!instance) {
		instance = new NewsAnalyzer();
	}
	return instance;
}

module.exports = {
	getAnalyzer,
	NewsAnalyzer,
	setNotificationManager,
};
