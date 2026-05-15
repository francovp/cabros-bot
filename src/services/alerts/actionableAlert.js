const UrgencyLevel = Object.freeze({
	LOW: 'LOW',
	MEDIUM: 'MEDIUM',
	HIGH: 'HIGH',
});

const SignalSide = Object.freeze({
	BUY: 'BUY',
	SELL: 'SELL',
	WAIT: 'WAIT',
});

const URGENCY_ORDER = {
	[UrgencyLevel.LOW]: 1,
	[UrgencyLevel.MEDIUM]: 2,
	[UrgencyLevel.HIGH]: 3,
};

const SPANISH_HINTS = /[áéíóúñ¿¡]|\b(alerta|senal|venta|compra|rompe|pierde|precio|alcista|bajista|fuerza|cuidado|mercado|volumen|riesgo|caida|sube|baja|soporte|resistencia|estructura|cierre)\b/i;
const DIVERGENCE_HINTS = /\b(divergenc(?:e|ia)?|sin fuerza|pierde fuerza|fuerza baja|weak(?:ness|ening)?|momentum fade|no compres el peak|dont chase the top|don't chase the top)\b/i;
const HIGH_URGENCY_HINTS = /\b(choch|confirmad[oa]|confirmed|breakdown|breakout|alta conviccion|high conviction|liquidation|capitulation|strong sell|strong buy|señal fuerte|senal fuerte)\b/i;

function cleanText(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function uniqueStrings(items = []) {
	return [...new Set((items || []).map(cleanText).filter(Boolean))];
}

function normalizeSentiment(sentiment) {
	return ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(sentiment) ? sentiment : 'NEUTRAL';
}

function normalizeSentimentScore(sentiment, rawScore) {
	const numeric = typeof rawScore === 'number' && !Number.isNaN(rawScore)
		? Math.abs(rawScore)
		: sentiment === 'NEUTRAL' ? 0 : 0.5;
	const magnitude = Math.max(0, Math.min(1, numeric));

	if (sentiment === 'BULLISH') {
		return magnitude;
	}

	if (sentiment === 'BEARISH') {
		return -magnitude;
	}

	return 0;
}

function normalizeSignalSide(rawSide, sentiment) {
	if (rawSide && typeof rawSide === 'string') {
		const normalized = rawSide.trim().toUpperCase();
		if (normalized === SignalSide.BUY || normalized === SignalSide.SELL || normalized === SignalSide.WAIT) {
			return normalized;
		}
	}

	if (sentiment === 'BULLISH') {
		return SignalSide.BUY;
	}

	if (sentiment === 'BEARISH') {
		return SignalSide.SELL;
	}

	return SignalSide.WAIT;
}

function normalizeUrgencyLevel(rawLevel, context = {}) {
	if (rawLevel && typeof rawLevel === 'string') {
		const normalized = rawLevel.trim().toUpperCase();
		if (URGENCY_ORDER[normalized]) {
			return normalized;
		}
	}

	const scoreAbs = Math.abs(Number(context.sentiment_score) || 0);
	const technicalLevels = context.technical_levels || { supports: [], resistances: [] };
	const levelCount = (technicalLevels.supports || []).length + (technicalLevels.resistances || []).length;
	const combinedText = [
		context.original_text,
		context.headline,
		context.recommended_action,
		context.risk_warning,
		...(context.insights || []),
	].filter(Boolean).join(' ');
	const hasStrongHints = HIGH_URGENCY_HINTS.test(combinedText);
	const hasHighConviction = !!(context.indicator_context && context.indicator_context.highConviction);

	if (hasHighConviction || scoreAbs >= 0.75 || (scoreAbs >= 0.55 && hasStrongHints)) {
		return UrgencyLevel.HIGH;
	}

	if (scoreAbs >= 0.35 || levelCount >= 2 || hasStrongHints) {
		return UrgencyLevel.MEDIUM;
	}

	return UrgencyLevel.LOW;
}

function normalizeScenarioEntry(entry) {
	if (!entry || typeof entry !== 'object') {
		return null;
	}

	const trigger = cleanText(entry.trigger);
	const outcome = cleanText(entry.outcome);

	if (!trigger && !outcome) {
		return null;
	}

	return {
		trigger,
		outcome,
	};
}

function detectAlertLanguage(...texts) {
	const sample = texts
		.flat()
		.map(cleanText)
		.filter(Boolean)
		.join(' ');

	return SPANISH_HINTS.test(sample) ? 'es' : 'en';
}

function getWebhookCopy(language = 'es') {
	if (language === 'en') {
		return {
			labels: {
				action: 'RECOMMENDED ACTION',
				urgency: 'Urgency',
				caution: 'Caution',
				scenarios: 'Scenarios',
				bull: 'Bull case',
				bear: 'Bear case',
				quickRead: 'Quick read',
				keyLevels: 'Key levels',
				supports: 'Supports',
				resistances: 'Resistances',
				sources: 'Sources',
				reminder: 'REMINDER',
			},
			urgencyLabels: {
				[UrgencyLevel.LOW]: 'Low',
				[UrgencyLevel.MEDIUM]: 'Medium',
				[UrgencyLevel.HIGH]: 'High',
			},
		};
	}

	return {
		labels: {
			action: 'ACCION RECOMENDADA',
			urgency: 'Urgencia',
			caution: 'Cuidado',
			scenarios: 'Escenarios',
			bull: 'Escenario bull',
			bear: 'Escenario bear',
			quickRead: 'Lectura rapida',
			keyLevels: 'Niveles clave',
			supports: 'Soportes',
			resistances: 'Resistencias',
			sources: 'Fuentes',
			reminder: 'RECORDATORIO',
		},
		urgencyLabels: {
			[UrgencyLevel.LOW]: 'Baja',
			[UrgencyLevel.MEDIUM]: 'Media',
			[UrgencyLevel.HIGH]: 'Alta',
		},
	};
}

function normalizeTechnicalLevels(levels = {}) {
	return {
		supports: uniqueStrings(levels.supports || []),
		resistances: uniqueStrings(levels.resistances || []),
	};
}

function buildFallbackScenarios(technicalLevels = {}, language = 'es') {
	const [firstResistance, secondResistance] = technicalLevels.resistances || [];
	const [firstSupport, secondSupport] = technicalLevels.supports || [];
	let bull = null;
	let bear = null;

	if (firstResistance) {
		bull = {
			trigger: language === 'en' ? `If it breaks ${firstResistance}` : `Si rompe ${firstResistance}`,
			outcome: secondResistance
				? language === 'en' ? `next objective ${secondResistance}` : `objetivo ${secondResistance}`
				: language === 'en' ? 'there is room for continuation higher' : 'se abre espacio para seguir subiendo',
		};
	}

	if (firstSupport) {
		bear = {
			trigger: language === 'en' ? `If it loses ${firstSupport}` : `Si pierde ${firstSupport}`,
			outcome: secondSupport
				? language === 'en' ? `probable drop toward ${secondSupport}` : `caida probable a ${secondSupport}`
				: language === 'en' ? 'it can speed up lower' : 'puede acelerar la correccion',
		};
	}

	return {
		bull,
		bear,
	};
}

function normalizeScenarios(rawScenarios, technicalLevels, language) {
	const bull = normalizeScenarioEntry(rawScenarios && rawScenarios.bull);
	const bear = normalizeScenarioEntry(rawScenarios && rawScenarios.bear);
	const fallback = buildFallbackScenarios(technicalLevels, language);

	return {
		bull: bull || fallback.bull,
		bear: bear || fallback.bear,
	};
}

function buildFallbackHeadline({
	language,
	assetSymbol,
	timeframe,
	signalSide,
	urgencyLevel,
	originalText,
}) {
	const marketLabel = assetSymbol
		? `${assetSymbol}${timeframe ? ` ${timeframe}` : ''}`
		: language === 'en' ? 'this setup' : 'esta jugada';

	if (signalSide === SignalSide.SELL) {
		if (urgencyLevel === UrgencyLevel.HIGH) {
			return language === 'en'
				? `${marketLabel} rolled over hard. The bullish party is cooling off for now.`
				: `${marketLabel} se dio vuelta con fuerza. Se enfrio la fiesta alcista por ahora.`;
		}

		return language === 'en'
			? `${marketLabel} is losing steam. Do not fall in love with the bounce yet.`
			: `${marketLabel} esta perdiendo fuerza. No te enamores del rebote todavia.`;
	}

	if (signalSide === SignalSide.BUY) {
		if (urgencyLevel === UrgencyLevel.HIGH) {
			return language === 'en'
				? `${marketLabel} is pushing higher. Wait for confirmation before chasing the candle.`
				: `${marketLabel} viene empujando al alza. Espera confirmacion antes de perseguir la vela.`;
		}

		return language === 'en'
			? `${marketLabel} looks constructive, but it still needs confirmation.`
			: `${marketLabel} se ve mejor, pero aun necesita confirmacion.`;
	}

	if (originalText) {
		return originalText;
	}

	return language === 'en'
		? 'The move is still noisy. Better wait for a cleaner setup.'
		: 'La jugada sigue ruidosa. Mejor esperar una entrada mas limpia.';
}

function buildFallbackRecommendedAction({ language, signalSide, urgencyLevel }) {
	if (signalSide === SignalSide.SELL) {
		if (urgencyLevel === UrgencyLevel.HIGH) {
			return language === 'en'
				? 'Take partial profits or close the position and move your stop now.'
				: 'Tomar ganancias parciales o cerrar posicion y mover el stop ya.';
		}

		if (urgencyLevel === UrgencyLevel.MEDIUM) {
			return language === 'en'
				? 'Cut risk and protect the position before looking for a fresh entry.'
				: 'Reducir riesgo y proteger la posicion antes de buscar una nueva entrada.';
		}

		return language === 'en'
			? 'Keep it on watch. Do not add risk until support is cleaner.'
			: 'Solo monitorear. No sumes riesgo hasta ver soporte mas limpio.';
	}

	if (signalSide === SignalSide.BUY) {
		if (urgencyLevel === UrgencyLevel.HIGH) {
			return language === 'en'
				? 'Look for continuation only with confirmation and a defined stop.'
				: 'Buscar continuidad solo con confirmacion y stop definido.';
		}

		if (urgencyLevel === UrgencyLevel.MEDIUM) {
			return language === 'en'
				? 'Prepare the entry, but wait for a clean breakout before sizing up.'
				: 'Preparar la entrada, pero esperar ruptura limpia antes de meter size completo.';
		}

		return language === 'en'
			? 'Monitor only. It is not a clean entry yet.'
			: 'Solo monitorear. Todavia no es una entrada limpia.';
	}

	return language === 'en'
		? 'Monitor only and wait for a cleaner setup before acting.'
		: 'Solo monitorear y esperar una senal mas limpia antes de actuar.';
}

function buildFallbackUrgencyReason({ language, signalSide, urgencyLevel }) {
	if (urgencyLevel === UrgencyLevel.HIGH) {
		if (signalSide === SignalSide.SELL) {
			return language === 'en'
				? 'Several sell signals are aligned, so this needs action now.'
				: 'Se alinearon varias senales de venta, asi que esto pide reaccion ahora.';
		}

		if (signalSide === SignalSide.BUY) {
			return language === 'en'
				? 'Momentum is strong, but it only pays if the breakout confirms.'
				: 'El impulso viene fuerte, pero solo sirve si la ruptura confirma.';
		}

		return language === 'en'
			? 'The move has enough conviction to deserve immediate attention.'
			: 'La jugada tiene suficiente conviccion como para mirarla ya.';
	}

	if (urgencyLevel === UrgencyLevel.MEDIUM) {
		if (signalSide === SignalSide.SELL) {
			return language === 'en'
				? 'The structure is weakening, but this still needs confirmation.'
				: 'La estructura se enfria, pero aun falta confirmacion total.';
		}

		if (signalSide === SignalSide.BUY) {
			return language === 'en'
				? 'Buyers are showing up, but the setup can still fake out.'
				: 'Aparecen compradores, pero la jugada aun puede barrer liquidez.';
		}

		return language === 'en'
			? 'Signals are improving, but not enough for a full conviction move yet.'
			: 'Las senales mejoran, pero todavia no para una jugada de conviccion total.';
	}

	return language === 'en'
		? 'This is a smaller shift for now, so monitoring is enough.'
		: 'Por ahora es un cambio menor, asi que basta con monitorear.';
}

function buildFallbackRiskWarning({ language, originalText, insights, indicatorContext }) {
	const combinedText = [originalText, ...(insights || [])].filter(Boolean).join(' ');
	if (DIVERGENCE_HINTS.test(combinedText) || (indicatorContext && indicatorContext.divergenceHint)) {
		return language === 'en'
			? 'Price is moving, but the strength is not keeping up. Do not chase the top.'
			: 'El precio se mueve, pero la fuerza no acompana. No compres el peak.';
	}

	return null;
}

function normalizeReminder(reminder) {
	if (!reminder || typeof reminder !== 'object') {
		return null;
	}

	const text = cleanText(reminder.text);
	if (!text) {
		return null;
	}

	return {
		triggered: reminder.triggered === true,
		text,
	};
}

function normalizeActionableAlert(raw = {}) {
	const originalText = cleanText(raw.original_text);
	const insights = uniqueStrings(raw.insights || []);
	const language = raw.language || detectAlertLanguage(
		originalText,
		raw.headline,
		raw.recommended_action,
		raw.risk_warning,
		insights,
	);
	const sentiment = normalizeSentiment(raw.sentiment);
	const sentimentScore = normalizeSentimentScore(sentiment, raw.sentiment_score);
	const technicalLevels = normalizeTechnicalLevels(raw.technical_levels);
	const signalSide = normalizeSignalSide(raw.signal_side, sentiment);
	const urgencyLevel = normalizeUrgencyLevel(raw.urgency_level, {
		...raw,
		original_text: originalText,
		insights,
		sentiment_score: sentimentScore,
		signal_side: signalSide,
		technical_levels: technicalLevels,
	});
	const headline = cleanText(raw.headline) || buildFallbackHeadline({
		language,
		assetSymbol: cleanText(raw.asset_symbol),
		timeframe: cleanText(raw.timeframe),
		signalSide,
		urgencyLevel,
		originalText,
	});
	const recommendedAction = cleanText(raw.recommended_action) || buildFallbackRecommendedAction({
		language,
		signalSide,
		urgencyLevel,
	});
	const urgencyReason = cleanText(raw.urgency_reason) || buildFallbackUrgencyReason({
		language,
		signalSide,
		urgencyLevel,
	});
	const riskWarning = cleanText(raw.risk_warning) || buildFallbackRiskWarning({
		language,
		originalText,
		insights,
		indicatorContext: raw.indicator_context,
	});
	const scenarios = normalizeScenarios(raw.scenarios, technicalLevels, language);
	const reminder = normalizeReminder(raw.reminder);

	return {
		...raw,
		original_text: originalText,
		sentiment,
		sentiment_score: sentimentScore,
		insights,
		technical_levels: technicalLevels,
		sources: Array.isArray(raw.sources) ? raw.sources : [],
		truncated: !!raw.truncated,
		headline,
		recommended_action: recommendedAction,
		urgency_level: urgencyLevel,
		urgency_reason: urgencyReason,
		risk_warning: riskWarning || null,
		scenarios,
		asset_symbol: cleanText(raw.asset_symbol) || null,
		timeframe: cleanText(raw.timeframe) || null,
		signal_side: signalSide,
		language,
		reminder,
	};
}

function buildReminderKey(enriched = {}) {
	const normalized = normalizeActionableAlert(enriched);
	if (!normalized.asset_symbol) {
		return null;
	}

	return [
		normalized.asset_symbol.toUpperCase(),
		normalized.signal_side,
		normalized.timeframe || 'na',
	].join('|');
}

function isReminderEligible(enriched = {}) {
	const normalized = normalizeActionableAlert(enriched);
	return (
		normalized.asset_symbol
		&& normalized.signal_side === SignalSide.SELL
		&& normalized.urgency_level === UrgencyLevel.HIGH
	);
}

function buildReminderText(enriched = {}) {
	const normalized = normalizeActionableAlert(enriched);
	const marketLabel = normalized.asset_symbol
		? `${normalized.asset_symbol}${normalized.timeframe ? ` ${normalized.timeframe}` : ''}`
		: normalized.language === 'en' ? 'this setup' : 'esta jugada';

	if (normalized.language === 'en') {
		return `Still seeing strong sell pressure on ${marketLabel}. If you are still in, review the stop before you hold and hope.`;
	}

	return `Sigo viendo venta fuerte en ${marketLabel}. Si sigues dentro, revisa el stop antes de holdear por fe.`;
}

module.exports = {
	UrgencyLevel,
	SignalSide,
	detectAlertLanguage,
	getWebhookCopy,
	normalizeActionableAlert,
	buildReminderKey,
	isReminderEligible,
	buildReminderText,
	URGENCY_ORDER,
};
