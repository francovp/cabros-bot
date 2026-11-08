const { sendErrorFrom } = require('../../../../lib/errorEnvelope');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const requestDeadline = require('../../../../lib/requestDeadline');
const { resolveRequestId } = requestDeadline;
const {
	VolumeConfirmationRequestError,
	parseVolumeConfirmationRequest,
	getVolumeDecision,
} = require('../../../../services/tradingview/volumeConfirmationRequest');
const { resolveTrendConfluence } = require('../../../../services/tradingview/marketScannerScoring');
const sentryService = require('../../../../services/monitoring/SentryService');

const REQUEST_DEADLINE_RESPONSE_RESERVE_MS = 1000;

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

function postVolumeConfirmation() {
	return async (req, res) => {
		const requestId = (req && req.requestId) || resolveRequestId(req);
		const startTime = (req && typeof req.startTime === 'number' && Number.isFinite(req.startTime))
			? req.startTime
			: Date.now();

		try {
			const parsed = parseVolumeConfirmationRequest(req);
			if (resolveDryRun(req)) {
				console.debug('[VolumeConfirmation] Dry-run mode: skipping TradingView MCP call');
				return res.status(200).json({
					success: true,
					dryRun: true,
					symbol: parsed.rawSymbol,
					exchange: parsed.exchange,
					asset: parsed.symbol,
					timeframe: parsed.timeframe,
					confirmed: null,
					decision: 'unknown',
					volumeRatio: null,
					analysis: null,
					requestId,
					processingTimeMs: Math.max(0, Date.now() - startTime),
				});
			}
			const analysis = await tradingViewMcpService.callVolumeConfirmation({
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				timeframe: parsed.timeframe,
				signal: req.requestDeadlineSignal,
			});
			const decision = getVolumeDecision(analysis);
			const isMultiTimeframeEnabled = process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME === 'true';
			let multiTimeframeAnalysis = null;
			let htfAlignment = 'unknown';

			if (parsed.includeMultiTimeframe && isMultiTimeframeEnabled) {
				const requestDeadlineAt = Number.isFinite(req.requestDeadlineAt)
					? req.requestDeadlineAt
					: startTime + requestDeadline.constants.DEFAULT_TIMEOUT_MS;
				const remainingMtfBudgetMs = Math.max(
					0,
					requestDeadlineAt - Date.now() - REQUEST_DEADLINE_RESPONSE_RESERVE_MS,
				);

				if (remainingMtfBudgetMs > 0 && !req.requestDeadlineSignal?.aborted) {
					const mtfDeadlineController = new AbortController();
					const mtfSignal = req.requestDeadlineSignal
						? AbortSignal.any([req.requestDeadlineSignal, mtfDeadlineController.signal])
						: mtfDeadlineController.signal;
					let mtfDeadlineTimer;
					const mtfDeadline = new Promise((_, reject) => {
						mtfDeadlineTimer = setTimeout(() => {
							const error = new Error('Optional multi-timeframe analysis exceeded the request budget');
							mtfDeadlineController.abort(error);
							reject(error);
						}, remainingMtfBudgetMs);
					});

					try {
						multiTimeframeAnalysis = await Promise.race([
							tradingViewMcpService.callMultiTimeframeAnalysis({
								symbol: parsed.symbol,
								exchange: parsed.exchange,
								signal: mtfSignal,
							}),
							mtfDeadline,
						]);
						const trendConfluence = resolveTrendConfluence({
							...analysis,
							breakout_type: parsed.breakoutType || parsed.direction || parsed.side,
							trading_recommendation: parsed.tradingRecommendation || parsed.side || parsed.direction,
						}, 'volume_confirmation', { trendConfluence: multiTimeframeAnalysis });
						htfAlignment = trendConfluence?.status || 'unknown';
					} catch (error) {
						console.warn('[VolumeConfirmation] Multi-timeframe analysis failed:', {
							symbol: parsed.rawSymbol,
							errorMessage: error.message,
						});
						multiTimeframeAnalysis = null;
						htfAlignment = 'unknown';
					} finally {
						clearTimeout(mtfDeadlineTimer);
					}
				}
			}

			const processingTimeMs = Math.max(0, Date.now() - startTime);
			const response = {
				success: true,
				symbol: parsed.rawSymbol,
				exchange: parsed.exchange,
				asset: parsed.symbol,
				timeframe: parsed.timeframe,
				...decision,
				analysis,
				volumeConfirmation: {
					...decision,
					analysis,
				},
				requestId,
				processingTimeMs,
			};

			if (parsed.includeMultiTimeframe && isMultiTimeframeEnabled) {
				response.multiTimeframeAnalysis = multiTimeframeAnalysis;
				response.htfAlignment = htfAlignment;
			}

			return res.status(200).json(response);
		} catch (error) {
			const processingTimeMs = Math.max(0, Date.now() - startTime);
			if (error instanceof VolumeConfirmationRequestError) {
				return sendErrorFrom(res, 400, {
					error: error.message,
					code: error.code,
					requestId,
					processingTimeMs,
				});
			}

			if (error && error.message) {
				console.warn('[VolumeConfirmation] TradingView MCP call failed:', error.message);
				return sendErrorFrom(res, 502, {
					success: false,
					error: error.message,
					code: 'VOLUME_CONFIRMATION_FAILED',
					requestId,
					processingTimeMs,
				});
			}

			console.error('[VolumeConfirmation] Request failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/webhook/volume-confirmation',
					method: 'POST',
					statusCode: 500,
					requestId,
				},
			});

			return sendErrorFrom(res, 500, {
				error: 'Internal server error. Please try again later.',
				code: 'INTERNAL_ERROR',
				requestId,
				processingTimeMs,
			});
		}
	};
}

module.exports = {
	postVolumeConfirmation,
};
