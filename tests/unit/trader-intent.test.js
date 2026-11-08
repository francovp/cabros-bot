'use strict';

const {
	validateTraderIntent,
	isCompleteTraderIntent,
} = require('../../src/lib/traderIntent');

function expectInvalid(raw, field) {
	expect(() => validateTraderIntent(raw)).toThrow(expect.objectContaining({
		code: 'INVALID_REQUEST',
		statusCode: 400,
		message: expect.stringContaining(field),
	}));
}

describe('trader intent validation', () => {
	it('keeps omission inert', () => {
		expect(validateTraderIntent(undefined)).toBeUndefined();
	});

	it('returns a sanitized copy of a complete BUY plan', () => {
		const raw = {
			side: 'BUY',
			entry: 60500,
			invalidation: 59000,
			target: 62000,
			horizon: '1D',
			notes: '  Conservative plan  ',
		};

		const intent = validateTraderIntent(raw);

		expect(intent).toEqual({
			side: 'BUY',
			entry: 60500,
			invalidation: 59000,
			target: 62000,
			horizon: '1D',
			notes: 'Conservative plan',
		});
		expect(intent).not.toBe(raw);
		expect(isCompleteTraderIntent(intent)).toBe(true);
	});

	it('accepts a partial annotation without directional barriers', () => {
		const intent = validateTraderIntent({ entry: 60500, horizon: '4h' });

		expect(intent).toEqual({ entry: 60500, horizon: '4h' });
		expect(isCompleteTraderIntent(intent)).toBe(false);
	});

	it.each([
		[null, 'traderIntent'],
		[[], 'traderIntent'],
		['plan', 'traderIntent'],
		[{}, 'entry'],
		[{ entry: 100 }, 'horizon'],
		[{ entry: 100, horizon: '1d' }, 'horizon'],
		[{ entry: 0, horizon: '1h' }, 'entry'],
		[{ entry: -1, horizon: '1h' }, 'entry'],
		[{ entry: Number.NaN, horizon: '1h' }, 'entry'],
		[{ entry: Number.POSITIVE_INFINITY, horizon: '1h' }, 'entry'],
		[{ entry: 100, horizon: '1h', side: 'buy' }, 'side'],
		[{ entry: 100, horizon: '1h', target: 110 }, 'side'],
		[{ entry: 100, horizon: '1h', invalidation: 90 }, 'side'],
		[{ entry: 100, horizon: '1h', extra: true }, 'extra'],
		[{ entry: 100, horizon: '1h', notes: '' }, 'notes'],
		[{ entry: 100, horizon: '1h', notes: 'x'.repeat(501) }, 'notes'],
	])('rejects invalid trader intent %#', (raw, field) => {
		expectInvalid(raw, field);
	});

	it.each([
		[{ side: 'BUY', entry: 100, invalidation: 100, target: 110, horizon: '1h' }, 'invalidation'],
		[{ side: 'BUY', entry: 100, invalidation: 90, target: 100, horizon: '1h' }, 'target'],
		[{ side: 'SELL', entry: 100, invalidation: 100, target: 90, horizon: '1h' }, 'invalidation'],
		[{ side: 'SELL', entry: 100, invalidation: 110, target: 100, horizon: '1h' }, 'target'],
	])('rejects directionally inverted levels %#', (raw, field) => {
		expectInvalid(raw, field);
	});

	it('accepts a complete SELL plan', () => {
		const intent = validateTraderIntent({
			side: 'SELL', entry: 100, invalidation: 110, target: 80, horizon: '1W',
		});

		expect(isCompleteTraderIntent(intent)).toBe(true);
	});
});
