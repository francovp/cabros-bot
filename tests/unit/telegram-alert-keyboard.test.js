'use strict';

const {
	buildReplyMarkup,
	buildCallbackData,
	parseCallbackData,
	getActionCodes,
	TELEGRAM_MAX_CALLBACK_BYTES,
} = require('../../src/services/alerts/telegramAlertKeyboard');

describe('telegramAlertKeyboard', () => {
	describe('buildCallbackData', () => {
		it('produces a callback string that fits in the 64-byte Telegram limit', () => {
			const data = buildCallbackData('vd', 'ABCDEFGH');
			expect(data).toBe('vd:ABCDEFGH');
			expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_MAX_CALLBACK_BYTES);
		});

		it('throws when the resulting data would exceed the limit', () => {
			const longShortId = 'A'.repeat(80);
			expect(() => buildCallbackData('vd', longShortId)).toThrow(RangeError);
		});

		it('rejects empty action or shortId', () => {
			expect(() => buildCallbackData('', 'ABCDEFGH')).toThrow(TypeError);
			expect(() => buildCallbackData('r', '')).toThrow(TypeError);
		});
	});

	describe('parseCallbackData', () => {
		it('parses action and shortId from a valid payload', () => {
			expect(parseCallbackData('r:ABCDEFGH')).toEqual({ action: 'r', shortId: 'ABCDEFGH' });
			expect(parseCallbackData('vd:0000AAAA')).toEqual({ action: 'vd', shortId: '0000AAAA' });
		});

		it('returns null for malformed payloads', () => {
			expect(parseCallbackData('')).toBeNull();
			expect(parseCallbackData('nocolon')).toBeNull();
			expect(parseCallbackData(':ABCDEFGH')).toBeNull();
			expect(parseCallbackData('r:')).toBeNull();
		});
	});

	describe('buildReplyMarkup', () => {
		it('returns a 3-row inline_keyboard when enrichment and replay are both enabled', () => {
			const markup = buildReplyMarkup({ shortId: 'ABCDEFGH', hasEnrichment: true, includeReplay: true });
			expect(markup).not.toBeNull();
			const rows = markup.inline_keyboard;
			expect(rows).toHaveLength(3);
			expect(rows[0]).toHaveLength(2);
			expect(rows[0][0].text).toBe('🔁 Replay');
			expect(rows[0][0].callback_data).toBe('r:ABCDEFGH');
			expect(rows[0][1].text).toBe('✖️ Descartar');
			expect(rows[0][1].callback_data).toBe('x:ABCDEFGH');
			expect(rows[1]).toHaveLength(1);
			expect(rows[1][0].callback_data).toBe('d:ABCDEFGH');
			expect(rows[2]).toHaveLength(2);
			expect(rows[2][0].callback_data).toBe('vu:ABCDEFGH');
			expect(rows[2][1].callback_data).toBe('vd:ABCDEFGH');
		});

		it('omits the Details row when there is no enrichment', () => {
			const markup = buildReplyMarkup({ shortId: 'ABCDEFGH', hasEnrichment: false, includeReplay: true });
			const rows = markup.inline_keyboard;
			expect(rows).toHaveLength(2);
			const callbackActions = rows.flat().map((button) => button.callback_data.split(':')[0]);
			expect(callbackActions).not.toContain('d');
		});

		it('omits the Replay button when includeReplay is false', () => {
			const markup = buildReplyMarkup({ shortId: 'ABCDEFGH', hasEnrichment: true, includeReplay: false });
			const rows = markup.inline_keyboard;
			const callbackActions = rows.flat().map((button) => button.callback_data.split(':')[0]);
			expect(callbackActions).not.toContain('r');
		});

		it('returns null when shortId is missing or empty', () => {
			expect(buildReplyMarkup({ shortId: '' })).toBeNull();
			expect(buildReplyMarkup({ shortId: null })).toBeNull();
			expect(buildReplyMarkup()).toBeNull();
		});

		it('keeps every callback_data payload within the Telegram 64-byte limit', () => {
			const markup = buildReplyMarkup({ shortId: 'ABCDEFGH', hasEnrichment: true, includeReplay: true });
			markup.inline_keyboard.flat().forEach((button) => {
				expect(Buffer.byteLength(button.callback_data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_MAX_CALLBACK_BYTES);
			});
		});
	});

	describe('getActionCodes', () => {
		it('exposes the canonical action codes', () => {
			const codes = getActionCodes();
			expect(codes).toEqual({
				ACTION_REPLAY: 'r',
				ACTION_DETAILS: 'd',
				ACTION_DISMISS: 'x',
				ACTION_VOTE_UP: 'vu',
				ACTION_VOTE_DOWN: 'vd',
			});
		});
	});
});
