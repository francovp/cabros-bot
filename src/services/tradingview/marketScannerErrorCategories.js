'use strict';

/**
 * marketScannerErrorCategories - closed enum + classifier for scanner-level
 * TradingView MCP failures. Operators triaging a noisy day need to distinguish
 * "TradingView MCP is degraded" from "these specific symbols are bad picks".
 *
 * The closed enum keeps the categorization robust to provider schema drift:
 * unrecognised errors fall back to `unknown` rather than silently dropping
 * the category.
 */

const SCANNER_ERROR_CATEGORIES = Object.freeze({
	MCP_UNREACHABLE: 'mcp_unreachable',
	MCP_TIMEOUT: 'mcp_timeout',
	MCP_RATE_LIMITED: 'mcp_rate_limited',
	MCP_TOOL_ERROR: 'mcp_tool_error',
	MCP_SUSPENDED: 'mcp_suspended',
	SYMBOL_INVALID: 'symbol_invalid',
	SYMBOL_UNSUPPORTED: 'symbol_unsupported',
	UNKNOWN: 'unknown',
});

const SCANNER_ERROR_CATEGORY_SET = new Set(Object.values(SCANNER_ERROR_CATEGORIES));

const SCANNER_ERROR_CATEGORY_DISPLAY = Object.freeze({
	[SCANNER_ERROR_CATEGORIES.MCP_UNREACHABLE]: 'mcp_unreachable',
	[SCANNER_ERROR_CATEGORIES.MCP_TIMEOUT]: 'mcp_timeout',
	[SCANNER_ERROR_CATEGORIES.MCP_RATE_LIMITED]: 'mcp_rate_limited',
	[SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR]: 'mcp_tool_error',
	[SCANNER_ERROR_CATEGORIES.MCP_SUSPENDED]: 'mcp_suspended',
	[SCANNER_ERROR_CATEGORIES.SYMBOL_INVALID]: 'symbol_invalid',
	[SCANNER_ERROR_CATEGORIES.SYMBOL_UNSUPPORTED]: 'symbol_unsupported',
	[SCANNER_ERROR_CATEGORIES.UNKNOWN]: 'unknown',
});

function isScannerErrorCategory(value) {
	return typeof value === 'string' && SCANNER_ERROR_CATEGORY_SET.has(value);
}

function normalizeScannerErrorCategory(value) {
	if (value === undefined || value === null) {
		return null;
	}

	if (typeof value !== 'string') {
		return null;
	}

	const normalized = value.trim().toLowerCase();
	if (SCANNER_ERROR_CATEGORY_SET.has(normalized)) {
		return normalized;
	}

	return null;
}

/**
 * Classify a scanner-level error into one of the closed enum categories.
 */
function classifyScannerError(error, context = {}) {
	if (context && isScannerErrorCategory(context.category)) {
		return context.category;
	}

	if (error && isScannerErrorCategory(error.category)) {
		return error.category;
	}

	const message = extractErrorMessage(error);

	if (!message) {
		return SCANNER_ERROR_CATEGORIES.UNKNOWN;
	}

	if (/suspended|service suspended|503/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_SUSPENDED;
	}

	if (/rate[- ]?limit|too many requests|429/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_RATE_LIMITED;
	}

	if (/abort|timed?\s*out|timeout/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_TIMEOUT;
	}

	if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket hang up/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_UNREACHABLE;
	}

	if (/HTTP 5\d\d/i.test(message) || /HTTP 4\d\d/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR;
	}

	if (/tool[- ]?error|invalid tool|tool not found|method not found/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR;
	}

	if (/invalid symbol|symbol not found|unknown symbol|invalid exchange|exchange not supported|unsupported symbol/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.SYMBOL_INVALID;
	}

	if (/symbol.{0,24}unsupported|exchange.{0,24}unsupported|not supported on/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.SYMBOL_UNSUPPORTED;
	}

	if (/invalid|empty|non-JSON|non-SSE|mcp-session-id|payload|RPC/i.test(message)) {
		return SCANNER_ERROR_CATEGORIES.MCP_TOOL_ERROR;
	}

	return SCANNER_ERROR_CATEGORIES.UNKNOWN;
}

function extractErrorMessage(error) {
	if (!error) {
		return '';
	}

	if (typeof error === 'string') {
		return error;
	}

	if (typeof error.message === 'string') {
		return error.message;
	}

	return '';
}

function emptyScannerErrorCategoryCounts() {
	const counts = {};
	for (const category of Object.values(SCANNER_ERROR_CATEGORIES)) {
		counts[category] = 0;
	}
	return counts;
}

function incrementScannerErrorCategoryCount(counts, category) {
	const safeCounts = counts && typeof counts === 'object' ? counts : emptyScannerErrorCategoryCounts();
	const safeCategory = isScannerErrorCategory(category)
		? category
		: SCANNER_ERROR_CATEGORIES.UNKNOWN;
	safeCounts[safeCategory] = (safeCounts[safeCategory] || 0) + 1;
	return safeCounts;
}

function summarizeScannerErrorCategoryCounts(entries = []) {
	const counts = emptyScannerErrorCategoryCounts();
	for (const entry of entries) {
		if (!entry) {
			continue;
		}
		const category = isScannerErrorCategory(entry)
			? entry
			: entry.category;
		incrementScannerErrorCategoryCount(counts, category);
	}
	return counts;
}

function scannerErrorCategoryPercentages(counts = {}) {
	const safeCounts = counts && typeof counts === 'object' ? counts : {};
	const total = Object.values(safeCounts).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
	const percentages = {};
	for (const category of Object.values(SCANNER_ERROR_CATEGORIES)) {
		const count = Number.isFinite(safeCounts[category]) ? safeCounts[category] : 0;
		percentages[category] = total === 0 ? 0 : Number(((count / total) * 100).toFixed(2));
	}
	return { total, percentages };
}

module.exports = {
	SCANNER_ERROR_CATEGORIES,
	SCANNER_ERROR_CATEGORY_SET,
	SCANNER_ERROR_CATEGORY_DISPLAY,
	classifyScannerError,
	normalizeScannerErrorCategory,
	isScannerErrorCategory,
	emptyScannerErrorCategoryCounts,
	incrementScannerErrorCategoryCount,
	summarizeScannerErrorCategoryCounts,
	scannerErrorCategoryPercentages,
};
