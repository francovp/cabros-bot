const { v4: uuidv4 } = require('uuid');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	VolumeConfirmationRequestError,
	parseVolumeConfirmationRequest,
	getVolumeDecision,
} = require('../../../../services/tradingview/volumeConfirmationRequest');
const sentryService = require('../../../../services/monitoring/SentryService');

function postVolumeConfirmation() {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		try {
			const parsed = parseVolumeConfirmationRequest(req);
			const analysis = await tradingViewMcpService.callVolumeConfirmation({
				symbol: parsed.symbol,
				exchange: parsed.exchange,
				timeframe: parsed.timeframe,
			});
			const decision = getVolumeDecision(analysis);

			return res.status(200).json({
				success: true,
				symbol: parsed.rawSymbol,
				exchange: parsed.exchange,
				asset: parsed.symbol,
				timeframe: parsed.timeframe,
				...decision,
				analysis,
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
			if (error instanceof VolumeConfirmationRequestError) {
				return res.status(400).json({
					error: error.message,
					code: error.code,
					requestId,
				});
			}

			if (error && error.message) {
				console.warn('[VolumeConfirmation] TradingView MCP call failed:', error.message);
				return res.status(502).json({
					success: false,
					error: error.message,
					code: 'VOLUME_CONFIRMATION_FAILED',
					requestId,
					totalDurationMs: Date.now() - startTime,
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
			});
		}
	};
}

module.exports = {
	postVolumeConfirmation,
};
