'use strict';

/* global AbortController */

const { v4: uuidv4 } = require('uuid');
const {
	scannerPresetService,
	parseIfMatchHeader,
	formatEtag,
} = require('../../../../services/scannerPresets/ScannerPresetService');
const { runScans } = require('../marketScanner/marketScanner');
const {
	MarketScannerRequestError,
	buildMarketScannerReport,
} = require('../../../../services/tradingview/marketScannerReport');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../alert/alert');
const sentryService = require('../../../../services/monitoring/SentryService');
const {
	NotificationRoutingValidationError,
	parseNotificationRouting,
	sendWithNotificationRouting,
	getRequestedChannels,
	getDeliveredChannels,
} = require('../../../../services/notification/requestRouting');
const { getRuntimeConfig } = require('../../../../services/remoteConfig/RemoteConfigService');

const DEFAULT_SCANNER_TIMEOUT_MS = 90000;
const MAX_SCANNER_TIMEOUT_MS = 120000;

function getStorageMetadata() {
	return scannerPresetService.getStorageStatus();
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

function compactScanResults(results) {
	return results.map((result) => {
		if (result.status === 'error' || result.status === 'timeout') {
			return {
				scan: result.scan,
				status: result.status,
				error: result.error,
			};
		}

		return {
			scan: result.scan,
			status: result.status,
			itemCount: result.items.length,
		};
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

function hasTimedOut(results) {
	return results.some((result) => result.status === 'timeout');
}

function getScannerTimeoutMs() {
	const parsedTimeout = parseInt(process.env.MARKET_SCANNER_TIMEOUT_MS || `${DEFAULT_SCANNER_TIMEOUT_MS}`, 10);
	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
		return DEFAULT_SCANNER_TIMEOUT_MS;
	}

	return Math.min(parsedTimeout, MAX_SCANNER_TIMEOUT_MS);
}

function createScannerDeadline(timeoutMs) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => {
		controller.abort(new Error(`Market scanner timeout after ${timeoutMs}ms`));
	}, timeoutMs);

	return {
		signal: controller.signal,
		clear: () => clearTimeout(timeoutId),
	};
}

function postPreset(req, res) {
	return (async () => {
		try {
			const preset = await scannerPresetService.createPreset(req.body || {});
			setPresetEtag(res, preset);
			return res.status(201).json({
				success: true,
				storage: getStorageMetadata(),
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
	})();
}

function listPresets(req, res) {
	return (async () => {
		try {
			const presets = await scannerPresetService.listPresets();
			return res.status(200).json({
				success: true,
				storage: getStorageMetadata(),
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
	})();
}

function setPresetEtag(res, preset) {
	if (preset && Number.isInteger(preset.version)) {
		res.set('ETag', formatEtag(preset.version));
	}
}

function resolveIfMatchVersion(req) {
	const headerValue = req.headers ? req.headers['if-match'] : undefined;
	return parseIfMatchHeader(headerValue);
}

function getPreset(req, res) {
	return (async () => {
		try {
			const routing = parseNotificationRouting(req.body);
			const preset = await scannerPresetService.getPreset(req.params.id);
			if (!preset) {
				return res.status(404).json({
					success: false,
					error: 'Preset not found',
					storage: getStorageMetadata(),
				});
			}

			setPresetEtag(res, preset);
			return res.status(200).json({
				success: true,
				storage: getStorageMetadata(),
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
	})();
}

function deletePreset(req, res) {
	return (async () => {
		try {
			const ifMatchVersion = resolveIfMatchVersion(req);
			const deleted = await scannerPresetService.deletePreset(req.params.id, { ifMatchVersion });
			if (!deleted) {
				return res.status(404).json({
					success: false,
					error: 'Preset not found',
					storage: getStorageMetadata(),
				});
			}

			return res.status(200).json({
				success: true,
				storage: getStorageMetadata(),
			});
		} catch (error) {
			if (error instanceof MarketScannerRequestError) {
				const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
				const body = {
					error: error.message,
					code: error.code || 'INVALID_REQUEST',
					storage: getStorageMetadata(),
				};
				if (error.code === 'PRECONDITION_FAILED' && error.preset) {
					body.preset = error.preset;
					setPresetEtag(res, error.preset);
				}
				return res.status(statusCode).json(body);
			}

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
	})();
}

function updatePreset(req, res) {
	return (async () => {
		try {
			const ifMatchVersion = resolveIfMatchVersion(req);
			const preset = await scannerPresetService.updatePreset(req.params.id, req.body || {}, { ifMatchVersion });
			if (!preset) {
				return res.status(404).json({
					success: false,
					error: 'Preset not found',
					storage: getStorageMetadata(),
				});
			}

			setPresetEtag(res, preset);
			return res.status(200).json({
				success: true,
				storage: getStorageMetadata(),
				preset,
			});
		} catch (error) {
			if (error instanceof MarketScannerRequestError) {
				const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 400;
				const body = {
					error: error.message,
					code: error.code || 'INVALID_REQUEST',
					storage: getStorageMetadata(),
				};
				if (error.code === 'PRECONDITION_FAILED' && error.preset) {
					body.preset = error.preset;
					setPresetEtag(res, error.preset);
				}
				if (error.code === 'PRESET_LOCKED') {
					if (error.lockedUntil) {
						body.lockedUntil = error.lockedUntil;
					}
					if (error.preset) {
						body.preset = error.preset;
						setPresetEtag(res, error.preset);
					}
				}
				return res.status(statusCode).json(body);
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
	})();
}

function postRunPreset(botOrGetter) {
	return async (req, res) => {
		const requestId = uuidv4();
		const startTime = Date.now();

		try {
			if (!getRuntimeConfig().ENABLE_MARKET_SCANNER) {
				return res.status(404).json({
					error: 'Market scanner is not enabled',
					code: 'FEATURE_DISABLED',
				});
			}
			const routing = parseNotificationRouting(req.body);

			const preset = await scannerPresetService.getPreset(req.params.id);
			if (!preset) {
				return res.status(404).json({
					success: false,
					error: 'Preset not found',
				});
			}

			const timeoutMs = getScannerTimeoutMs();
			const deadline = createScannerDeadline(timeoutMs);
			let scanResults;

			try {
				scanResults = await runScans(preset, { signal: deadline.signal });
			} finally {
				deadline.clear();
			}

			const timedOut = hasTimedOut(scanResults);
			const successfulScans = scanResults.filter((r) => r.status === 'success');

			if (successfulScans.length === 0) {
				return res.status(timedOut ? 504 : 502).json({
					success: false,
					code: timedOut ? 'PRESET_SCAN_TIMEOUT' : 'ALL_SCANS_FAILED',
					error: timedOut
						? `Scanner preset timed out after ${timeoutMs}ms.`
						: 'TradingView MCP failed for all requested scans.',
					scanResults: compactScanResults(scanResults),
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
					scanResults: compactScanResults(scanResults),
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

			const deliveryResults = await sendWithNotificationRouting(
				notificationManager,
				{ text: alertText, source: 'scanner-preset' },
				routing,
				{
					parentSpan: sentryService.getActiveSpan(),
				},
			);
			const requestedChannels = getRequestedChannels(notificationManager, routing);
			const deliveredChannels = getDeliveredChannels(deliveryResults);
			const summary = buildSummary(scanResults, deliveryResults);

			return res.status(200).json({
				success: true,
				presetId: preset.id,
				alertText,
				scanResults: compactScanResults(scanResults),
				deliveryResults,
				requestedChannels,
				deliveredChannels,
				summary,
				timedOut,
				timeoutMs,
				requestId,
				totalDurationMs: Date.now() - startTime,
			});
		} catch (error) {
			if (error instanceof NotificationRoutingValidationError) {
				return res.status(400).json({
					error: error.message,
					code: 'INVALID_REQUEST',
					requestId,
				});
			}

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

module.exports = {
	postPreset,
	listPresets,
	getPreset,
	deletePreset,
	updatePreset,
	postRunPreset,
};
