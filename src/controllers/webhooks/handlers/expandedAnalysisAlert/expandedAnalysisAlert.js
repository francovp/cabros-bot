/* global AbortController */

const { v4: uuidv4 } = require('uuid');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	ExpandedAnalysisAlertRequestError,
	parseExpandedAnalysisAlertRequest,
	buildExpandedAnalysisAlertReport,
} = require('../../../../services/tradingview/expandedAnalysisAlertReport');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../alert/alert');
const sentryService = require('../../../../services/monitoring/SentryService');

const DEFAULT_ALERT_TIMEOUT_MS = 60000;
const MAX_ALERT_TIMEOUT_MS = 120000;

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}

	return botOrGetter || null;
}

function postExpandedAnalysisAlert(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		try {
			const requestSpan = sentryService.getActiveSpan();
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
			let notificationManager = getNotificationManager();
			if (!notificationManager) {
				notificationManager = await initializeNotificationServices(resolveBot(botOrGetter));
			}

			const deliveryResults = await notificationManager.sendToAll({ text: alertText }, { parentSpan: requestSpan });
			const summary = buildSummary(results, deliveryResults);

			return res.status(200).json({
				success: true,
				alertText,
				results: compactResults(results),
				deliveryResults,
				summary,
				timedOut,
				timeoutMs,
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
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

async function analyzeSymbols({ symbols, timeframe, includeMultiTimeframe }, options = {}) {
	const { signal } = options;
	const results = [];

	for (let index = 0; index < symbols.length; index++) {
		const input = symbols[index];
		if (signal && signal.aborted) {
			appendTimeoutResults(results, symbols.slice(index), getAbortMessage(signal));
			break;
		}

		try {
			const analysisRequest = {
				...input,
				timeframe,
			};
			if (signal) {
				analysisRequest.signal = signal;
			}

			const analysis = await tradingViewMcpService.analyzeSymbolIdentifier({
				...analysisRequest,
			});

			let multiTimeframe = null;
			if (includeMultiTimeframe) {
				try {
					multiTimeframe = await tradingViewMcpService.callMultiTimeframeAnalysis({
						symbol: input.symbol,
						exchange: input.exchange,
						signal,
					});
				} catch (mErr) {
					console.warn(
						'[ExpandedAnalysisAlert] Multi-timeframe analysis failed for',
						input.raw,
						mErr.message,
					);
				}
			}

			results.push({
				symbol: input.raw,
				status: 'analyzed',
				input,
				analysis,
				multiTimeframe,
			});
		} catch (error) {
			if (isAbortTriggered(signal, error)) {
				const timeoutMessage = getAbortMessage(signal, error.message);
				results.push({
					symbol: input.raw,
					status: 'timeout',
					input,
					error: timeoutMessage,
				});
				appendTimeoutResults(results, symbols.slice(index + 1), timeoutMessage);
				break;
			}

			console.warn('[ExpandedAnalysisAlert] Symbol analysis failed:', input.raw, error.message);
			results.push({
				symbol: input.raw,
				status: 'error',
				input,
				error: error.message,
			});
		}
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

		return {
			symbol: result.symbol,
			status: result.status,
			price: result.analysis && result.analysis.price_data
				? result.analysis.price_data.current_price ?? result.analysis.price_data.close
				: undefined,
			rsi: result.analysis
				? result.analysis.technical_indicators?.rsi ?? result.analysis.rsi?.value
				: undefined,
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
	const parsedTimeout = parseInt(process.env.EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS || `${DEFAULT_ALERT_TIMEOUT_MS}`, 10);

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

function appendTimeoutResults(results, symbols, error) {
	symbols.forEach((input) => {
		results.push({
			symbol: input.raw,
			status: 'timeout',
			input,
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
