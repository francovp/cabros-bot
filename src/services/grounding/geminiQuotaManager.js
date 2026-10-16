'use strict';

/**
 * GeminiQuotaManager - Shared process-level Gemini API quota cooldown manager
 * Prevents cascading 429 errors across concurrent workers and requests
 */

class GeminiQuotaManager {
	constructor() {
		this.quotaCooldownUntil = 0;
		this.lastTriggeredAt = null;
		this.lastTriggeredAtMs = null;
		this.triggersTotal = 0;
		this.braveFallbacksDuringCooldown = 0;
		this.lastBraveFallbackAt = null;
		this._maxCooldownMs = null;
	}

	/**
	 * Set process-level or test-level maximum cooldown ceiling override
	 * @param {number|null} ms
	 */
	setMaxCooldownMs(ms) {
		this._maxCooldownMs = typeof ms === 'number' && ms > 0 ? ms : null;
	}

	/**
	 * Get effective maximum cooldown ceiling in milliseconds
	 * @returns {number}
	 */
	getMaxCooldownMs() {
		if (typeof this._maxCooldownMs === 'number' && this._maxCooldownMs > 0) {
			return this._maxCooldownMs;
		}

		try {
			// Fail-open lazy load to avoid any circular dependency
			// eslint-disable-next-line global-require
			const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
			const runtimeConfig = getRuntimeConfig();
			if (runtimeConfig && typeof runtimeConfig.NEWS_GEMINI_QUOTA_MAX_COOLDOWN_MS === 'number') {
				return runtimeConfig.NEWS_GEMINI_QUOTA_MAX_COOLDOWN_MS;
			}
		} catch {
			// Fail open to environment or default
		}

		const envVal = Number.parseInt(process.env.NEWS_GEMINI_QUOTA_MAX_COOLDOWN_MS, 10);
		if (Number.isFinite(envVal) && envVal >= 1000) {
			return envVal;
		}

		return 1800000; // 30 minutes default
	}

	/**
	 * Check if an error is a Gemini 429 quota exhaustion error
	 * @param {Error|object} error
	 * @returns {boolean}
	 */
	isQuotaError(error) {
		if (!error) {
			return false;
		}

		const status = Number(error.status || error.statusCode || error.code);
		if (status === 429) {
			return true;
		}

		const message = String(error.message || '').toUpperCase();
		return (
			message.includes('429') ||
			message.includes('RESOURCE_EXHAUSTED') ||
			message.includes('QUOTA')
		);
	}

	/**
	 * Extract recommended retry delay in milliseconds from error or exponential backoff,
	 * clamped to the configured maximum cooldown ceiling.
	 * @param {Error|object} error
	 * @param {number} attempt
	 * @param {number} baseDelayMs
	 * @param {number|null} [maxDelayMs]
	 * @returns {number} Delay in milliseconds bounded by max cooldown ceiling
	 */
	extractRetryDelayMs(error, attempt = 1, baseDelayMs = 1000, maxDelayMs = null) {
		let rawDelayMs;
		const retryDelay = error && (error.retryDelay || error.retryAfter || error.retryDelayMs);
		if (typeof retryDelay === 'number' && retryDelay >= 0) {
			rawDelayMs = retryDelay;
		} else {
			const message = String((error && error.message) || '');
			const retryDelayMatch = message.match(/"?retry(?:\s|-)?delay"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)(ms|s)?"?/i);
			if (retryDelayMatch) {
				const value = Number.parseFloat(retryDelayMatch[1]);
				const unit = (retryDelayMatch[2] || 'ms').toLowerCase();
				rawDelayMs = unit === 's' ? value * 1000 : value;
			} else {
				const retryAfterMatch = message.match(/"?retry-after"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)(ms|s)?"?/i);
				if (retryAfterMatch) {
					const value = Number.parseFloat(retryAfterMatch[1]);
					const unit = (retryAfterMatch[2] || 's').toLowerCase();
					rawDelayMs = unit === 'ms' ? value : value * 1000;
				} else {
					rawDelayMs = baseDelayMs * (2 ** Math.max(0, attempt - 1));
				}
			}
		}

		const ceilingMs = maxDelayMs ?? this.getMaxCooldownMs();
		return Math.min(rawDelayMs, ceilingMs);
	}

	/**
	 * Extend process-level quota cooldown without recording a new incident.
	 *
	 * Used by layers that observe a provider rejection that has already been
	 * counted elsewhere in the same call chain. Extending the cooldown keeps the
	 * fail-safe behaviour intact while ensuring one rejection yields exactly one
	 * `triggersTotal` increment (issue #718).
	 * @param {Error|object} error
	 * @param {number} attempt
	 * @param {number} baseDelayMs
	 * @returns {number} Cooldown delay in milliseconds
	 */
	extendQuotaCooldown(error, attempt = 1, baseDelayMs = 1000) {
		const delayMs = this.extractRetryDelayMs(error, attempt, baseDelayMs);
		const now = Date.now();
		const newCooldownUntil = now + delayMs;

		if (!this.lastTriggeredAtMs) {
			this.lastTriggeredAtMs = now;
		}

		if (newCooldownUntil > this.quotaCooldownUntil) {
			this.quotaCooldownUntil = newCooldownUntil;
		}
		return delayMs;
	}

	/**
	 * Trigger or extend process-level quota cooldown
	 * @param {Error|object} error
	 * @param {number} attempt
	 * @param {number} baseDelayMs
	 * @returns {number} Cooldown delay in milliseconds
	 */
	triggerQuotaCooldown(error, attempt = 1, baseDelayMs = 1000) {
		const delayMs = this.extractRetryDelayMs(error, attempt, baseDelayMs);
		const now = Date.now();
		const newCooldownUntil = now + delayMs;
		this.triggersTotal += 1;
		this.lastTriggeredAt = new Date(now).toISOString();
		this.lastTriggeredAtMs = now;

		if (newCooldownUntil > this.quotaCooldownUntil) {
			this.quotaCooldownUntil = newCooldownUntil;
			console.warn('[GeminiQuotaManager] Gemini 429 quota exhaustion detected. Process-level cooldown activated:', {
				delayMs,
				cooldownUntil: new Date(this.quotaCooldownUntil).toISOString(),
				attempt,
			});
		}
		return delayMs;
	}

	/**
	 * Record a fallback to Brave search during active cooldown
	 */
	recordBraveFallbackDuringCooldown() {
		this.braveFallbacksDuringCooldown += 1;
		this.lastBraveFallbackAt = new Date().toISOString();
	}

	/**
	 * Get snapshot of current quota manager state and counters
	 * @returns {object}
	 */
	getSnapshot() {
		return {
			cooldownActive: this.isCooldownActive(),
			remainingCooldownMs: this.getRemainingCooldownMs(),
			lastTriggeredAt: this.lastTriggeredAt,
			triggersTotal: this.triggersTotal,
			braveFallbacksDuringCooldown: this.braveFallbacksDuringCooldown,
			lastBraveFallbackAt: this.lastBraveFallbackAt,
		};
	}

	/**
	 * Get effective cooldown expiration timestamp in milliseconds, respecting dynamic max cooldown overrides
	 * @returns {number}
	 */
	getEffectiveCooldownUntil() {
		if (this.quotaCooldownUntil <= 0) {
			return 0;
		}
		const maxCooldownMs = this.getMaxCooldownMs();
		if (this.lastTriggeredAtMs) {
			return Math.min(this.quotaCooldownUntil, this.lastTriggeredAtMs + maxCooldownMs);
		}
		return this.quotaCooldownUntil;
	}

	/**
	 * Check if process-level quota cooldown is currently active
	 * @returns {boolean}
	 */
	isCooldownActive() {
		return Date.now() < this.getEffectiveCooldownUntil();
	}

	/**
	 * Get remaining cooldown duration in milliseconds
	 * @returns {number}
	 */
	getRemainingCooldownMs() {
		return Math.max(0, this.getEffectiveCooldownUntil() - Date.now());
	}

	/**
	 * Wait for active quota cooldown if needed
	 * @param {object} options
	 * @param {number} [options.maxWaitMs] Maximum allowable wait budget in ms
	 * @param {boolean} [options.throwOnExceeded] Whether to throw GEMINI_QUOTA_EXHAUSTED if wait exceeds budget
	 * @returns {Promise<boolean>} True if waited or no cooldown needed; false if wait exceeded budget (and throwOnExceeded=false)
	 */
	async waitForCooldownIfNeeded(options = {}) {
		const { maxWaitMs, throwOnExceeded = false } = options;
		const startWaitTime = Date.now();

		while (this.isCooldownActive()) {
			const remainingCooldownMs = this.getRemainingCooldownMs();
			if (remainingCooldownMs <= 0) {
				break;
			}

			if (typeof maxWaitMs === 'number') {
				const totalWaitTimeSoFar = Date.now() - startWaitTime;
				const remainingBudgetMs = maxWaitMs - totalWaitTimeSoFar;

				if (remainingCooldownMs > remainingBudgetMs || remainingBudgetMs <= 0) {
					if (throwOnExceeded) {
						const error = new Error(`Gemini quota cooldown (${remainingCooldownMs}ms) exceeds remaining budget (${Math.max(0, remainingBudgetMs)}ms)`);
						error.code = 'GEMINI_QUOTA_EXHAUSTED';
						error.status = 429;
						error.retryDelay = remainingCooldownMs;
						throw error;
					}
					return false;
				}
			}

			console.info(`[GeminiQuotaManager] Pausing request for active Gemini quota cooldown (${remainingCooldownMs}ms)`);
			await new Promise(resolve => setTimeout(resolve, remainingCooldownMs));
		}

		return true;
	}

	/**
	 * Reset quota manager state for testing
	 */
	resetForTesting() {
		this.quotaCooldownUntil = 0;
		this.lastTriggeredAt = null;
		this.lastTriggeredAtMs = null;
		this.triggersTotal = 0;
		this.braveFallbacksDuringCooldown = 0;
		this.lastBraveFallbackAt = null;
		this._maxCooldownMs = null;
	}
}

const instance = new GeminiQuotaManager();

module.exports = instance;
module.exports.GeminiQuotaManager = GeminiQuotaManager;
