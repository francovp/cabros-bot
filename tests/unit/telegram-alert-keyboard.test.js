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
			const data = buildCallbackData('vd', 'alert-abc-123');
			expect(data).toBe('vd:alert-abc-123');
			expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(TELEGRAM_MAX_CALLBACK_BYTES);
		});

		it('throws when the resulting data would exceed the limit', () => {
			const longAlertId = 'A'.repeat(80);
			expect(() => buildCallbackData('vd', longAlertId)).toThrow(RangeError);
		});

		it('rejects empty action or alertId', () => {
			expect(() => buildCallbackData('', 'alert-1')).toThrow(TypeError);
			expect(() => buildCallbackData('r', '')).toThrow(TypeError);
		});
	});

	describe('parseCallbackData', () => {
		it('parses action and alertId from a valid payload', () => {
			expect(parseCallbackData('r:alert-abc-123')).toEqual({ action: 'r', alertId: 'alert-abc-123' });
			expect(parseCallbackData('vd:0000AAAA')).toEqual({ action: 'vd', alertId: '0000AAAA' });
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
			const markup = buildReplyMarkup({ alertId: 'alert-abc-123', hasEnrichment: true, includeReplay: true });
			expect(markup).not.toBeNull();
			const rows = markup.inline_keyboard;
			expect(rows).toHaveLength(3);
			expect(rows[0]).toHaveLength(2);
			expect(rows[0][0].text).toBe('🔁 Replay');
			expect(rows[0][0].callback_data).toBe('r:alert-abc-123');
			expect(rows[0][1].text).toBe('✖️ Descartar');
			expect(rows[0][1].callback_data).toBe('x:alert-abc-123');
			expect(rows[1]).toHaveLength(1);
			expect(rows[1][0].callback_data).toBe('d:alert-abc-123');
			expect(rows[2]).toHaveLength(2);
			expect(rows[2][0].callback_data).toBe('vu:alert-abc-123');
			expect(rows[2][1].callback_data).toBe('vd:alert-abc-123');
		});

		it('omits the Details row when there is no enrichment', () => {
			const markup = buildReplyMarkup({ alertId: 'alert-abc-123', hasEnrichment: false, includeReplay: true });
			const rows = markup.inline_keyboard;
			expect(rows).toHaveLength(2);
			const callbackActions = rows.flat().map((button) => button.callback_data.split(':')[0]);
			expect(callbackActions).not.toContain('d');
		});

		it('omits the Replay button when includeReplay is false', () => {
			const markup = buildReplyMarkup({ alertId: 'alert-abc-123', hasEnrichment: true, includeReplay: false });
			const rows = markup.inline_keyboard;
			const callbackActions = rows.flat().map((button) => button.callback_data.split(':')[0]);
			expect(callbackActions).not.toContain('r');
		});

		it('returns null when alertId is missing or empty', () => {
			expect(buildReplyMarkup({ alertId: '' })).toBeNull();
			expect(buildReplyMarkup({ alertId: null })).toBeNull();
			expect(buildReplyMarkup()).toBeNull();
		});

		it('keeps every callback_data payload within the Telegram 64-byte limit', () => {
			const markup = buildReplyMarkup({ alertId: '550e8400-e29b-41d4-a716-446655440000', hasEnrichment: true, includeReplay: true });
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
