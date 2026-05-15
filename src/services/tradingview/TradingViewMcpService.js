/* global fetch, AbortController */

const { sendWithRetry } = require('../../lib/retryHelper');
const { detectAlertLanguage, normalizeActionableAlert, UrgencyLevel } = require('../alerts/actionableAlert');
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
		const sideSentiment = side === 'SELL' ? -0.55 : 0.55;
		const rating = this._safeNumber(analysis && analysis.bollinger_analysis && analysis.bollinger_analysis.rating, 0);
		const ratingBias = Math.max(-0.35, Math.min(0.35, rating / 10));
		const sentimentScore = Math.max(-1, Math.min(1, sideSentiment + ratingBias));
		const sentiment = sentimentScore > 0.15 ? 'BULLISH' : sentimentScore < -0.15 ? 'BEARISH' : 'NEUTRAL';
		const language = detectAlertLanguage(originalText);

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
		const urgencyLevel = this._determineUrgency({
			side,
			sentimentScore,
			indicators,
			bollinger,
			marketSentiment,
		});
		const insights = this._compactUnique(this._buildInsights({
			language,
			side,
			symbol,
			timeframe,
			exchange,
			priceData,
			indicators,
			marketSentiment,
			rating,
		}));

		return normalizeActionableAlert({
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
			headline: this._buildHeadline({
				language,
				side,
				symbol,
				timeframe,
				urgencyLevel,
			}),
			recommended_action: this._buildRecommendedAction({
				language,
				side,
				urgencyLevel,
			}),
			urgency_level: urgencyLevel,
			urgency_reason: this._buildUrgencyReason({
				language,
				side,
				urgencyLevel,
				indicators,
				marketSentiment,
			}),
			risk_warning: this._buildRiskWarning({
				language,
				side,
				indicators,
				marketSentiment,
			}),
			scenarios: this._buildScenarios({
				language,
				supports,
				resistances,
			}),
			asset_symbol: symbol,
			timeframe,
			signal_side: side,
			extraText: '*Grounding*: `tradingview-mcp`',
			language,
			market_context: {
				current_price: priceData.current_price,
				change_percent: priceData.change_percent,
			},
			indicator_context: {
				rsiSignal: indicators.rsi_signal || '',
				trendStrength: indicators.trend_strength || '',
				momentum: marketSentiment.momentum || '',
				highConviction: urgencyLevel === UrgencyLevel.HIGH,
				divergenceHint: this._hasDivergenceHint({ side, indicators, marketSentiment }),
			},
		});
	}

	_determineUrgency({ side, sentimentScore, indicators = {}, bollinger = {}, marketSentiment = {} }) {
		const rsi = this._safeNumber(indicators.rsi, 0);
		const adx = this._safeNumber(indicators.adx, 0);
		const trendStrength = String(indicators.trend_strength || '').toLowerCase();
		const momentum = String(marketSentiment.momentum || '').toLowerCase();
		const position = String(bollinger.position || '').toLowerCase();
		const extremeRsi = side === 'SELL' ? rsi >= 68 : rsi <= 32;
		const strongTrend = adx >= 25 || trendStrength.includes('strong');
		const alignedMomentum = side === 'SELL' ? momentum.includes('bear') : momentum.includes('bull');
		const stretchedPrice = position.includes('upper') || position.includes('lower');

		if (Math.abs(sentimentScore) >= 0.75 || (extremeRsi && (strongTrend || alignedMomentum || stretchedPrice))) {
			return UrgencyLevel.HIGH;
		}

		if (Math.abs(sentimentScore) >= 0.45 || extremeRsi || strongTrend || alignedMomentum) {
			return UrgencyLevel.MEDIUM;
		}

		return UrgencyLevel.LOW;
	}

	_buildInsights({ language, side, symbol, timeframe, exchange, priceData = {}, indicators = {}, marketSentiment = {}, rating }) {
		const currentPrice = this._formatLevel(priceData.current_price);
		const changePercent = this._formatPercent(priceData.change_percent);
		const rsi = this._formatLevel(indicators.rsi);
		const adx = this._formatLevel(indicators.adx);
		const rsiSignal = indicators.rsi_signal || 'N/A';
		const trendStrength = indicators.trend_strength || 'N/A';
		const momentum = marketSentiment.momentum || 'N/A';

		if (language === 'en') {
			return [
				`${side === 'SELL' ? 'Sell' : 'Buy'} signal detected on ${symbol} ${timeframe} (${exchange})`,
				`Price sits at ${currentPrice} (${changePercent}) with ${momentum} momentum`,
				`RSI ${rsi} (${rsiSignal}) and ADX ${adx} (${trendStrength}) keep the setup active`,
				`Bollinger rating ${rating} still leans ${side === 'SELL' ? 'against buyers' : 'in favor of buyers'}`,
			];
		}

		return [
			`Senal de ${side === 'SELL' ? 'VENTA' : 'COMPRA'} en ${symbol} ${timeframe} (${exchange})`,
			`Precio en ${currentPrice} (${changePercent}) con momentum ${momentum}`,
			`RSI ${rsi} (${rsiSignal}) y ADX ${adx} (${trendStrength}) mantienen viva la jugada`,
			`Bollinger rating ${rating} sigue ${side === 'SELL' ? 'presionando a los compradores' : 'favoreciendo a los compradores'}`,
		];
	}

	_buildHeadline({ language, side, symbol, timeframe, urgencyLevel }) {
		if (language === 'en') {
			if (side === 'SELL') {
				return urgencyLevel === UrgencyLevel.HIGH
					? `${symbol} flipped in ${timeframe}. The bullish party looks done for now.`
					: `${symbol} is weakening in ${timeframe}. Be careful buying the bounce.`;
			}

			return urgencyLevel === UrgencyLevel.HIGH
				? `${symbol} is pressing higher in ${timeframe}, but only chase it with confirmation.`
				: `${symbol} looks better in ${timeframe}, though it can still fake out before continuing.`;
		}

		if (side === 'SELL') {
			return urgencyLevel === UrgencyLevel.HIGH
				? `${symbol} cambio la estructura en ${timeframe}. Se acabo la fiesta alcista por ahora.`
				: `${symbol} se esta enfriando en ${timeframe}. Ojo con seguir comprando arriba.`;
		}

		return urgencyLevel === UrgencyLevel.HIGH
			? `${symbol} quiere romper en ${timeframe}, pero solo persiguelo si confirma.`
			: `${symbol} mejora en ${timeframe}, aunque todavia puede barrer antes de seguir.`;
	}

	_buildRecommendedAction({ language, side, urgencyLevel }) {
		if (language === 'en') {
			if (side === 'SELL') {
				return urgencyLevel === UrgencyLevel.HIGH
					? 'Take partial profits or close the position and move the stop now.'
					: 'Reduce risk and protect the position before looking for a fresh long.';
			}

			return urgencyLevel === UrgencyLevel.HIGH
				? 'Look for continuation only with a confirmed break and a tight stop.'
				: 'Prepare the long, but wait for confirmation before sizing up.';
		}

		if (side === 'SELL') {
			return urgencyLevel === UrgencyLevel.HIGH
				? 'Tomar ganancias parciales o cerrar posicion y subir el stop ahora.'
				: 'Reducir exposicion y proteger la posicion antes de buscar otra compra.';
		}

		return urgencyLevel === UrgencyLevel.HIGH
			? 'Buscar continuidad solo con ruptura confirmada y stop corto.'
			: 'Preparar la entrada, pero esperar confirmacion antes de meter size.';
	}

	_buildUrgencyReason({ language, side, urgencyLevel, indicators = {}, marketSentiment = {} }) {
		const rsi = this._formatLevel(indicators.rsi);
		const adx = this._formatLevel(indicators.adx);
		const momentum = marketSentiment.momentum || 'N/A';

		if (language === 'en') {
			if (urgencyLevel === UrgencyLevel.HIGH) {
				return side === 'SELL'
					? `Sell pressure stays active with RSI ${rsi}, ADX ${adx}, and ${momentum} momentum.`
					: `Buy pressure stays active with RSI ${rsi}, ADX ${adx}, and ${momentum} momentum.`;
			}

			if (urgencyLevel === UrgencyLevel.MEDIUM) {
				return side === 'SELL'
					? 'The setup is turning lower, but it still needs cleaner follow-through.'
					: 'Buyers are active, but the breakout still needs cleaner follow-through.';
			}

			return 'This is a smaller shift for now, so monitoring is enough.';
		}

		if (urgencyLevel === UrgencyLevel.HIGH) {
			return side === 'SELL'
				? `La venta sigue viva con RSI ${rsi}, ADX ${adx} y momentum ${momentum}.`
				: `La compra sigue viva con RSI ${rsi}, ADX ${adx} y momentum ${momentum}.`;
		}

		if (urgencyLevel === UrgencyLevel.MEDIUM) {
			return side === 'SELL'
				? 'La estructura va girando a la baja, pero aun falta continuidad mas limpia.'
				: 'Aparecen compradores, pero la ruptura aun necesita continuidad mas limpia.';
		}

		return 'Por ahora es un cambio menor, asi que basta con monitorear.';
	}

	_buildRiskWarning({ language, side, indicators = {}, marketSentiment = {} }) {
		const rsiSignal = String(indicators.rsi_signal || '').toLowerCase();
		const momentum = String(marketSentiment.momentum || '').toLowerCase();

		if (side === 'SELL' && (rsiSignal.includes('overbought') || momentum.includes('bear'))) {
			return language === 'en'
				? 'Price can still bounce, but the strength is fading. Do not buy the top.'
				: 'El precio todavia puede rebotar, pero la fuerza se esta agotando. No compres el peak.';
		}

		if (side === 'BUY' && (rsiSignal.includes('oversold') || momentum.includes('bull'))) {
			return language === 'en'
				? 'If the break does not confirm quickly, this can shake out longs before continuing.'
				: 'Si la ruptura no confirma rapido, esto puede barrer largos antes de seguir.';
		}

		return null;
	}

	_buildScenarios({ language, supports = [], resistances = [] }) {
		const [firstResistance, secondResistance] = resistances;
		const [firstSupport, secondSupport] = supports;

		return {
			bull: firstResistance
				? {
					trigger: language === 'en' ? `If it breaks ${firstResistance}` : `Si rompe ${firstResistance}`,
					outcome: secondResistance
						? language === 'en' ? `next objective ${secondResistance}` : `objetivo ${secondResistance}`
						: language === 'en' ? 'buyers can extend the move' : 'los compradores pueden estirar el movimiento',
				}
				: null,
			bear: firstSupport
				? {
					trigger: language === 'en' ? `If it loses ${firstSupport}` : `Si pierde ${firstSupport}`,
					outcome: secondSupport
						? language === 'en' ? `probable drop toward ${secondSupport}` : `caida probable a ${secondSupport}`
						: language === 'en' ? 'the selloff can speed up lower' : 'la caida puede acelerar mas abajo',
				}
				: null,
		};
	}

	_hasDivergenceHint({ side, indicators = {}, marketSentiment = {} }) {
		const rsiSignal = String(indicators.rsi_signal || '').toLowerCase();
		const momentum = String(marketSentiment.momentum || '').toLowerCase();

		return (
			(side === 'SELL' && (rsiSignal.includes('overbought') || momentum.includes('bear')))
			|| (side === 'BUY' && (rsiSignal.includes('oversold') || momentum.includes('bull')))
		);
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
