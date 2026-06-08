const {
	normalizeTradingViewTimeframe,
	SUPPORTED_MCP_TIMEFRAMES,
} = require('./parseTradingViewSignal');

const MAX_SYMBOLS = 50;
const SUPPORTED_TIMEFRAME_ALIASES = new Set([
	'5',
	'5M',
	'15',
	'15M',
	'60',
	'1H',
	'240',
	'4H',
	'1440',
	'D',
	'1D',
	'10080',
	'W',
	'1W',
	'43200',
	'M',
	'1M',
]);

class ExpandedAnalysisAlertRequestError extends Error {
	constructor(message, code = 'INVALID_REQUEST') {
		super(message);
		this.name = 'ExpandedAnalysisAlertRequestError';
		this.code = code;
	}
}

function parseExpandedAnalysisAlertRequest(req = {}) {
	const body = getRequestBody(req);
	const rawSymbols = getRequestSymbols(body);
	const symbols = rawSymbols.map(parseSymbolIdentifier);
	validateTimeframeType(body);
	const timeframe = parseTimeframe(body.timeframe);
	const includeMultiTimeframe = parseIncludeMultiTimeframe(body);
	const analysisMode = parseAnalysisMode(body);

	if (symbols.length === 0) {
		throw new ExpandedAnalysisAlertRequestError(
			'No expanded analysis symbols provided. Pass body.symbols or set EXPANDED_ANALYSIS_ALERT_SYMBOLS.',
			'NO_SYMBOLS',
		);
	}

	if (symbols.length > MAX_SYMBOLS) {
		throw new ExpandedAnalysisAlertRequestError(`Too many symbols requested (max: ${MAX_SYMBOLS})`);
	}

	return { symbols, timeframe, includeMultiTimeframe, analysisMode };
}

function parseIncludeMultiTimeframe(body = {}) {
	const val = body.includeMultiTimeframe !== undefined ? body.includeMultiTimeframe : body.include_multi_timeframe;
	if (val === undefined || val === null) {
		return false;
	}
	if (typeof val !== 'boolean') {
		if (typeof val === 'string') {
			const lower = val.trim().toLowerCase();
			if (lower === 'true') return true;
			if (lower === 'false') return false;
		}
		throw new ExpandedAnalysisAlertRequestError('includeMultiTimeframe must be a boolean');
	}
	return val;
}

function parseAnalysisMode(body = {}) {
	const val = body.analysisMode !== undefined ? body.analysisMode : body.analysis_mode;
	if (val === undefined || val === null) {
		return 'standard';
	}
	if (typeof val !== 'string') {
		throw new ExpandedAnalysisAlertRequestError('analysisMode must be a string');
	}
	const normalized = val.trim().toLowerCase();
	if (normalized !== 'standard' && normalized !== 'combined') {
		throw new ExpandedAnalysisAlertRequestError('analysisMode must be either "standard" or "combined"');
	}
	return normalized;
}

function getRequestBody(req = {}) {
	if (!Object.prototype.hasOwnProperty.call(req, 'body') || req.body === undefined) {
		return {};
	}

	if (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body)) {
		throw new ExpandedAnalysisAlertRequestError('request body must be a JSON object');
	}

	return req.body;
}

function validateTimeframeType(body = {}) {
	if (
		Object.prototype.hasOwnProperty.call(body, 'timeframe')
		&& body.timeframe !== undefined
		&& typeof body.timeframe !== 'string'
	) {
		throw new ExpandedAnalysisAlertRequestError('timeframe must be a string');
	}
}

function getRequestSymbols(body = {}) {
	if (Object.prototype.hasOwnProperty.call(body, 'symbols')) {
		if (!Array.isArray(body.symbols)) {
			throw new ExpandedAnalysisAlertRequestError('symbols must be an array of EXCHANGE:SYMBOL strings');
		}

		const bodySymbols = body.symbols
			.map((symbol) => (typeof symbol === 'string' ? symbol.trim() : symbol))
			.filter((symbol) => symbol !== '');

		if (bodySymbols.length > 0) {
			return bodySymbols;
		}
	}

	return (process.env.EXPANDED_ANALYSIS_ALERT_SYMBOLS || '')
		.split(',')
		.map((symbol) => symbol.trim())
		.filter(Boolean);
}

function parseSymbolIdentifier(value) {
	if (typeof value !== 'string') {
		throw new ExpandedAnalysisAlertRequestError('All symbols must be strings in EXCHANGE:SYMBOL format');
	}

	const raw = value.trim().toUpperCase();
	const match = raw.match(/^(?<exchange>[A-Z0-9_]+):(?<symbol>[A-Z0-9._-]{1,30})$/);
	if (!match || !match.groups) {
		throw new ExpandedAnalysisAlertRequestError(`Symbol must use EXCHANGE:SYMBOL format: ${value}`);
	}

	return {
		raw,
		exchange: match.groups.exchange,
		symbol: match.groups.symbol,
	};
}

function parseTimeframe(value) {
	const rawTimeframe = typeof value === 'string' && value.trim()
		? value.trim()
		: (process.env.TRADINGVIEW_MCP_DEFAULT_TIMEFRAME || '1D');
	const normalizedToken = rawTimeframe.toUpperCase();

	if (!SUPPORTED_MCP_TIMEFRAMES.has(rawTimeframe) && !SUPPORTED_TIMEFRAME_ALIASES.has(normalizedToken)) {
		throw new ExpandedAnalysisAlertRequestError(`Unsupported timeframe: ${rawTimeframe}`);
	}

	return normalizeTradingViewTimeframe(rawTimeframe, '1D');
}

function buildExpandedAnalysisAlertReport(items = [], options = {}) {
	const groups = {
		extremeOversold: [],
		oversold: [],
		neutral: [],
		overbought: [],
	};

	items.forEach((item) => {
		const row = buildReportRow(item);
		groups[categorizeRsi(row.rsi)].push(row);
	});

	const now = options.now || new Date();
	const lines = [
		`📊 *ANÁLISIS AMPLIADO — ${formatReportDate(now)}*`,
		'',
		'*🔴 SOBRESVENDIDOS EXTREMOS*',
		...formatGroupRows(groups.extremeOversold),
		'',
		'*⚠️ SOBRESVENDIDOS*',
		...formatGroupRows(groups.oversold),
		'',
		'*🟡 NEUTROS*',
		...formatGroupRows(groups.neutral),
		'',
		'*🔴 SOBRECOMPRADOS*',
		...formatGroupRows(groups.overbought),
	];

	return lines.join('\n');
}

function buildReportRow({ input = {}, analysis = {}, multiTimeframe }) {
	const techData = analysis.technical || analysis || {};
	const priceData = techData.price_data || {};
	const indicators = techData.technical_indicators || {};
	const bollinger = techData.bollinger_analysis || {};
	const currentBollinger = techData.bollinger_bands || {};
	const price = numberOrNull(priceData.current_price ?? priceData.close);
	const changePercent = numberOrNull(priceData.change_percent);
	const rsi = numberOrNull(indicators.rsi ?? techData.rsi?.value);
	const sma20 = numberOrNull(indicators.sma20 ?? bollinger.bb_middle ?? techData.sma?.sma20 ?? currentBollinger.middle);
	const macd = numberOrNull(indicators.macd ?? techData.macd?.macd_line);
	const macdSignal = numberOrNull(indicators.macd_signal ?? techData.macd?.signal_line);
	const atr = numberOrNull(indicators.atr ?? techData.atr?.value ?? techData.atr ?? techData.volatility?.atr);
	const trend = getTrend(price, sma20);
	const macdDirection = getMacdDirection(macd, macdSignal);
	const volume = getVolumeLabel(techData);
	const stopLoss = getStopLoss(price, atr, bollinger, currentBollinger);

	const sentiment = analysis.sentiment || null;
	const confluence = analysis.confluence || null;
	const news = analysis.news || null;

	return {
		symbol: input.symbol || stripExchange(techData.symbol) || 'UNKNOWN',
		price,
		changePercent,
		rsi,
		trend,
		macdDirection,
		volume,
		atr,
		stopLoss,
		suggestion: getSuggestion({ rsi, trend, macdDirection }),
		multiTimeframe,
		sentiment,
		confluence,
		news,
	};
}

function formatGroupRows(rows) {
	if (rows.length === 0) {
		return ['No hay.'];
	}

	return rows.flatMap((row, index) => {
		const lines = [
			`${row.symbol} ${formatCurrency(row.price)} (${formatPercent(row.changePercent)}) | RSI ${formatNumber(row.rsi, 1)}`,
			`- *Tendencia (SMA20):* ${row.trend} | *MACD:* ${row.macdDirection}`,
			formatVolumeAtrLine(row),
			`- *Stop Loss sugerido:* ${formatCurrency(row.stopLoss)}`,
			`- *Sugerencia:* ${row.suggestion}`,
		];

		if (row.sentiment) {
			const sentText = formatRedditSentiment(row.sentiment);
			if (sentText) {
				lines.push(sentText);
			}
		}

		if (row.confluence) {
			const confText = formatConfluence(row.confluence);
			if (confText) {
				lines.push(confText);
			}
		}

		if (row.news) {
			const newsText = formatNewsSection(row.news);
			if (newsText) {
				lines.push(newsText);
			}
		}

		if (row.multiTimeframe) {
			lines.push(formatMultiTimeframeSection(row.multiTimeframe));
		}

		if (index < rows.length - 1) {
			lines.push('');
		}

		return lines;
	});
}

function formatRedditSentiment(sentiment) {
	if (!sentiment) return null;
	const label = translateSentimentLabel(sentiment.sentiment_label || sentiment.label);
	const score = typeof sentiment.sentiment_score === 'number' ? sentiment.sentiment_score : (sentiment.score ?? 0);
	const posts = sentiment.posts_analyzed ?? sentiment.posts ?? 0;

	let emoji = '😐';
	if (score > 0.15 || label.toLowerCase() === 'alcista') emoji = '🐂';
	else if (score < -0.15 || label.toLowerCase() === 'bajista') emoji = '🐻';

	return `- *Sentimiento Reddit:* ${emoji} ${label} (Score: ${score.toFixed(2)}, ${posts} posts)`;
}

function translateSentimentLabel(label) {
	if (!label) return 'Neutral';
	const lower = String(label).toLowerCase().trim();
	if (lower === 'bullish' || lower === 'alcista') return 'Alcista';
	if (lower === 'bearish' || lower === 'bajista') return 'Bajista';
	if (lower === 'neutral') return 'Neutral';
	return label;
}

function formatConfluence(confluence) {
	if (!confluence) return null;
	const rec = formatRecommendation(confluence.recommendation || confluence.action || 'N/A');
	const confidence = confluence.confidence || 'N/A';
	const agree = confluence.signals_agree === true || String(confluence.signals_agree).toLowerCase() === 'yes';
	const agreeText = agree ? ' · Señales Alineadas ✅' : '';
	return `- *Confluencia:* ${rec}${agreeText} (Confianza: ${confidence})`;
}

function formatRecommendation(rec) {
	if (!rec) return 'N/A';
	const upper = String(rec).toUpperCase().trim();
	if (upper.includes('STRONG BUY')) return '🟢 STRONG BUY';
	if (upper.includes('BUY')) return '🟢 BUY';
	if (upper.includes('STRONG SELL')) return '🔴 STRONG SELL';
	if (upper.includes('SELL')) return '🔴 SELL';
	if (upper.includes('HOLD') || upper.includes('NEUTRAL')) return '🟡 HOLD';
	return rec;
}

function formatNewsSection(news) {
	if (!news || !Array.isArray(news.latest) || news.latest.length === 0) {
		return null;
	}

	const articles = news.latest.slice(0, 3);
	const lines = ['- *Últimas Noticias:*'];
	articles.forEach(art => {
		const title = art.title || 'Noticia';
		let source = art.source || art.publisher || '';
		if (!source && art.url) {
			try {
				const urlObj = new URL(art.url);
				source = urlObj.hostname.replace('www.', '');
			} catch {
				source = '';
			}
		}
		const sourceText = source ? ` (${source})` : '';
		lines.push(`  • ${title}${sourceText}`);
	});

	return lines.join('\n');
}

function formatMultiTimeframeSection(mtf) {
	const timeframes = mtf.timeframes || {};
	const alignment = mtf.alignment || {};
	const rec = mtf.recommendation || {};

	const tfLines = [];
	const tfOrder = ['1W', '1D', '4h', '1h', '15m'];
	const tfNames = {
		'1W': 'Semanal (1W)',
		'1D': 'Diario (1D)',
		'4h': '4H',
		'1h': '1H',
		'15m': '15M',
	};

	tfOrder.forEach((tf) => {
		const data = timeframes[tf];
		if (data) {
			const bias = translateBias(data.bias);
			const rsiVal = data.rsi?.value ?? data.rsi;
			const rsiText = typeof rsiVal === 'number' ? ` (RSI ${rsiVal.toFixed(1)})` : '';
			tfLines.push(`  • *${tfNames[tf]}:* ${bias}${rsiText}`);
		}
	});

	return [
		`- *Alineación Multi-TF:*`,
		...tfLines,
		`  • *Confluencia:* ${alignment.status || 'N/A'} (Confianza: ${alignment.confidence || 'N/A'})`,
		`  • *Recomendación:* ${rec.action || 'N/A'}`,
	].join('\n');
}

function translateBias(bias) {
	if (!bias) {
		return 'Neutral';
	}

	const lower = bias.toLowerCase().trim();
	if (lower === 'bullish') {
		return 'Alcista';
	}
	if (lower === 'bearish') {
		return 'Bajista';
	}

	return bias;
}

function formatVolumeAtrLine(row) {
	const base = `- *Volumen:* ${row.volume}`;
	if (row.atr === null) {
		return base;
	}

	return `${base} | *ATR:* ${formatCurrency(row.atr)}`;
}

function categorizeRsi(rsi) {
	if (rsi !== null && rsi < 25) {
		return 'extremeOversold';
	}

	if (rsi !== null && rsi < 35) {
		return 'oversold';
	}

	if (rsi !== null && rsi > 70) {
		return 'overbought';
	}

	return 'neutral';
}

function formatReportDate(date) {
	const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
	const day = String(date.getDate()).padStart(2, '0');
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const year = date.getFullYear();
	return `${weekday} ${day}/${month}/${year}`;
}

function getTrend(price, sma20) {
	if (price === null || sma20 === null) {
		return 'N/A';
	}

	if (price > sma20) {
		return 'Alcista';
	}

	if (price < sma20) {
		return 'Bajista';
	}

	return 'Neutral';
}

function getMacdDirection(macd, macdSignal) {
	if (macd === null || macdSignal === null) {
		return 'N/A';
	}

	if (macd > macdSignal) {
		return 'Bullish';
	}

	if (macd < macdSignal) {
		return 'Bearish';
	}

	return 'Neutral';
}

function getVolumeLabel(analysis) {
	const ratio = numberOrNull(
		analysis.volume_analysis?.volume_ratio
		?? analysis.volume_analysis?.ratio
		?? analysis.volume_data?.volume_ratio
		?? analysis.technical_indicators?.volume_ratio
		?? analysis.price_data?.relative_volume,
	);
	const signal = analysis.volume_analysis?.signal;

	if (typeof signal === 'string' && signal.trim()) {
		return signal.trim();
	}

	if (ratio === null) {
		return 'Normal';
	}

	if (ratio >= 1.5) {
		return 'Alto';
	}

	if (ratio <= 0.7) {
		return 'Bajo';
	}

	return 'Normal';
}

function getStopLoss(price, atr, bollinger, currentBollinger = {}) {
	if (price === null) {
		return null;
	}

	if (atr !== null) {
		return price - (atr * 1.5);
	}

	const bbLower = numberOrNull(bollinger.bb_lower ?? currentBollinger.lower);
	if (bbLower !== null) {
		return bbLower;
	}

	return price * 0.95;
}

function getSuggestion({ rsi, trend, macdDirection }) {
	if (rsi !== null && rsi > 70) {
		return 'VENDER / TOMAR GANANCIAS (RSI en zona de sobrecompra)';
	}

	if (rsi !== null && rsi < 25) {
		return 'VIGILAR REBOTE / COMPRA ESPECULATIVA (RSI en sobreventa extrema)';
	}

	if (rsi !== null && rsi < 35) {
		return 'VIGILAR / ACUMULAR GRADUAL (RSI en zona de sobreventa)';
	}

	if (trend === 'Bajista' && macdDirection === 'Bearish') {
		return 'REDUCIR POSICIÓN (Tendencia y Momentum alineados a la baja)';
	}

	if (trend === 'Alcista' && macdDirection === 'Bearish') {
		return 'MANTENER / ACUMULAR (Tendencia alcista base, MACD sugiere pausa temporal)';
	}

	if (trend === 'Alcista' && macdDirection === 'Bullish') {
		return 'MANTENER / ACUMULAR (RSI saludable, tendencia alcista mantenida)';
	}

	return 'MANTENER (Señales mixtas; esperar confirmación)';
}

function stripExchange(symbol) {
	if (typeof symbol !== 'string') {
		return null;
	}

	const parts = symbol.split(':');
	return parts[parts.length - 1] || null;
}

function formatCurrency(value) {
	if (value === null) {
		return 'N/A';
	}

	const decimals = Math.abs(value) >= 1 ? 2 : 6;
	return `$${value.toLocaleString('en-US', {
		minimumFractionDigits: decimals,
		maximumFractionDigits: decimals,
	})}`;
}

function formatPercent(value) {
	if (value === null) {
		return 'N/A';
	}

	const sign = value > 0 ? '+' : '';
	return `${sign}${value.toFixed(1)}%`;
}

function formatNumber(value, decimals) {
	if (value === null) {
		return 'N/A';
	}

	return value.toFixed(decimals);
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

module.exports = {
	ExpandedAnalysisAlertRequestError,
	parseExpandedAnalysisAlertRequest,
	parseSymbolIdentifier,
	buildExpandedAnalysisAlertReport,
};
