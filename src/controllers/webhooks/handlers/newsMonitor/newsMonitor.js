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
		console.log('[NewsMonitor] Handler initialized');
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

		try {
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
			const { crypto, stocks } = this.parseRequest(req);
			const allSymbols = [...(crypto || []), ...(stocks || [])];

			// Validate request
			const validationError = this.validateRequest(allSymbols);
			if (validationError) {
				return res.status(400).json({
					error: validationError,
					code: 'INVALID_REQUEST',
					requestId,
				});
			}

			// Get default symbols if not provided
			const symbolsToAnalyze = allSymbols.length > 0
				? allSymbols
				: this.getDefaultSymbols();

			if (symbolsToAnalyze.length === 0) {
				return res.status(400).json({
					error: 'No symbols to analyze. Provide crypto/stocks or set env defaults.',
					code: 'NO_SYMBOLS',
					requestId,
				});
			}

			console.log('[NewsMonitor] Analyzing symbols:', symbolsToAnalyze, 'RequestID:', requestId);

			// Run analysis
			const results = await this.analyzer.analyzeSymbols(symbolsToAnalyze, requestId);

			// Generate summary
			const summary = this.generateSummary(results);

			// Build response
			const response = {
				success: summary.analyzed > 0 || summary.cached > 0,
				partial_success: summary.timeout > 0 || summary.error > 0,
				results,
				summary,
				totalDurationMs: Date.now() - startTime,
				requestId,
			};

			// Remove partial_success if all succeeded
			if (!response.partial_success) {
				delete response.partial_success;
			}

			console.log('[NewsMonitor] Request complete', {
				requestId,
				totalMs: response.totalDurationMs,
				summary,
			});

			return res.status(200).json(response);
		} catch (error) {
			console.error('[NewsMonitor] Unexpected error:', error);
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
		return {
			crypto: Array.isArray(body.crypto) ? body.crypto : undefined,
			stocks: Array.isArray(body.stocks) ? body.stocks : undefined,
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
		const cryptoStr = process.env.NEWS_SYMBOLS_CRYPTO || '';
		const stocksStr = process.env.NEWS_SYMBOLS_STOCKS || '';

		const crypto = cryptoStr.split(',').map(s => s.trim()).filter(s => s.length > 0);
		const stocks = stocksStr.split(',').map(s => s.trim()).filter(s => s.length > 0);

		return [...crypto, ...stocks];
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
