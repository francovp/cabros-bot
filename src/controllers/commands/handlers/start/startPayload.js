'use strict';

/**
 * startPayload parser for /start t.me/<bot>?start=<payload> deep links.
 *
 * Tokens:
 *   enroll            -> opt-in default enrollment, generic welcome
 *   lang=es|lang=en   -> sets chat language preference
 *   watch=SYM1,SYM2   -> pre-populates the chat watchlist
 *   ref=<token>       -> operator-issued referral attribution
 *
 * Multiple tokens can be combined into a single payload, separated by `&`
 * (Telegram preserves the raw query string up to 64 chars). Each token is
 * parsed independently; tokens with malformed values are dropped silently
 * so a noisy payload cannot lock the user out of the welcome flow.
 *
 * The parser never echoes the raw payload back to the chat; welcome copy
 * is chosen from a localized map.
 */

const MAX_PAYLOAD_LENGTH = 64;
const MAX_WATCH_TOKENS = 20;
const MAX_WATCH_SYMBOL_LENGTH = 30;
const MAX_REF_TOKEN_LENGTH = 64;
const ALLOWED_LANGUAGES = new Set(['es', 'en']);

const WELCOME_COPY = {
	es: {
		enrolled: '¡Listo! Te registré como nuevo chat de Cabros Bot.',
		languageUpdated: 'Idioma actualizado a Español.',
		watchUpdated: 'Tu watchlist quedó con {symbols}.',
		refRecorded: 'Origen registrado.',
		generic: '¡Hola! Soy Cabros Bot. Estoy listo para ayudarte con señales y precios.',
	},
	en: {
		enrolled: "All set! You're registered as a new Cabros Bot chat.",
		languageUpdated: 'Language updated to English.',
		watchUpdated: 'Your watchlist is now {symbols}.',
		refRecorded: 'Referral recorded.',
		generic: "Hi! I'm Cabros Bot. Ready to help with signals and prices.",
	},
};

const DEFAULT_LANGUAGE = 'es';
const DEEP_LINK_PREFIX = 'v1_';

function encodeStartPayload(rawPayload) {
	const parsed = parseStartPayload(rawPayload);
	if (parsed.invalid || parsed.tokens.length === 0) throw new TypeError('Invalid start payload');
	const encoded = DEEP_LINK_PREFIX + Buffer.from(rawPayload, 'utf8').toString('base64url');
	if (encoded.length > MAX_PAYLOAD_LENGTH) throw new RangeError('Start payload exceeds Telegram limit');
	return encoded;
}

function isSupportedLanguage(value) {
	return typeof value === 'string' && ALLOWED_LANGUAGES.has(value.trim().toLowerCase());
}

function sanitizeSymbol(symbol) {
	if (typeof symbol !== 'string') return null;
	const trimmed = symbol.trim().toUpperCase();
	if (!trimmed) return null;
	if (trimmed.length > MAX_WATCH_SYMBOL_LENGTH) return null;
	if (!/^[A-Z0-9._-]+$/.test(trimmed)) return null;
	return trimmed;
}

function parseWatchValue(value) {
	if (typeof value !== 'string') return null;
	const tokens = value.split(',');
	const cleaned = [];
	const seen = new Set();
	for (const raw of tokens) {
		const symbol = sanitizeSymbol(raw);
		if (!symbol) continue;
		if (seen.has(symbol)) continue;
		seen.add(symbol);
		cleaned.push(symbol);
		if (cleaned.length >= MAX_WATCH_TOKENS) break;
	}
	return cleaned.length > 0 ? cleaned : null;
}

function parseRefValue(value) {
	if (typeof value !== 'string') return null;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > MAX_REF_TOKEN_LENGTH) return null;
	return trimmed;
}

/**
 * Parse a start payload string into a structured result.
 *
 * @param {string} [rawPayload]
 * @returns {{tokens: Array<{kind: string, value: string|Array<string>}>, language: string|null, watchlist: string[], refSource: string|null, invalid: boolean}}
 */
function parseStartPayload(rawPayload, decoded = false) {
	const emptyResult = {
		tokens: [],
		language: null,
		watchlist: [],
		refSource: null,
		invalid: false,
	};
	if (typeof rawPayload !== 'string') return emptyResult;
	const trimmed = rawPayload.trim();
	if (!trimmed) return emptyResult;
	if (trimmed.length > MAX_PAYLOAD_LENGTH) {
		return { ...emptyResult, invalid: true };
	}
	if (!decoded && trimmed.startsWith(DEEP_LINK_PREFIX)) {
		const encoded = trimmed.slice(DEEP_LINK_PREFIX.length);
		if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return { ...emptyResult, invalid: true };
		const bytes = Buffer.from(encoded, 'base64url');
		if (bytes.toString('base64url') !== encoded) return { ...emptyResult, invalid: true };
		const value = bytes.toString('utf8');
		if (!Buffer.from(value, 'utf8').equals(bytes)) return { ...emptyResult, invalid: true };
		return parseStartPayload(value, true);
	}

	const tokens = trimmed.split('&').map((part) => part.trim()).filter(Boolean);
	const parsed = [];
	let language = null;
	let watchlist = [];
	let refSource = null;
	let hasInvalid = false;

	for (const token of tokens) {
		const equalIndex = token.indexOf('=');
		if (equalIndex === -1) {
			if (token === 'enroll') {
				parsed.push({ kind: 'enroll', value: 'enroll' });
				continue;
			}
			hasInvalid = true;
			continue;
		}
		const key = token.slice(0, equalIndex).trim().toLowerCase();
		const value = token.slice(equalIndex + 1).trim();
		switch (key) {
		case 'enroll':
			parsed.push({ kind: 'enroll', value: 'enroll' });
			break;
		case 'lang': {
			if (isSupportedLanguage(value)) {
				language = value.trim().toLowerCase();
				parsed.push({ kind: 'lang', value: language });
			} else {
				hasInvalid = true;
			}
			break;
		}
		case 'watch': {
			const symbols = parseWatchValue(value);
			if (symbols) {
				watchlist = symbols;
				parsed.push({ kind: 'watch', value: symbols });
			} else {
				hasInvalid = true;
			}
			break;
		}
		case 'ref': {
			const ref = parseRefValue(value);
			if (ref) {
				refSource = ref;
				parsed.push({ kind: 'ref', value: ref });
			} else {
				hasInvalid = true;
			}
			break;
		}
		default:
			hasInvalid = true;
			break;
		}
	}

	return {
		tokens: parsed,
		language,
		watchlist,
		refSource,
		invalid: hasInvalid,
	};
}

/**
 * Pick the welcome message for a given parsed payload and preferred language.
 *
 * @param {object} parsedResult output of parseStartPayload
 * @param {string} [preferredLanguage]
 * @returns {{language: string, message: string, lines: string[]}}
 */
function buildWelcomeMessage(parsedResult, preferredLanguage) {
	const lang = isSupportedLanguage(preferredLanguage)
		? preferredLanguage.trim().toLowerCase()
		: (parsedResult && parsedResult.language) || DEFAULT_LANGUAGE;
	const copy = WELCOME_COPY[lang] || WELCOME_COPY[DEFAULT_LANGUAGE];

	const lines = [];
	let headline = copy.generic;
	if (parsedResult && !parsedResult.invalid && Array.isArray(parsedResult.tokens) && parsedResult.tokens.length > 0) {
		const kinds = new Set(parsedResult.tokens.map((token) => token.kind));
		if (kinds.has('enroll')) headline = copy.enrolled;
		else if (kinds.has('lang')) headline = copy.languageUpdated;
		else if (kinds.has('watch')) {
			const symbols = (parsedResult.watchlist || []).join(', ');
			headline = copy.watchUpdated.replace('{symbols}', symbols);
		} else if (kinds.has('ref')) {
			headline = copy.refRecorded;
		}
	}
	lines.push(headline);
	if (parsedResult && parsedResult.invalid) {
		// keep generic follow-up; never echo the raw payload
	}
	return {
		language: lang,
		message: lines.join('\n'),
		lines,
	};
}

/**
 * Build the localized welcome message from a raw start payload.
 *
 * @param {string} [rawPayload]
 * @param {string} [preferredLanguage]
 * @returns {{language: string, message: string, parsed: object}}
 */
function buildStartMessage(rawPayload, preferredLanguage) {
	const parsed = parseStartPayload(rawPayload);
	const welcome = buildWelcomeMessage(parsed, preferredLanguage);
	return {
		language: welcome.language,
		message: welcome.message,
		parsed,
	};
}

module.exports = {
	parseStartPayload,
	encodeStartPayload,
	buildWelcomeMessage,
	buildStartMessage,
	MAX_PAYLOAD_LENGTH,
	MAX_WATCH_TOKENS,
	MAX_WATCH_SYMBOL_LENGTH,
	MAX_REF_TOKEN_LENGTH,
	ALLOWED_LANGUAGES,
	WELCOME_COPY,
	DEFAULT_LANGUAGE,
};
