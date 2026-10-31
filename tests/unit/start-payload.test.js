'use strict';

const {
	parseStartPayload,
	encodeStartPayload,
	buildWelcomeMessage,
	buildStartMessage,
	ALLOWED_LANGUAGES,
	DEFAULT_LANGUAGE,
	MAX_PAYLOAD_LENGTH,
} = require('../../src/controllers/commands/handlers/start/startPayload');

describe('parseStartPayload', () => {
	it('round-trips a Telegram-safe deep-link parameter', () => {
		const encoded = encodeStartPayload('lang=en&watch=BTCUSDT,ETHUSDT');
		expect(encoded).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
		expect(parseStartPayload(encoded)).toMatchObject({ language: 'en', watchlist: ['BTCUSDT', 'ETHUSDT'], invalid: false });
	});

	it('rejects malformed encoded deep-link parameters', () => {
		expect(parseStartPayload('v1_not-valid-encoding_')).toMatchObject({ invalid: true, tokens: [] });
	});
	it('returns empty result for empty/null payloads without marking them invalid', () => {
		expect(parseStartPayload()).toEqual({
			tokens: [],
			language: null,
			watchlist: [],
			refSource: null,
			invalid: false,
		});
		expect(parseStartPayload('')).toEqual({
			tokens: [],
			language: null,
			watchlist: [],
			refSource: null,
			invalid: false,
		});
		expect(parseStartPayload('   ')).toEqual({
			tokens: [],
			language: null,
			watchlist: [],
			refSource: null,
			invalid: false,
		});
	});

	it('flags payloads longer than MAX_PAYLOAD_LENGTH as invalid without parsing', () => {
		const longPayload = 'a'.repeat(MAX_PAYLOAD_LENGTH + 1);
		const result = parseStartPayload(longPayload);
		expect(result.invalid).toBe(true);
		expect(result.tokens).toEqual([]);
	});

	it('parses enroll token as opt-in default', () => {
		const result = parseStartPayload('enroll');
		expect(result).toEqual({
			tokens: [{ kind: 'enroll', value: 'enroll' }],
			language: null,
			watchlist: [],
			refSource: null,
			invalid: false,
		});
	});

	it('normalises language and rejects unknown languages', () => {
		expect(parseStartPayload('lang=es').language).toBe('es');
		expect(parseStartPayload('lang=EN').language).toBe('en');
		const unknown = parseStartPayload('lang=zz');
		expect(unknown.language).toBeNull();
		expect(unknown.invalid).toBe(true);
	});

	it('parses comma-separated watch tokens, dedupes, and normalises to uppercase', () => {
		const result = parseStartPayload('watch=BTCUSDT,ethusdt,BTCUSDT,ETH-USDT');
		expect(result.watchlist).toEqual(['BTCUSDT', 'ETHUSDT', 'ETH-USDT']);
		expect(result.invalid).toBe(false);
	});

	it('drops malformed watch symbols without invalidating well-formed siblings', () => {
		const result = parseStartPayload('watch=BTCUSDT,bad!!,ETHUSDT');
		expect(result.watchlist).toEqual(['BTCUSDT', 'ETHUSDT']);
		expect(result.invalid).toBe(false);
	});

	it('captures refSource tokens', () => {
		const result = parseStartPayload('ref=campaign-2026-Q1');
		expect(result.refSource).toBe('campaign-2026-Q1');
		expect(result.invalid).toBe(false);
	});

	it('flags empty ref tokens as invalid', () => {
		const result = parseStartPayload('ref=');
		expect(result.refSource).toBeNull();
		expect(result.invalid).toBe(true);
	});

	it('flags unknown tokens as invalid', () => {
		const result = parseStartPayload('foo=bar');
		expect(result.invalid).toBe(true);
		expect(result.tokens).toEqual([]);
	});

	it('combines multiple tokens in a single payload', () => {
		const result = parseStartPayload('lang=es&watch=BTCUSDT,ETHUSDT&ref=launch');
		expect(result).toEqual({
			tokens: [
				{ kind: 'lang', value: 'es' },
				{ kind: 'watch', value: ['BTCUSDT', 'ETHUSDT'] },
				{ kind: 'ref', value: 'launch' },
			],
			language: 'es',
			watchlist: ['BTCUSDT', 'ETHUSDT'],
			refSource: 'launch',
			invalid: false,
		});
	});

	it('uses generic copy for a payload mixing valid and invalid tokens', () => {
		const result = buildStartMessage('enroll&unknown=private', null);
		expect(result.message).toContain('¡Hola!');
		expect(result.message).not.toContain('registré');
	});

	it('never includes an untrusted referral value in the welcome', () => {
		const result = buildStartMessage('ref=secretCampaign', null);
		expect(result.message).not.toContain('secretCampaign');
	});
});

describe('buildWelcomeMessage', () => {
	it('returns the generic Spanish welcome when no tokens are present', () => {
		const result = buildWelcomeMessage(parseStartPayload(''), null);
		expect(result.language).toBe('es');
		expect(result.message).toContain('¡Hola!');
	});

	it('prefers an enrolled token over generic copy', () => {
		const parsed = parseStartPayload('enroll');
		const result = buildWelcomeMessage(parsed, null);
		expect(result.message).toMatch(/registré/i);
	});

	it('renders the watch summary in Spanish', () => {
		const parsed = parseStartPayload('watch=BTCUSDT,ETHUSDT');
		const result = buildWelcomeMessage(parsed, null);
		expect(result.message).toContain('BTCUSDT');
		expect(result.message).toContain('ETHUSDT');
	});

	it('switches to English copy when language=en', () => {
		const parsed = parseStartPayload('lang=en');
		const result = buildWelcomeMessage(parsed, null);
		expect(result.language).toBe('en');
		expect(result.message).toMatch(/Language updated/i);
	});

	it('falls back to default language for unsupported preferences', () => {
		const result = buildWelcomeMessage(parseStartPayload('enroll'), 'zz');
		expect(result.language).toBe(DEFAULT_LANGUAGE);
	});

	it('exposes the allowed language allowlist', () => {
		expect(ALLOWED_LANGUAGES.has('es')).toBe(true);
		expect(ALLOWED_LANGUAGES.has('en')).toBe(true);
		expect(ALLOWED_LANGUAGES.has('fr')).toBe(false);
	});
});

describe('buildStartMessage', () => {
	it('combines parser and welcome builder', () => {
		const result = buildStartMessage('lang=es&watch=BTCUSDT', null);
		expect(result.language).toBe('es');
		expect(result.parsed.watchlist).toEqual(['BTCUSDT']);
		expect(result.message).toBeTruthy();
	});
});
