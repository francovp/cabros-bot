const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const { resolveRequestId } = require('../../../../lib/requestDeadline');
const {
	VolumeConfirmationRequestError,
	parseVolumeConfirmationRequest,
	getVolumeDecision,
} = require('../../../../services/tradingview/volumeConfirmationRequest');
const sentryService = require('../../../../services/monitoring/SentryService');

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

function postVolumeConfirmation() {
	return async (req, res) => {
		const requestId = resolveRequestId(req);
		const startTime = Date.now();

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
					totalDurationMs: Date.now() - startTime,
				});
			}
			const analysis = await tradingViewMcpService.callVolumeConfirmation({
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				timeframe: parsed.timeframe,
				signal: req.requestDeadlineSignal,
			});
			const decision = getVolumeDecision(analysis);

			const processingTimeMs = Math.max(0, Date.now() - startTime);

			return res.status(200).json({
				success: true,
				symbol: parsed.rawSymbol,
				exchange: parsed.exchange,
				asset: parsed.symbol,
				timeframe: parsed.timeframe,
				...decision,
				analysis,
				requestId,
				processingTimeMs,
			});
		} catch (error) {
			const processingTimeMs = Math.max(0, Date.now() - startTime);
			if (error instanceof VolumeConfirmationRequestError) {
				return res.status(400).json({
					error: error.message,
					code: error.code,
					requestId,
					processingTimeMs,
				});
			}

			if (error && error.message) {
				console.warn('[VolumeConfirmation] TradingView MCP call failed:', error.message);
				return res.status(502).json({
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

			return res.status(500).json({
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
