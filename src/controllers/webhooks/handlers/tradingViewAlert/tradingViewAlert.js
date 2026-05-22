const { v4: uuidv4 } = require('uuid');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	TradingViewAlertRequestError,
	parseTradingViewAlertRequest,
	buildTradingViewAlertReport,
} = require('../../../../services/tradingview/tradingViewAlertReport');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../alert/alert');
const sentryService = require('../../../../services/monitoring/SentryService');

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}

	return botOrGetter || null;
}

function postTradingViewAlert(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		try {
			const requestSpan = sentryService.getActiveSpan();
			const parsed = parseTradingViewAlertRequest(req);
			const results = await analyzeSymbols(parsed);
			const analyzedItems = results
				.filter((result) => result.status === 'analyzed')
				.map((result) => ({
					input: result.input,
					analysis: result.analysis,
				}));

			if (analyzedItems.length === 0) {
				return res.status(502).json({
					success: false,
					code: 'ALL_SYMBOLS_FAILED',
					error: 'TradingView MCP failed for all requested symbols.',
					results: compactResults(results),
					summary: buildSummary(results, []),
					requestId,
					totalDurationMs: Date.now() - startTime,
				});
			}

			const alertText = buildTradingViewAlertReport(analyzedItems);
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
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
			if (error instanceof TradingViewAlertRequestError) {
				return res.status(400).json({
					error: error.message,
					code: error.code,
					requestId,
				});
			}

			console.error('[TradingViewAlert] Request failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: {
					endpoint: '/api/tradingview-alert',
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

async function analyzeSymbols({ symbols, timeframe }) {
	const results = [];

	for (const input of symbols) {
		try {
			const analysis = await tradingViewMcpService.analyzeSymbolIdentifier({
				...input,
				timeframe,
			});

			results.push({
				symbol: input.raw,
				status: 'analyzed',
				input,
				analysis,
			});
		} catch (error) {
			console.warn('[TradingViewAlert] Symbol analysis failed:', input.raw, error.message);
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
		if (result.status === 'error') {
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
		};
	});
}

function buildSummary(results, deliveryResults) {
	return {
		total: results.length,
		analyzed: results.filter((result) => result.status === 'analyzed').length,
		error: results.filter((result) => result.status === 'error').length,
		delivered: deliveryResults.filter((result) => result.success).length,
	};
}

module.exports = {
	postTradingViewAlert,
	analyzeSymbols,
};
