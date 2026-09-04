/* global AbortController */

const { v4: uuidv4 } = require('uuid'); // retained for fallback when req.requestId is not set
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	MarketScannerRequestError,
	parseMarketScannerRequest,
	buildMarketScannerReport,
	prepareMarketScannerItems,
	getRiskLevelsForSide,
	getScanItemSide,
	pickLevel,
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
		const requestId = (req && req.requestId) || uuidv4();
		const startTime = (req && req.startTime) || Date.now();

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
			const deadline = createScannerDeadline(timeoutMs);
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
					totalDurationMs: Date.now() - startTime,
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
					totalDurationMs: Date.now() - startTime,
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
				}).catch(() => {});
			}

			const signalOutcomeService = require('../../../../services/storage/SignalOutcomeService');
			if (signalOutcomeService.isEnabled()) {
				for (const scanResult of scanResults) {
					if (scanResult.status === 'success' && Array.isArray(scanResult.items) && scanResult.items.length > 0) {
						// Resolve sides from the same prepared (rank-normalized) item set the
						// report rendered, so persisted sides match delivered levels
						const preparedItems = prepareMarketScannerItems(scanResult, parsed.ranked === true);
						for (const item of preparedItems) {
							const closePrice = item.indicators?.close ?? null;
							// Persisted side must match the rendered report side
							const itemSide = getScanItemSide(scanResult.scan, item);
							const itemScore = item.changePercent ?? item.indicators?.RSI ?? item.volume_ratio ?? null;

							const atr = pickLevel([item.indicators?.atr, item.indicators?.ATR, item.atr]);
							const bbLower = pickLevel([item.indicators?.bb_lower, item.indicators?.bollinger_lower, item.indicators?.lower, item.bollinger?.lower, item.bollinger_lower]);
							const bbUpper = pickLevel([item.indicators?.bb_upper, item.indicators?.bollinger_upper, item.indicators?.upper, item.bollinger?.upper, item.bollinger_upper]);
							const support = pickLevel([
								item.indicators?.support,
								item.indicators?.nearest_support,
								item.support,
								item.support_resistance?.nearest_support,
								item.support_resistance?.support_1,
							]);
							const resistance = pickLevel([
								item.indicators?.resistance,
								item.indicators?.nearest_resistance,
								item.resistance,
								item.support_resistance?.nearest_resistance,
								item.support_resistance?.resistance_1,
							]);

							const validPrice = typeof closePrice === 'number' && Number.isFinite(closePrice) && closePrice > 0 ? closePrice : null;
							let stopLoss = null;
							let takeProfit = null;
							if (validPrice !== null) {
								const riskLevels = getRiskLevelsForSide({
									side: itemSide,
									price: validPrice,
									atr: typeof atr === 'number' && Number.isFinite(atr) && atr > 0 ? atr : null,
									bbLower: typeof bbLower === 'number' && Number.isFinite(bbLower) && bbLower > 0 ? bbLower : null,
									bbUpper: typeof bbUpper === 'number' && Number.isFinite(bbUpper) && bbUpper > 0 ? bbUpper : null,
									support: typeof support === 'number' && Number.isFinite(support) && support > 0 ? support : null,
									resistance: typeof resistance === 'number' && Number.isFinite(resistance) && resistance > 0 ? resistance : null,
								});
								stopLoss = riskLevels.stopLoss;
								takeProfit = riskLevels.takeProfit;
							}

							signalOutcomeService.recordSignal({
								requestId,
								source: 'market-scanner',
								symbol: item.symbol,
								exchange: parsed.exchange,
								timeframe: parsed.timeframe,
								setupType: scanResult.scan,
								score: itemScore,
								side: itemSide,
								price: validPrice,
								stop: stopLoss,
								target: takeProfit,
								sources: [],
								tokenUsage: null,
								processingTimeMs: Date.now() - startTime,
							}).catch(() => {});
						}
					}
				}
			}

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
				totalDurationMs: Date.now() - startTime,
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
			results.push({
				scan: scanType,
				status: 'error',
				items: [],
				error: error.message,
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
	return {
		totalScans: scanResults.length,
		success: scanResults.filter((r) => r.status === 'success').length,
		error: scanResults.filter((r) => r.status === 'error').length,
		timeout: scanResults.filter((r) => r.status === 'timeout').length,
		totalItems: scanResults.reduce((sum, r) => sum + r.items.length, 0),
		delivered: deliveryResults.filter((r) => r.success).length,
	};
}

function getMarketScannerTimeoutMs() {
	const parsedTimeout = parseInt(process.env.MARKET_SCANNER_TIMEOUT_MS || `${DEFAULT_SCANNER_TIMEOUT_MS}`, 10);

	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
		return DEFAULT_SCANNER_TIMEOUT_MS;
	}

	return Math.min(parsedTimeout, MAX_SCANNER_TIMEOUT_MS);
}

function createScannerDeadline(timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(new Error(`Market scanner timeout after ${timeoutMs}ms`));
	}, timeoutMs);

	return {
		signal: controller.signal,
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
