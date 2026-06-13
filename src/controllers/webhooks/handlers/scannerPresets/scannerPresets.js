'use strict';

/* global AbortController */

const { v4: uuidv4 } = require('uuid');
const { scannerPresetService } = require('../../../../services/scannerPresets/ScannerPresetService');
const { tradingViewMcpService } = require('../../../../services/tradingview/TradingViewMcpService');
const {
	MarketScannerRequestError,
	buildMarketScannerReport,
} = require('../../../../services/tradingview/marketScannerReport');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../alert/alert');
const sentryService = require('../../../../services/monitoring/SentryService');

const DEFAULT_SCANNER_TIMEOUT_MS = 90000;
const MAX_SCANNER_TIMEOUT_MS = 120000;

// ---- CRUD Handlers ----

function postPreset(req, res) {
	try {
		const preset = scannerPresetService.createPreset(req.body || {});
		return res.status(201).json({
			success: true,
			preset,
		});
	} catch (error) {
		if (error instanceof MarketScannerRequestError) {
			return res.status(400).json({
				error: error.message,
				code: error.code || 'INVALID_REQUEST',
			});
		}
		console.error('[ScannerPresets] Create failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'scanner-presets',
			error,
			http: { endpoint: '/api/scanner-presets', method: 'POST', statusCode: 500 },
		});
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

function listPresets(req, res) {
	try {
		const presets = scannerPresetService.listPresets();
		return res.status(200).json({
			success: true,
			presets,
		});
	} catch (error) {
		console.error('[ScannerPresets] List failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'scanner-presets',
			error,
			http: { endpoint: '/api/scanner-presets', method: 'GET', statusCode: 500 },
		});
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

function getPreset(req, res) {
	try {
		const preset = scannerPresetService.getPreset(req.params.id);
		if (!preset) {
			return res.status(404).json({
				success: false,
				error: 'Preset not found',
			});
		}
		return res.status(200).json({
			success: true,
			preset,
		});
	} catch (error) {
		console.error('[ScannerPresets] Get failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'scanner-presets',
			error,
			http: { endpoint: `/api/scanner-presets/${req.params.id}`, method: 'GET', statusCode: 500 },
		});
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

function deletePreset(req, res) {
	try {
		const deleted = scannerPresetService.deletePreset(req.params.id);
		if (!deleted) {
			return res.status(404).json({
				success: false,
				error: 'Preset not found',
			});
		}
		return res.status(200).json({
			success: true,
		});
	} catch (error) {
		console.error('[ScannerPresets] Delete failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'scanner-presets',
			error,
			http: { endpoint: `/api/scanner-presets/${req.params.id}`, method: 'DELETE', statusCode: 500 },
		});
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

function updatePreset(req, res) {
	try {
		const preset = scannerPresetService.updatePreset(req.params.id, req.body || {});
		if (!preset) {
			return res.status(404).json({
				success: false,
				error: 'Preset not found',
			});
		}
		return res.status(200).json({
			success: true,
			preset,
		});
	} catch (error) {
		if (error instanceof MarketScannerRequestError) {
			return res.status(400).json({
				error: error.message,
				code: error.code || 'INVALID_REQUEST',
			});
		}
		console.error('[ScannerPresets] Update failed:', error.message);
		sentryService.captureRuntimeError({
			channel: 'scanner-presets',
			error,
			http: { endpoint: `/api/scanner-presets/${req.params.id}`, method: 'PUT', statusCode: 500 },
		});
		return res.status(500).json({
			error: 'Internal server error',
			code: 'INTERNAL_ERROR',
		});
	}
}

function resolveBot(botOrGetter) {
	if (typeof botOrGetter === 'function') {
		return botOrGetter();
	}
	return botOrGetter || null;
}

function resolveDryRun(req) {
	const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
	const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
	return queryFlag || bodyFlag;
}

// ---- Run Handler ----

function postRunPreset(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		try {
			const preset = scannerPresetService.getPreset(req.params.id);
			if (!preset) {
				return res.status(404).json({
					success: false,
					error: 'Preset not found',
				});
			}

			const timeoutMs = getScannerTimeoutMs();
			const deadline = createDeadline(timeoutMs);
			let scanResults;

			try {
				scanResults = await runScansForPreset(preset, { signal: deadline.signal });
			} finally {
				deadline.clear();
			}

			const timedOut = scanResults.some((r) => r.status === 'timeout');
			const successfulScans = scanResults.filter((r) => r.status === 'success');

			if (successfulScans.length === 0) {
				return res.status(timedOut ? 504 : 502).json({
					success: false,
					code: timedOut ? 'PRESET_SCAN_TIMEOUT' : 'ALL_SCANS_FAILED',
					error: timedOut
						? `Scanner preset timed out after ${timeoutMs}ms.`
						: 'TradingView MCP failed for all requested scans.',
					scanResults: compactResults(scanResults),
					summary: buildSummary(scanResults, []),
					timedOut,
					timeoutMs,
					requestId,
					totalDurationMs: Date.now() - startTime,
				});
			}

			const alertText = buildMarketScannerReport(scanResults, {
				exchange: preset.exchange,
				timeframe: preset.timeframe,
				now: new Date(),
			});

			const dryRun = resolveDryRun(req);
			if (dryRun) {
				console.debug('[ScannerPresets] Dry-run mode: skipping delivery');
				return res.status(200).json({
					success: true,
					dryRun: true,
					presetId: preset.id,
					payload: { alertText },
					scanResults: compactResults(scanResults),
					summary: buildSummary(scanResults, []),
					timedOut,
					timeoutMs,
					requestId,
					totalDurationMs: Date.now() - startTime,
				});
			}

			let notificationManager = getNotificationManager();
			if (!notificationManager) {
				notificationManager = await initializeNotificationServices(resolveBot(botOrGetter));
			}

			const deliveryResults = await notificationManager.sendToAll({ text: alertText });
			const summary = buildSummary(scanResults, deliveryResults);

			return res.status(200).json({
				success: true,
				presetId: preset.id,
				alertText,
				scanResults: compactResults(scanResults),
				deliveryResults,
				summary,
				timedOut,
				timeoutMs,
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
			console.error('[ScannerPresets] Run failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'scanner-presets',
				error,
				http: {
					endpoint: `/api/scanner-presets/${req.params.id}/run`,
					method: 'POST',
					statusCode: 500,
					requestId,
				},
			});
			return res.status(500).json({
				error: 'Internal server error. Please try again later.',
				code: 'INTERNAL_ERROR',
				requestId,
			});
		}
	};
}

// ---- Scanner execution (adapted from marketScanner) ----

async function runScansForPreset(preset, options = {}) {
	const { signal } = options;
	const results = [];

	for (let index = 0; index < preset.scans.length; index++) {
		const scanType = preset.scans[index];

		if (signal && signal.aborted) {
			appendTimeoutResults(results, preset.scans.slice(index), getAbortMessage(signal));
			break;
		}

		try {
			const args = buildScanArgs(preset, scanType);
			const scanOptions = {};
			if (signal) {
				scanOptions.signal = signal;
			}

			const result = await tradingViewMcpService.callScanTool(scanType, args, scanOptions);
			const items = Array.isArray(result) ? result : (result && Array.isArray(result.result) ? result.result : []);

			results.push({
				scan: scanType,
				status: 'success',
				items,
			});
		} catch (error) {
			if (isAbortTriggered(signal, error)) {
				const timeoutMessage = getAbortMessage(signal, error.message);
				results.push({
					scan: scanType,
					status: 'timeout',
					items: [],
					error: timeoutMessage,
				});
				appendTimeoutResults(results, preset.scans.slice(index + 1), timeoutMessage);
				break;
			}

			console.warn('[ScannerPresets] Scan failed:', scanType, error.message);
			results.push({
				scan: scanType,
				status: 'error',
				items: [],
				error: error.message,
			});
		}
	}

	return results;
}

function buildScanArgs(preset, scanType) {
	const args = {
		exchange: preset.exchange,
		timeframe: preset.timeframe,
		limit: preset.limit,
	};
	if (scanType === 'bollinger_scan') {
		args.bbw_threshold = preset.bbwThreshold;
	}
	return args;
}

function compactResults(results) {
	return results.map((result) => {
		if (result.status === 'error' || result.status === 'timeout') {
			return { scan: result.scan, status: result.status, error: result.error };
		}
		return { scan: result.scan, status: result.status, itemCount: result.items.length };
	});
}

function buildSummary(scanResults, deliveryResults) {
	return {
		totalScans: scanResults.length,
		success: scanResults.filter((r) => r.status === 'success').length,
		error: scanResults.filter((r) => r.status === 'error').length,
		timeout: scanResults.filter((r) => r.status === 'timeout').length,
		totalItems: scanResults.reduce((sum, r) => sum + r.items.length, 0),
		delivered: deliveryResults.filter((r) => r.success).length,
	};
}

function getScannerTimeoutMs() {
	const parsed = parseInt(process.env.MARKET_SCANNER_TIMEOUT_MS || `${DEFAULT_SCANNER_TIMEOUT_MS}`, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_SCANNER_TIMEOUT_MS;
	}
	return Math.min(parsed, MAX_SCANNER_TIMEOUT_MS);
}

function createDeadline(timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(new Error(`Scanner preset timeout after ${timeoutMs}ms`));
	}, timeoutMs);
	return {
		signal: controller.signal,
		clear: () => clearTimeout(timeoutId),
	};
}

function appendTimeoutResults(results, scans, error) {
	scans.forEach((scanType) => {
		results.push({ scan: scanType, status: 'timeout', items: [], error });
	});
}

function isAbortTriggered(signal, error) {
	return Boolean(
		(signal && signal.aborted)
		|| (error && error.name === 'AbortError')
		|| (error && error.name === 'AbortSignalError'),
	);
}

function getAbortMessage(signal, fallback = 'Scanner preset timed out') {
	const reason = signal && signal.reason;
	if (reason instanceof Error && reason.message) {
		return reason.message;
	}
	if (typeof reason === 'string' && reason) {
		return reason;
	}
	return fallback;
}

module.exports = {
	postPreset,
	listPresets,
	getPreset,
	deletePreset,
	updatePreset,
	postRunPreset,
};
