/* global describe, it, expect */

const { validateAlert } = require('../../src/lib/validation');

describe('validateAlert', () => {
	it('reports metadata when alert text is truncated', () => {
		const result = validateAlert('A'.repeat(4001));

		expect(result).toEqual({
			text: `${'A'.repeat(4000)}...`,
			metadata: null,
			truncated: true,
			originalLength: 4001,
			deliveredLength: 4003,
		});
	});

	it('does not add truncation metadata when alert text fits', () => {
		expect(validateAlert('short')).toEqual({ text: 'short', metadata: null });
	});
});
