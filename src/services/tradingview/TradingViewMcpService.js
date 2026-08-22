/* global fetch, AbortController */

const { sendWithRetry } = require('../../lib/retryHelper');
const { parseTradingViewSignal, normalizeTradingViewTimeframe } = require('./parseTradingViewSignal');
const {
	getStopLossMeta,
	getTakeProfitTarget,
	getRiskRewardRatio,
} = require('./expandedAnalysisAlertReport');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_TRADINGVIEW_MCP_URL = 'https://tradingview-mcp-yp6b.onrender.com/mcp';

function getAbortMessage(signal, fallback) {
	const reason = signal && signal.reason;
	if (reason instanceof Error && reason.message) {
		return reason.message;
	}

	if (typeof reason === 'string' && reason) {
		return reason;
	}

	return fallback;
}

function createRuntimeStatus() {
	return {
		status: 'unknown',
		lastCheckedAt: null,
		lastSuccessAt: null,
		lastFailureAt: null,
		lastErrorCategory: null,
		successCount: 0,
		failureCount: 0,
	};
}

const SETUP_TYPES = new Set(['breakout', 'mean_reversion', 'trend_continuation', 'reversal']);

function inferSetupType(analysis, side) {
	const explicit = typeof analysis.setup_type === 'string' ? analysis.setup_type.trim().toLowerCase() : '';
	if (SETUP_TYPES.has(explicit)) {
		return explicit;
	}

	const trend = String(analysis.market_structure?.trend || '').toLowerCase();
	const aligned = side === 'SELL'
		? /bearish|downtrend|bajista/.test(trend)
		: /bullish|uptrend|alcista/.test(trend);
	if (aligned) {
		return 'trend_continuation';
	}

	const bollingerPosition = String(
		analysis.bollinger_bands?.position || analysis.bollinger_analysis?.position || '',
	).toLowerCase();
	if (/upper|lower|overbought|oversold/.test(bollingerPosition)) {
		return 'mean_reversion';
	}

	return null;
}

function isValidRiskLevel(value, price, side, role) {
	if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(price) || price <= 0) {
		return false;
	}

	const isShort = side === 'SELL';
	return role === 'stop'
		? (isShort ? value > price : value < price)
		: (isShort ? value < price : value > price);
}

class TradingViewMcpService {
	constructor(config = {}) {
		this.config = config;
		this.logger = config.logger || console;
		this.requestCounter = 0;
		this.runtimeStatus = createRuntimeStatus();
		this.volumeRuntimeStatus = createRuntimeStatus();
	}

	isEnabled() {
		return getRuntimeConfig().ENABLE_TRADINGVIEW_MCP_ENRICHMENT;
	}

	getConfig() {
		const runtimeConfig = getRuntimeConfig();
		const timeoutMs = parseInt(this.config.timeoutMs || runtimeConfig.TRADINGVIEW_MCP_TIMEOUT_MS, 10);
		const maxRetries = parseInt(this.config.maxRetries || runtimeConfig.TRADINGVIEW_MCP_MAX_RETRIES, 10);
		const defaultExchange = (this.config.defaultExchange || process.env.TRADINGVIEW_MCP_DEFAULT_EXCHANGE || 'BINANCE').toUpperCase();
		const defaultTimeframe = normalizeTradingViewTimeframe(
			this.config.defaultTimeframe || runtimeConfig.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '1h',
			'1h',
		);
		const enrichmentBudgetMs = parseInt(
			this.config.enrichmentBudgetMs || runtimeConfig.TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS,
			10,
		);

		return {
			url: this.config.url || process.env.TRADINGVIEW_MCP_URL || DEFAULT_TRADINGVIEW_MCP_URL,
			timeoutMs,
			maxRetries,
			defaultExchange,
			defaultTimeframe,
			enrichmentBudgetMs,
		};
	}

	getStatus({ enabled = this.isEnabled(), runtimeStatus = this.runtimeStatus } = {}) {
		const { url } = this.getConfig();
		const configured = typeof url === 'string' && url.trim().length > 0;
		const status = !enabled ? 'disabled' : !configured ? 'misconfigured' : runtimeStatus.status;

		return {
			enabled,
			configured,
			...runtimeStatus,
			ready: enabled && configured && status === 'ready',
			status,
		};
	}

	getVolumeConfirmationStatus({ enabled = this.isEnabled() } = {}) {
		return this.getStatus({ enabled, runtimeStatus: this.volumeRuntimeStatus });
	}

	async enrichFromAlertText(alertText, options = {}) {
		const { defaultTimeframe } = this.getConfig();
		const parsed = parseTradingViewSignal(alertText, { defaultTimeframe });
		if (!parsed) {
			return null;
		}

		return this.enrichFromSignal(parsed, options);
	}

	async enrichFromSignal(parsedSignal, options = {}) {
		const cfg = this.getConfig();
		const budgetMs = options.budgetMs || cfg.enrichmentBudgetMs;
		const symbol = parsedSignal.symbol.toUpperCase();
		const exchange = (parsedSignal.exchange || cfg.defaultExchange).toUpperCase();
		const timeframe = normalizeTradingViewTimeframe(parsedSignal.timeframe || parsedSignal.rawTimeframe, cfg.defaultTimeframe);

		// Create an overall budget controller for the enrichment timeout.
		// When the budget is exceeded, all in-flight MCP calls are aborted.
		const budgetController = new AbortController();
		let budgetTimer = null;
		if (budgetMs > 0) {
			budgetTimer = setTimeout(() => {
				budgetController.abort(new Error(`TradingView MCP enrichment budget exceeded (${budgetMs}ms)`));
			}, budgetMs);
		}

		const cleanBudget = () => {
			if (budgetTimer) {
				clearTimeout(budgetTimer);
				budgetTimer = null;
			}
		};

		const result = await sendWithRetry(async ({ signal: retrySignal }) => {
			try {
				const combinedSignal = retrySignal || budgetController.signal;
				const analysis = await this.callCoinAnalysis({ symbol, exchange, timeframe, signal: combinedSignal });
				return { success: true, channel: 'tradingview-mcp', analysis };
			} catch (error) {
				return { success: false, channel: 'tradingview-mcp', error: error.message };
			}
		}, cfg.maxRetries, this.logger, { signal: budgetController.signal });

		// Budget still applies for volume confirmation, but the budget timer
		// is stopped after the entire enrichment (coin + volume) completes.
		if (!result.success) {
			cleanBudget();
			throw new Error(`TradingView MCP call failed: ${result.error || 'unknown error'}`);
		}

		let volumeAnalysis = null;
		if (getRuntimeConfig().ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION) {
			const volumeTimeoutMs = Math.min(5000, Math.max(1000, (budgetMs || 12000) / 4));
			const controller = new AbortController();
			const timeoutId = setTimeout(() => {
				controller.abort(new Error(`TradingView MCP volume confirmation timeout after ${volumeTimeoutMs}ms`));
			}, volumeTimeoutMs);

			const vResult = await sendWithRetry(async ({ signal: retrySignal }) => {
				try {
					const combinedSignal = retrySignal || controller.signal;
					const volConfirm = await this.callVolumeConfirmation({ symbol, exchange, timeframe, signal: combinedSignal });
					return { success: true, channel: 'tradingview-mcp', volConfirm };
				} catch (error) {
					return { success: false, channel: 'tradingview-mcp', error: error.message };
				}
			}, 1, this.logger, { signal: controller.signal });

			clearTimeout(timeoutId);

			if (vResult.success) {
				volumeAnalysis = vResult.volConfirm;
			} else {
				this.logger.warn(`[TradingViewMcpService] Volume confirmation failed for ${symbol}: ${vResult.error || 'unknown error'}`);
			}
		}

		// Confluence enrichment: optional call to combined_analysis for broader context
		// Gated by ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true (fail-open: errors do not block delivery).
		// The confluence call is wired to BOTH its own per-call timeout AND the overall budget signal
		// (via AbortSignal.any) so an exhausted enrichment budget cancels it immediately.
		let confluenceAnalysis = null;
		let multiTimeframeAnalysis = null;
		if (process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT === 'true' && !budgetController.signal.aborted) {
			const confluenceTimeoutMs = Math.min(8000, Math.max(2000, (budgetMs || 12000) / 2));
			const confluenceController = new AbortController();
			const confluenceTimeoutId = setTimeout(() => {
				confluenceController.abort(new Error(`TradingView MCP confluence timeout after ${confluenceTimeoutMs}ms`));
			}, confluenceTimeoutMs);

			// Respect both the per-call timeout and the overall enrichment budget
			const combinedSignal = AbortSignal.any([confluenceController.signal, budgetController.signal]);

			try {
				confluenceAnalysis = await this.callCombinedAnalysis({
					symbol,
					exchange,
					timeframe,
					signal: combinedSignal,
				});
				console.debug(`[TradingViewMcpService] Confluence analysis fetched for ${symbol}`);
				if (process.env.ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME === 'true' && !budgetController.signal.aborted) {
					multiTimeframeAnalysis = await this.callMultiTimeframeAnalysis({
						symbol,
						exchange,
						signal: combinedSignal,
					});
					console.debug(`[TradingViewMcpService] Multi-timeframe confluence analysis fetched for ${symbol}`);
				}
			} catch (error) {
				this.logger.warn(`[TradingViewMcpService] Confluence enrichment failed for ${symbol} (fail-open): ${error.message}`);
			} finally {
				clearTimeout(confluenceTimeoutId);
			}
		}

		cleanBudget();
		return this._toEnrichedAlert(parsedSignal.rawText || '', { symbol, exchange, timeframe, side: parsedSignal.side }, result.analysis, volumeAnalysis, confluenceAnalysis, multiTimeframeAnalysis);
	}

	async callCoinAnalysis({ symbol, exchange, timeframe, signal }) {
		return this._withRuntimeStatus(async () => {
			const rpcResult = await this._callTool('coin_analysis', {
				symbol,
				exchange,
				timeframe,
			}, { signal });
			const normalizedResult = this._unwrapSchemaResult(rpcResult);

			if (normalizedResult && normalizedResult.error) {
				throw new Error(normalizedResult.error);
			}

			if (!normalizedResult || typeof normalizedResult !== 'object' || Array.isArray(normalizedResult)) {
				throw new Error('TradingView MCP coin_analysis returned invalid payload');
			}

			return normalizedResult;
		}, { signal });
	}

	async analyzeSymbolIdentifier({ raw, exchange, symbol, timeframe, analysisMode, signal }) {
		const cfg = this.getConfig();
		const result = await sendWithRetry(async () => {
			try {
				let analysis;
				if (analysisMode === 'combined') {
					analysis = await this.callCombinedAnalysis({ symbol, exchange, timeframe, signal });
				} else {
					analysis = await this.callCoinAnalysis({ symbol, exchange, timeframe, signal });
				}
				return { success: true, channel: 'tradingview-mcp', analysis };
			} catch (error) {
				return { success: false, channel: 'tradingview-mcp', error: error.message };
			}
		}, cfg.maxRetries, this.logger, { signal });

		if (!result.success) {
			throw new Error(`TradingView MCP call failed for ${raw || `${exchange}:${symbol}`}: ${result.error || 'unknown error'}`);
		}

		return {
			...result.analysis,
			requested_symbol: raw,
			requested_exchange: exchange,
			requested_timeframe: timeframe,
		};
	}

	async callCombinedAnalysis({ symbol, exchange, timeframe, signal }) {
		return this._withRuntimeStatus(async () => {
			const rpcResult = await this._callTool('combined_analysis', {
				symbol,
				exchange,
				timeframe,
			}, { signal });
			const normalizedResult = this._unwrapSchemaResult(rpcResult);

			if (normalizedResult && normalizedResult.error) {
				throw new Error(normalizedResult.error);
			}

			if (!normalizedResult || typeof normalizedResult !== 'object' || Array.isArray(normalizedResult)) {
				throw new Error('TradingView MCP combined_analysis returned invalid payload');
			}

			return normalizedResult;
		}, { signal });
	}

	async callMultiTimeframeAnalysis({ symbol, exchange, signal }) {
		return this._withRuntimeStatus(async () => {
			const rpcResult = await this._callTool('multi_timeframe_analysis', {
				symbol,
				exchange,
			}, { signal });
			const normalizedResult = this._unwrapSchemaResult(rpcResult);

			if (normalizedResult && normalizedResult.error) {
				throw new Error(normalizedResult.error);
			}

			if (!normalizedResult || typeof normalizedResult !== 'object' || Array.isArray(normalizedResult)) {
				throw new Error('TradingView MCP multi_timeframe_analysis returned invalid payload');
			}

			return normalizedResult;
		}, { signal });
	}

	async callVolumeConfirmation({ symbol, exchange, timeframe, signal }) {
		return this._withRuntimeStatus(async () => {
			const fullSymbol = symbol.includes(':') ? symbol : `${exchange}:${symbol}`;
			const rpcResult = await this._callTool('volume_confirmation_analysis', {
				symbol: fullSymbol,
				exchange,
				timeframe,
			}, { signal });
			const normalizedResult = this._unwrapSchemaResult(rpcResult);

			if (normalizedResult && normalizedResult.error) {
				throw new Error(normalizedResult.error);
			}

			if (!normalizedResult || typeof normalizedResult !== 'object' || Array.isArray(normalizedResult)) {
				throw new Error('TradingView MCP volume_confirmation_analysis returned invalid payload');
			}

			return normalizedResult;
		}, { signal, runtimeStatusKey: 'volumeRuntimeStatus' });
	}

	async callScanTool(toolName, args = {}, options = {}) {
		const { signal } = options;
		const cfg = this.getConfig();

		return this._withRuntimeStatus(async () => {
			const result = await sendWithRetry(async () => {
				try {
					const rpcResult = await this._callTool(toolName, args, { signal });
					return { success: true, channel: 'tradingview-mcp', data: rpcResult };
				} catch (error) {
					return { success: false, channel: 'tradingview-mcp', error: error.message };
				}
			}, cfg.maxRetries, this.logger, { signal });

			if (!result.success) {
				throw new Error(`TradingView MCP scan ${toolName} failed: ${result.error || 'unknown error'}`);
			}

			return this._normalizeScanResult(result.data);
		}, { signal });
	}

	_normalizeScanResult(data) {
		if (Array.isArray(data)) {
			return data;
		}

		if (data && typeof data === 'object' && Array.isArray(data.result)) {
			return data.result;
		}

		if (data && typeof data === 'object' && !Array.isArray(data)) {
			const unwrapped = this._unwrapSchemaResult(data);
			if (Array.isArray(unwrapped)) {
				return unwrapped;
			}

			if (unwrapped && typeof unwrapped === 'object' && Array.isArray(unwrapped.result)) {
				return unwrapped.result;
			}

			return [unwrapped];
		}

		return [];
	}

	async _callTool(toolName, args = {}, options = {}) {
		const { signal } = options;
		const initializeRequest = {
			jsonrpc: '2.0',
			id: this._nextRequestId('initialize'),
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: {
					name: 'cabros-bot',
					version: '0.1.0',
				},
			},
		};

		const initResponse = await this._rpcRequest(initializeRequest, { signal });
		const sessionId = initResponse.sessionId;

		if (!sessionId) {
			throw new Error('TradingView MCP did not return mcp-session-id header');
		}

		await this._rpcRequest({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
			params: {},
		}, { sessionId, expectResponse: false, signal });

		const toolCallRequest = {
			jsonrpc: '2.0',
			id: this._nextRequestId('tool'),
			method: 'tools/call',
			params: {
				name: toolName,
				arguments: args,
			},
		};

		const toolResponse = await this._rpcRequest(toolCallRequest, { sessionId, signal });
		const callResult = toolResponse.rpc && toolResponse.rpc.result;

		if (!callResult) {
			throw new Error(`TradingView MCP tool ${toolName} returned empty result`);
		}

		if (callResult.isError) {
			const errorMessage = this._extractContentText(callResult) || `TradingView MCP tool ${toolName} returned isError=true`;
			throw new Error(errorMessage);
		}

		if (callResult.structuredContent && typeof callResult.structuredContent === 'object') {
			return callResult.structuredContent;
		}

		const contentText = this._extractContentText(callResult);
		if (!contentText) {
			throw new Error(`TradingView MCP tool ${toolName} returned empty content`);
		}

		return this._parseToolJson(contentText);
	}

	_extractContentText(callResult) {
		if (!callResult || !Array.isArray(callResult.content)) {
			return '';
		}

		const textBlock = callResult.content.find(item => item && item.type === 'text' && typeof item.text === 'string');
		return textBlock ? textBlock.text : '';
	}

	_parseToolJson(text) {
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new Error(`TradingView MCP returned non-JSON tool content: ${error.message}`);
		}
	}

	async _rpcRequest(payload, options = {}) {
		const cfg = this.getConfig();
		const { sessionId, expectResponse = true, signal } = options;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => {
			controller.abort(new Error(`TradingView MCP timeout after ${cfg.timeoutMs}ms`));
		}, cfg.timeoutMs);
		let onAbort = null;

		if (signal) {
			if (signal.aborted) {
				clearTimeout(timeoutId);
				throw new Error(getAbortMessage(signal, 'TradingView MCP request aborted'));
			}

			onAbort = () => {
				controller.abort(signal.reason || new Error('TradingView MCP request aborted'));
			};
			signal.addEventListener('abort', onAbort, { once: true });
		}

		const headers = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream, application/json',
		};

		if (sessionId) {
			headers['mcp-session-id'] = sessionId;
		}

		let response;
		let bodyText;
		try {
			response = await fetch(cfg.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
			bodyText = await response.text();
		} catch (error) {
			if (controller.signal.aborted || error.name === 'AbortError') {
				if (signal && signal.aborted) {
					throw new Error(getAbortMessage(signal, 'TradingView MCP request aborted'));
				}

				throw new Error(`TradingView MCP timeout after ${cfg.timeoutMs}ms`);
			}

			throw new Error(`TradingView MCP request failed: ${error.message}`);
		} finally {
			clearTimeout(timeoutId);
			if (signal && onAbort) {
				signal.removeEventListener('abort', onAbort);
			}
		}

		const nextSessionId = response.headers.get('mcp-session-id') || sessionId;

		if (!response.ok && !(response.status === 202 && !expectResponse)) {
			throw new Error(`TradingView MCP HTTP ${response.status}: ${bodyText || 'empty response'}`);
		}

		if (!expectResponse) {
			return {
				rpc: null,
				sessionId: nextSessionId,
				status: response.status,
				raw: bodyText,
			};
		}

		const rpc = this._decodeRpcBody(bodyText, response.headers.get('content-type'), payload.id);

		if (rpc && rpc.error) {
			throw new Error(rpc.error.message || 'TradingView MCP returned an RPC error');
		}

		return {
			rpc,
			sessionId: nextSessionId,
			status: response.status,
			raw: bodyText,
		};
	}

	_decodeRpcBody(bodyText, contentType = '', expectedId = null) {
		if (!bodyText) {
			throw new Error('TradingView MCP returned an empty body');
		}

		if (contentType && contentType.includes('application/json')) {
			try {
				return JSON.parse(bodyText);
			} catch {
				throw new Error('TradingView MCP returned invalid JSON response');
			}
		}

		const dataLines = bodyText
			.split('\n')
			.map(line => line.trim())
			.filter(line => line.startsWith('data:'))
			.map(line => line.substring(5).trim())
			.filter(Boolean);

		if (dataLines.length === 0) {
			throw new Error(`TradingView MCP returned non-SSE response: ${bodyText.substring(0, 200)}`);
		}

		const parsedPayloads = dataLines
			.map(line => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);

		if (parsedPayloads.length === 0) {
			throw new Error('TradingView MCP SSE payload could not be parsed as JSON');
		}

		if (expectedId) {
			const matched = parsedPayloads.find(item => String(item.id) === String(expectedId));
			if (matched) {
				return matched;
			}
		}

		return parsedPayloads[0];
	}

	_toEnrichedAlert(originalText, signal, analysis = {}, volumeAnalysis = null, confluenceAnalysis = null, multiTimeframeAnalysis = null) {
		const { side, symbol, exchange, timeframe } = signal;
		const sideLabel = side === 'SELL' ? 'VENTA' : 'COMPRA';
		const sideSentiment = side === 'SELL' ? -0.55 : 0.55;
		const rawPriceData = (analysis && (analysis.price_data || analysis.price)) || {};
		const validCurrentPrice = typeof rawPriceData.current_price === 'number'
			&& Number.isFinite(rawPriceData.current_price)
			&& rawPriceData.current_price > 0
			? rawPriceData.current_price
			: null;
		const priceData = {
			...rawPriceData,
			current_price: validCurrentPrice,
		};
		const indicators = (analysis && analysis.technical_indicators) || {};
		const rsiData = (analysis && analysis.rsi) || {};
		const adxData = (analysis && analysis.adx) || {};
		const legacyBollinger = (analysis && analysis.bollinger_analysis) || {};
		const bollingerBands = (analysis && analysis.bollinger_bands) || {};
		const supportResistance = (analysis && analysis.support_resistance) || {};
		const marketSentiment = (analysis && analysis.market_sentiment) || {};
		const marketStructure = (analysis && analysis.market_structure) || {};
		const timeframeContext = (analysis && analysis.timeframe_context) || {};
		const atr = this._firstNumber([
			indicators.atr,
			analysis && analysis.atr && typeof analysis.atr === 'object' ? analysis.atr.value : analysis && analysis.atr,
			analysis && analysis.volatility && analysis.volatility.atr,
		], null);
		const atrStop = validCurrentPrice === null ? null : side === 'SELL' ? validCurrentPrice + (atr * 1.5) : validCurrentPrice - (atr * 1.5);
		const atrTarget = validCurrentPrice === null ? null : side === 'SELL' ? validCurrentPrice - (atr * 3) : validCurrentPrice + (atr * 3);
		const usableAtr = Number.isFinite(atr)
			&& atr > 0
			&& isValidRiskLevel(atrStop, validCurrentPrice, side, 'stop')
			&& isValidRiskLevel(atrTarget, validCurrentPrice, side, 'target')
			? atr
			: null;
		const stopLossMeta = getStopLossMeta(validCurrentPrice, usableAtr, legacyBollinger, bollingerBands, side);
		const targetLevel = getTakeProfitTarget(validCurrentPrice, usableAtr, legacyBollinger, bollingerBands, analysis, side);
		const riskRewardRatio = getRiskRewardRatio(validCurrentPrice, stopLossMeta.value, targetLevel, side);
		const setupType = inferSetupType(analysis, side);
		const riskMetadata = isValidRiskLevel(stopLossMeta.value, validCurrentPrice, side, 'stop')
			&& isValidRiskLevel(targetLevel, validCurrentPrice, side, 'target')
			&& Number.isFinite(riskRewardRatio)
			&& riskRewardRatio > 0
			? {
				invalidation_level: stopLossMeta.value,
				target_level: targetLevel,
				risk_reward_ratio: riskRewardRatio,
				...(setupType ? { setup_type: setupType } : {}),
			}
			: {};

		const rating = this._firstNumber([
			marketSentiment.overall_rating,
			marketStructure.trend_score,
			legacyBollinger.rating,
		], 0);
		const ratingBias = Math.max(-0.35, Math.min(0.35, rating / 10));
		let sentimentScore = Math.max(-1, Math.min(1, sideSentiment + ratingBias));

		const rsiValue = this._firstNumber([rsiData.value, indicators.rsi], null);
		const adxValue = this._firstNumber([adxData.value, indicators.adx], null);
		const rsiSignal = rsiData.signal || indicators.rsi_signal || 'N/A';
		const trendStrength = adxData.trend_strength || indicators.trend_strength || 'N/A';
		const bollingerPosition = bollingerBands.position || legacyBollinger.position || 'N/A';
		const momentumLabel = marketSentiment.momentum || marketSentiment.buy_sell_signal || marketStructure.trend || 'N/A';
		const trendLabel = marketStructure.trend || timeframeContext.bias || 'N/A';

		const supports = this._compactUnique([
			this._formatLevel(supportResistance.nearest_support),
			this._formatLevel(supportResistance.support_1),
			this._formatLevel(supportResistance.support_2),
			this._formatLevel(supportResistance.support_3),
			this._formatLevel(bollingerBands.lower),
			this._formatLevel(legacyBollinger.bb_lower),
			this._formatLevel(priceData.low),
		]).slice(0, 4);

		const resistances = this._compactUnique([
			this._formatLevel(supportResistance.nearest_resistance),
			this._formatLevel(supportResistance.resistance_1),
			this._formatLevel(supportResistance.resistance_2),
			this._formatLevel(supportResistance.resistance_3),
			this._formatLevel(bollingerBands.upper),
			this._formatLevel(legacyBollinger.bb_upper),
			this._formatLevel(priceData.high),
		]).slice(0, 4);

		const insights = this._compactUnique([
			`Señal detectada: ${sideLabel} para ${symbol} en ${timeframe} (${exchange})`,
			`Precio actual: ${this._formatLevel(priceData.current_price)} (${this._formatPercent(priceData.change_percent)})`,
			`RSI ${this._formatLevel(rsiValue)} (${rsiSignal}) · ADX ${this._formatLevel(adxValue)} (${trendStrength})`,
			`Tendencia ${trendLabel} · Bollinger ${bollingerPosition} · Momentum ${momentumLabel} · Rating ${rating}`,
		]);

		if (volumeAnalysis && volumeAnalysis.volume_analysis) {
			const volData = volumeAnalysis.volume_analysis;
			const ratio = volData.volume_ratio;
			if (typeof ratio === 'number' && Number.isFinite(ratio)) {
				const confirms = ratio >= 1.2 ? 'YES' : 'NO';
				insights.push(`Volume confirms: ${confirms} (${this._formatRatio(ratio)} avg)`);
			}
		}

		// Confluence insight: append summary line using the .confluence sub-object from combined_analysis.
		// The MCP payload shape (established in expandedAnalysisAlertReport.js) is:
		//   confluenceAnalysis.confluence = { recommendation, confidence, signals_agree }
		if (confluenceAnalysis) {
			const conf = confluenceAnalysis.confluence;
			if (conf) {
				const rec = conf.recommendation || conf.action || null;
				const confidence = conf.confidence || null;
				const agree = conf.signals_agree === true || String(conf.signals_agree).toLowerCase() === 'yes';
				const contradictory = this._isContradictoryConfluence(side, rec, conf.signals_agree);
				const confParts = [];
				if (rec) confParts.push(`${contradictory ? 'Confluencia contradictoria' : 'Confluencia'}: ${rec}`);
				if (agree) confParts.push('Señales Alineadas ✅');
				if (contradictory) confParts.push('Señales Mixtas ⚠️');
				if (confidence) confParts.push(`Confianza: ${confidence}`);
				if (confParts.length > 0) {
					insights.push(confParts.join(' · '));
				}
				if (contradictory) {
					sentimentScore = Math.max(-0.15, Math.min(0.15, sentimentScore * 0.15));
				}
			}
		}

		if (multiTimeframeAnalysis) {
			const alignment = this._formatMultiTimeframeSummary(multiTimeframeAnalysis);
			if (alignment) {
				insights.push(`Multi-timeframe: ${alignment}`);
			}
		}

		const sentiment = sentimentScore > 0.15 ? 'BULLISH' : sentimentScore < -0.15 ? 'BEARISH' : 'NEUTRAL';
		const extraText = getRuntimeConfig().ENABLE_MESSAGE_FOOTER_METADATA
			? '*Grounding*: `tradingview-mcp`'
			: '';

		return {
			original_text: originalText,
			tradingViewEnrichmentApplied: true,
			sentiment,
			sentiment_score: sentimentScore,
			current_price: validCurrentPrice,
			price_data: priceData,
			insights,
			technical_levels: {
				supports,
				resistances,
			},
			sources: [],
			truncated: false,
			extraText,
			confluenceData: confluenceAnalysis || null,
			multiTimeframeData: multiTimeframeAnalysis || null,
			...riskMetadata,
		};
	}

	_isContradictoryConfluence(side, recommendation, signalsAgree) {
		const rec = String(recommendation || '').toUpperCase();
		const disagree = signalsAgree === false || ['NO', 'FALSE', '0'].includes(String(signalsAgree).toUpperCase());
		const buyRec = rec.includes('BUY') || rec.includes('COMPRA') || rec.includes('LONG');
		const sellRec = rec.includes('SELL') || rec.includes('VENTA') || rec.includes('SHORT');

		if (side === 'BUY' && sellRec) {
			return true;
		}

		if (side === 'SELL' && buyRec) {
			return true;
		}

		return disagree;
	}

	_formatMultiTimeframeSummary(multiTimeframeAnalysis = {}) {
		const alignment = multiTimeframeAnalysis.alignment;
		if (alignment && typeof alignment === 'object') {
			return alignment.status || alignment.action || alignment.trend || alignment.summary || null;
		}

		if (alignment) {
			return alignment;
		}

		const recommendation = multiTimeframeAnalysis.recommendation;
		if (recommendation && typeof recommendation === 'object') {
			return recommendation.action || recommendation.status || recommendation.summary || null;
		}

		return recommendation || multiTimeframeAnalysis.trend || null;
	}

	_formatRatio(value) {
		if (typeof value !== 'number' || Number.isNaN(value)) {
			return '1.0x';
		}
		return `${value.toFixed(1)}x`;
	}

	_formatPercent(value) {
		if (typeof value !== 'number' || Number.isNaN(value)) {
			return 'N/A';
		}

		const sign = value > 0 ? '+' : '';
		return `${sign}${value.toFixed(2)}%`;
	}

	_formatLevel(value) {
		if (typeof value !== 'number' || Number.isNaN(value)) {
			return 'N/A';
		}

		if (Math.abs(value) >= 1000) {
			return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
		}

		if (Math.abs(value) >= 1) {
			return value.toFixed(2);
		}

		return Number(value.toPrecision(6)).toString();
	}

	_compactUnique(items) {
		return [...new Set((items || []).filter(item => item && item !== 'N/A'))];
	}

	_safeNumber(value, fallback = 0) {
		if (typeof value !== 'number' || Number.isNaN(value)) {
			return fallback;
		}

		return value;
	}

	_firstNumber(values = [], fallback = null) {
		for (const value of values) {
			if (typeof value === 'number' && !Number.isNaN(value)) {
				return value;
			}
		}

		return fallback;
	}

	_unwrapSchemaResult(result) {
		if (!result || typeof result !== 'object' || Array.isArray(result)) {
			return result;
		}

		const keys = Object.keys(result);
		if (keys.length === 1 && Object.prototype.hasOwnProperty.call(result, 'result')) {
			const innerResult = result.result;
			if (innerResult && typeof innerResult === 'object' && !Array.isArray(innerResult)) {
				return innerResult;
			}
		}

		return result;
	}

	_nextRequestId(prefix) {
		this.requestCounter += 1;
		return `${prefix}-${Date.now()}-${this.requestCounter}`;
	}

	async _withRuntimeStatus(operation, { signal, runtimeStatusKey } = {}) {
		const runtimeStatusKeys = runtimeStatusKey ? ['runtimeStatus', runtimeStatusKey] : ['runtimeStatus'];

		try {
			const result = await operation();
			const timestamp = new Date().toISOString();
			runtimeStatusKeys.forEach((key) => {
				this[key] = {
					...this[key],
					status: 'ready',
					lastCheckedAt: timestamp,
					lastSuccessAt: timestamp,
					lastErrorCategory: null,
					successCount: this[key].successCount + 1,
				};
			});
			return result;
		} catch (error) {
			if (signal && signal.aborted && getAbortMessage(signal, '') === 'Job cancelled by user') {
				throw error;
			}

			const timestamp = new Date().toISOString();
			runtimeStatusKeys.forEach((key) => {
				this[key] = {
					...this[key],
					status: 'degraded',
					lastCheckedAt: timestamp,
					lastFailureAt: timestamp,
					lastErrorCategory: this._getErrorCategory(error),
					failureCount: this[key].failureCount + 1,
				};
			});
			throw error;
		}
	}

	_getErrorCategory(error) {
		const message = error && typeof error.message === 'string' ? error.message : '';
		if (/HTTP 5\d\d/i.test(message)) {
			return 'http_5xx';
		}
		if (/HTTP 4\d\d/i.test(message)) {
			return 'http_4xx';
		}
		if (/timeout|aborted/i.test(message)) {
			return 'timeout';
		}
		if (/invalid|empty|non-JSON|non-SSE|mcp-session-id|payload|RPC/i.test(message)) {
			return 'invalid_response';
		}
		return 'request_failed';
	}
}

const tradingViewMcpService = new TradingViewMcpService();

module.exports = {
	TradingViewMcpService,
	tradingViewMcpService,
	DEFAULT_TRADINGVIEW_MCP_URL,
};
