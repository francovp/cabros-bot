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

// Placeholder for NotificationManager - will be injected
let notificationManager = null;

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
		this.notificationManager = getNotificationManager();
		// Per-symbol timeout
		this.timeout = parseInt(process.env.NEWS_TIMEOUT_MS || 30000);
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

		// Build analysis context for Gemini
		const analysisContext = this.buildAnalysisContext(symbol, marketContext);

		// Call Gemini for sentiment analysis
		console.debug('[Analyzer] Calling Gemini for symbol:', symbol);
		const geminiAnalysis = await analyzeNewsForSymbol(symbol, analysisContext);
		console.debug('[Analyzer] Gemini analysis result for', symbol, ':', {
			event_category: geminiAnalysis.event_category,
			confidence: geminiAnalysis.confidence,
			sentiment_score: geminiAnalysis.sentiment_score,
		});

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
		if (this.enrichmentService.isEnabled()) {
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
		const deliveryResults = await this.notificationManager.sendToAll(alert);
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
	 * @returns {Promise<Object>} MarketContext or null
	 */
	async fetchBinancePrice() {
		// Placeholder - would call Binance API
		// Reuse existing fetchPriceCryptoSymbol from src/controllers/commands/handlers/core/
		console.debug('[Analyzer] Binance price fetch not yet implemented');
		return null;
	}

	/**
	 * Fetch price via Gemini GoogleSearch
	 * @returns {Promise<Object>} MarketContext or null
	 */
	async fetchGeminiPrice() {
		// Placeholder - would call Gemini with price discovery prompt
		console.debug('[Analyzer] Gemini price fetch not yet implemented');
		return null;
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
- Source: ${marketContext.source}`;
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

		const formattedMessage = this.formatAlertMessage(symbol, geminiAnalysis, marketContext);

		return {
			symbol,
			eventCategory: geminiAnalysis.event_category,
			headline: geminiAnalysis.headline,
			sentimentScore: geminiAnalysis.sentiment_score,
			confidence: finalConfidence,
			sources: geminiAnalysis.sources,
			formattedMessage,
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
		let message = `*${symbol} Alert*\n\n`;
		message += `Event: ${analysis.headline}\n`;
		message += `Sentiment: ${this.sentimentLabel(analysis.sentiment_score)} (${analysis.sentiment_score.toFixed(2)})\n`;
		message += `Confidence: ${(analysis.confidence * 100).toFixed(0)}%\n`;

		if (marketContext) {
			message += `Price: $${marketContext.price} (${marketContext.change24h > 0 ? '+' : ''}${marketContext.change24h.toFixed(1)}%)\n`;
		}

		if (analysis.sources && analysis.sources.length > 0) {
			message += `Sources: ${analysis.sources.slice(0, 3).join(' | ')}\n`;
		}

		return message;
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
