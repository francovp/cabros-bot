/* global AbortController */

const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const { resolveRequestId } = require('../../../../lib/requestDeadline');
const {
	MarketScannerRequestError,
	parseMarketScannerRequest,
	buildMarketScannerReport,
	prepareMarketScannerItems,
	recordMarketScannerOutcomes,
} = require('../../../../services/tradingview/marketScannerReport');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../alert/alert');
const sentryService = require('../../../../services/monitoring/SentryService');
const {
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
} = require('../../../../services/notification/requestRouting');
const { enrichScannerItemsWithTrendConfluence } = require('../../../../services/tradingview/marketScannerConfluence');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const alertStorageService = require('../../../../services/storage/AlertStorageService');
const {
	classifyScannerError,
	emptyScannerErrorCategoryCounts,
	incrementScannerErrorCategoryCount,
} = require('../../../../services/tradingview/marketScannerErrorCategories');

const DEFAULT_SCANNER_TIMEOUT_MS = 90000;
const MAX_SCANNER_TIMEOUT_MS = 120000;

function resolveBot(botOrGetter) {	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}

	return botOrGetter || null;
}

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

function postMarketScannerAlert(botOrGetter) {
	return async (req, res) => {
		const requestId = resolveRequestId(req);
		const startTime = Date.now();

		try {
			if (!getRuntimeConfig().ENABLE_MARKET_SCANNER) {
				return res.status(404).json({
					error: 'Market scanner is not enabled',
					code: 'FEATURE_DISABLED',
				});
			}

			const requestSpan = sentryService.getActiveSpan();
			const routing = parseNotificationRouting(req.body);
			const parsed = parseMarketScannerRequest(req);
			const timeoutMs = getMarketScannerTimeoutMs();
			const deadline = createScannerDeadline(timeoutMs, req.requestDeadlineSignal);
			let scanResults;

			try {
				scanResults = await runScans(parsed, { signal: deadline.signal });
			} finally {
				deadline.clear();
			}

			const timedOut = hasTimedOut(scanResults);
			const successfulScans = scanResults.filter((r) => r.status === 'success');

			if (successfulScans.length === 0) {
				const timeoutError = timedOut;
				return res.status(timeoutError ? 504 : 502).json({
					success: false,
					ranked: parsed.ranked === true,
					includeMultiTimeframe: parsed.includeMultiTimeframe === true,
					code: timeoutError ? 'MARKET_SCANNER_TIMEOUT' : 'ALL_SCANS_FAILED',
					error: timeoutError
						? `Market scanner timed out after ${timeoutMs}ms.`
						: 'TradingView MCP failed for all requested scans.',
					scanResults: compactScanResults(scanResults),
					summary: buildSummary(scanResults, []),
					timedOut,
					timeoutMs,
					requestId,
					processingTimeMs: Math.max(0, Date.now() - startTime),
				});
			}

			const alertText = buildMarketScannerReport(scanResults, {
				exchange: parsed.exchange,
				timeframe: parsed.timeframe,
				now: new Date(),
				ranked: parsed.ranked === true,
			});

			const dryRun = resolveDryRun(req);
			if (dryRun) {
				console.debug('[MarketScanner] Dry-run mode: skipping delivery');
				return res.status(200).json({
					success: true,
					dryRun: true,
					ranked: parsed.ranked === true,
					includeMultiTimeframe: parsed.includeMultiTimeframe === true,
					payload: { alertText },
					scanResults: compactScanResults(scanResults, parsed.ranked === true),
					summary: buildSummary(scanResults, []),
					timedOut,
					timeoutMs,
					requestId,
					processingTimeMs: Math.max(0, Date.now() - startTime),
				});
			}

			let notificationManager = getNotificationManager();
			if (!notificationManager) {
				notificationManager = await initializeNotificationServices(resolveBot(botOrGetter));
			}

			const deliveryResults = await sendWithNotificationRouting(
				notificationManager,
				{ text: alertText, source: 'market-scanner' },
				routing,
				{ parentSpan: requestSpan },
			);
			const requestedChannels = getRequestedChannels(notificationManager, routing);
			const deliveredChannels = getDeliveredChannels(deliveryResults);
			const summary = buildSummary(scanResults, deliveryResults);

			// Fire-and-forget: persist delivered market-scanner report to AlertStorageService.
			// Storage failures never block delivery (handled inside saveAlert).
			if (alertStorageService.isEnabled() && deliveredChannels.length > 0) {
				const scannerSymbols = successfulScans.length > 0
					? Array.from(new Set(
						successfulScans
							.flatMap((scan) => Array.isArray(scan.items) ? scan.items : [])
							.map((item) => item && item.symbol)
							.filter(Boolean),
					))
					: [];
				const scannerErrorCategories = scanResults
					.filter((r) => r.status === 'error' && r.errorCategory)
					.map((r) => r.errorCategory);
				alertStorageService.saveAlert({
					requestId,
					text: alertText,
					symbol: scannerSymbols[0] || null,
					exchange: parsed.exchange || null,
					enriched: false,
					enrichmentData: null,
					tokenUsage: null,
					channels: requestedChannels,
					deliveryResults,
					source: 'market-scanner',
					telegramChatId: routing.telegramChatId,
					telegramThreadId: routing.telegramThreadId,
					whatsappChatId: routing.whatsappChatId,
					discordWebhookUrl: routing.discordWebhookUrl,
					processingTimeMs: Date.now() - startTime,
					scannerErrorCategories,
				}).catch(() => {});
			}

			recordMarketScannerOutcomes(scanResults, parsed, {
				requestId,
				startTime,
				source: 'market-scanner',
			});

			return res.status(200).json({
				success: true,
				ranked: parsed.ranked === true,
				includeMultiTimeframe: parsed.includeMultiTimeframe === true,
				alertText,
				scanResults: compactScanResults(scanResults, parsed.ranked === true),
				deliveryResults,
				requestedChannels,
				deliveredChannels,
				summary,
				timedOut,
				timeoutMs,
				requestId,
				processingTimeMs: Math.max(0, Date.now() - startTime),
			});
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(400).json({
					error: error.message,
					code: 'INVALID_REQUEST',
					requestId,
				});
			}

			if (error instanceof MarketScannerRequestError) {
				return res.status(400).json({
					error: error.message,
					code: error.code,
					requestId,
				});
			}

			console.error('[MarketScanner] Request failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/webhook/market-scanner-alert',
					method: 'POST',
					statusCode: 500,
					requestId,
				},
			});

			return res.status(500).json({
				error: 'Internal server error. Please try again later.',
				code: 'INTERNAL_ERROR',
				requestId,
			});
		}
	};
}

async function runScans(parsed, options = {}) {
	const { signal } = options;
	const results = [];
	const symbolCache = new Map();

	for (let index = 0; index < parsed.scans.length; index++) {
		const scanType = parsed.scans[index];

		if (signal && signal.aborted) {
			appendTimeoutResults(results, parsed.scans.slice(index), getAbortMessage(signal));
			break;
		}

		try {
			const args = buildScanArgs(parsed, scanType);
			const scanOptions = {};
			if (signal) {
				scanOptions.signal = signal;
			}

			const result = await tradingViewMcpService.callScanTool(scanType, args, scanOptions);
			const items = Array.isArray(result) ? result : (result && Array.isArray(result.result) ? result.result : []);
			let enrichedItems = items;
			if (parsed.includeMultiTimeframe === true) {
				try {
					enrichedItems = await enrichScannerItemsWithTrendConfluence(items, { ...parsed, scanType }, signal, { symbolCache });
				} catch (error) {
					if (isAbortTriggered(signal, error)) {
						const timeoutMessage = getAbortMessage(signal, error.message);
						results.push({ scan: scanType, status: 'success', items });
						appendTimeoutResults(results, parsed.scans.slice(index + 1), timeoutMessage);
						break;
					}
					throw error;
				}
			}

			results.push({
				scan: scanType,
				status: 'success',
				items: enrichedItems,
			});
		} catch (error) {
			if (isAbortTriggered(signal, error)) {
				const timeoutMessage = getAbortMessage(signal, error.message);
				results.push({
					scan: scanType,
					status: 'timeout',
					items: [],
					error: timeoutMessage,
				});
				appendTimeoutResults(results, parsed.scans.slice(index + 1), timeoutMessage);
				break;
			}

			console.warn('[MarketScanner] Scan failed:', scanType, error.message);
			const errorCategory = classifyScannerError(error);
			sentryService.captureRuntimeError({
				channel: 'market-scanner',
				feature: 'market-scanner',
				error,
				extra: {
					mcp_error_category: errorCategory,
					scan_type: scanType,
					source: 'market-scanner',
				},
			});
			results.push({
				scan: scanType,
				status: 'error',
				items: [],
				error: error.message,
				errorCategory,
			});
		}
	}

	return results;
}

function buildScanArgs(parsed, scanType) {
	const args = {
		exchange: parsed.exchange,
		timeframe: parsed.timeframe,
		limit: parsed.limit,
	};
	if (scanType === 'bollinger_scan') {
		args.bbw_threshold = parsed.bbwThreshold;
	} else if (scanType === 'rating_filter') {
		args.rating = parsed.rating;
	} else if (scanType === 'consecutive_candles_scan') {
		args.pattern_type = parsed.consecutiveCandlesPatternType;
		args.candle_count = parsed.candleCount;
		if (parsed.minGrowth !== undefined) {
			args.min_growth = parsed.minGrowth;
		}
	}
	return args;
}

function compactScanResults(results, includeScores = false) {
	return results.map((result) => {
		if (result.status === 'error' || result.status === 'timeout') {
			return {
				scan: result.scan,
				status: result.status,
				error: result.error,
				errorCategory: result.errorCategory || null,
			};
		}

		const compact = {
			scan: result.scan,
			status: result.status,
			itemCount: result.items.length,
		};

		if (includeScores && Array.isArray(result.items) && result.items.length > 0) {
			compact.scores = prepareMarketScannerItems(result, true).map((item) => ({
				symbol: item.symbol,
				score: item._score,
				reason: item._scoreReason,
				...(item._trendConfluence ? { trendConfluence: item._trendConfluence } : {}),
			}));
		}

		return compact;
	});
}

function buildSummary(scanResults, deliveryResults) {
	const errorCategories = emptyScannerErrorCategoryCounts();
	for (const result of scanResults) {
		if (result.status === 'error' && result.errorCategory) {
			incrementScannerErrorCategoryCount(errorCategories, result.errorCategory);
		}
	}
	return {
		totalScans: scanResults.length,
		success: scanResults.filter((r) => r.status === 'success').length,
		error: scanResults.filter((r) => r.status === 'error').length,
		timeout: scanResults.filter((r) => r.status === 'timeout').length,
		totalItems: scanResults.reduce((sum, r) => sum + r.items.length, 0),
		delivered: deliveryResults.filter((r) => r.success).length,
		errorCategoryCounts: errorCategories,
	};
}

function getMarketScannerTimeoutMs() {
	const parsedTimeout = parseInt(process.env.MARKET_SCANNER_TIMEOUT_MS || `${DEFAULT_SCANNER_TIMEOUT_MS}`, 10);

	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
		return DEFAULT_SCANNER_TIMEOUT_MS;
	}

	return Math.min(parsedTimeout, MAX_SCANNER_TIMEOUT_MS);
}

function createScannerDeadline(timeoutMs, parentSignal) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(new Error(`Market scanner timeout after ${timeoutMs}ms`));
	}, timeoutMs);

	return {
		signal: parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal,
		clear: () => clearTimeout(timeoutId),
	};
}

function appendTimeoutResults(results, scans, error) {
	scans.forEach((scanType) => {
		results.push({
			scan: scanType,
			status: 'timeout',
			items: [],
			error,
		});
	});
}

function hasTimedOut(results) {
	return results.some((result) => result.status === 'timeout');
}

function isAbortTriggered(signal, error) {
	return Boolean(
		(signal && signal.aborted)
		|| (error && error.name === 'AbortError')
		|| (error && error.name === 'AbortSignalError'),
	);
}

function getAbortMessage(signal, fallback = 'Market scanner timed out') {
	const reason = signal && signal.reason;
	if (reason instanceof Error && reason.message) {
		return reason.message;
	}

	if (typeof reason === 'string' && reason) {
		return reason;
	}

	return fallback;
}

module.exports = {
	postMarketScannerAlert,
	runScans,
};
