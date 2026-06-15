'use strict';

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

class JobService {
	constructor(repository = jobRepository) {
		this.repository = repository;
		this.jobs = repository;
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

		const jobId = uuidv4();
		const job = {
			jobId,
			type,
			status: 'processing',
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
		};

		await this.repository.save(job);

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
			job.status = 'failed';
			job.error = error.message;
			job.code = error.code || 'INTERNAL_ERROR';

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
			job.totalDurationMs = Date.now() - startTime;
			job.updatedAt = new Date().toISOString();
			await this._persistJob(job);
		}
	}

	async _executeExpandedAnalysis(job, parsed, signal, botOrGetter) {
		const { symbols, timeframe, includeMultiTimeframe } = parsed;

		for (let index = 0; index < symbols.length; index++) {
			const input = symbols[index];
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
			job.status = 'failed';
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

		job.progress.current = scans.length;
		job.progress.status = 'Completed scans';
		job.updatedAt = new Date().toISOString();
		await this._persistJob(job);

		const timedOut = job.fullScanResults.some((r) => r.status === 'timeout');
		const successfulScans = job.fullScanResults.filter((r) => r.status === 'success');

		if (successfulScans.length === 0) {
			job.status = 'failed';
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

	_resolveBot(botOrGetter) {
		if (typeof botOrGetter === 'function') {
			return botOrGetter();
		}

		return botOrGetter || null;
	}
}

// Singleton instance
const jobService = new JobService();

module.exports = {
	jobService,
	JobService,
};
