'use strict';

const { VALID_SIGNAL_CLASSES } = require('../../lib/validation');

/**
 * Signal classification (issue #858).
 *
 * The `signalClass` enum, its persistence, its filters, and the Telegram /
 * WhatsApp badge markers already existed, but nothing ever populated the value
 * on the webhook ingest path: `validateAlert()` returned 'unknown' whenever the
 * caller omitted an explicit class. Production evidence showed 10/10 stored
 * alerts in `unknown` while `featureFlags.signalClassMarker` reported `true`,
 * so the green flag implied a working classification that never happened.
 *
 * Design constraints:
 *   - DETERMINISTIC: same text always yields the same class. No randomness,
 *     no clock, no network, no model calls.
 *   - CHANNEL-NEUTRAL: this is business logic. It never touches formatters,
 *     MarkdownV2 escaping, or notification rendering. The formatters keep
 *     rendering markers exactly as before from whatever class they receive.
 *   - HONEST: text with no setup semantics stays 'unknown'. We would rather
 *     under-classify than attach a misleading badge to an alert.
 *   - FAIL-OPEN: classification and its metrics never throw into the caller,
 *     so delivery and persistence cannot be affected.
 */

const SignalClass = Object.freeze({
	BREAKOUT: 'breakout',
	MEAN_REVERSION: 'mean_reversion',
	TREND_CONTINUATION: 'trend_continuation',
	REVERSAL: 'reversal',
	VOLUME_SPIKE: 'volume_spike',
	NEWS_EVENT: 'news_event',
	MANUAL: 'manual',
	UNKNOWN: 'unknown',
});

/**
 * Ordered rules. The FIRST class whose vocabulary matches wins, so the order
 * encodes real precedence between competing interpretations of one alert:
 *
 *   1. manual   - operator authorship is a property of the whole message.
 *   2. news     - an external catalyst explains the move; it outranks whatever
 *                 price action the alert also describes.
 *   3. volume   - when volume is the explicit subject, it is the setup.
 *   4. mean_rev - a stretched extreme is more specific than a bare "reversal".
 *   5. breakout - breaking a level is a structural event.
 *   6. reversal - a directional flip.
 *   7. trend    - continuation of an existing move.
 *
 * Matching is substring-based on a normalized (lowercased, whitespace
 * collapsed) copy of the text, so multi-word phrases work regardless of the
 * internal spacing, and an alert mentioning several signals resolves to the
 * most specific one by the ordering above rather than to a coin flip.
 */
const RULES = [
	{
		class: SignalClass.MANUAL,
		phrases: ['manual', 'nota manual', 'revision manual', 'operator note'],
	},
	{
		class: SignalClass.NEWS_EVENT,
		phrases: [
			'news',
			'noticia',
			'noticias',
			'headline',
			'announced',
			'announcement',
			'approves',
			'approved',
			'approval',
			'partnership',
			'acquisition',
			'acquired',
			'merger',
			'ceo',
			'regulation',
			'regulatory',
			'catalyst',
			'press release',
			'filing',
			'earnings report',
		],
	},
	{
		class: SignalClass.VOLUME_SPIKE,
		// Only phrases where volume is unambiguously the SUBJECT of the alert
		// ("volume exploded") belong here. Generic strength words such as
		// "strong volume" or "huge volume" are deliberately excluded: in
		// "broke resistance with strong volume" the volume merely CONFIRMS a
		// breakout, and labelling that a volume_spike would misreport the
		// setup the operator actually acted on.
		phrases: [
			'volume spike',
			'spike in volume',
			'volume explosion',
			'volume surge',
			'surge in volume',
			'unusual volume',
			'abnormal volume',
			'volume anomaly',
			'volumen alto',
			'volumen fuerte',
			'aumento de volumen',
		],
	},
	{
		class: SignalClass.MEAN_REVERSION,
		phrases: [
			'mean reversion',
			'mean-reversion',
			'oversold bounce',
			'overbought rejection',
			'oversold',
			'overbought',
			'sobrevendido',
			'sobrecompra',
			'bollinger',
			'extremes',
			'stretched',
			'reversion to the mean',
		],
	},
	{
		class: SignalClass.BREAKOUT,
		phrases: [
			'breakout',
			'break out',
			'breaks out',
			'breaking out',
			'broke resistance',
			'break resistance',
			'breaks resistance',
			'breaking resistance',
			'breaks support',
			'broke support',
			'breaks down',
			'broke down',
			'break down resistance',
			'breaking down',
			'rompe resistencia',
			'ruptura',
		],
	},
	{
		class: SignalClass.REVERSAL,
		phrases: [
			'reversal',
			'reverse',
			'changes trend',
			'change of trend',
			'double top',
			'double bottom',
			'head and shoulders',
			'failed breakout',
			'failed break',
			'rechazo',
		],
	},
	{
		class: SignalClass.TREND_CONTINUATION,
		phrases: [
			'trend continuation',
			'trend-continuation',
			'continuation',
			'uptrend',
			'downtrend',
			'rally continues',
			'trend intact',
			'tendencia',
		],
	},
];

function normalizeForMatching(text) {
	if (typeof text !== 'string') {
		return '';
	}
	// Lowercase, fold accents, and collapse all whitespace.
	//
	// The Spanish vocabulary in RULES is stored unaccented, so without folding the
	// accented spellings that real Spanish alerts actually use never matched:
	// 'sobrecompra extrema' vs 'sobrecompra extrema' both missed. Folding is done
	// by stripping combining marks after NFD, which keeps every character in the
	// range [a-z0-9] and therefore keeps the ASCII word-boundary matchers valid.
	return text
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeExplicitSignalClass(value) {
	if (typeof value !== 'string') {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	return VALID_SIGNAL_CLASSES.has(normalized) ? normalized : null;
}

// Pre-compile each phrase as a word-boundary regex.
//
// A bare `includes()` matches a phrase anywhere inside a longer word, which
// misclassified ordinary prose: "las manualidades del prestamo" -> manual,
// "the newsroom was quiet" -> news_event, "el informe de CEO holdings" ->
// news_event. Those pollute byClass analytics and mislead trader filtering, which
// is exactly what this classification exists to serve.
//
// Boundaries are ASCII-aware on purpose: alert bodies are English/Spanish, and
// `\\b` would not treat an accented letter as a word character, which would
// either break real matches or reintroduce the substring problem.
/**
 * Where a signalClass came from. Recorded so a dead classifier is distinguishable
 * from one that is merely unused: `populationRate` alone cannot tell those apart,
 * because a caller that always supplies an explicit class yields the same 1.0 as
 * a fully working classifier.
 */
const SignalClassSource = Object.freeze({
	DERIVED: 'derived',
	EXPLICIT: 'explicit',
	// Derivation ran and found no setup semantics in the text.
	DEFAULTED: 'defaulted',
});

const VALID_SIGNAL_CLASS_SOURCES = new Set(Object.values(SignalClassSource));

const PHRASE_MATCHERS = Object.freeze(RULES.map(rule => Object.freeze({
	class: rule.class,
	matchers: Object.freeze(rule.phrases.map(phrase => {
		const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
		// A leading/trailing non-word char in the phrase (none today) needs no
		// boundary, otherwise the assertion could never match.
		const left = /^[a-z0-9]/.test(phrase) ? '(?<![a-z0-9])' : '';
		const right = /[a-z0-9]$/.test(phrase) ? '(?![a-z0-9])' : '';
		return new RegExp(`${left}${escaped.replace(/\s+/g, '\\s+')}${right}`, 'i');
	})),
})));

function deriveSignalClass(normalized) {
	if (!normalized) {
		return SignalClass.UNKNOWN;
	}
	for (const rule of PHRASE_MATCHERS) {
		for (const matcher of rule.matchers) {
			if (matcher.test(normalized)) {
				return rule.class;
			}
		}
	}
	return SignalClass.UNKNOWN;
}

/**
 * In-memory classification counters.
 *
 * Mirrors FirestoreWriteMetricsService / DeliveryMetricsService: windowed,
 * process-local, and returns null when nothing has been recorded so callers can
 * omit the key entirely from /api/status. Only enum classes and counts are
 * stored — never alert text, symbols, or chat ids.
 */
class SignalClassMetrics {
	constructor() {
		this.windowStartedAt = Date.now();
		this.classCounters = new Map();
		this.sourceCounters = new Map();
	}

	record(signalClass, source = SignalClassSource.DERIVED) {
		try {
			if (typeof signalClass !== 'string') {
				return;
			}
			const normalized = signalClass.trim().toLowerCase();
			if (!VALID_SIGNAL_CLASSES.has(normalized)) {
				return;
			}
			this.classCounters.set(normalized, (this.classCounters.get(normalized) || 0) + 1);
			const origin = VALID_SIGNAL_CLASS_SOURCES.has(source) ? source : SignalClassSource.DERIVED;
			this.sourceCounters.set(origin, (this.sourceCounters.get(origin) || 0) + 1);
		} catch (error) {
			// Fail-open: metric bookkeeping must never propagate.
			console.warn('[SignalClassMetrics] record failed:', error.message);
		}
	}

	getSnapshot() {
		try {
			const byClass = {};
			let totalAlerts = 0;
			for (const [signalClass, count] of this.classCounters.entries()) {
				byClass[signalClass] = count;
				totalAlerts += count;
			}
			if (totalAlerts === 0) {
				return null;
			}
			const unknownAlerts = byClass[SignalClass.UNKNOWN] || 0;
			const classifiedAlerts = totalAlerts - unknownAlerts;
			const bySource = {};
			for (const [origin, count] of this.sourceCounters.entries()) {
				bySource[origin] = count;
			}
			return {
				window: {
					startedAt: new Date(this.windowStartedAt).toISOString(),
					durationMs: Date.now() - this.windowStartedAt,
				},
				totalAlerts,
				classifiedAlerts,
				unknownAlerts,
				// 0 means "no alert classified so far", which is the signal that
				// a classification regression is silent rather than absent.
				populationRate: classifiedAlerts / totalAlerts,
				byClass,
				// Where each class came from. Without this, `populationRate` alone
				// cannot detect a dead classifier: a caller that always sends an
				// explicit class produces the same 1.0 as a fully working classifier,
				// and an always-'unknown' caller produces the same 0.0 as a regression.
				// `derivedAlerts` is therefore the real health signal.
				bySource,
				derivedAlerts: bySource[SignalClassSource.DERIVED] || 0,
				explicitAlerts: bySource[SignalClassSource.EXPLICIT] || 0,
				defaultedAlerts: bySource[SignalClassSource.DEFAULTED] || 0,
			};
		} catch (error) {
			console.warn('[SignalClassMetrics] getSnapshot failed:', error.message);
			return null;
		}
	}

	reset() {
		this.classCounters.clear();
		this.sourceCounters.clear();
		this.windowStartedAt = Date.now();
	}
}

const signalClassMetrics = new SignalClassMetrics();

/**
 * Classify an alert's signal class.
 *
 * @param {string} text Raw alert text.
 * @param {Object} [options]
 * @param {string} [options.explicit] Caller-supplied class. Honored when it is
 *   a valid enum member (so an API caller stays authoritative); otherwise the
 *   value is ignored rather than trusted, and derivation runs instead.
 * @returns {string} A VALID_SIGNAL_CLASSES member. Never throws.
 */
function classifySignal(text, options = {}) {
	try {
		const explicit = normalizeExplicitSignalClass(options && options.explicit);
		const derived = deriveSignalClass(normalizeForMatching(text));
		const resolved = explicit || derived || SignalClass.UNKNOWN;
		const source = explicit
			? SignalClassSource.EXPLICIT
			: (derived ? SignalClassSource.DERIVED : SignalClassSource.DEFAULTED);
		signalClassMetrics.record(resolved, source);
		return resolved;
	} catch (error) {
		// Fail-open: an unexpected classifier fault degrades to 'unknown' and
		// must never break alert delivery or persistence.
		console.warn('[SignalClassifier] classification failed, defaulting to unknown:', error.message);
		return SignalClass.UNKNOWN;
	}
}

module.exports = {
	SignalClassSource,
	SignalClass,
	classifySignal,
	deriveSignalClass,
	SignalClassMetrics,
	signalClassMetrics,
	RULES,
};
