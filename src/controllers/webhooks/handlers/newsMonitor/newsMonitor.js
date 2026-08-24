/**
 * News Monitor Webhook Handler
 * Main HTTP endpoint for /api/news-monitor
 * Handles POST and GET requests
 * 003-news-monitor: User Story 1 (endpoint & analysis), User Story 2 (alert delivery)
 */

const { v4: uuidv4 } = require('uuid');
const { getAnalyzer, setNotificationManager } = require('./analyzer');
const { getCacheInstance } = require('./cache');
const { AnalysisStatus } = require('./constants');
const { getNotificationManager } = require('../alert/alert');
const sentryService = require('../../../../services/monitoring/SentryService');
const { TokenUsageTracker } = require('../../../../lib/tokenUsage');
const {
	NotificationRoutingValidationError,
	parseNotificationRouting,
	validateNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
} = require('../../../../services/notification/requestRouting');
const alertStorageService = require('../../../../services/storage/AlertStorageService');

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

class NewsMonitorHandler {
	constructor() {
		this.analyzer = getAnalyzer();
		this.cache = getCacheInstance();
		this.maxSymbols = 100;
	}

	/**
   * Initialize the news monitor (called on app startup)
   */
	initialize() {
		this.cache.initialize();
		console.debug('[NewsMonitor] Handler initialized');
	}

	/**
   * Handle incoming request (POST or GET)
   * @param {Express.Request} req - HTTP request
   * @param {Express.Response} res - HTTP response
   * @returns {void}
   */
	async handleRequest(req, res) {
		const requestId = uuidv4();
		const startTime = Date.now();
		const tokenUsage = new TokenUsageTracker();

		try {
			const requestSpan = sentryService.getActiveSpan();
			const dryRun = resolveDryRun(req);

			// Inject notification manager into analyzer (set once before analysis)
			const notificationManager = getNotificationManager();
			if (notificationManager) {
				setNotificationManager(notificationManager);
			}

			// Check feature flag
			if (process.env.ENABLE_NEWS_MONITOR !== 'true') {
				return res.status(403).json({
					error: 'News monitor feature is disabled. Set ENABLE_NEWS_MONITOR=true to enable.',
					code: 'FEATURE_DISABLED',
					requestId,
				});
			}

			// Parse request
			const routing = req.method === 'GET'
				? parseNotificationRouting(req.query, { allowQueryChannels: true })
				: parseNotificationRouting(req.body);
			validateNotificationRouting(notificationManager, routing);
			const { crypto, stocks } = this.parseRequest(req);
			const allSymbols = [...(crypto || []), ...(stocks || [])];
			const useDefaultSymbols = allSymbols.length === 0;
			const symbolsToAnalyze = useDefaultSymbols
				? this.getDefaultSymbols()
				: allSymbols;
			const validationError = this.validateRequest(symbolsToAnalyze);
			if (validationError) {
				return res.status(400).json({
					error: validationError,
					code: 'INVALID_REQUEST',
					requestId,
				});
			}

			const assetClassBySymbol = this.getAssetClassBySymbol(crypto, stocks, useDefaultSymbols);

			console.info('[NewsMonitor] Analyzing symbols:', symbolsToAnalyze);
			if (symbolsToAnalyze.length === 0) {
				return res.status(400).json({
					error: 'No symbols to analyze. Provide crypto/stocks or set env defaults.',
					code: 'NO_SYMBOLS',
					requestId,
				});
			}

			const analysisSpan = sentryService.startInactiveSpan({
				name: 'news_monitor.analyze_symbols',
				op: 'news.analysis',
				onlyIfParent: true,
				parentSpan: requestSpan,
				attributes: {
					'news.symbol_count': symbolsToAnalyze.length,
					'news.request_id': requestId,
				},
			});

			let results;
			let summary;
			try {
				results = await sentryService.withActiveSpan(
					analysisSpan,
					() => this.analyzer.analyzeSymbols(symbolsToAnalyze, requestId, tokenUsage, routing, {
						dryRun,
						assetClassBySymbol,
					}),
				);
				summary = this.generateSummary(results);
				if (analysisSpan && typeof analysisSpan.setAttribute === 'function') {
					analysisSpan.setAttribute('news.quota_exhausted', summary.quota_exhausted);
					analysisSpan.setAttribute('news.error_count', summary.error);
				}
			} finally {
				sentryService.endSpan(analysisSpan);
			}

			const notificationManagerForResponse = getNotificationManager();
			const response = {
				success: summary.analyzed > 0 || summary.cached > 0,
				partial_success: summary.timeout > 0 || summary.error > 0,
				results,
				summary,
				requestedChannels: getRequestedChannels(notificationManagerForResponse, routing),
				deliveredChannels: getDeliveredChannels(results.flatMap((result) => result.deliveryResults || [])),
				totalDurationMs: Date.now() - startTime,
				requestId,
				tokenUsage: tokenUsage.toJSON(),
			};

			if (dryRun) {
				response.dryRun = true;
			}

			if (!response.partial_success) {
				delete response.partial_success;
			}

			console.info('[NewsMonitor] Request complete', {
				requestId,
				totalMs: response.totalDurationMs,
				summary,
			});

			res.status(200).json(response);

			// Fire-and-forget: persist delivered alerts to Firestore after responding to the caller.
			// Failures are caught and logged — delivery is never blocked by storage.
			if (!dryRun && alertStorageService.isEnabled()) {
				const requestedChannels = response.requestedChannels || [];
				for (const result of results || []) {
					const isDeliveredAnalyzed = result && result.alert && result.status === AnalysisStatus.ANALYZED;
					const isDeliveredCached = result && result.alert && result.status === AnalysisStatus.CACHED && result.redelivered;
					if (isDeliveredAnalyzed || isDeliveredCached) {
						alertStorageService.saveAlert({
							text: result.alert.text || '',
							symbol: result.alert.symbol || result.symbol,
							exchange: result.alert.marketContext && result.alert.marketContext.source === 'binance' ? 'BINANCE' : undefined,
							enriched: Boolean(result.alert.enriched),
							enrichmentData: result.alert.enriched || null,
							tokenUsage: (result.alert.enriched && result.alert.enriched.tokenUsage) || null,
							channels: requestedChannels,
							deliveryResults: result.deliveryResults || [],
							source: 'news-monitor',
							eventCategory: result.alert.eventCategory,
							confidence: result.alert.confidence,
							sentimentScore: result.alert.sentimentScore,
							dedupStatus: result.cached ? 'cached' : 'fresh',
							processingTimeMs: result.totalDurationMs,
						}).catch((err) => {
							console.warn('[NewsMonitor] Failed to persist alert to storage:', err.message);
						});
					}
				}
			}

			return;
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(400).json({
					error: error.message,
					code: 'INVALID_REQUEST',
					requestId,
				});
			}

			console.error('[NewsMonitor] Unexpected error:', error);

			// Capture runtime error to Sentry (T013) - only for 500 errors
			sentryService.captureRuntimeError({
				channel: 'news-monitor',
				error,
				http: {
					endpoint: '/api/news-monitor',
					method: req.method,
					statusCode: 500,
					requestId,
					featureFlagState: {
						ENABLE_NEWS_MONITOR: process.env.ENABLE_NEWS_MONITOR === 'true',
					},
				},
			});

			return res.status(500).json({
				error: 'Internal server error. Please try again later.',
				code: 'INTERNAL_ERROR',
				requestId,
			});
		}
	}

	/**
   * Parse request (POST body or GET query params)
   * @param {Express.Request} req - HTTP request
   * @returns {Object} Parsed crypto and stocks arrays
   */
	parseRequest(req) {
		if (req.method === 'GET') {
			return this.parseGetRequest(req);
		}
		return this.parsePostRequest(req);
	}

	/**
   * Parse POST request body
   * @param {Express.Request} req - HTTP request
   * @returns {Object} Parsed crypto and stocks arrays
   */
	parsePostRequest(req) {
		const body = req.body || {};
		const crypto = Array.isArray(body.crypto) ? body.crypto : undefined;
		const stocks = Array.isArray(body.stocks) ? body.stocks : undefined;
		return {
			crypto,
			stocks,
		};
	}

	/**
   * Parse GET query parameters
   * @param {Express.Request} req - HTTP request
   * @returns {Object} Parsed crypto and stocks arrays
   */
	parseGetRequest(req) {
		const { crypto, stocks } = req.query || {};
		return {
			crypto: typeof crypto === 'string' ? crypto.split(',').map(s => s.trim()) : undefined,
			stocks: typeof stocks === 'string' ? stocks.split(',').map(s => s.trim()) : undefined,
		};
	}

	/**
   * Validate request parameters
   * @param {string[]} symbols - Array of symbols
   * @returns {string|null} Error message or null if valid
   */
	validateRequest(symbols) {
		if (!Array.isArray(symbols)) {
			return 'Symbols must be an array';
		}

		if (symbols.length > this.maxSymbols) {
			return `Too many symbols requested (max: ${this.maxSymbols})`;
		}

		for (const symbol of symbols) {
			if (typeof symbol !== 'string') {
				return 'All symbols must be strings';
			}
			if (symbol.length === 0 || symbol.length > 20) {
				return `Symbol must be 1-20 characters: ${symbol}`;
			}
			if (!/^[A-Z0-9_]+$/i.test(symbol)) {
				return `Symbol must be alphanumeric (with underscore): ${symbol}`;
			}
		}

		return null;
	}

	/**
   * Get default symbols from environment variables
   * @returns {string[]} Array of default symbols
   */
	getDefaultSymbols() {
		const crypto = this.getSymbolsFromEnv('NEWS_SYMBOLS_CRYPTO');
		const stocks = this.getSymbolsFromEnv('NEWS_SYMBOLS_STOCKS');

		return [...crypto, ...stocks];
	}

	getSymbolsFromEnv(name) {
		return (process.env[name] || '').split(',').map(s => s.trim()).filter(Boolean);
	}

	getAssetClassBySymbol(crypto, stocks, useDefaults) {
		const cryptoSymbols = useDefaults ? this.getSymbolsFromEnv('NEWS_SYMBOLS_CRYPTO') : (crypto || []);
		const stockSymbols = useDefaults ? this.getSymbolsFromEnv('NEWS_SYMBOLS_STOCKS') : (stocks || []);
		const assetClassBySymbol = {};

		for (const symbol of cryptoSymbols) {
			assetClassBySymbol[String(symbol).trim().toUpperCase()] = 'crypto';
		}
		for (const symbol of stockSymbols) {
			assetClassBySymbol[String(symbol).trim().toUpperCase()] = 'stock';
		}

		return assetClassBySymbol;
	}

	/**
   * Generate analysis summary statistics
   * @param {Object[]} results - Array of AnalysisResult objects
   * @returns {Object} Summary object
   */
	generateSummary(results) {
		const summary = {
			total: results.length,
			analyzed: 0,
			cached: 0,
			timeout: 0,
			error: 0,
			quota_exhausted: 0,
			alerts_sent: 0,
		};

		for (const result of results) {
			if (result.status === AnalysisStatus.ANALYZED) {
				summary.analyzed++;
				if (result.alert) {
					summary.alerts_sent++;
				}
			} else if (result.status === AnalysisStatus.CACHED) {
				summary.cached++;
				if (result.alert) {
					summary.alerts_sent++;
				}
			} else if (result.status === AnalysisStatus.TIMEOUT) {
				summary.timeout++;
			} else if (result.status === AnalysisStatus.ERROR) {
				summary.error++;
				if (result.error && result.error.code === 'GEMINI_QUOTA_EXHAUSTED') {
					summary.quota_exhausted++;
				}
			}
		}

		return summary;
	}
}

// Singleton instance
let instance = null;

function getNewsMonitor() {
	if (!instance) {
		instance = new NewsMonitorHandler();
	}
	return instance;
}

module.exports = {
	getNewsMonitor,
	NewsMonitorHandler,
};
