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

		return {
			url: this.config.url || process.env.TRADINGVIEW_MCP_URL || 'https://tradingview-mcp.onrender.com/mcp',
			timeoutMs,
			maxRetries,
			defaultExchange,
			defaultTimeframe,
		};
	}

	async enrichFromAlertText(alertText) {
		const { defaultTimeframe } = this.getConfig();
		const parsed = parseTradingViewSignal(alertText, { defaultTimeframe });
		if (!parsed) {
			return null;
		}

		return this.enrichFromSignal(parsed);
	}

	async enrichFromSignal(signal) {
		const cfg = this.getConfig();
		const symbol = signal.symbol.toUpperCase();
		const exchange = (signal.exchange || cfg.defaultExchange).toUpperCase();
		const timeframe = normalizeTradingViewTimeframe(signal.timeframe || signal.rawTimeframe, cfg.defaultTimeframe);

		const result = await sendWithRetry(async () => {
			try {
				const analysis = await this.callCoinAnalysis({ symbol, exchange, timeframe });
				return { success: true, channel: 'tradingview-mcp', analysis };
			} catch (error) {
				return { success: false, channel: 'tradingview-mcp', error: error.message };
			}
		}, cfg.maxRetries, this.logger);

		if (!result.success) {
			throw new Error(`TradingView MCP call failed: ${result.error || 'unknown error'}`);
		}

		let volumeAnalysis = null;
		if (process.env.ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION === 'true') {
			const volumeTimeoutMs = 5000;
			const controller = new AbortController();
			const timeoutId = setTimeout(() => {
				controller.abort(new Error(`TradingView MCP volume confirmation timeout after ${volumeTimeoutMs}ms`));
			}, volumeTimeoutMs);

			const vResult = await sendWithRetry(async () => {
				try {
					const volConfirm = await this.callVolumeConfirmation({ symbol, exchange, timeframe, signal: controller.signal });
					return { success: true, channel: 'tradingview-mcp', volConfirm };
				} catch (error) {
					return { success: false, channel: 'tradingview-mcp', error: error.message };
				}
			}, 1, this.logger);

			clearTimeout(timeoutId);

			if (vResult.success) {
				volumeAnalysis = vResult.volConfirm;
			} else {
				this.logger.warn(`[TradingViewMcpService] Volume confirmation failed for ${symbol}: ${vResult.error || 'unknown error'}`);
			}
		}

		return this._toEnrichedAlert(signal.rawText || '', { symbol, exchange, timeframe, side: signal.side }, result.analysis, volumeAnalysis);
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

	_toEnrichedAlert(originalText, signal, analysis = {}, volumeAnalysis = null) {
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
		const sentimentScore = Math.max(-1, Math.min(1, sideSentiment + ratingBias));
		const sentiment = sentimentScore > 0.15 ? 'BULLISH' : sentimentScore < -0.15 ? 'BEARISH' : 'NEUTRAL';

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
			extraText: '*Grounding*: `tradingview-mcp`',
		};
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
