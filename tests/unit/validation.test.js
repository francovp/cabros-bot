'use strict';

const {
	validateAlert,
	VALID_SIGNAL_CLASSES,
} = require('../../src/lib/validation');

describe('validation - signalClass and validateAlert', () => {
	it('exports VALID_SIGNAL_CLASSES containing the 8 allowed closed enum values', () => {
		expect(VALID_SIGNAL_CLASSES).toBeDefined();
		const expectedClasses = [
			'breakout',
			'mean_reversion',
			'trend_continuation',
			'reversal',
			'volume_spike',
			'news_event',
			'manual',
			'unknown',
		];
		expect(Array.from(VALID_SIGNAL_CLASSES).sort()).toEqual(expectedClasses.sort());
	});

	it('defaults signalClass to unknown when not provided', () => {
		const result = validateAlert('BTCUSDT Breakout imminent');
		expect(result.text).toBe('BTCUSDT Breakout imminent');
		expect(result.signalClass).toBe('unknown');
	});

	it('accepts valid signalClass as 3rd argument and normalizes case and whitespace', () => {
		for (const validClass of VALID_SIGNAL_CLASSES) {
			const formatted = `  ${validClass.toUpperCase()}  `;
			const result = validateAlert('BTCUSDT Alert', null, formatted);
			expect(result.signalClass).toBe(validClass);
		}
	});

	it('accepts valid signalClass from metadata object', () => {
		const result = validateAlert('BTCUSDT Alert', { signalClass: 'reversal' });
		expect(result.signalClass).toBe('reversal');
	});

	it('rejects invalid signalClass with 400 INVALID_REQUEST error', () => {
		expect(() => validateAlert('BTCUSDT Alert', null, 'invalid_class')).toThrow(
			expect.objectContaining({
				statusCode: 400,
				code: 'INVALID_REQUEST',
			}),
		);
	});

	it('rejects non-string signalClass with 400 INVALID_REQUEST error', () => {
		expect(() => validateAlert('BTCUSDT Alert', null, 123)).toThrow(
			expect.objectContaining({
				statusCode: 400,
				code: 'INVALID_REQUEST',
			}),
		);
	});

	it('still validates text requiredness', () => {
		expect(() => validateAlert('', null, 'breakout')).toThrow('Alert text is required');
		expect(() => validateAlert('   ', null, 'breakout')).toThrow('Alert text is required');
		expect(() => validateAlert(null, null, 'breakout')).toThrow('Alert text is required');
	});
});

describe('validateAlert truncation metadata (GH-637)', () => {
	it('reports metadata when alert text is truncated', () => {
		const result = validateAlert('A'.repeat(4001));

		expect(result).toEqual({
			text: `${'A'.repeat(4000)}...`,
			metadata: null,
			signalClass: 'unknown',
			truncated: true,
			originalLength: 4001,
			deliveredLength: 4003,
		});
	});

	it('does not add truncation metadata when alert text fits', () => {
		expect(validateAlert('short')).toEqual({
			text: 'short',
			metadata: null,
			signalClass: 'unknown',
		});
	});

	it('does not add truncation metadata at the exact 4,000 character boundary', () => {
		const result = validateAlert('B'.repeat(4000));

		expect(result.truncated).toBeUndefined();
		expect(result.originalLength).toBeUndefined();
		expect(result.deliveredLength).toBeUndefined();
		expect(result.text).toBe('B'.repeat(4000));
	});

	it('reports truncation metadata together with an explicit signalClass', () => {
		const result = validateAlert('C'.repeat(4500), null, 'breakout');

		expect(result.signalClass).toBe('breakout');
		expect(result.truncated).toBe(true);
		expect(result.originalLength).toBe(4500);
		expect(result.deliveredLength).toBe(4003);
	});
});
