/**
 * SentryService - Wrapper around @sentry/node for runtime error monitoring
 * Provides a thin abstraction for capturing errors with consistent tagging
 *
 * Feature: 005-sentry-runtime-errors
 */

const Sentry = require('@sentry/node');

/**
 * @typedef {'http-alert' | 'news-monitor' | 'telegram' | 'whatsapp' | 'grounding' | 'news-enrichment' | 'process'} RuntimeChannelId
 */

/**
 * @typedef {'runtime_error' | 'process_error' | 'external_failure'} ErrorEventType
 */

/**
 * @typedef {'telegram-api' | 'whatsapp-greenapi' | 'gemini' | 'azure-llm' | 'binance' | 'url-shortener-bitly' | 'url-shortener-tinyurl' | 'url-shortener-other'} ExternalProviderId
 */

/**
 * @typedef {Object} HttpErrorContext
 * @property {string} endpoint - e.g., '/api/webhook/alert', '/api/news-monitor'
 * @property {'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'} method
 * @property {number} statusCode
 * @property {string} [requestId]
 * @property {Object<string, boolean>} [featureFlagState]
 */

/**
 * @typedef {Object} ExternalFailureContext
 * @property {ExternalProviderId} provider
 * @property {number} attemptCount
 * @property {number} durationMs
 * @property {string} [lastErrorMessage]
 * @property {string|number} [lastErrorCode]
 */

/**
 * @typedef {Object} AlertContext
 * @property {number} textLength
 * @property {boolean} hasEnrichment
 * @property {'gemini-grounding' | 'news-monitor' | 'other'} [enrichedSource]
 * @property {boolean} truncated
 */

/**
 * @typedef {Object} NewsContext
 * @property {number} symbolCount
 * @property {number} alertsSent
 * @property {{analyzed: number, cached: number, timeout: number, error: number}} summaryStatus
 */

/**
 * @typedef {Object} ErrorEvent
 * @property {string} [id]
 * @property {ErrorEventType} type
 * @property {RuntimeChannelId} channel
 * @property {string} [feature]
 * @property {string} message
 * @property {string} [errorName]
 * @property {string} [stack]
 * @property {string} environment
 * @property {string} [release]
 * @property {boolean} isProcessLevel
 * @property {number} timestamp
 * @property {HttpErrorContext} [http]
 * @property {ExternalFailureContext} [external]
 * @property {AlertContext} [alert]
 * @property {NewsContext} [news]
 * @property {Object<string, unknown>} [extra]
 */

/**
 * @typedef {Object} MonitoringConfiguration
 * @property {boolean} enabled
 * @property {string} [dsn]
 * @property {string} environment
 * @property {string} [release]
 * @property {boolean} sendAlertContent - Whether to include full alert/news text in events
 * @property {number} sampleRateErrors - Error sample rate (0.0-1.0)
 */

/**
 * @typedef {Object} MonitoringServiceState
 * @property {boolean} configured
 * @property {boolean} enabled
 * @property {string} [lastInitError]
 */

/**
 * @typedef {Object} MonitoringCaptureRequest
 * @property {ErrorEvent} event
 */

/**
 * @typedef {Object} MonitoringCaptureResult
 * @property {boolean} captured
 * @property {string} [skippedReason]
 * @property {string} [eventId]
 */

// Feature name mapping for different channels
const FEATURE_NAMES = {
	'http-alert': 'alerts',
	'news-monitor': 'news-monitor',
	'telegram': 'telegram-alerts',
	'whatsapp': 'whatsapp-alerts',
	'grounding': 'gemini-grounding',
	'news-enrichment': 'news-enrichment',
	'process': 'process',
};

/**
 * SentryService singleton instance
 * Manages Sentry initialization and error capture
 */
class SentryService {
	constructor() {
		/** @type {MonitoringServiceState} */
		this.state = {
			configured: false,
			enabled: false,
			lastInitError: undefined,
		};

		/** @type {MonitoringConfiguration|null} */
		this.config = null;
	}

	/**
	 * Derive environment string from environment variables
	 * @returns {string}
	 */
	_deriveEnvironment() {
		// If SENTRY_ENVIRONMENT is explicitly set, use it
		if (process.env.SENTRY_ENVIRONMENT) {
			return process.env.SENTRY_ENVIRONMENT;
		}

		// If on Render and this is a PR preview
		if (process.env.RENDER === 'true' && process.env.IS_PULL_REQUEST === 'true') {
			return 'preview';
		}

		// If in production mode or on Render
		if (process.env.NODE_ENV === 'production' || process.env.RENDER === 'true') {
			return 'production';
		}

		// Default to development
		return 'development';
	}

	/**
	 * Derive release string from environment variables
	 * @returns {string|undefined}
	 */
	_deriveRelease() {
		// If SENTRY_RELEASE is explicitly set, use it
		if (process.env.SENTRY_RELEASE) {
			return process.env.SENTRY_RELEASE;
		}

		// If RENDER_GIT_COMMIT is available, use short commit hash
		if (process.env.RENDER_GIT_COMMIT) {
			const shortCommit = process.env.RENDER_GIT_COMMIT.substring(0, 7);
			const repoSlug = process.env.RENDER_GIT_REPO_SLUG || 'cabros-bot';
			return `${repoSlug}@${shortCommit}`;
		}

		// Let Sentry auto-detect if possible
		return undefined;
	}

	/**
	 * Build monitoring configuration from environment variables
	 * @returns {MonitoringConfiguration}
	 */
	_buildConfiguration() {
		const dsn = process.env.SENTRY_DSN || undefined;
		const enabled = process.env.ENABLE_SENTRY === 'true' && !!dsn;

		// Default sendAlertContent to true
		return {
			enabled,
			dsn,
			environment: this._deriveEnvironment(),
			release: this._deriveRelease(),
			sendAlertContent: process.env.SENTRY_SEND_ALERT_CONTENT !== 'false',
			sampleRateErrors: parseFloat(process.env.SENTRY_SAMPLE_RATE_ERRORS) || 1.0,
		};
	}

	/**
	 * Initialize Sentry monitoring service
	 * Call this once at application startup
	 * @returns {void}
	 */
	init() {
		try {
			this.config = this._buildConfiguration();

			if (!this.config.enabled) {
				const reason = !process.env.SENTRY_DSN
					? 'SENTRY_DSN not configured'
					: 'ENABLE_SENTRY is not true';

				console.info(`[SentryService] Monitoring disabled: ${reason}`);
				this.state = {
					configured: false,
					enabled: false,
					lastInitError: reason,
				};
				return;
			}

			// Initialize Sentry SDK
			Sentry.init({
				dsn: this.config.dsn,
				environment: this.config.environment,
				release: this.config.release,
				sampleRate: this.config.sampleRateErrors,

				// Disable tracing/performance for this feature (FR-010)
				tracesSampleRate: 0,

				// Configure process-level error capture (FR-002)
				integrations: (integrations) => {
					// Keep default integrations but configure them appropriately
					return integrations;
				},

				// beforeSend hook for additional filtering if needed
				beforeSend(event) {
					// Can be used for additional filtering or modification
					return event;
				},
			});

			this.state = {
				configured: true,
				enabled: true,
				lastInitError: undefined,
			};

			console.info(
				`[SentryService] Monitoring enabled (environment=${this.config.environment}, release=${this.config.release || 'auto'})`,
			);
		} catch (error) {
			console.error('[SentryService] Failed to initialize:', error.message);
			this.state = {
				configured: false,
				enabled: false,
				lastInitError: error.message,
			};
		}
	}

	/**
	 * Check if monitoring is enabled
	 * @returns {boolean}
	 */
	isEnabled() {
		return this.state.enabled;
	}

	/**
	 * Get current service state (for testing and health checks)
	 * @returns {MonitoringServiceState}
	 */
	getState() {
		return { ...this.state };
	}

	/**
	 * Get current configuration (for testing)
	 * @returns {MonitoringConfiguration|null}
	 */
	getConfig() {
		return this.config ? { ...this.config } : null;
	}

	/**
	 * Capture a generic error event
	 * @param {MonitoringCaptureRequest} request
	 * @returns {MonitoringCaptureResult}
	 */
	captureEvent(request) {
		try {
			if (!this.state.enabled) {
				return {
					captured: false,
					skippedReason: this.state.lastInitError || 'Monitoring disabled',
				};
			}

			const { event } = request;

			// Build Sentry scope with tags and contexts
			const eventId = Sentry.captureException(
				event.errorName ? new Error(event.message) : event.message,
				{
					tags: {
						channel: event.channel,
						feature: event.feature || FEATURE_NAMES[event.channel] || 'unknown',
						environment: event.environment,
						error_type: event.type,
						is_process_level: String(event.isProcessLevel),
					},
					contexts: {
						...(event.http && { http: event.http }),
						...(event.external && { external: event.external }),
						...(event.alert && this._buildAlertContext(event.alert)),
						...(event.news && this._buildNewsContext(event.news)),
					},
					extra: {
						...event.extra,
						timestamp: event.timestamp,
						errorName: event.errorName,
					},
				},
			);

			console.debug(`[SentryService] Event captured: ${eventId} (channel=${event.channel}, type=${event.type})`);

			return {
				captured: true,
				eventId,
			};
		} catch (error) {
			// Never throw - monitoring failures should not affect application behavior
			console.warn(`[SentryService] Failed to capture event: ${error.message}`);
			return {
				captured: false,
				skippedReason: `Capture error: ${error.message}`,
			};
		}
	}

	/**
	 * Build alert context, respecting sendAlertContent policy
	 * @param {AlertContext} alertContext
	 * @returns {{alert: Object}}
	 */
	_buildAlertContext(alertContext) {
		// Always include metadata
		const context = {
			alert: {
				textLength: alertContext.textLength,
				hasEnrichment: alertContext.hasEnrichment,
				enrichedSource: alertContext.enrichedSource,
				truncated: alertContext.truncated,
			},
		};

		return context;
	}

	/**
	 * Build news context, respecting sendAlertContent policy
	 * @param {NewsContext} newsContext
	 * @returns {{news: Object}}
	 */
	_buildNewsContext(newsContext) {
		return {
			news: {
				symbolCount: newsContext.symbolCount,
				alertsSent: newsContext.alertsSent,
				summaryStatus: newsContext.summaryStatus,
			},
		};
	}

	/**
	 * Capture a runtime error from application code
	 * @param {Object} params
	 * @param {RuntimeChannelId} params.channel
	 * @param {Error|string} params.error
	 * @param {string} [params.feature]
	 * @param {HttpErrorContext} [params.http]
	 * @param {AlertContext} [params.alert]
	 * @param {NewsContext} [params.news]
	 * @param {Object<string, unknown>} [params.extra]
	 * @returns {MonitoringCaptureResult}
	 */
	captureRuntimeError({ channel, error, feature, http, alert, news, extra }) {
		const errorObj = error instanceof Error ? error : new Error(String(error));

		/** @type {ErrorEvent} */
		const event = {
			type: 'runtime_error',
			channel,
			feature: feature || FEATURE_NAMES[channel],
			message: errorObj.message,
			errorName: errorObj.name,
			stack: errorObj.stack ? errorObj.stack.substring(0, 8000) : undefined,
			environment: (this.config && this.config.environment) || this._deriveEnvironment(),
			release: this.config && this.config.release,
			isProcessLevel: false,
			timestamp: Date.now(),
			http,
			alert,
			news,
			extra,
		};

		return this.captureEvent({ event });
	}

	/**
	 * Capture an external service failure (after retries exhausted)
	 * @param {Object} params
	 * @param {RuntimeChannelId} params.channel
	 * @param {ExternalFailureContext} params.external
	 * @param {string} [params.feature]
	 * @param {Object<string, unknown>} [params.extra]
	 * @returns {MonitoringCaptureResult}
	 */
	captureExternalFailure({ channel, external, feature, extra }) {
		const message = `External failure: ${external.provider} after ${external.attemptCount} attempt(s)`;

		/** @type {ErrorEvent} */
		const event = {
			type: 'external_failure',
			channel,
			feature: feature || FEATURE_NAMES[channel],
			message,
			errorName: 'ExternalFailure',
			environment: (this.config && this.config.environment) || this._deriveEnvironment(),
			release: this.config && this.config.release,
			isProcessLevel: false,
			timestamp: Date.now(),
			external,
			extra: {
				...extra,
				lastErrorMessage: external.lastErrorMessage,
			},
		};

		return this.captureEvent({ event });
	}

	/**
	 * Capture a process-level error (uncaughtException/unhandledRejection)
	 * Note: This is typically handled by Sentry's built-in integrations
	 * @param {Object} params
	 * @param {Error|string} params.error
	 * @param {'uncaughtException' | 'unhandledRejection'} params.source
	 * @param {Object<string, unknown>} [params.extra]
	 * @returns {MonitoringCaptureResult}
	 */
	captureProcessError({ error, source, extra }) {
		const errorObj = error instanceof Error ? error : new Error(String(error));

		/** @type {ErrorEvent} */
		const event = {
			type: 'process_error',
			channel: 'process',
			feature: 'process',
			message: errorObj.message,
			errorName: errorObj.name,
			stack: errorObj.stack ? errorObj.stack.substring(0, 8000) : undefined,
			environment: (this.config && this.config.environment) || this._deriveEnvironment(),
			release: this.config && this.config.release,
			isProcessLevel: true,
			timestamp: Date.now(),
			extra: {
				...extra,
				processErrorSource: source,
			},
		};

		return this.captureEvent({ event });
	}

	/**
	 * Flush pending events (for graceful shutdown)
	 * @param {number} [timeout=2000] - Timeout in milliseconds
	 * @returns {Promise<boolean>}
	 */
	async flush(timeout = 2000) {
		if (!this.state.enabled) {
			return true;
		}

		try {
			return await Sentry.flush(timeout);
		} catch (error) {
			console.warn(`[SentryService] Flush failed: ${error.message}`);
			return false;
		}
	}

	/**
	 * Reset service state (for testing)
	 * @returns {void}
	 */
	_reset() {
		this.state = {
			configured: false,
			enabled: false,
			lastInitError: undefined,
		};
		this.config = null;
	}
}

// Export singleton instance
const sentryService = new SentryService();

module.exports = sentryService;
module.exports.SentryService = SentryService;
module.exports.FEATURE_NAMES = FEATURE_NAMES;
