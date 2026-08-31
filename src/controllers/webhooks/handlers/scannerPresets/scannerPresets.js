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
	SUPPORTED_SCAN_TYPES,
} = require('../../../../services/tradingview/marketScannerReport');
const {
	SUPPORTED_MCP_TIMEFRAMES,
} = require('../../../../services/tradingview/parseTradingViewSignal');
const {
	tradingViewMcpService,
} = require('../../../../services/tradingview/TradingViewMcpService');
const { getIdempotencyKey } = require('../../../../lib/idempotency');
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

const SUPPORTED_TIMEFRAME_ALIASES = new Set([
	'5', '5M', '15', '15M', '60', '1H', '240', '4H',
	'1440', 'D', '1D', '10080', 'W', '1W', '43200', 'M', '1M',
]);

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

function sendMalformedIfMatch(res) {
	return res.status(400).json({
		error: 'Malformed If-Match header. Use a quoted integer such as "3" or the weak form W/"3".',
		code: 'INVALID_IF_MATCH',
		storage: getStorageMetadata(),
	});
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
			const ifMatch = resolveIfMatchVersion(req);
			if (ifMatch.present && ifMatch.malformed) {
				return sendMalformedIfMatch(res);
			}
			const deleted = await scannerPresetService.deletePreset(req.params.id, { ifMatchVersion: ifMatch.version });
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
			const ifMatch = resolveIfMatchVersion(req);
			if (ifMatch.present && ifMatch.malformed) {
				return sendMalformedIfMatch(res);
			}
			const preset = await scannerPresetService.updatePreset(
				req.params.id,
				req.body || {},
				{ ifMatchVersion: ifMatch.version },
			);
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

function validatePresetConfig(preset, reqBody = {}) {
	const errors = [];

	if (!preset || typeof preset !== 'object') {
		errors.push('preset must be a valid object');
		return errors;
	}

	if (!Array.isArray(preset.scans) || preset.scans.length === 0) {
		errors.push('scans must be a non-empty array of scan types');
	} else {
		const unknownScans = preset.scans.filter((scan) => typeof scan !== 'string' || !SUPPORTED_SCAN_TYPES.has(scan.trim()));
		if (unknownScans.length > 0) {
			errors.push(`Unsupported scan types: ${unknownScans.join(', ')}. Supported: ${[...SUPPORTED_SCAN_TYPES].join(', ')}`);
		}
	}

	if (typeof preset.timeframe !== 'string' || !preset.timeframe.trim()) {
		errors.push('timeframe must be a non-empty string');
	} else {
		const rawTimeframe = preset.timeframe.trim();
		const normalizedToken = rawTimeframe.toUpperCase();
		if (!SUPPORTED_MCP_TIMEFRAMES.has(rawTimeframe) && !SUPPORTED_TIMEFRAME_ALIASES.has(normalizedToken)) {
			errors.push(`Unsupported timeframe: ${rawTimeframe}`);
		}
	}

	if (typeof preset.exchange !== 'string' || !preset.exchange.trim()) {
		errors.push('exchange must be a non-empty string');
	}

	if (preset.limit !== undefined && preset.limit !== null) {
		const num = Number(preset.limit);
		if (!Number.isFinite(num) || !Number.isInteger(num) || num < 1 || num > 20) {
			errors.push('limit must be an integer between 1 and 20');
		}
	}

	if (preset.bbw_threshold !== undefined && preset.bbw_threshold !== null) {
		const threshold = Number(preset.bbw_threshold);
		if (!Number.isFinite(threshold)) {
			errors.push('bbw_threshold must be a number');
		}
	}

	if (reqBody && reqBody.ranked !== undefined && reqBody.ranked !== null) {
		if (typeof reqBody.ranked !== 'boolean' && reqBody.ranked !== 'true' && reqBody.ranked !== 'false') {
			errors.push('ranked must be a boolean');
		}
	}

	if (reqBody && reqBody.includeMultiTimeframe !== undefined && reqBody.includeMultiTimeframe !== null) {
		if (typeof reqBody.includeMultiTimeframe !== 'boolean' && reqBody.includeMultiTimeframe !== 'true' && reqBody.includeMultiTimeframe !== 'false') {
			errors.push('includeMultiTimeframe must be a boolean');
		}
	}

	return errors;
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

			const preset = await scannerPresetService.getPreset(req.params.id);
			if (!preset) {
				return res.status(404).json({
					success: false,
					error: 'Preset not found',
					storage: getStorageMetadata(),
				});
			}

			const dryRun = resolveDryRun(req);

			const bodyRouting = parseNotificationRouting(req.body);
			const routing = {
				channels: bodyRouting.channels || preset.channels || undefined,
				telegramChatId: bodyRouting.telegramChatId || preset.telegramChatId || undefined,
				telegramThreadId: bodyRouting.telegramThreadId !== undefined ? bodyRouting.telegramThreadId : preset.telegramThreadId,
				whatsappChatId: bodyRouting.whatsappChatId || preset.whatsappChatId || undefined,
				discordWebhookUrl: bodyRouting.discordWebhookUrl || preset.discordWebhookUrl || undefined,
			};

			if (dryRun) {
				console.debug('[ScannerPresets] Dry-run preview mode: skipping MCP calls and delivery');

				let notificationManager = getNotificationManager();
				if (!notificationManager) {
					try {
						notificationManager = await initializeNotificationServices(resolveBot(botOrGetter));
					} catch (_) {}
				}
				const requestedChannels = getRequestedChannels(notificationManager, routing);

				const effectivePreset = {
					id: preset.id,
					name: preset.name || '',
					exchange: req.body?.exchange !== undefined && typeof req.body?.exchange === 'string' ? req.body.exchange.trim().toUpperCase() : preset.exchange,
					timeframe: req.body?.timeframe !== undefined && typeof req.body?.timeframe === 'string' ? req.body.timeframe.trim() : preset.timeframe,
					scans: Array.isArray(req.body?.scans) ? req.body.scans : preset.scans,
					limit: req.body?.limit !== undefined ? req.body.limit : preset.limit,
					bbw_threshold: req.body?.bbw_threshold !== undefined
						? req.body.bbw_threshold
						: (req.body?.bbwThreshold !== undefined
							? req.body.bbwThreshold
							: (preset.bbwThreshold !== undefined ? preset.bbwThreshold : preset.bbw_threshold)),
					ranked: req.body?.ranked !== undefined
						? (req.body.ranked === true || req.body.ranked === 'true')
						: Boolean(preset.ranked),
					includeMultiTimeframe: req.body?.includeMultiTimeframe !== undefined
						? (req.body.includeMultiTimeframe === true || req.body.includeMultiTimeframe === 'true')
						: Boolean(preset.includeMultiTimeframe),
				};

				const validationErrors = validatePresetConfig(effectivePreset, req.body);
				const validation = {
					ok: validationErrors.length === 0,
					errors: validationErrors,
				};

				const scanCount = Array.isArray(effectivePreset.scans) ? effectivePreset.scans.length : 0;
				const parsedLimit = typeof effectivePreset.limit === 'number' && Number.isFinite(effectivePreset.limit) && effectivePreset.limit > 0
					? effectivePreset.limit
					: 5;
				const estimatedCalls = {
					coinAnalysis: scanCount,
					multiTimeframe: effectivePreset.includeMultiTimeframe ? scanCount * parsedLimit : 0,
				};

				const mcpStatus = typeof tradingViewMcpService?.getStatus === 'function'
					? tradingViewMcpService.getStatus({ enabled: true })
					: { ready: false, lastCheckedAt: null, lastErrorCategory: null };

				const mcpReadiness = {
					ready: Boolean(mcpStatus.ready),
					lastCheckedAt: mcpStatus.lastCheckedAt || null,
					lastErrorCategory: mcpStatus.lastErrorCategory || null,
				};

				const idempotencyKey = getIdempotencyKey(req) || null;

				return res.status(200).json({
					success: true,
					dryRun: true,
					presetId: preset.id,
					preset: {
						id: effectivePreset.id,
						name: effectivePreset.name,
						exchange: effectivePreset.exchange,
						timeframe: effectivePreset.timeframe,
						scans: effectivePreset.scans,
						limit: effectivePreset.limit,
						bbw_threshold: effectivePreset.bbw_threshold,
						ranked: effectivePreset.ranked,
						includeMultiTimeframe: effectivePreset.includeMultiTimeframe,
					},
					validation,
					estimatedCalls,
					requestedChannels,
					mcpReadiness,
					idempotencyKey,
					requestId,
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
					processingTimeMs: Math.max(0, Date.now() - startTime),
				});
			}

			const alertText = buildMarketScannerReport(scanResults, {
				exchange: preset.exchange,
				timeframe: preset.timeframe,
				now: new Date(),
			});

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
				processingTimeMs: Math.max(0, Date.now() - startTime),
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
	validatePresetConfig,
};
