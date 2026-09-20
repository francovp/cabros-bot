/**
 * Token usage utilities
 * Provides normalization helpers and a tracker for aggregating
 * input/output tokens across multiple LLM calls.
 */

function toNumber(value) {
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function firstDefined(...values) {
	for (const value of values) {
		if (value !== undefined && value !== null) {
			return value;
		}
	}
	return null;
}

// Pricing per 1M tokens (USD)
// Based on: https://ai.google.dev/gemini-api/docs/pricing
const PRICING_PER_1M = {
	'gemini-3-pro-preview': { input: 2.00, output: 12.00 },
	'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
	'gemini-2.5-pro': { input: 1.25, output: 10.00 },
	'gemini-2.5-flash': { input: 0.30, output: 2.50 },
	'gemini-2.0-flash': { input: 0.10, output: 0.40 },
	'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
	// Other models
	'default': { input: 0.00, output: 0.00 },
};

/**
 * Normalize usage metadata from various providers into a common shape.
 * Supports Gemini usageMetadata ({ promptTokenCount, candidatesTokenCount, totalTokenCount }),
 * OpenAI-compatible usage ({ prompt_tokens, completion_tokens, total_tokens }),
 * and generic { inputTokens, outputTokens, totalTokens } objects.
 * @param {Object} usageMetadata
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens: number }|null}
 */
function normalizeUsageMetadata(usageMetadata) {
	if (!usageMetadata) return null;

	const meta = usageMetadata.usageMetadata || usageMetadata;
	const inputTokens = toNumber(firstDefined(meta.promptTokenCount, meta.inputTokens, meta.promptTokens, meta.prompt_tokens)) || 0;
	const outputTokens = toNumber(firstDefined(meta.candidatesTokenCount, meta.outputTokens, meta.completionTokens, meta.completion_tokens)) || 0;

	const explicitTotal = toNumber(firstDefined(meta.totalTokenCount, meta.totalTokens, meta.total_tokens));
	const totalTokens = explicitTotal != null ? explicitTotal : inputTokens + outputTokens;

	return {
		inputTokens,
		outputTokens,
		totalTokens: totalTokens != null ? totalTokens : inputTokens + outputTokens,
	};
}

class TokenUsageTracker {
	constructor() {
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.inputCost = 0;
		this.outputCost = 0;
	}

	/**
	 * Calculate cost for token usage
	 * @param {number} inputTokens
	 * @param {number} outputTokens
	 * @param {string} model
	 */
	calculateCost(inputTokens, outputTokens, model) {
		let pricing = PRICING_PER_1M[model];

		// Handle unknown gemma models as free (fallback)
		if (!pricing && model && model.toLowerCase().includes('gemma')) {
			pricing = { input: 0, output: 0 };
		}

		// Fallback to default
		if (!pricing) {
			pricing = PRICING_PER_1M['default'];
		}

		const iCost = (inputTokens / 1000000) * pricing.input;
		const oCost = (outputTokens / 1000000) * pricing.output;

		return { inputCost: iCost, outputCost: oCost };
	}

	/**
	 * Add a usage record (raw metadata or normalized object)
	 * @param {Object|null|undefined} usage
	 * @param {string} [model] - Model name for pricing calculation
	 */
	addUsage(usage, model, options = {}) {
		const normalized = normalizeUsageMetadata(usage);
		if (!normalized) return;

		const currentInput = normalized.inputTokens || 0;
		let currentOutput = normalized.outputTokens || 0;

		// If only totalTokens is available, spread remainder into outputTokens
		const remainder = (normalized.totalTokens || 0) - currentInput - currentOutput;
		if (remainder > 0) {
			currentOutput += remainder;
		}

		this.inputTokens += currentInput;
		this.outputTokens += currentOutput;

		let iCost = 0;
		let oCost = 0;
		if (model) {
			const cost = this.calculateCost(currentInput, currentOutput, model);
			iCost = cost.inputCost;
			oCost = cost.outputCost;
			this.inputCost += iCost;
			this.outputCost += oCost;
		}

		if (options.recordGlobal && this !== globalTokenTracker) {
			globalTokenTracker.recordUsage({
				inputTokens: currentInput,
				outputTokens: currentOutput,
				inputCost: iCost,
				outputCost: oCost,
				model,
			});
		}
	}

	merge(otherTracker) {
		if (!otherTracker) return;
		const { inputTokens, outputTokens, inputCost, outputCost } = otherTracker.toJSON();
		this.inputTokens += inputTokens;
		this.outputTokens += outputTokens;
		this.inputCost += (inputCost || 0);
		this.outputCost += (outputCost || 0);
	}

	getTotalUsage() {
		const json = this.toJSON();
		return {
			...json,
			estimatedSpendUsd: json.totalCost,
		};
	}

	toJSON() {
		const totalTokens = this.inputTokens + this.outputTokens;
		const totalCost = this.inputCost + this.outputCost;
		return {
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			totalTokens,
			inputCost: this.inputCost,
			outputCost: this.outputCost,
			totalCost,
		};
	}

	/**
	 * Format usage and price as a string
	 * @returns {string}
	 */
	formatSummary() {
		const { inputTokens, outputTokens, totalTokens, inputCost, outputCost, totalCost } = this.toJSON();

		// Helper to format currency (up to 6 decimal places for small amounts)
		const fmt = (val) => {
			if (val === 0) return '0.00';
			return val < 0.01 ? val.toPrecision(3) : val.toFixed(4);
		};

		return `Token usage:
- In ${inputTokens} ($${fmt(inputCost)})
- Out ${outputTokens} ($${fmt(outputCost)})
- Total ${totalTokens} ($${fmt(totalCost)})`;
	}
}

class GlobalTokenCostBudgetTracker extends TokenUsageTracker {
	constructor() {
		super();
		this.dailySpendUsd = 0;
		this.dailyInputTokens = 0;
		this.dailyOutputTokens = 0;
		this.lastResetAt = new Date(Date.now()).toISOString();
		this.warningAlertSent = false;
		this.limitAlertSent = false;
		this.alertsSent = 0;
		this.notificationManager = null;
		this.notifyAdmin = null;
	}

	checkDayRollover(now = new Date(Date.now())) {
		const lastResetDate = new Date(this.lastResetAt);
		const isSameDay = (
			now.getUTCFullYear() === lastResetDate.getUTCFullYear() &&
			now.getUTCMonth() === lastResetDate.getUTCMonth() &&
			now.getUTCDate() === lastResetDate.getUTCDate()
		);

		if (!isSameDay) {
			this.dailySpendUsd = 0;
			this.dailyInputTokens = 0;
			this.dailyOutputTokens = 0;
			this.warningAlertSent = false;
			this.limitAlertSent = false;
			this.alertsSent = 0;
			this.lastResetAt = now.toISOString();
		}
	}

	getBudgetConfig() {
		let rc = {};
		try {
			const { getRuntimeConfig } = require('../services/remoteConfig/RemoteConfigService');
			rc = typeof getRuntimeConfig === 'function' ? getRuntimeConfig() : {};
		} catch {
			rc = {};
		}

		const enabled = rc.ENABLE_TOKEN_COST_BUDGET !== undefined
			? Boolean(rc.ENABLE_TOKEN_COST_BUDGET)
			: process.env.ENABLE_TOKEN_COST_BUDGET === 'true';

		const rawBudget = rc.TOKEN_COST_DAILY_BUDGET_USD !== undefined
			? rc.TOKEN_COST_DAILY_BUDGET_USD
			: process.env.TOKEN_COST_DAILY_BUDGET_USD;
		const parsedBudget = Number(rawBudget);
		const budgetUsd = Number.isFinite(parsedBudget) && parsedBudget > 0 ? parsedBudget : 5.00;

		const rawWarn = rc.TOKEN_COST_WARN_THRESHOLD_PCT !== undefined
			? rc.TOKEN_COST_WARN_THRESHOLD_PCT
			: process.env.TOKEN_COST_WARN_THRESHOLD_PCT;
		const parsedWarn = Number(rawWarn);
		const warnThresholdPct = Number.isFinite(parsedWarn) && parsedWarn >= 1 && parsedWarn <= 100
			? Math.round(parsedWarn)
			: 80;

		return {
			enabled,
			budgetUsd,
			dailyBudgetUsd: budgetUsd,
			warnThresholdPct,
		};
	}

	isEnabled() {
		return this.getBudgetConfig().enabled;
	}

	recordUsage(usageOrDetails, model) {
		this.checkDayRollover();

		let currentInput = 0;
		let currentOutput = 0;
		let iCost = 0;
		let oCost = 0;

		if (usageOrDetails && typeof usageOrDetails === 'object' && ('inputCost' in usageOrDetails || 'outputCost' in usageOrDetails)) {
			currentInput = usageOrDetails.inputTokens || 0;
			currentOutput = usageOrDetails.outputTokens || 0;
			iCost = usageOrDetails.inputCost || 0;
			oCost = usageOrDetails.outputCost || 0;
		} else {
			const normalized = normalizeUsageMetadata(usageOrDetails);
			if (!normalized) return;

			currentInput = normalized.inputTokens || 0;
			currentOutput = normalized.outputTokens || 0;
			const remainder = (normalized.totalTokens || 0) - currentInput - currentOutput;
			if (remainder > 0) {
				currentOutput += remainder;
			}

			const effectiveModel = model || (usageOrDetails && usageOrDetails.model);
			if (effectiveModel) {
				const cost = this.calculateCost(currentInput, currentOutput, effectiveModel);
				iCost = cost.inputCost;
				oCost = cost.outputCost;
			}
		}

		this.inputTokens += currentInput;
		this.outputTokens += currentOutput;
		this.inputCost += iCost;
		this.outputCost += oCost;

		this.dailyInputTokens += currentInput;
		this.dailyOutputTokens += currentOutput;
		const addedCost = iCost + oCost;
		this.dailySpendUsd += addedCost;

		const config = this.getBudgetConfig();
		if (config.enabled) {
			const utilizationPct = config.budgetUsd > 0
				? Number(((this.dailySpendUsd / config.budgetUsd) * 100).toFixed(1))
				: 0;

			// Warning threshold breached
			if (utilizationPct >= config.warnThresholdPct && !this.warningAlertSent) {
				this.warningAlertSent = true;
				this.alertsSent++;
				console.warn(`[TokenCostBudget] Warning: daily token spend $${this.dailySpendUsd.toFixed(4)} reached ${utilizationPct.toFixed(1)}% of daily budget $${config.budgetUsd.toFixed(2)} (threshold ${config.warnThresholdPct}%)`);
				this._sendAdminNotification('warning', {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
					warnThresholdPct: config.warnThresholdPct,
				});
			}

			// Hard budget limit breached
			if (utilizationPct >= 100 && !this.limitAlertSent) {
				this.limitAlertSent = true;
				this.alertsSent++;
				console.error(`[TokenCostBudget] Hard limit reached: daily token spend $${this.dailySpendUsd.toFixed(4)} reached 100% of daily budget $${config.budgetUsd.toFixed(2)}. Blocking new LLM calls.`);
				this._sendAdminNotification('limit', {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
				});
			}
		}
	}

	addUsage(usage, model) {
		return this.recordUsage(usage, model);
	}

	isBudgetExceeded() {
		this.checkDayRollover();
		const config = this.getBudgetConfig();
		if (!config.enabled) {
			return false;
		}

		if (this.dailySpendUsd >= config.budgetUsd) {
			console.error(`[TokenCostBudget] Daily token budget exceeded ($${this.dailySpendUsd.toFixed(4)} / $${config.budgetUsd.toFixed(2)}). Blocking new LLM calls.`);
			return true;
		}
		return false;
	}

	isWarningThresholdReached() {
		this.checkDayRollover();
		const config = this.getBudgetConfig();
		if (!config.enabled) {
			return false;
		}
		const utilizationPct = config.budgetUsd > 0 ? (this.dailySpendUsd / config.budgetUsd) * 100 : 0;
		return utilizationPct >= config.warnThresholdPct;
	}

	getBudgetStatus() {
		this.checkDayRollover();
		const config = this.getBudgetConfig();
		const dailySpendUsd = Number(this.dailySpendUsd.toFixed(4));
		const budgetUsd = Number(config.budgetUsd.toFixed(2));
		const utilizationPct = budgetUsd > 0
			? Number(((this.dailySpendUsd / budgetUsd) * 100).toFixed(1))
			: 0;

		const isExceeded = config.enabled && this.dailySpendUsd >= budgetUsd;
		const isWarning = config.enabled && utilizationPct >= config.warnThresholdPct;
		const status = !config.enabled ? 'disabled' : (isExceeded ? 'exceeded' : (isWarning ? 'warning' : 'ready'));

		return {
			enabled: config.enabled,
			configured: true,
			ready: config.enabled ? !isExceeded : false,
			status,
			dailySpendUsd,
			budgetUsd,
			utilizationPct,
			alertsSent: this.alertsSent,
			lastResetAt: this.lastResetAt,
		};
	}

	_sendAdminNotification(type, data) {
		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const message = type === 'warning'
			? `⚠️ Token Budget Warning\nDaily spend: $${data.dailySpendUsd.toFixed(4)} / $${data.budgetUsd.toFixed(2)} (${data.utilizationPct.toFixed(1)}%)\nWarning threshold: ${data.warnThresholdPct}%\nLLM calls will be blocked when 100% is reached.`
			: `🚨 Token Budget Exceeded\nDaily spend: $${data.dailySpendUsd.toFixed(4)} / $${data.budgetUsd.toFixed(2)} (${data.utilizationPct.toFixed(1)}%)\nHard budget limit reached. New LLM calls will fail open until daily reset (00:00 UTC).`;

		if (typeof this.notifyAdmin === 'function') {
			try {
				const res = this.notifyAdmin({ type, message, ...data });
				if (res && typeof res.catch === 'function') {
					res.catch((err) => console.warn(`[TokenCostBudget] notifyAdmin failed: ${err.message}`));
				}
			} catch (err) {
				console.warn(`[TokenCostBudget] notifyAdmin failed: ${err.message}`);
			}
			return;
		}

		if (!adminChatId) {
			return;
		}

		try {
			const manager = this.notificationManager || this._getNotificationManager();
			const telegramService = manager?.channels?.get?.('telegram');
			if (telegramService && typeof telegramService.send === 'function' && telegramService.isEnabled()) {
				telegramService.send({
					text: message,
					telegramChatId: adminChatId,
				}).catch((err) => {
					console.warn(`[TokenCostBudget] Failed to send admin telegram notification: ${err.message}`);
				});
			}
		} catch (err) {
			console.warn(`[TokenCostBudget] Failed to send admin telegram notification: ${err.message}`);
		}
	}

	_getNotificationManager() {
		try {
			const { getNotificationManager } = require('../controllers/webhooks/handlers/alert/alert');
			return typeof getNotificationManager === 'function' ? getNotificationManager() : null;
		} catch {
			return null;
		}
	}

	_resetForTesting() {
		this.inputTokens = 0;
		this.outputTokens = 0;
		this.inputCost = 0;
		this.outputCost = 0;
		this.dailySpendUsd = 0;
		this.dailyInputTokens = 0;
		this.dailyOutputTokens = 0;
		this.lastResetAt = new Date(Date.now()).toISOString();
		this.warningAlertSent = false;
		this.limitAlertSent = false;
		this.alertsSent = 0;
		this.notificationManager = null;
		this.notifyAdmin = null;
	}

	reset() {
		this._resetForTesting();
	}
}

const globalTokenTracker = new GlobalTokenCostBudgetTracker();

function registerGlobalUsage(usage, model) {
	globalTokenTracker.addUsage(usage, model);
}

module.exports = {
	normalizeUsageMetadata,
	TokenUsageTracker,
	GlobalTokenCostBudgetTracker,
	globalTokenTracker,
	tokenCostBudgetService: globalTokenTracker,
	registerGlobalUsage,
	PRICING_PER_1M,
	MODEL_PRICING: PRICING_PER_1M,
};
