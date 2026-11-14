'use strict';

const {
	SCANNER_ERROR_CATEGORIES,
	SCANNER_ERROR_CATEGORY_SET,
	classifyScannerError,
	normalizeScannerErrorCategory,
	isScannerErrorCategory,
	emptyScannerErrorCategoryCounts,
	incrementScannerErrorCategoryCount,
	summarizeScannerErrorCategoryCounts,
	scannerErrorCategoryPercentages,
} = require('../../src/services/tradingview/marketScannerErrorCategories');

describe('Market Scanner Error Categories', () => {
	describe('closed enum', () => {
		it('exposes a frozen enum of scanner error categories', () => {
			expect(Object.isFrozen(SCANNER_ERROR_CATEGORIES)).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('mcp_unreachable')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('mcp_timeout')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('mcp_rate_limited')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('mcp_tool_error')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('mcp_suspended')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('symbol_invalid')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('symbol_unsupported')).toBe(true);
			expect(SCANNER_ERROR_CATEGORY_SET.has('unknown')).toBe(true);
		});

		it('isScannerErrorCategory accepts only known enum values', () => {
			expect(isScannerErrorCategory('mcp_timeout')).toBe(true);
			expect(isScannerErrorCategory('not_a_category')).toBe(false);
			expect(isScannerErrorCategory(null)).toBe(false);
			expect(isScannerErrorCategory(undefined)).toBe(false);
			expect(isScannerErrorCategory(42)).toBe(false);
		});

		it('normalizeScannerErrorCategory lowercases valid values and rejects invalid ones', () => {
			expect(normalizeScannerErrorCategory('MCP_TIMEOUT')).toBe('mcp_timeout');
			expect(normalizeScannerErrorCategory('  symbol_invalid  ')).toBe('symbol_invalid');
			expect(normalizeScannerErrorCategory('not_valid')).toBe(null);
			expect(normalizeScannerErrorCategory(null)).toBe(null);
			expect(normalizeScannerErrorCategory(undefined)).toBe(null);
			expect(normalizeScannerErrorCategory(42)).toBe(null);
		});
	});

	describe('classifyScannerError', () => {
		const cases = [
			{ message: 'Service Suspended - 503', expected: SCANNER_ERROR_CATEGORIES.MCP_SUSPENDED },
			{ message: 'TradingView MCP host suspended due to billing', expected: SCANNER_ERROR_CATEGORIES.MCP_SUSPENDED },
			{ message: 'rate limit exceeded for tool coin_analysis', expected: SCANNER_ERROR_CATEGORIES.MCP_RATE_LIMITED },
			{ message: '429 Too Many Requests', expected: SCANNER_ERROR_CATEGORIES.MCP_RATE_LIMITED },
			{ message: 'AbortError: request aborted', expected: SCANNER_ERROR_CATEGORIES.MCP_TIMEOUT },
			{ message: 'TradingView MCP timed out after 12000ms', expected: SCANNER_ERROR_CATEGORIES.MCP_TIMEOUT },
			{ message: 'ECONNREFUSED 127.0.0.1:443', expected: SCANNER_ERROR_CATEGORIES.MCP_UNREACHABLE },
			{ message: 'fetch failed: getaddrinfo ENOTFOUND', expected: SCANNER_ERROR_CATEGORIES.MCP_UNREACHABLE },
			{ message: 'HTTP 502 upstream busy', expected: SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR },
			{ message: 'HTTP 400 bad request', expected: SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR },
			{ message: 'invalid tool: not_a_real_tool', expected: SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR },
			{ message: 'invalid symbol: BTCUSDT-FAKE', expected: SCANNER_ERROR_CATEGORIES.SYMBOL_INVALID },
			{ message: 'symbol BTCUSDT not supported on this exchange', expected: SCANNER_ERROR_CATEGORIES.SYMBOL_UNSUPPORTED },
			{ message: 'non-JSON payload received', expected: SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR },
		];

		for (const { message, expected } of cases) {
			it(`classifies "${message}" as ${expected}`, () => {
				expect(classifyScannerError(new Error(message))).toBe(expected);
			});
		}

		it('falls back to unknown for unrecognised messages', () => {
			expect(classifyScannerError(new Error('something else entirely'))).toBe(SCANNER_ERROR_CATEGORIES.UNKNOWN);
			expect(classifyScannerError(null)).toBe(SCANNER_ERROR_CATEGORIES.UNKNOWN);
			expect(classifyScannerError('')).toBe(SCANNER_ERROR_CATEGORIES.UNKNOWN);
		});

		it('accepts string errors directly', () => {
			expect(classifyScannerError('HTTP 502 upstream error')).toBe(SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR);
		});

		it('honours caller-provided category hint', () => {
			expect(classifyScannerError(new Error('whatever'), { category: 'mcp_rate_limited' })).toBe('mcp_rate_limited');
			expect(classifyScannerError(new Error('whatever'), { category: 'not_real' })).toBe(SCANNER_ERROR_CATEGORIES.UNKNOWN);
		});

		it('honours error.category property when present', () => {
			const error = new Error('message');
			error.category = 'symbol_invalid';
			expect(classifyScannerError(error)).toBe('symbol_invalid');
		});
	});

	describe('aggregation helpers', () => {
		it('emptyScannerErrorCategoryCounts returns zeroed counts for every category', () => {
			const counts = emptyScannerErrorCategoryCounts();
			expect(Object.keys(counts).sort()).toEqual(Object.values(SCANNER_ERROR_CATEGORIES).sort());
			for (const value of Object.values(counts)) {
				expect(value).toBe(0);
			}
		});

		it('incrementScannerErrorCategoryCount tallies known categories and rejects unknown ones', () => {
			const counts = emptyScannerErrorCategoryCounts();
			incrementScannerErrorCategoryCount(counts, 'mcp_timeout');
			incrementScannerErrorCategoryCount(counts, 'mcp_timeout');
			incrementScannerErrorCategoryCount(counts, 'not_a_category');
			expect(counts.mcp_timeout).toBe(2);
			expect(counts.unknown).toBe(1);
		});

		it('summarizeScannerErrorCategoryCounts tallies raw enum strings and object entries with .category', () => {
			const counts = summarizeScannerErrorCategoryCounts([
				'mcp_timeout',
				{ category: 'mcp_rate_limited' },
				'mcp_timeout',
				null,
				undefined,
				'junk_value',
			]);
			expect(counts.mcp_timeout).toBe(2);
			expect(counts.mcp_rate_limited).toBe(1);
			expect(counts.unknown).toBe(1);
		});

		it('scannerErrorCategoryPercentages computes percentage of total observations', () => {
			const counts = {
				mcp_timeout: 2,
				mcp_rate_limited: 1,
				mcp_unreachable: 0,
				mcp_tool_error: 0,
				mcp_suspended: 0,
				symbol_invalid: 0,
				symbol_unsupported: 0,
				unknown: 0,
			};
			const { total, percentages } = scannerErrorCategoryPercentages(counts);
			expect(total).toBe(3);
			expect(percentages.mcp_timeout).toBe(66.67);
			expect(percentages.mcp_rate_limited).toBe(33.33);
			expect(percentages.mcp_unreachable).toBe(0);
		});

		it('scannerErrorCategoryPercentages returns zeros for empty input', () => {
			const { total, percentages } = scannerErrorCategoryPercentages({});
			expect(total).toBe(0);
			expect(percentages.mcp_timeout).toBe(0);
		});

		it('scannerErrorCategoryPercentages ignores non-finite counts', () => {
			const { total, percentages } = scannerErrorCategoryPercentages({
				mcp_timeout: Number.NaN,
				mcp_rate_limited: 'oops',
				mcp_unreachable: 2,
			});
			expect(total).toBe(2);
			expect(percentages.mcp_unreachable).toBe(100);
		});
	});
});
