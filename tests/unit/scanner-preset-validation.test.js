'use strict';

const { validatePresetConfig } = require('../../src/controllers/webhooks/handlers/scannerPresets/scannerPresets');

describe('validatePresetConfig', () => {
	it('passes for a valid preset configuration', () => {
		const preset = {
			name: 'Valid preset',
			exchange: 'BINANCE',
			timeframe: '4h',
			scans: ['top_gainers', 'top_losers'],
			limit: 5,
			bbw_threshold: 0.05,
		};

		const errors = validatePresetConfig(preset);
		expect(errors).toEqual([]);
	});

	it('validates supported timeframe aliases', () => {
		const preset = {
			name: 'Valid preset with alias',
			exchange: 'BINANCE',
			timeframe: '1D',
			scans: ['volume_breakout_scanner'],
			limit: 10,
		};

		const errors = validatePresetConfig(preset);
		expect(errors).toEqual([]);
	});

	it('detects invalid scan types and empty scan list', () => {
		expect(validatePresetConfig({ exchange: 'BINANCE', timeframe: '4h', scans: [] })).toEqual([
			'scans must be a non-empty array of scan types',
		]);

		expect(validatePresetConfig({ exchange: 'BINANCE', timeframe: '4h', scans: ['unknown_tool', 'top_gainers'] })).toEqual([
			expect.stringContaining('Unsupported scan types: unknown_tool'),
		]);
	});

	it('detects unsupported timeframe', () => {
		const errors = validatePresetConfig({
			exchange: 'BINANCE',
			timeframe: 'invalid_tf',
			scans: ['top_gainers'],
		});

		expect(errors).toEqual(['Unsupported timeframe: invalid_tf']);
	});

	it('detects empty or invalid exchange', () => {
		const errors = validatePresetConfig({
			exchange: '',
			timeframe: '4h',
			scans: ['top_gainers'],
		});

		expect(errors).toEqual(['exchange must be a non-empty string']);
	});

	it('detects invalid limits', () => {
		expect(validatePresetConfig({
			exchange: 'BINANCE',
			timeframe: '4h',
			scans: ['top_gainers'],
			limit: 0,
		})).toEqual(['limit must be an integer between 1 and 20']);

		expect(validatePresetConfig({
			exchange: 'BINANCE',
			timeframe: '4h',
			scans: ['top_gainers'],
			limit: 25,
		})).toEqual(['limit must be an integer between 1 and 20']);
	});

	it('detects invalid bbw_threshold', () => {
		expect(validatePresetConfig({
			exchange: 'BINANCE',
			timeframe: '4h',
			scans: ['top_gainers'],
			bbw_threshold: 'not-a-number',
		})).toEqual(['bbw_threshold must be a number']);
	});

	it('detects invalid boolean overrides in reqBody', () => {
		expect(validatePresetConfig({
			exchange: 'BINANCE',
			timeframe: '4h',
			scans: ['top_gainers'],
		}, { ranked: 'not-a-bool', includeMultiTimeframe: 123 })).toEqual([
			'ranked must be a boolean',
			'includeMultiTimeframe must be a boolean',
		]);
	});
});
