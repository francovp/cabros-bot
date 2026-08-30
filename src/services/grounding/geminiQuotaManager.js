'use strict';

/**
 * GeminiQuotaManager - Shared process-level Gemini API quota cooldown manager
 * Prevents cascading 429 errors across concurrent workers and requests
 */

class GeminiQuotaManager {
	constructor() {
		this.quotaCooldownUntil = 0;
		this.lastTriggeredAt = null;
		this.triggersTotal = 0;
		this.braveFallbacksDuringCooldown = 0;
		this.lastBraveFallbackAt = null;
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
	 * Extract recommended retry delay in milliseconds from error or exponential backoff
	 * @param {Error|object} error
	 * @param {number} attempt
	 * @param {number} baseDelayMs
	 * @returns {number} Delay in milliseconds
	 */
	extractRetryDelayMs(error, attempt = 1, baseDelayMs = 1000) {
		const retryDelay = error && (error.retryDelay || error.retryAfter || error.retryDelayMs);
		if (typeof retryDelay === 'number' && retryDelay >= 0) {
			return retryDelay;
		}

		const message = String((error && error.message) || '');
		const retryDelayMatch = message.match(/"?retry(?:\s|-)?delay"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)(ms|s)?"?/i);
		if (retryDelayMatch) {
			const value = Number.parseFloat(retryDelayMatch[1]);
			const unit = (retryDelayMatch[2] || 'ms').toLowerCase();
			return unit === 's' ? value * 1000 : value;
		}

		const retryAfterMatch = message.match(/"?retry-after"?\s*[:=]?\s*"?(\d+(?:\.\d+)?)(ms|s)?"?/i);
		if (retryAfterMatch) {
			const value = Number.parseFloat(retryAfterMatch[1]);
			const unit = (retryAfterMatch[2] || 's').toLowerCase();
			return unit === 'ms' ? value : value * 1000;
		}

		return baseDelayMs * (2 ** Math.max(0, attempt - 1));
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
	 * Check if process-level quota cooldown is currently active
	 * @returns {boolean}
	 */
	isCooldownActive() {
		return Date.now() < this.quotaCooldownUntil;
	}

	/**
	 * Get remaining cooldown duration in milliseconds
	 * @returns {number}
	 */
	getRemainingCooldownMs() {
		return Math.max(0, this.quotaCooldownUntil - Date.now());
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
		this.triggersTotal = 0;
		this.braveFallbacksDuringCooldown = 0;
		this.lastBraveFallbackAt = null;
	}
}

const instance = new GeminiQuotaManager();

module.exports = instance;
module.exports.GeminiQuotaManager = GeminiQuotaManager;
