'use strict';

const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { tradingViewMcpService } = require('../tradingview/TradingViewMcpService');
const {
	parseExpandedAnalysisAlertRequest,
	buildExpandedAnalysisAlertReport,
} = require('../tradingview/expandedAnalysisAlertReport');
const {
	parseMarketScannerRequest,
	buildMarketScannerReport,
} = require('../tradingview/marketScannerReport');
const {
	getNotificationManager,
	initializeNotificationServices,
} = require('../../controllers/webhooks/handlers/alert/alert');
const sentryService = require('../monitoring/SentryService');
const { jobRepository } = require('./JobRepository');

const EXPIRATION_MS = 3600000; // 1 hour
const DEFAULT_JOB_TIMEOUT_MS = 300000; // 5 minutes

function isValidCallbackUrl(urlStr) {
	try {
		const url = new URL(urlStr);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') {
			return false;
		}
		if (url.protocol === 'http:') {
			const isLocal = url.hostname === 'localhost' ||
				url.hostname === '127.0.0.1' ||
				url.hostname === '::1' ||
				process.env.NODE_ENV === 'test' ||
				process.env.ALLOW_HTTP_CALLBACKS === 'true';
			return isLocal;
		}
		return true;
	} catch (err) {
		return false;
	}
}

class JobService {
	constructor(repository = jobRepository) {
		this.repository = repository;
		this.jobs = repository;
		this.activeControllers = new Map();
	}

	/**
	 * Cleans up jobs older than 1 hour if they are completed or failed.
	 */
	async _cleanExpiredJobs() {
		const now = Date.now();
		for (const [id, job] of this.repository.entries()) {
			if (
				now - new Date(job.createdAt).getTime() > EXPIRATION_MS &&
				(job.status === 'completed' || job.status === 'failed')
			) {
				await this.repository.delete(id);
			}
		}
	}

	/**
	 * Retrieve a job by its ID.
	 * @param {string} jobId
	 * @returns {Object|null}
	 */
	async getJob(jobId) {
		await this._cleanExpiredJobs();
		const job = await this.repository.get(jobId);
		if (!job) {
			return null;
		}

		if (
			Date.now() - new Date(job.createdAt).getTime() > EXPIRATION_MS &&
			(job.status === 'completed' || job.status === 'failed')
		) {
			await this.repository.delete(jobId);
			return null;
		}

		// Prepare external representation of the job
		return this._formatJobResponse(job);
	}

	/**
	 * Format internal job state to match the requested output.
	 * @param {Object} job
	 * @returns {Object}
	 */
	_formatJobResponse(job) {
		const formatted = {
			jobId: job.jobId,
			type: job.type,
			status: job.status,
			progress: job.progress,
			createdAt: job.createdAt,
			updatedAt: job.updatedAt,
			totalDurationMs: job.status === 'completed' || job.status === 'failed'
				? job.totalDurationMs
				: (Date.now() - new Date(job.createdAt).getTime()),
		};

		if (job.callbackStatus) {
			formatted.callbackStatus = job.callbackStatus;
		}

		if (job.type === 'expanded-analysis') {
			formatted.results = this._compactResults(job.fullResults);
		} else if (job.type === 'market-scanner') {
			formatted.scanResults = this._compactScanResults(job.fullScanResults);
		}

		if (job.status === 'completed') {
			formatted.alertText = job.alertText;
			formatted.deliveryResults = job.deliveryResults;
			formatted.summary = job.summary;
		} else if (job.status === 'failed') {
			formatted.error = job.error;
			formatted.code = job.code;
			if (job.type === 'expanded-analysis') {
				formatted.summary = this._buildExpandedSummary(job.fullResults, []);
			} else if (job.type === 'market-scanner') {
				formatted.summary = this._buildScannerSummary(job.fullScanResults, []);
			}
		}

		return formatted;
	}

	/**
	 * Creates a job, validates the request synchronously, and runs it in the background.
	 * @param {string} type - 'expanded-analysis' | 'market-scanner'
	 * @param {Object} payload - request body payload
	 * @param {Function|Object} botOrGetter - Telegraf bot instance or getter
	 * @returns {Object} The created job metadata
	 */
	async createJob(type, payload, botOrGetter) {
		await this._cleanExpiredJobs();

		// Synchronous validation based on job type
		let parsed;
		if (type === 'expanded-analysis') {
			parsed = parseExpandedAnalysisAlertRequest({ body: payload });
		} else if (type === 'market-scanner') {
			if (process.env.ENABLE_MARKET_SCANNER !== 'true') {
				const error = new Error('Market scanner is not enabled');
				error.code = 'FEATURE_DISABLED';
				error.statusCode = 404;
				throw error;
			}
			parsed = parseMarketScannerRequest({ body: payload });
		} else {
			const error = new Error(`Unsupported job type: ${type}`);
			error.code = 'UNSUPPORTED_TYPE';
			error.statusCode = 400;
			throw error;
		}

		// Validate timeoutMs if provided
		let validatedTimeoutMs = DEFAULT_JOB_TIMEOUT_MS;
		const MAX_JOB_TIMEOUT_MS = 600000; // 10 minutes
		if (payload && payload.timeoutMs !== undefined) {
			const timeoutVal = Number(payload.timeoutMs);
			if (!Number.isFinite(timeoutVal) || !Number.isInteger(timeoutVal) || timeoutVal <= 0) {
				const msg = 'timeoutMs must be a positive integer';
				if (type === 'expanded-analysis') {
					const { ExpandedAnalysisAlertRequestError } = require('../tradingview/expandedAnalysisAlertReport');
					throw new ExpandedAnalysisAlertRequestError(msg);
				} else {
					const { MarketScannerRequestError } = require('../tradingview/marketScannerReport');
					throw new MarketScannerRequestError(msg);
				}
			}
			validatedTimeoutMs = Math.min(timeoutVal, MAX_JOB_TIMEOUT_MS);
		}

		let callbackUrl = null;
		let callbackSecret = null;
		let callbackEvents = ['completed', 'failed', 'cancelled', 'timed_out'];

		if (payload && payload.callbackUrl !== undefined && payload.callbackUrl !== null) {
			if (typeof payload.callbackUrl !== 'string' || !isValidCallbackUrl(payload.callbackUrl)) {
				const msg = 'callbackUrl must be a valid HTTPS URL (HTTP only allowed for local development)';
				if (type === 'expanded-analysis') {
					const { ExpandedAnalysisAlertRequestError } = require('../tradingview/expandedAnalysisAlertReport');
					throw new ExpandedAnalysisAlertRequestError(msg);
				} else {
					const { MarketScannerRequestError } = require('../tradingview/marketScannerReport');
					throw new MarketScannerRequestError(msg);
				}
			}
			callbackUrl = payload.callbackUrl;

			if (payload.callbackSecret !== undefined && payload.callbackSecret !== null) {
				if (typeof payload.callbackSecret !== 'string') {
					const msg = 'callbackSecret must be a string';
					if (type === 'expanded-analysis') {
						const { ExpandedAnalysisAlertRequestError } = require('../tradingview/expandedAnalysisAlertReport');
						throw new ExpandedAnalysisAlertRequestError(msg);
					} else {
						const { MarketScannerRequestError } = require('../tradingview/marketScannerReport');
						throw new MarketScannerRequestError(msg);
					}
				}
				callbackSecret = payload.callbackSecret;
			}

			if (payload.callbackEvents !== undefined && payload.callbackEvents !== null) {
				if (!Array.isArray(payload.callbackEvents)) {
					const msg = 'callbackEvents must be an array of strings';
					if (type === 'expanded-analysis') {
						const { ExpandedAnalysisAlertRequestError } = require('../tradingview/expandedAnalysisAlertReport');
						throw new ExpandedAnalysisAlertRequestError(msg);
					} else {
						const { MarketScannerRequestError } = require('../tradingview/marketScannerReport');
						throw new MarketScannerRequestError(msg);
					}
				}
				const validEvents = new Set(['completed', 'failed', 'cancelled', 'timed_out', 'processing']);
				for (const event of payload.callbackEvents) {
					if (typeof event !== 'string' || !validEvents.has(event)) {
						const msg = `Invalid event in callbackEvents: ${event}. Supported values are: ${[...validEvents].join(', ')}`;
						if (type === 'expanded-analysis') {
							const { ExpandedAnalysisAlertRequestError } = require('../tradingview/expandedAnalysisAlertReport');
							throw new ExpandedAnalysisAlertRequestError(msg);
						} else {
							const { MarketScannerRequestError } = require('../tradingview/marketScannerReport');
							throw new MarketScannerRequestError(msg);
						}
					}
				}
				callbackEvents = payload.callbackEvents;
			}
		}

		const requestMetadata = {
			type,
			timeoutMs: validatedTimeoutMs,
			callbackUrl,
			callbackSecret,
			callbackEvents,
			...(type === 'expanded-analysis' ? {
				symbols: parsed.symbols.map((s) => s.raw),
				timeframe: parsed.timeframe,
				includeMultiTimeframe: parsed.includeMultiTimeframe,
				analysisMode: parsed.analysisMode,
			} : {
				exchange: parsed.exchange,
				timeframe: parsed.timeframe,
				scans: parsed.scans,
				limit: parsed.limit,
				bbwThreshold: parsed.bbwThreshold,
			}),
		};

		const jobId = uuidv4();
		const job = {
			jobId,
			type,
			status: 'processing',
			requestMetadata,
			progress: {
				total: type === 'expanded-analysis' ? parsed.symbols.length : parsed.scans.length,
				current: 0,
				status: 'pending',
			},
			fullResults: [],
			fullScanResults: [],
			alertText: null,
			deliveryResults: null,
			summary: null,
			error: null,
			code: null,
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			totalDurationMs: 0,
			timeoutMs: validatedTimeoutMs,
			...(callbackUrl ? {
				callbackUrl,
				callbackSecret,
				callbackEvents,
				callbackStatus: {
					status: 'pending',
					attempts: [],
				},
			} : {}),
		};

		await this.repository.save(job);

		// Trigger callback for 'processing' if configured
		await this._triggerCallbackIfConfigured(job);

		// Execute background job (fire-and-forget)
		this._runBackgroundJob(jobId, parsed, payload, botOrGetter).catch((error) => {
			console.error(`[JobService] Background job ${jobId} failed with unhandled error:`, error.message);
		});

		return {
			success: true,
			jobId,
			status: job.status,
			createdAt: job.createdAt,
		};
	}

	/**
	 * Run the job in the background.
	 */
	async _runBackgroundJob(jobId, parsed, payload, botOrGetter) {
		const startTime = Date.now();
		const job = await this.repository.get(jobId);
		if (!job) return;

		job.status = 'processing';
		job.updatedAt = new Date().toISOString();
		await this._persistJob(job);

		// Setup Timeout AbortController
		const timeoutMs = job.timeoutMs || DEFAULT_JOB_TIMEOUT_MS;

		const controller = new AbortController();
		this.activeControllers.set(jobId, controller);

		const timeoutId = setTimeout(() => {
			controller.abort(new Error(`Job timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		const signal = controller.signal;

		try {
			if (job.type === 'expanded-analysis') {
				await this._executeExpandedAnalysis(job, parsed, signal, botOrGetter);
			} else if (job.type === 'market-scanner') {
				await this._executeMarketScanner(job, parsed, signal, botOrGetter);
			}
		} catch (error) {
			console.error(`[JobService] Job ${jobId} failed:`, error.message);

			const currentJob = await this.repository.get(jobId);
			if (currentJob && currentJob.status === 'cancelled') {
				return;
			}

			const isTimeout =
				error.message.includes('timed out') ||
				error.name === 'TimeoutError' ||
				error.name === 'AbortError' ||
				(job.fullResults && job.fullResults.some((r) => r.status === 'timeout')) ||
				(job.fullScanResults && job.fullScanResults.some((r) => r.status === 'timeout'));

			job.status = isTimeout ? 'timed_out' : 'failed';
			job.error = error.message;
			job.code = error.code || (isTimeout ? 'JOB_TIMEOUT' : 'INTERNAL_ERROR');

			sentryService.captureRuntimeError({
				channel: 'job-service',
				error,
				attributes: {
					jobId,
					jobType: job.type,
				},
			});
		} finally {
			clearTimeout(timeoutId);
			this.activeControllers.delete(jobId);

			const finalJob = await this.repository.get(jobId);
			if (finalJob && finalJob.status === 'cancelled') {
				finalJob.totalDurationMs = Date.now() - startTime;
				finalJob.updatedAt = new Date().toISOString();
				await this._persistJob(finalJob);
				await this._triggerCallbackIfConfigured(finalJob);
				return;
			}

			job.totalDurationMs = Date.now() - startTime;
			job.updatedAt = new Date().toISOString();
			await this._persistJob(job);
			await this._triggerCallbackIfConfigured(job);
		}
	}

	async _executeExpandedAnalysis(job, parsed, signal, botOrGetter) {
		const { symbols, timeframe, includeMultiTimeframe } = parsed;

		for (let index = 0; index < symbols.length; index++) {
			const input = symbols[index];

			const currentJob = await this.repository.get(job.jobId);
			if (currentJob && currentJob.status === 'cancelled') {
				break;
			}

			job.progress.current = index;
			job.progress.status = `Analyzing symbol ${input.raw} (${index + 1}/${symbols.length})`;
			job.updatedAt = new Date().toISOString();
			await this._persistJob(job);

			if (signal && signal.aborted) {
				this._appendTimeoutResults(job.fullResults, symbols.slice(index), this._getAbortMessage(signal));
				break;
			}

			try {
				const analysisRequest = {
					...input,
					timeframe,
				};
				if (signal) {
					analysisRequest.signal = signal;
				}

				const analysis = await tradingViewMcpService.analyzeSymbolIdentifier(analysisRequest);

				let multiTimeframe = null;
				if (includeMultiTimeframe) {
					try {
						multiTimeframe = await tradingViewMcpService.callMultiTimeframeAnalysis({
							symbol: input.symbol,
							exchange: input.exchange,
							signal,
						});
					} catch (mErr) {
						console.warn(
							'[JobService] Multi-timeframe analysis failed for',
							input.raw,
							mErr.message,
						);
					}
				}

				job.fullResults.push({
					symbol: input.raw,
					status: 'analyzed',
					input,
					analysis,
					multiTimeframe,
				});
			} catch (error) {
				if (this._isAbortTriggered(signal, error)) {
					const timeoutMessage = this._getAbortMessage(signal, error.message);
					job.fullResults.push({
						symbol: input.raw,
						status: 'timeout',
						input,
						error: timeoutMessage,
					});
					this._appendTimeoutResults(job.fullResults, symbols.slice(index + 1), timeoutMessage);
					break;
				}

				console.warn('[JobService] Symbol analysis failed:', input.raw, error.message);
				job.fullResults.push({
					symbol: input.raw,
					status: 'error',
					input,
					error: error.message,
				});
			}
		}

		const currentJob = await this.repository.get(job.jobId);
		if (currentJob && currentJob.status === 'cancelled') {
			return;
		}

		job.progress.current = symbols.length;
		job.progress.status = 'Completed analysis';
		job.updatedAt = new Date().toISOString();
		await this._persistJob(job);

		const timedOut = job.fullResults.some((r) => r.status === 'timeout');
		const analyzedItems = job.fullResults
			.filter((result) => result.status === 'analyzed')
			.map((result) => ({
				input: result.input,
				analysis: result.analysis,
				multiTimeframe: result.multiTimeframe,
			}));

		if (analyzedItems.length === 0) {
			job.status = timedOut ? 'timed_out' : 'failed';
			job.error = timedOut
				? 'Expanded analysis job timed out.'
				: 'TradingView MCP failed for all requested symbols.';
			job.code = timedOut ? 'EXPANDED_ANALYSIS_ALERT_TIMEOUT' : 'ALL_SYMBOLS_FAILED';
			await this._persistJob(job);
			return;
		}

		const alertText = buildExpandedAnalysisAlertReport(analyzedItems);
		job.alertText = alertText;

		let notificationManager = getNotificationManager();
		if (!notificationManager) {
			notificationManager = await initializeNotificationServices(this._resolveBot(botOrGetter));
		}

		const deliveryResults = await notificationManager.sendToAll({ text: alertText });
		job.deliveryResults = deliveryResults;
		job.summary = this._buildExpandedSummary(job.fullResults, deliveryResults);
		job.status = 'completed';
		await this._persistJob(job);
	}

	async _executeMarketScanner(job, parsed, signal, botOrGetter) {
		const { exchange, timeframe, scans } = parsed;

		for (let index = 0; index < scans.length; index++) {
			const scanType = scans[index];

			const currentJob = await this.repository.get(job.jobId);
			if (currentJob && currentJob.status === 'cancelled') {
				break;
			}

			job.progress.current = index;
			job.progress.status = `Running scan ${scanType} (${index + 1}/${scans.length})`;
			job.updatedAt = new Date().toISOString();
			await this._persistJob(job);

			if (signal && signal.aborted) {
				this._appendScannerTimeoutResults(job.fullScanResults, scans.slice(index), this._getAbortMessage(signal));
				break;
			}

			try {
				const args = this._buildScanArgs(parsed, scanType);
				const scanOptions = {};
				if (signal) {
					scanOptions.signal = signal;
				}

				const result = await tradingViewMcpService.callScanTool(scanType, args, scanOptions);
				const items = Array.isArray(result) ? result : (result && Array.isArray(result.result) ? result.result : []);

				job.fullScanResults.push({
					scan: scanType,
					status: 'success',
					items,
				});
			} catch (error) {
				if (this._isAbortTriggered(signal, error)) {
					const timeoutMessage = this._getAbortMessage(signal, error.message);
					job.fullScanResults.push({
						scan: scanType,
						status: 'timeout',
						items: [],
						error: timeoutMessage,
					});
					this._appendScannerTimeoutResults(job.fullScanResults, scans.slice(index + 1), timeoutMessage);
					break;
				}

				console.warn('[JobService] Scan failed:', scanType, error.message);
				job.fullScanResults.push({
					scan: scanType,
					status: 'error',
					items: [],
					error: error.message,
				});
			}
		}

		const currentJob = await this.repository.get(job.jobId);
		if (currentJob && currentJob.status === 'cancelled') {
			return;
		}

		job.progress.current = scans.length;
		job.progress.status = 'Completed scans';
		job.updatedAt = new Date().toISOString();
		await this._persistJob(job);

		const timedOut = job.fullScanResults.some((r) => r.status === 'timeout');
		const successfulScans = job.fullScanResults.filter((r) => r.status === 'success');

		if (successfulScans.length === 0) {
			job.status = timedOut ? 'timed_out' : 'failed';
			job.error = timedOut
				? 'Market scanner job timed out.'
				: 'TradingView MCP failed for all requested scans.';
			job.code = timedOut ? 'MARKET_SCANNER_TIMEOUT' : 'ALL_SCANS_FAILED';
			await this._persistJob(job);
			return;
		}

		const alertText = buildMarketScannerReport(job.fullScanResults, {
			exchange,
			timeframe,
			now: new Date(),
		});
		job.alertText = alertText;

		let notificationManager = getNotificationManager();
		if (!notificationManager) {
			notificationManager = await initializeNotificationServices(this._resolveBot(botOrGetter));
		}

		const deliveryResults = await notificationManager.sendToAll({ text: alertText });
		job.deliveryResults = deliveryResults;
		job.summary = this._buildScannerSummary(job.fullScanResults, deliveryResults);
		job.status = 'completed';
		await this._persistJob(job);
	}

	async _persistJob(job) {
		const current = await this.repository.get(job.jobId);
		if (current) {
			const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
			if (terminalStatuses.has(current.status) && job.status === 'processing') {
				return;
			}
		}
		await this.repository.save(job);
	}

	_buildScanArgs(parsed, scanType) {
		const args = {
			exchange: parsed.exchange,
			timeframe: parsed.timeframe,
			limit: parsed.limit,
		};
		if (scanType === 'bollinger_scan') {
			args.bbw_threshold = parsed.bbwThreshold;
		}
		return args;
	}

	_compactResults(results) {
		return results.map((result) => {
			if (result.status === 'error' || result.status === 'timeout') {
				return {
					symbol: result.symbol,
					status: result.status,
					error: result.error,
				};
			}

			return {
				symbol: result.symbol,
				status: result.status,
				price: result.analysis && result.analysis.price_data
					? result.analysis.price_data.current_price ?? result.analysis.price_data.close
					: undefined,
				rsi: result.analysis
					? result.analysis.technical_indicators?.rsi ?? result.analysis.rsi?.value
					: undefined,
				multiTimeframe: result.multiTimeframe ? 'success' : undefined,
			};
		});
	}

	_compactScanResults(results) {
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

	_buildExpandedSummary(results, deliveryResults) {
		const summary = {
			total: results.length,
			analyzed: results.filter((result) => result.status === 'analyzed').length,
			error: results.filter((result) => result.status === 'error').length,
			delivered: deliveryResults.filter((result) => result.success).length,
		};
		const timeout = results.filter((result) => result.status === 'timeout').length;

		if (timeout > 0) {
			summary.timeout = timeout;
		}

		return summary;
	}

	_buildScannerSummary(scanResults, deliveryResults) {
		return {
			totalScans: scanResults.length,
			success: scanResults.filter((r) => r.status === 'success').length,
			error: scanResults.filter((r) => r.status === 'error').length,
			timeout: scanResults.filter((r) => r.status === 'timeout').length,
			totalItems: scanResults.reduce((sum, r) => sum + r.items.length, 0),
			delivered: deliveryResults.filter((r) => r.success).length,
		};
	}

	_appendTimeoutResults(results, symbols, error) {
		symbols.forEach((input) => {
			results.push({
				symbol: input.raw,
				status: 'timeout',
				input,
				error,
			});
		});
	}

	_appendScannerTimeoutResults(results, scans, error) {
		scans.forEach((scanType) => {
			results.push({
				scan: scanType,
				status: 'timeout',
				items: [],
				error,
			});
		});
	}

	_isAbortTriggered(signal, error) {
		return Boolean(
			(signal && signal.aborted)
			|| (error && error.name === 'AbortError')
			|| (error && error.name === 'AbortSignalError'),
		);
	}

	_getAbortMessage(signal, fallback = 'Job timed out') {
		const reason = signal && signal.reason;
		if (reason instanceof Error && reason.message) {
			return reason.message;
		}

		if (typeof reason === 'string' && reason) {
			return reason;
		}

		return fallback;
	}

	async cancelJob(jobId) {
		const job = await this.repository.get(jobId);
		if (!job) {
			return null;
		}

		const terminalStatuses = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
		if (terminalStatuses.has(job.status)) {
			return {
				success: false,
				code: 'TERMINAL_JOB',
				message: 'Job is already in a terminal state.',
				status: job.status,
			};
		}

		job.status = 'cancelled';
		job.error = 'Job cancelled by user';
		job.code = 'USER_CANCELLED';
		job.updatedAt = new Date().toISOString();
		await this._persistJob(job);

		const controller = this.activeControllers.get(jobId);
		if (controller) {
			controller.abort(new Error('Job cancelled by user'));
			this.activeControllers.delete(jobId);
		} else {
			await this._triggerCallbackIfConfigured(job);
		}

		return {
			success: true,
			jobId,
			status: job.status,
		};
	}

	async retryJob(jobId, botOrGetter) {
		const job = await this.repository.get(jobId);
		if (!job) {
			return null;
		}

		const retryableStatuses = new Set(['failed', 'timed_out', 'cancelled']);
		if (!retryableStatuses.has(job.status)) {
			return {
				success: false,
				code: 'NOT_RETRYABLE',
				message: `Job cannot be retried. Current status: ${job.status}`,
			};
		}

		if (!job.requestMetadata) {
			return {
				success: false,
				code: 'MISSING_METADATA',
				message: 'Missing job request metadata for retry.',
			};
		}

		const result = await this.createJob(job.requestMetadata.type, job.requestMetadata, botOrGetter);
		return {
			success: true,
			oldJobId: jobId,
			newJobId: result.jobId,
			status: result.status,
		};
	}

	async retryFailedJob(jobId, botOrGetter) {
		const job = await this.repository.get(jobId);
		if (!job) {
			return null;
		}

		if (job.status === 'processing') {
			return {
				success: false,
				code: 'JOB_ACTIVE',
				message: 'Cannot retry a currently processing job.',
			};
		}

		if (!job.requestMetadata) {
			return {
				success: false,
				code: 'MISSING_METADATA',
				message: 'Missing job request metadata for retry.',
			};
		}

		const type = job.requestMetadata.type;
		let failedItems = [];

		if (type === 'expanded-analysis') {
			const results = job.fullResults || [];
			const successfulSymbols = new Set(
				results
					.filter((r) => r.status === 'analyzed')
					.map((r) => r.symbol)
			);
			failedItems = (job.requestMetadata.symbols || []).filter((sym) => !successfulSymbols.has(sym));
		} else if (type === 'market-scanner') {
			const results = job.fullScanResults || [];
			const successfulScans = new Set(
				results
					.filter((r) => r.status === 'success')
					.map((r) => r.scan)
			);
			failedItems = (job.requestMetadata.scans || []).filter((scan) => !successfulScans.has(scan));
		}

		if (failedItems.length === 0) {
			return {
				success: false,
				code: 'NO_FAILED_ITEMS',
				message: 'No failed or timed-out items found to retry in the original job.',
			};
		}

		const retryPayload = {
			...job.requestMetadata,
			...(type === 'expanded-analysis' ? { symbols: failedItems } : { scans: failedItems }),
		};

		const result = await this.createJob(type, retryPayload, botOrGetter);
		return {
			success: true,
			oldJobId: jobId,
			newJobId: result.jobId,
			status: result.status,
		};
	}

	_resolveBot(botOrGetter) {
		if (typeof botOrGetter === 'function') {
			return botOrGetter();
		}

		return botOrGetter || null;
	}

	async _triggerCallbackIfConfigured(job) {
		if (!job.callbackUrl) return;

		const events = job.callbackEvents || ['completed', 'failed', 'cancelled', 'timed_out'];
		if (!events.includes(job.status)) {
			return;
		}

		// Prevent duplicate callback trigger for the same terminal state
		const terminalStates = new Set(['completed', 'failed', 'cancelled', 'timed_out']);
		if (terminalStates.has(job.status) && job.callbackStatus && job.callbackStatus.status === 'success') {
			return;
		}

		// Execute the callback in the background
		this._sendCallbackWithRetry(job).catch((err) => {
			console.error(`[JobService] Callback for job ${job.jobId} failed:`, err.message);
		});
	}

	async _sendCallbackWithRetry(job) {
		const callbackUrl = job.callbackUrl;
		const secret = job.callbackSecret || process.env.JOB_CALLBACK_SIGNING_SECRET || '';
		const payload = this._formatJobResponse(job);
		const payloadStr = JSON.stringify(payload);

		const headers = {
			'Content-Type': 'application/json',
		};
		if (secret) {
			headers['x-callback-signature'] = crypto.createHmac('sha256', secret).update(payloadStr).digest('hex');
		}

		const attempts = [];
		let success = false;
		const maxAttempts = 4; // 1 initial + 3 retries
		let delayMs = process.env.JOB_CALLBACK_RETRY_DELAY_MS ? parseInt(process.env.JOB_CALLBACK_RETRY_DELAY_MS, 10) : 1000;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5000);
			const timestamp = new Date().toISOString();

			try {
				const response = await fetch(callbackUrl, {
					method: 'POST',
					headers,
					body: payloadStr,
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				const attemptInfo = {
					attempt,
					timestamp,
					statusCode: response.status,
				};

				if (response.ok) {
					attempts.push(attemptInfo);
					success = true;
					break;
				} else {
					attemptInfo.error = `HTTP ${response.status} ${response.statusText}`;
					attempts.push(attemptInfo);
				}
			} catch (err) {
				clearTimeout(timeoutId);
				attempts.push({
					attempt,
					timestamp,
					error: err.name === 'AbortError' ? 'Timeout' : err.message,
				});
			}

			if (attempt < maxAttempts) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
				delayMs *= 2;
			}
		}

		// Update job state in repository
		const freshJob = await this.repository.get(job.jobId);
		if (freshJob) {
			freshJob.callbackStatus = {
				status: success ? 'success' : 'failed',
				attempts: [...(freshJob.callbackStatus?.attempts || []), ...attempts],
			};
			await this.repository.save(freshJob);
		}
	}
}

// Singleton instance
const jobService = new JobService();

module.exports = {
	jobService,
	JobService,
};
