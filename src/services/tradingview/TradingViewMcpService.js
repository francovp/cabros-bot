/* global fetch, AbortController */

const { sendWithRetry } = require('../../lib/retryHelper');
const { parseTradingViewSignal, normalizeTradingViewTimeframe } = require('./parseTradingViewSignal');

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

class TradingViewMcpService {
	constructor(config = {}) {
		this.config = config;
		this.logger = config.logger || console;
		this.requestCounter = 0;
	}

	isEnabled() {
		return process.env.ENABLE_TRADINGVIEW_MCP_ENRICHMENT === 'true';
	}

	getConfig() {
		const timeoutMs = parseInt(this.config.timeoutMs || process.env.TRADINGVIEW_MCP_TIMEOUT_MS || '12000', 10);
		const maxRetries = parseInt(this.config.maxRetries || process.env.TRADINGVIEW_MCP_MAX_RETRIES || '3', 10);
		const defaultExchange = (this.config.defaultExchange || process.env.TRADINGVIEW_MCP_DEFAULT_EXCHANGE || 'BINANCE').toUpperCase();
		const defaultTimeframe = normalizeTradingViewTimeframe(
			this.config.defaultTimeframe || process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '1h',
			'1h',
		);
		const enrichmentBudgetMs = parseInt(
			this.config.enrichmentBudgetMs || process.env.TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS || '12000',
			10,
		);

		return {
			url: this.config.url || process.env.TRADINGVIEW_MCP_URL || 'https://tradingview-mcp.onrender.com/mcp',
			timeoutMs,
			maxRetries,
			defaultExchange,
			defaultTimeframe,
			enrichmentBudgetMs,
		};
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
		if (process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION === 'true') {
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
		if (process.env.ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT !== 'false' && !budgetController.signal.aborted) {
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
	}

	async callMultiTimeframeAnalysis({ symbol, exchange, signal }) {
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
	}

	async callVolumeConfirmation({ symbol, exchange, timeframe, signal }) {
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
	}

	async callScanTool(toolName, args = {}, options = {}) {
		const { signal } = options;
		const cfg = this.getConfig();

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
			return JSON.parse(bodyText);
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
		const priceData = (analysis && analysis.price_data) || {};
		const indicators = (analysis && analysis.technical_indicators) || {};
		const rsiData = (analysis && analysis.rsi) || {};
		const adxData = (analysis && analysis.adx) || {};
		const legacyBollinger = (analysis && analysis.bollinger_analysis) || {};
		const bollingerBands = (analysis && analysis.bollinger_bands) || {};
		const supportResistance = (analysis && analysis.support_resistance) || {};
		const marketSentiment = (analysis && analysis.market_sentiment) || {};
		const marketStructure = (analysis && analysis.market_structure) || {};
		const timeframeContext = (analysis && analysis.timeframe_context) || {};

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
		const extraText = process.env.ENABLE_MESSAGE_FOOTER_METADATA !== 'false'
			? '*Grounding*: `tradingview-mcp`'
			: '';

		return {
			original_text: originalText,
			sentiment,
			sentiment_score: sentimentScore,
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
}

const tradingViewMcpService = new TradingViewMcpService();

module.exports = {
	TradingViewMcpService,
	tradingViewMcpService,
};
