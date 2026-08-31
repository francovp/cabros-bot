/* global AbortController */

const { v4: uuidv4 } = require('uuid');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	ExpandedAnalysisAlertRequestError,
	parseExpandedAnalysisAlertRequest,
	buildExpandedAnalysisAlertReport,
	buildReportRow,
	getStopLossMeta,
	getTakeProfitTarget,
	getRiskRewardRatio,
	selectTakeProfitWithMinRatio,
} = require('../../../../services/tradingview/expandedAnalysisAlertReport');
const sentryService = require('../../../../services/monitoring/SentryService');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');

function postSymbolAnalysis() {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();
		let deadline;

		try {
			const parsed = parseSymbolAnalysisRequest(req);
			deadline = createDeadline(getTimeoutMs());
			const input = parsed.symbols[0];
			const analysis = await tradingViewMcpService.analyzeSymbolIdentifier({
				...input,
				timeframe: parsed.timeframe,
				analysisMode: parsed.analysisMode,
				signal: deadline.signal,
			});

			let multiTimeframe = null;
			let analysisStatus = 'complete';
			if (parsed.includeMultiTimeframe) {
				try {
					multiTimeframe = await tradingViewMcpService.callMultiTimeframeAnalysis({
						symbol: input.symbol,
						exchange: input.exchange,
						signal: deadline.signal,
					});
				} catch (error) {
					if (deadline.signal.aborted || error?.name === 'AbortError') throw error;
					analysisStatus = 'partial';
					console.warn('[SymbolAnalysis] Multi-timeframe analysis failed:', error.message);
				}
			}

			const side = inferSide(analysis);
			const normalized = normalizeAnalysis({ analysis, input, parsed, multiTimeframe, side });
			const reportAnalysis = {
				...analysis,
				technical: {
					...(analysis.technical || analysis),
					price_data: normalized.price_data,
					technical_indicators: normalized.technical_indicators,
					volume_analysis: normalized.volume_analysis,
				},
			};
			const item = { input, analysis: reportAnalysis, multiTimeframe, side, risk: normalized.risk };

			return res.status(200).json({
				success: true,
				symbol: input.raw,
				exchange: input.exchange,
				asset: input.symbol,
				timeframe: parsed.timeframe,
				alertText: buildExpandedAnalysisAlertReport([item]),
				analysis: normalized,
				analysisStatus,
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
			if (error instanceof ExpandedAnalysisAlertRequestError) {
				return res.status(400).json({ error: error.message, code: error.code, requestId });
			}

			const timedOut = Boolean(deadline && deadline.signal.aborted) || error?.name === 'AbortError';
			if (timedOut) {
				try {
					sentryService.captureRuntimeError({
						channel: 'http-alert',
						error,
						http: { endpoint: '/api/webhook/symbol-analysis', method: 'POST', statusCode: 504, requestId },
						extra: { provider: 'tradingview-mcp', failureClass: 'timeout' },
					});
				} catch (monitoringError) {
					console.warn('[SymbolAnalysis] Sentry timeout capture failed:', monitoringError.message);
				}
				return res.status(504).json({
					success: false,
					error: 'Symbol analysis timed out.',
					code: 'SYMBOL_ANALYSIS_TIMEOUT',
					requestId,
					totalDurationMs: Date.now() - startTime,
				});
			}

			if (error && error.message) {
				console.warn('[SymbolAnalysis] TradingView MCP call failed:', error.message);
				try {
					sentryService.captureRuntimeError({
						channel: 'http-alert',
						error,
						http: { endpoint: '/api/webhook/symbol-analysis', method: 'POST', statusCode: 502, requestId },
						extra: { provider: 'tradingview-mcp', failureClass: 'upstream_failure' },
					});
				} catch (monitoringError) {
					console.warn('[SymbolAnalysis] Sentry capture failed:', monitoringError.message);
				}
				return res.status(502).json({
					success: false,
					error: error.message,
					code: 'SYMBOL_ANALYSIS_FAILED',
					requestId,
					totalDurationMs: Date.now() - startTime,
				});
			}

			sentryService.captureRuntimeError({
				channel: 'http-alert',
				error,
				http: { endpoint: '/api/webhook/symbol-analysis', method: 'POST', statusCode: 500, requestId },
			});
			return res.status(500).json({
				success: false,
				error: 'Internal server error. Please try again later.',
				code: 'INTERNAL_ERROR',
				requestId,
			});
		} finally {
			if (deadline) deadline.clear();
		}
	};
}

function parseSymbolAnalysisRequest(req) {
	const body = req && req.body;
	if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.symbol !== 'string') {
		throw new ExpandedAnalysisAlertRequestError('symbol must be a string in EXCHANGE:SYMBOL format');
	}

	return parseExpandedAnalysisAlertRequest({ body: { ...body, symbols: [body.symbol] } });
}

function normalizeAnalysis({ analysis = {}, input, parsed, multiTimeframe, side }) {
	const technical = analysis.technical || analysis;
	const rawPrice = technical.price_data || {};
	const rawIndicators = technical.technical_indicators || {};
	const rawBollinger = technical.bollinger_analysis || technical.bollinger_bands || {};
	const price = numberOrNull(rawPrice.current_price ?? rawPrice.close);
	const close = numberOrNull(rawPrice.close ?? rawPrice.current_price);
	const high = numberOrNull(rawPrice.high);
	const low = numberOrNull(rawPrice.low);
	const priceData = {
		...rawPrice,
		close,
		current_price: numberOrNull(rawPrice.current_price ?? rawPrice.close),
		change_percent: numberOrNull(rawPrice.change_percent),
		high,
		low,
		candle_range_percent: numberOrNull(rawPrice.candle_range_percent)
			?? (price && high !== null && low !== null ? ((high - low) / price) * 100 : null),
	};
	const rawVolume = analysis.volume_analysis || technical.volume_analysis || {};
	const volumeAnalysis = {
		...rawVolume,
		current_volume: numberOrNull(rawVolume.current_volume ?? rawVolume.volume ?? rawPrice.volume),
		average_volume: numberOrNull(rawVolume.average_volume),
		volume_ratio: numberOrNull(rawVolume.volume_ratio),
		volume_strength: rawVolume.volume_strength ?? null,
	};
	const technicalIndicators = {
		...rawIndicators,
		RSI: numberOrNull(rawIndicators.RSI ?? rawIndicators.rsi ?? technical.rsi?.value),
		BB_position: rawIndicators.BB_position ?? rawBollinger.position ?? null,
		BB_upper: numberOrNull(rawIndicators.BB_upper ?? rawBollinger.upper ?? rawBollinger.bb_upper),
		BB_lower: numberOrNull(rawIndicators.BB_lower ?? rawBollinger.lower ?? rawBollinger.bb_lower),
		SMA20: numberOrNull(rawIndicators.SMA20 ?? rawIndicators.sma20),
		MACD: numberOrNull(rawIndicators.MACD ?? rawIndicators.macd),
		MACD_signal: numberOrNull(rawIndicators.MACD_signal ?? rawIndicators.macd_signal),
		ATR: numberOrNull(rawIndicators.ATR ?? rawIndicators.atr ?? technical.atr?.value ?? technical.atr ?? technical.volatility?.atr),
		ADX: numberOrNull(rawIndicators.ADX ?? rawIndicators.adx ?? technical.adx?.value),
	};
	const assessment = analysis.overall_assessment || technical.overall_assessment || {};
	const overallAssessment = {
		...assessment,
		bullish_signals: numberOrNull(assessment.bullish_signals),
		bearish_signals: numberOrNull(assessment.bearish_signals),
		warning_signals: numberOrNull(assessment.warning_signals),
	};
	const signals = analysis.signals ?? technical.signals ?? [];
	const risk = buildRisk({ technical, price, side });

	return {
		...analysis,
		symbol: input.raw,
		exchange: input.exchange,
		asset: input.symbol,
		timeframe: parsed.timeframe,
		price_data: priceData,
		volume_analysis: volumeAnalysis,
		technical_indicators: technicalIndicators,
		signals,
		overall_assessment: overallAssessment,
		risk,
		decision: buildDecision({ analysis, technical, side, risk, price, technicalIndicators }),
		multi_timeframe: multiTimeframe,
	};
}

function buildRisk({ technical, price, side }) {
	if (!side || price === null) return emptyRisk(side, price);

	const indicators = technical.technical_indicators || {};
	const bollinger = technical.bollinger_analysis || {};
	const currentBollinger = technical.bollinger_bands || {};
	const atr = numberOrNull(indicators.ATR ?? indicators.atr ?? technical.atr?.value ?? technical.atr ?? technical.volatility?.atr);
	const stop = getStopLossMeta(price, atr, bollinger, currentBollinger, side);
	const directional = stop.source !== 'fallback'
		&& stop.value > 0
		&& (side === 'SELL' ? stop.value > price : stop.value < price);
	let target = getTakeProfitTarget(price, atr, bollinger, currentBollinger, technical, side);
	const minRatio = getMinRiskRewardRatio();
	let ratio = target !== null ? getRiskRewardRatio(price, stop.value, target, side) : null;

	// Plan-quality gate: when the nearest target yields a sub-floor plan and we
	// have a valid stop, walk documented alternatives before giving up.
	if (directional && ratio !== null && ratio < minRatio) {
		const upgraded = selectTakeProfitWithMinRatio({
			price,
			stopLoss: stop.value,
			atr,
			bollinger,
			currentBollinger,
			techData: technical,
			side,
			minRatio,
		});
		if (upgraded !== null) {
			target = upgraded;
			ratio = getRiskRewardRatio(price, stop.value, target, side);
		}
	}

	const meetsFloor = ratio !== null && ratio >= minRatio;
	const directionalOk = directional
		&& target !== null
		&& target > 0
		&& (side === 'SELL' ? target < price : target > price);
	const valid = directionalOk && meetsFloor;
	const rejectionReason = !directionalOk
		? 'invalid_directional_levels'
		: !meetsFloor
			? 'risk_reward_below_minimum'
			: null;

	return {
		entry_price: price,
		side,
		stop_loss: stop.value,
		target,
		invalidation_level: stop.value,
		risk_reward_ratio: ratio,
		source: stop.source,
		valid,
		rejectionReason,
		minRiskRewardRatio: minRatio,
	};
}

function emptyRisk(side, price) {
	return {
		entry_price: price,
		side: side || null,
		stop_loss: null,
		target: null,
		invalidation_level: null,
		risk_reward_ratio: null,
		source: 'missing',
		valid: false,
		rejectionReason: 'missing_levels',
		minRiskRewardRatio: getMinRiskRewardRatio(),
	};
}

function buildDecision({ analysis, technical, side, risk, price, technicalIndicators }) {
	const reasons = [];
	const warnings = [];
	const confluence = analysis.confluence || {};
	const dataSufficient = Boolean(price !== null && technicalIndicators.RSI !== null && side && risk.valid);
	if (confluence.recommendation || confluence.action) reasons.push(`Confluencia: ${confluence.recommendation || confluence.action}`);
	if (technicalIndicators.RSI !== null) reasons.push(`RSI: ${technicalIndicators.RSI}`);
	if (technical.market_structure?.trend) reasons.push(`Tendencia: ${technical.market_structure.trend}`);
	if (technical.macd?.direction) reasons.push(`MACD: ${technical.macd.direction}`);
	if (!side) warnings.push('No hay una dirección BUY/SELL concluyente.');
	if (technicalIndicators.RSI === null) warnings.push('Falta el RSI para una decisión accionable.');
	if (risk.rejectionReason === 'risk_reward_below_minimum') {
		const formattedRatio = Number.isFinite(risk.risk_reward_ratio)
			? risk.risk_reward_ratio.toFixed(2)
			: 'N/D';
		warnings.push(
			`⚠️ R/R ${formattedRatio} por debajo del mínimo ${risk.minRiskRewardRatio} — plan descartado.`,
		);
	} else if (risk.rejectionReason === 'invalid_directional_levels') {
		warnings.push('El riesgo calculado no tiene niveles direccionales válidos.');
	}
	if (!Number.isFinite(price)) warnings.push('Falta el precio actual.');

	return {
		action: dataSufficient ? side : 'NO_TRADE',
		confidence: confluence.confidence ?? null,
		dataSufficient,
		reasons,
		warnings,
	};
}

function inferSide(analysis = {}) {
	const confluence = String(analysis.confluence?.recommendation || analysis.confluence?.action || '').toUpperCase();
	if (confluence.includes('SELL')) return 'SELL';
	if (confluence.includes('BUY')) return 'BUY';
	const sentiment = String(analysis.sentiment?.sentiment_label || analysis.market_sentiment?.overall_sentiment || '').toUpperCase();
	if (sentiment.includes('BEARISH') || sentiment.includes('BAJISTA')) return 'SELL';
	if (sentiment.includes('BULLISH') || sentiment.includes('ALCISTA')) return 'BUY';

	const technical = analysis.technical || {};
	const indicators = technical.technical_indicators || analysis.technical_indicators || {};
	const rsi = numberOrNull(indicators.RSI ?? indicators.rsi);
	const macd = numberOrNull(indicators.MACD ?? indicators.macd);
	const macdSignal = numberOrNull(indicators.MACD_signal ?? indicators.macd_signal);
	const bias = String(
		technical.timeframe_context?.bias
			?? technical.market_structure?.bias
			?? technical.trend_bias
			?? '',
	).toUpperCase();
	const bollingerPosition = String(
		indicators.BB_position
			?? technical.bollinger_bands?.position
			?? technical.bollinger_analysis?.position
			?? '',
	).toUpperCase();

	// Intermediate tier: alignment between documented signals before falling back
	// to bare RSI extremes. Two-or-more aligned signals resolve the side.
	const bullishVotes = [];
	const bearishVotes = [];
	if (bias.includes('BULLISH') || bias.includes('ALCISTA')) bullishVotes.push('timeframe_context');
	else if (bias.includes('BEARISH') || bias.includes('BAJISTA')) bearishVotes.push('timeframe_context');
	if (macd !== null && macdSignal !== null) {
		if (macd > macdSignal) bullishVotes.push('macd');
		else if (macd < macdSignal) bearishVotes.push('macd');
	} else if (macd !== null) {
		if (macd > 0) bullishVotes.push('macd');
		else if (macd < 0) bearishVotes.push('macd');
	}
	if (bollingerPosition.includes('LOWER')) bullishVotes.push('bollinger');
	else if (bollingerPosition.includes('UPPER')) bearishVotes.push('bollinger');

	if (bullishVotes.length >= 2 && bullishVotes.length > bearishVotes.length) return 'BUY';
	if (bearishVotes.length >= 2 && bearishVotes.length > bullishVotes.length) return 'SELL';

	// Final fallback: bare RSI extremes keep their existing behavior.
	return rsi !== null && rsi > 70 ? 'SELL' : rsi !== null && rsi < 30 ? 'BUY' : null;
}

function getMinRiskRewardRatio() {
	const value = getRuntimeConfig().SYMBOL_ANALYSIS_MIN_RISK_REWARD_RATIO;
	return Number.isFinite(value) && value > 0 ? value : 1.5;
}

function getTimeoutMs() {
	const value = getRuntimeConfig().EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS;
	return Number.isFinite(value) && value > 0 ? Math.min(value, 120000) : 60000;
}

function createDeadline(timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(new Error(`Symbol analysis timeout after ${timeoutMs}ms`)), timeoutMs);
	return { signal: controller.signal, clear: () => clearTimeout(timeoutId) };
}

function numberOrNull(value) {
	if (value === null || value === undefined || (typeof value === 'string' && value.trim() === '')) return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

module.exports = { postSymbolAnalysis, inferSide, normalizeAnalysis };
