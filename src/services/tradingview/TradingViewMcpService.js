/* global fetch, AbortController */

const { sendWithRetry } = require('../../lib/retryHelper');
const { parseTradingViewSignal, normalizeTradingViewTimeframe } = require('./parseTradingViewSignal');

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
			url: this.config.url || process.env.TRADINGVIEW_MCP_URL || 'http://localhost:8000/mcp',
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

		return this._toEnrichedAlert(signal.rawText || '', { symbol, exchange, timeframe, side: signal.side }, result.analysis);
	}

	async callCoinAnalysis({ symbol, exchange, timeframe }) {
		const rpcResult = await this._callTool('coin_analysis', {
			symbol,
			exchange,
			timeframe,
		});

		if (rpcResult && rpcResult.error) {
			throw new Error(rpcResult.error);
		}

		return rpcResult;
	}

	async _callTool(toolName, args = {}) {
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

		const initResponse = await this._rpcRequest(initializeRequest);
		const sessionId = initResponse.sessionId;

		if (!sessionId) {
			throw new Error('TradingView MCP did not return mcp-session-id header');
		}

		await this._rpcRequest({
			jsonrpc: '2.0',
			method: 'notifications/initialized',
			params: {},
		}, { sessionId, expectResponse: false });

		const toolCallRequest = {
			jsonrpc: '2.0',
			id: this._nextRequestId('tool'),
			method: 'tools/call',
			params: {
				name: toolName,
				arguments: args,
			},
		};

		const toolResponse = await this._rpcRequest(toolCallRequest, { sessionId });
		const callResult = toolResponse.rpc && toolResponse.rpc.result;

		if (!callResult) {
			throw new Error(`TradingView MCP tool ${toolName} returned empty result`);
		}

		if (callResult.isError) {
			const errorMessage = this._extractContentText(callResult) || `TradingView MCP tool ${toolName} returned isError=true`;
			throw new Error(errorMessage);
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
		const { sessionId, expectResponse = true } = options;
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), cfg.timeoutMs);

		const headers = {
			'Content-Type': 'application/json',
			Accept: 'text/event-stream, application/json',
		};

		if (sessionId) {
			headers['mcp-session-id'] = sessionId;
		}

		let response;
		try {
			response = await fetch(cfg.url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal,
			});
		} catch (error) {
			if (error.name === 'AbortError') {
				throw new Error(`TradingView MCP timeout after ${cfg.timeoutMs}ms`);
			}

			throw new Error(`TradingView MCP request failed: ${error.message}`);
		} finally {
			clearTimeout(timeoutId);
		}

		const nextSessionId = response.headers.get('mcp-session-id') || sessionId;
		const bodyText = await response.text();

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

	_toEnrichedAlert(originalText, signal, analysis = {}) {
		const { side, symbol, exchange, timeframe } = signal;
		const sideLabel = side === 'SELL' ? 'VENTA' : 'COMPRA';
		const sideSentiment = side === 'SELL' ? -0.55 : 0.55;
		const rating = this._safeNumber(analysis && analysis.bollinger_analysis && analysis.bollinger_analysis.rating, 0);
		const ratingBias = Math.max(-0.35, Math.min(0.35, rating / 10));
		const sentimentScore = Math.max(-1, Math.min(1, sideSentiment + ratingBias));
		const sentiment = sentimentScore > 0.15 ? 'BULLISH' : sentimentScore < -0.15 ? 'BEARISH' : 'NEUTRAL';

		const priceData = (analysis && analysis.price_data) || {};
		const indicators = (analysis && analysis.technical_indicators) || {};
		const bollinger = (analysis && analysis.bollinger_analysis) || {};
		const marketSentiment = (analysis && analysis.market_sentiment) || {};

		const supports = this._compactUnique([
			this._formatLevel(bollinger.bb_lower),
			this._formatLevel(priceData.low),
		]);

		const resistances = this._compactUnique([
			this._formatLevel(bollinger.bb_upper),
			this._formatLevel(priceData.high),
		]);

		const insights = this._compactUnique([
			`Señal detectada: ${sideLabel} para ${symbol} en ${timeframe} (${exchange})`,
			`Precio actual: ${this._formatLevel(priceData.current_price)} (${this._formatPercent(priceData.change_percent)})`,
			`RSI ${this._formatLevel(indicators.rsi)} (${indicators.rsi_signal || 'N/A'}) · ADX ${this._formatLevel(indicators.adx)} (${indicators.trend_strength || 'N/A'})`,
			`Bollinger rating ${rating} (${bollinger.position || 'N/A'}) · Momentum ${marketSentiment.momentum || 'N/A'}`,
		]);

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
