/* global AbortController */

const { v4: uuidv4 } = require('uuid');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	ExpandedAnalysisAlertRequestError,
	parseExpandedAnalysisAlertRequest,
	buildExpandedAnalysisAlertReport,
	buildReportRow,
} = require('../../../../services/tradingview/expandedAnalysisAlertReport');
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
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');
const { runWithConcurrency } = require('../../../../lib/runWithConcurrency');
const alertStorageService = require('../../../../services/storage/AlertStorageService');

const DEFAULT_ALERT_TIMEOUT_MS = 60000;
const MAX_ALERT_TIMEOUT_MS = 120000;

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}

	return botOrGetter || null;
}

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

function deriveItemSide(analysis = {}) {
	const sentiment = String(analysis.sentiment || analysis.market_sentiment?.overall_sentiment || '').toUpperCase();
	const confluence = String(analysis.confluence?.recommendation || analysis.confluence?.action || '').toUpperCase();
	if (confluence.includes('SELL') || sentiment.includes('BEARISH') || sentiment.includes('BAJISTA')) {
		return 'SELL';
	}
	return 'BUY';
}

function postExpandedAnalysisAlert(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		try {
			const requestSpan = sentryService.getActiveSpan();
			const routing = parseNotificationRouting(req.body);
			const parsed = parseExpandedAnalysisAlertRequest(req);
			const timeoutMs = getAlertTimeoutMs();
			const deadline = createAlertDeadline(timeoutMs);
			let results;

			try {
				results = await analyzeSymbols(parsed, { signal: deadline.signal });
			} finally {
				deadline.clear();
			}

			const timedOut = hasTimedOut(results);
			const analyzedItems = results
				.filter((result) => result.status === 'analyzed')
				.map((result) => ({
					input: result.input,
					analysis: result.analysis,
					multiTimeframe: result.multiTimeframe,
					side: deriveItemSide(result.analysis),
				}));

			if (analyzedItems.length === 0) {
				const timeoutError = timedOut;
				return res.status(timeoutError ? 504 : 502).json({
					success: false,
					code: timeoutError ? 'EXPANDED_ANALYSIS_ALERT_TIMEOUT' : 'ALL_SYMBOLS_FAILED',
					error: timeoutError
						? `Expanded analysis alert timed out after ${timeoutMs}ms.`
						: 'TradingView MCP failed for all requested symbols.',
					results: compactResults(results),
					summary: buildSummary(results, []),
					timedOut,
					timeoutMs,
					requestId,
					totalDurationMs: Date.now() - startTime,
				});
			}

			const alertText = buildExpandedAnalysisAlertReport(analyzedItems);
			const dryRun = resolveDryRun(req);
			if (dryRun) {
				console.debug('[ExpandedAnalysisAlert] Dry-run mode: skipping delivery');
				return res.status(200).json({
					success: true,
					dryRun: true,
					payload: { alertText },
					results: compactResults(results),
					summary: buildSummary(results, []),
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

			const deliveryResults = await sendWithNotificationRouting(notificationManager, { text: alertText }, routing, { parentSpan: requestSpan });
			const requestedChannels = getRequestedChannels(notificationManager, routing);
			const deliveredChannels = getDeliveredChannels(deliveryResults);
			const summary = buildSummary(results, deliveryResults);

			// Fire-and-forget: persist delivered expanded-analysis report to AlertStorageService.
			// Storage failures never block delivery (handled inside saveAlert).
			if (alertStorageService.isEnabled() && deliveredChannels.length > 0 && analyzedItems.length > 0) {
				const firstSymbol = analyzedItems[0].input && analyzedItems[0].input.symbol
					? analyzedItems[0].input.symbol
					: (analyzedItems[0].input && analyzedItems[0].input.raw) || null;
				const firstExchange = analyzedItems[0].input && analyzedItems[0].input.exchange
					? analyzedItems[0].input.exchange
					: null;
				alertStorageService.saveAlert({
					requestId,
					text: alertText,
					symbol: firstSymbol,
					exchange: firstExchange,
					enriched: false,
					enrichmentData: null,
					tokenUsage: null,
					channels: requestedChannels,
					deliveryResults,
					source: 'expanded-analysis',
					processingTimeMs: Date.now() - startTime,
				}).catch(() => {});
			}

			const signalOutcomeService = require('../../../../services/storage/SignalOutcomeService');
			if (signalOutcomeService.isEnabled()) {
				for (const item of analyzedItems) {
					const itemSide = item.side;
					const row = buildReportRow(item);
					const tech = item.analysis.technical || item.analysis || {};
					const closePrice = row.price ?? tech.price_data?.current_price ?? tech.price_data?.close ?? null;
					const score = item.analysis.market_sentiment?.overall_rating ?? tech.market_sentiment?.overall_rating ?? null;

					signalOutcomeService.recordSignal({
						requestId,
						source: 'expanded-analysis',
						symbol: item.input.symbol,
						exchange: item.input.exchange,
						timeframe: parsed.timeframe,
						setupType: 'expanded-analysis',
						score,
						side: itemSide,
						price: typeof closePrice === 'number' ? closePrice : null,
						stop: typeof row.stopLoss === 'number' ? row.stopLoss : null,
						target: typeof row.takeProfit === 'number' ? row.takeProfit : null,
						sources: [],
						tokenUsage: null,
						processingTimeMs: Date.now() - startTime,
					}).catch(() => {});
				}
			}

			return res.status(200).json({
				success: true,
				alertText,
				results: compactResults(results),
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

			if (error instanceof ExpandedAnalysisAlertRequestError) {
				return res.status(400).json({
					error: error.message,
					code: error.code,
					requestId,
				});
			}

			console.error('[ExpandedAnalysisAlert] Request failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/webhook/expanded-analysis-alert',
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

async function analyzeSymbols({ symbols, timeframe, includeMultiTimeframe, analysisMode }, options = {}) {
	const { signal } = options;
	const { results } = await runWithConcurrency(
		symbols,
		getRuntimeConfig().EXPANDED_ANALYSIS_ALERT_CONCURRENCY,
		async (input) => {
			try {
				const analysisRequest = { ...input, timeframe, analysisMode };
				if (signal) analysisRequest.signal = signal;

				const analysis = await tradingViewMcpService.analyzeSymbolIdentifier(analysisRequest);
				let multiTimeframe = null;
				if (includeMultiTimeframe) {
					try {
						multiTimeframe = await tradingViewMcpService.callMultiTimeframeAnalysis({
							symbol: input.symbol,
							exchange: input.exchange,
							signal,
						});
					} catch (mErr) {
						console.warn('[ExpandedAnalysisAlert] Multi-timeframe analysis failed for', input.raw, mErr.message);
					}
				}

				return { symbol: input.raw, status: 'analyzed', input, analysis, multiTimeframe };
			} catch (error) {
				if (isAbortTriggered(signal, error)) {
					return { symbol: input.raw, status: 'timeout', input, error: getAbortMessage(signal, error.message) };
				}

				console.warn('[ExpandedAnalysisAlert] Symbol analysis failed:', input.raw, error.message);
				return { symbol: input.raw, status: 'error', input, error: error.message };
			}
		},
		{ shouldContinue: () => !(signal && signal.aborted) },
	);

	if (signal && signal.aborted) {
		fillTimeoutResults(results, symbols, getAbortMessage(signal));
	}

	return results;
}

function compactResults(results) {
	return results.map((result) => {
		if (result.status === 'error' || result.status === 'timeout') {
			return {
				symbol: result.symbol,
				status: result.status,
				error: result.error,
			};
		}

		const technicalAnalysis = result.analysis && result.analysis.technical
			? result.analysis.technical
			: result.analysis || {};
		const priceData = technicalAnalysis.price_data || {};
		const indicators = technicalAnalysis.technical_indicators || {};

		return {
			symbol: result.symbol,
			status: result.status,
			price: priceData.current_price ?? priceData.close,
			rsi: indicators.rsi ?? technicalAnalysis.rsi?.value,
			multiTimeframe: result.multiTimeframe ? 'success' : undefined,
		};
	});
}

function buildSummary(results, deliveryResults) {
	const summary = {
		total: results.length,
		analyzed: results.filter((result) => result.status === 'analyzed').length,
		error: results.filter((result) => result.status === 'error').length,
		delivered: deliveryResults.filter((result) => result.success).length,
	};
	const timeout = results.filter((result) => result.status === 'timeout').length;

	if (timeout > 0) {
		summary.timeout = timeout;
	}

	return summary;
}

function getAlertTimeoutMs() {
	const parsedTimeout = getRuntimeConfig().EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS;

	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
		return DEFAULT_ALERT_TIMEOUT_MS;
	}

	return Math.min(parsedTimeout, MAX_ALERT_TIMEOUT_MS);
}

function createAlertDeadline(timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(new Error(`Expanded analysis alert timeout after ${timeoutMs}ms`));
	}, timeoutMs);

	return {
		signal: controller.signal,
		clear: () => clearTimeout(timeoutId),
	};
}

function fillTimeoutResults(results, symbols, error) {
	symbols.forEach((input, index) => {
		if (!results[index]) {
			results[index] = {
				symbol: input.raw,
				status: 'timeout',
				input,
				error,
			};
		}
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

function getAbortMessage(signal, fallback = 'Expanded analysis alert timed out') {
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
	postExpandedAnalysisAlert,
	analyzeSymbols,
};
