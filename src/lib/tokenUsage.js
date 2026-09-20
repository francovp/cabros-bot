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
// Based on official pricing documentation:
// Gemini: https://ai.google.dev/gemini-api/docs/pricing
// OpenAI: https://openai.com/api/pricing/
// Anthropic: https://www.anthropic.com/pricing
const PRICING_PER_1M = {
	'gemini-3-pro-preview': { input: 2.00, output: 12.00 },
	'gemini-3-flash-preview': { input: 0.50, output: 3.00 },
	'gemini-2.5-pro': { input: 1.25, output: 10.00 },
	'gemini-2.5-flash': { input: 0.30, output: 2.50 },
	'gemini-2.0-flash': { input: 0.10, output: 0.40 },
	'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
	'gemini-1.5-flash': { input: 0.075, output: 0.30 },
	'gemini-1.5-pro': { input: 1.25, output: 5.00 },
	'gpt-4o': { input: 2.50, output: 10.00 },
	'gpt-4o-mini': { input: 0.15, output: 0.60 },
	'claude-3-5-sonnet': { input: 3.00, output: 15.00 },
	'claude-3-5-haiku': { input: 0.80, output: 4.00 },
	'deepseek-chat': { input: 0.14, output: 0.28 },
	'llama-3': { input: 0.20, output: 0.20 },
	// Default fallback rate for unrecognized models
	'default': { input: 0.15, output: 0.60 },
};

/**
 * Resolve pricing configuration for a given model string.
 * Strips provider prefixes (e.g. google/, google-ai-studio/, azure/, openai/)
 * and revisions (-001), and applies family heuristics for nonzero pricing.
 * @param {string} [model]
 * @returns {{ input: number, output: number }}
 */
function resolveModelPricing(model) {
	if (!model || typeof model !== 'string') {
		return PRICING_PER_1M.default;
	}
	const raw = model.trim().toLowerCase();
	if (PRICING_PER_1M[raw]) {
		return PRICING_PER_1M[raw];
	}

	// Handle explicitly free models (e.g. openrouter models with :free suffix or /free)
	if (raw.endsWith(':free') || raw.includes('/free') || raw === 'free') {
		return { input: 0, output: 0 };
	}

	// Gemma hosted variants (e.g. google/gemma-2-9b-it, google/gemma-2-27b-it)
	if (raw.includes('gemma-2-27b')) return { input: 0.27, output: 0.27 };
	if (raw.includes('gemma-2-9b') || raw.includes('gemma-2-2b') || raw.includes('gemma')) {
		return { input: 0.07, output: 0.07 };
	}

	// Strip provider prefix (e.g. google/, google-ai-studio/, openai/, azure/, meta/, @cf/meta/)
	const nameWithoutPrefix = raw.includes('/') ? raw.split('/').pop() : raw;
	if (PRICING_PER_1M[nameWithoutPrefix]) {
		return PRICING_PER_1M[nameWithoutPrefix];
	}

	// Strip revision suffixes like -001, -002, etc.
	const baseName = nameWithoutPrefix.replace(/-\d{3}$/, '');
	if (PRICING_PER_1M[baseName]) {
		return PRICING_PER_1M[baseName];
	}

	// Model family heuristic matching
	if (raw.includes('gemini-2.5-flash-lite')) return PRICING_PER_1M['gemini-2.5-flash-lite'];
	if (raw.includes('gemini-2.5-flash')) return PRICING_PER_1M['gemini-2.5-flash'];
	if (raw.includes('gemini-2.5-pro')) return PRICING_PER_1M['gemini-2.5-pro'];
	if (raw.includes('gemini-2.0-flash')) return PRICING_PER_1M['gemini-2.0-flash'];
	if (raw.includes('gemini-1.5-flash')) return PRICING_PER_1M['gemini-1.5-flash'];
	if (raw.includes('gemini-1.5-pro')) return PRICING_PER_1M['gemini-1.5-pro'];
	if (raw.includes('gemini-3-flash')) return PRICING_PER_1M['gemini-3-flash-preview'];
	if (raw.includes('gemini-3-pro')) return PRICING_PER_1M['gemini-3-pro-preview'];
	if (raw.includes('gpt-4o-mini')) return PRICING_PER_1M['gpt-4o-mini'];
	if (raw.includes('gpt-4o')) return PRICING_PER_1M['gpt-4o'];
	if (raw.includes('claude-3-5-sonnet') || raw.includes('claude-3-sonnet')) return PRICING_PER_1M['claude-3-5-sonnet'];
	if (raw.includes('claude-3-5-haiku') || raw.includes('claude-3-haiku')) return PRICING_PER_1M['claude-3-5-haiku'];
	if (raw.includes('deepseek')) return PRICING_PER_1M['deepseek-chat'];
	if (raw.includes('llama')) return PRICING_PER_1M['llama-3'];

	return PRICING_PER_1M.default;
}

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
	 * @param {string} [model]
	 */
	calculateCost(inputTokens, outputTokens, model) {
		const pricing = resolveModelPricing(model);
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

function getUtcDay(date = new Date(Date.now())) {
	const y = date.getUTCFullYear();
	const m = String(date.getUTCMonth() + 1).padStart(2, '0');
	const d = String(date.getUTCDate()).padStart(2, '0');
	return `${y}-${m}-${d}`;
}

class GlobalTokenCostBudgetTracker extends TokenUsageTracker {
	constructor() {
		super();
		this.dailySpendUsd = 0;
		this.dailyInputTokens = 0;
		this.dailyOutputTokens = 0;
		this.lastResetAt = new Date(Date.now()).toISOString();
		this.currentDay = getUtcDay();
		this.warningAlertSent = false;
		this.limitAlertSent = false;
		this.alertsSent = 0;
		this.notificationManager = null;
		this.notifyAdmin = null;
		this.firestore = null;
		this._lastSyncAt = 0;
		this._inFlightSync = null;

		// Asynchronously synchronize with shared Firestore daily spend if available
		this._syncSharedSpend().catch(() => {});
	}

	_getFirestore() {
		if (this.firestore) {
			return this.firestore;
		}
		try {
			const { getFirestore } = require('../services/storage/AlertStorageService');
			return typeof getFirestore === 'function' ? getFirestore() : null;
		} catch {
			return null;
		}
	}

	_persistSpendIncrement(addedCost, addedInput, addedOutput) {
		const firestore = this._getFirestore();
		if (!firestore) return;

		try {
			const docRef = firestore.collection('tokenBudgets').doc(this.currentDay);
			let adminSdk = null;
			try {
				adminSdk = require('firebase-admin');
			} catch {
				adminSdk = null;
			}
			const FieldValue = adminSdk?.firestore?.FieldValue;

			let writePromise = null;
			if (FieldValue?.increment && typeof docRef.set === 'function') {
				writePromise = docRef.set({
					dailySpendUsd: FieldValue.increment(addedCost),
					dailyInputTokens: FieldValue.increment(addedInput),
					dailyOutputTokens: FieldValue.increment(addedOutput),
					updatedAt: FieldValue.serverTimestamp ? FieldValue.serverTimestamp() : new Date().toISOString(),
				}, { merge: true });
			} else if (typeof firestore.runTransaction === 'function') {
				writePromise = firestore.runTransaction(async (tx) => {
					const snapshot = await tx.get(docRef);
					const data = snapshot && snapshot.exists ? (typeof snapshot.data === 'function' ? snapshot.data() : snapshot) : null;
					const currentSpend = Number(data?.dailySpendUsd) || 0;
					const currentIn = Number(data?.dailyInputTokens) || 0;
					const currentOut = Number(data?.dailyOutputTokens) || 0;
					tx.set(docRef, {
						dailySpendUsd: currentSpend + addedCost,
						dailyInputTokens: currentIn + addedInput,
						dailyOutputTokens: currentOut + addedOutput,
						updatedAt: new Date().toISOString(),
					}, { merge: true });
				});
			} else if (typeof docRef.set === 'function') {
				writePromise = docRef.set({
					dailySpendUsd: this.dailySpendUsd,
					dailyInputTokens: this.dailyInputTokens,
					dailyOutputTokens: this.dailyOutputTokens,
					updatedAt: new Date().toISOString(),
				}, { merge: true });
			}

			if (writePromise) {
				try {
					const { trackBackgroundTask } = require('./backgroundTaskTracker');
					if (typeof trackBackgroundTask === 'function') {
						trackBackgroundTask(writePromise);
					}
				} catch (_) {}
				if (typeof writePromise.catch === 'function') {
					writePromise.catch((err) => {
						console.warn(`[TokenCostBudget] Failed to persist spend increment to Firestore: ${err.message}`);
					});
				}
			}
		} catch (err) {
			console.warn(`[TokenCostBudget] Error persisting spend increment: ${err.message}`);
		}
	}

	async _claimAlertAtomically(type) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			if (type === 'limit') {
				if (this.limitAlertSent) return false;
				this.limitAlertSent = true;
				this.alertsSent++;
				return true;
			} else if (type === 'warning') {
				if (this.warningAlertSent) return false;
				this.warningAlertSent = true;
				this.alertsSent++;
				return true;
			}
			return false;
		}

		try {
			const docRef = firestore.collection('tokenBudgets').doc(this.currentDay);
			const claimed = await firestore.runTransaction(async (tx) => {
				const snap = await tx.get(docRef);
				const data = snap && snap.exists ? (typeof snap.data === 'function' ? snap.data() : snap) : {};
				const fieldName = type === 'limit' ? 'limitAlertSent' : 'warningAlertSent';
				if (data && data[fieldName]) {
					return false;
				}
				const currentAlertsSent = Number(data?.alertsSent) || 0;
				tx.set(docRef, {
					[fieldName]: true,
					alertsSent: currentAlertsSent + 1,
					updatedAt: new Date().toISOString(),
				}, { merge: true });
				return true;
			});

			if (claimed) {
				if (type === 'limit') this.limitAlertSent = true;
				if (type === 'warning') this.warningAlertSent = true;
				this.alertsSent++;
				return true;
			} else {
				if (type === 'limit') this.limitAlertSent = true;
				if (type === 'warning') this.warningAlertSent = true;
				return false;
			}
		} catch (err) {
			console.warn(`[TokenCostBudget] Error claiming ${type} alert in Firestore: ${err.message}`);
			if (type === 'limit') {
				if (this.limitAlertSent) return false;
				this.limitAlertSent = true;
				this.alertsSent++;
				return true;
			} else if (type === 'warning') {
				if (this.warningAlertSent) return false;
				this.warningAlertSent = true;
				this.alertsSent++;
				return true;
			}
			return false;
		}
	}

	async _releaseAlertClaimAtomically(type) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			if (type === 'limit') {
				this.limitAlertSent = false;
				this.alertsSent = Math.max(0, this.alertsSent - 1);
			} else if (type === 'warning') {
				this.warningAlertSent = false;
				this.alertsSent = Math.max(0, this.alertsSent - 1);
			}
			return;
		}

		try {
			const docRef = firestore.collection('tokenBudgets').doc(this.currentDay);
			await firestore.runTransaction(async (tx) => {
				const snap = await tx.get(docRef);
				const data = snap && snap.exists ? (typeof snap.data === 'function' ? snap.data() : snap) : {};
				const fieldName = type === 'limit' ? 'limitAlertSent' : 'warningAlertSent';
				const currentAlertsSent = Number(data?.alertsSent) || 0;
				tx.set(docRef, {
					[fieldName]: false,
					alertsSent: Math.max(0, currentAlertsSent - 1),
					updatedAt: new Date().toISOString(),
				}, { merge: true });
			});
		} catch (err) {
			console.warn(`[TokenCostBudget] Failed to release ${type} alert claim: ${err.message}`);
		} finally {
			if (type === 'limit') {
				this.limitAlertSent = false;
				this.alertsSent = Math.max(0, this.alertsSent - 1);
			} else if (type === 'warning') {
				this.warningAlertSent = false;
				this.alertsSent = Math.max(0, this.alertsSent - 1);
			}
		}
	}

	_triggerThresholdAlert(type, config, utilizationPct) {
		const firestore = this._getFirestore();
		if (!firestore || typeof firestore.runTransaction !== 'function') {
			if (type === 'limit') {
				if (this.limitAlertSent) return Promise.resolve();
				this.limitAlertSent = true;
				this.alertsSent++;
				console.error(`[TokenCostBudget] Hard limit reached: daily token spend $${this.dailySpendUsd.toFixed(4)} reached 100% of daily budget $${config.budgetUsd.toFixed(2)}. Blocking new LLM calls.`);
				return Promise.resolve(this._sendAdminNotification('limit', {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
				})).then((delivered) => {
					if (delivered === false) {
						this.limitAlertSent = false;
						this.alertsSent = Math.max(0, this.alertsSent - 1);
					}
				}).catch(() => {
					this.limitAlertSent = false;
					this.alertsSent = Math.max(0, this.alertsSent - 1);
				});
			} else if (type === 'warning') {
				if (this.warningAlertSent) return Promise.resolve();
				this.warningAlertSent = true;
				this.alertsSent++;
				console.warn(`[TokenCostBudget] Warning: daily token spend $${this.dailySpendUsd.toFixed(4)} reached ${utilizationPct.toFixed(1)}% of daily budget $${config.budgetUsd.toFixed(2)} (threshold ${config.warnThresholdPct}%)`);
				return Promise.resolve(this._sendAdminNotification('warning', {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
					warnThresholdPct: config.warnThresholdPct,
				})).then((delivered) => {
					if (delivered === false) {
						this.warningAlertSent = false;
						this.alertsSent = Math.max(0, this.alertsSent - 1);
					}
				}).catch(() => {
					this.warningAlertSent = false;
					this.alertsSent = Math.max(0, this.alertsSent - 1);
				});
			}
			return Promise.resolve();
		}

		// When Firestore is available, perform atomic distributed claim
		const fieldName = type === 'limit' ? 'limitAlertSent' : 'warningAlertSent';
		if (this[fieldName]) return Promise.resolve();
		this[fieldName] = true;

		const docRef = firestore.collection('tokenBudgets').doc(this.currentDay);
		const claimPromise = firestore.runTransaction(async (tx) => {
			const snap = await tx.get(docRef);
			const data = snap && snap.exists ? (typeof snap.data === 'function' ? snap.data() : snap) : {};
			if (data && data[fieldName]) {
				return false;
			}
			const currentAlertsSent = Number(data?.alertsSent) || 0;
			tx.set(docRef, {
				[fieldName]: true,
				alertsSent: currentAlertsSent + 1,
				updatedAt: new Date().toISOString(),
			}, { merge: true });
			return true;
		}).then(async (claimed) => {
			if (!claimed) {
				return;
			}
			this.alertsSent++;
			if (type === 'limit') {
				console.error(`[TokenCostBudget] Hard limit reached: daily token spend $${this.dailySpendUsd.toFixed(4)} reached 100% of daily budget $${config.budgetUsd.toFixed(2)}. Blocking new LLM calls.`);
				const delivered = await this._sendAdminNotification('limit', {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
				});
				if (delivered === false) {
					await this._releaseAlertClaimAtomically('limit');
				}
			} else {
				console.warn(`[TokenCostBudget] Warning: daily token spend $${this.dailySpendUsd.toFixed(4)} reached ${utilizationPct.toFixed(1)}% of daily budget $${config.budgetUsd.toFixed(2)} (threshold ${config.warnThresholdPct}%)`);
				const delivered = await this._sendAdminNotification('warning', {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
					warnThresholdPct: config.warnThresholdPct,
				});
				if (delivered === false) {
					await this._releaseAlertClaimAtomically('warning');
				}
			}
		}).catch(async (err) => {
			console.warn(`[TokenCostBudget] Error in atomic alert claim transaction: ${err.message}`);
			this.alertsSent++;
			try {
				const delivered = await this._sendAdminNotification(type, {
					dailySpendUsd: this.dailySpendUsd,
					budgetUsd: config.budgetUsd,
					utilizationPct,
					warnThresholdPct: config.warnThresholdPct,
				});
				if (delivered === false) {
					this[fieldName] = false;
					this.alertsSent = Math.max(0, this.alertsSent - 1);
				}
			} catch (_) {
				this[fieldName] = false;
				this.alertsSent = Math.max(0, this.alertsSent - 1);
			}
		});

		try {
			const { trackBackgroundTask } = require('./backgroundTaskTracker');
			if (typeof trackBackgroundTask === 'function') {
				trackBackgroundTask(claimPromise);
			}
		} catch (_) {}
	}

	async _syncSharedSpend() {
		const firestore = this._getFirestore();
		if (!firestore) return;

		try {
			const docRef = firestore.collection('tokenBudgets').doc(this.currentDay);
			const doc = await docRef.get();
			if (doc && doc.exists) {
				const data = typeof doc.data === 'function' ? doc.data() : doc;
				const sharedSpend = Number(data?.dailySpendUsd) || 0;
				const sharedInput = Number(data?.dailyInputTokens) || 0;
				const sharedOutput = Number(data?.dailyOutputTokens) || 0;
				if (sharedSpend > this.dailySpendUsd) {
					this.dailySpendUsd = sharedSpend;
				}
				if (sharedInput > this.dailyInputTokens) {
					this.dailyInputTokens = sharedInput;
				}
				if (sharedOutput > this.dailyOutputTokens) {
					this.dailyOutputTokens = sharedOutput;
				}

				if (data?.warningAlertSent) {
					this.warningAlertSent = true;
				}
				if (data?.limitAlertSent) {
					this.limitAlertSent = true;
				}
				if (Number(data?.alertsSent) > this.alertsSent) {
					this.alertsSent = Number(data.alertsSent);
				}

				// Check budget alerts based on refreshed shared spend
				const config = this.getBudgetConfig();
				if (config.enabled && config.budgetUsd > 0) {
					const utilizationPct = Number(((this.dailySpendUsd / config.budgetUsd) * 100).toFixed(1));
					if (utilizationPct >= 100 && !this.limitAlertSent) {
						this._triggerThresholdAlert('limit', config, utilizationPct).catch(() => {});
					} else if (utilizationPct >= config.warnThresholdPct && !this.warningAlertSent) {
						this._triggerThresholdAlert('warning', config, utilizationPct).catch(() => {});
					}
				}
			}
		} catch (err) {
			console.warn(`[TokenCostBudget] Failed to sync shared spend from Firestore: ${err.message}`);
		}
	}

	async syncSharedSpendThrottled({ force = false } = {}) {
		this.checkDayRollover();
		const config = this.getBudgetConfig();
		if (!config.enabled) {
			return this.getBudgetStatus();
		}

		const firestore = this._getFirestore();
		if (!firestore) {
			return this.getBudgetStatus();
		}

		const now = Date.now();
		const utilizationPct = config.budgetUsd > 0 ? (this.dailySpendUsd / config.budgetUsd) * 100 : 0;
		const minIntervalMs = utilizationPct >= 80 ? 2000 : 10000;

		if (!force && (now - this._lastSyncAt < minIntervalMs)) {
			return this.getBudgetStatus();
		}

		if (this._inFlightSync) {
			return this._inFlightSync;
		}

		this._inFlightSync = (async () => {
			try {
				await this._syncSharedSpend();
				this._lastSyncAt = Date.now();
			} finally {
				this._inFlightSync = null;
			}
			return this.getBudgetStatus();
		})();

		return this._inFlightSync;
	}

	async syncSharedSpend() {
		return this.syncSharedSpendThrottled({ force: true });
	}

	async isBudgetExceededAsync() {
		await this.syncSharedSpendThrottled().catch(() => {});
		return this.isBudgetExceeded();
	}

	checkDayRollover(now = new Date(Date.now())) {
		const today = getUtcDay(now);
		if (this.currentDay !== today) {
			this.dailySpendUsd = 0;
			this.dailyInputTokens = 0;
			this.dailyOutputTokens = 0;
			this.warningAlertSent = false;
			this.limitAlertSent = false;
			this.alertsSent = 0;
			this.lastResetAt = now.toISOString();
			this.currentDay = today;
			this._syncSharedSpend().catch(() => {});
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

		if (addedCost > 0 || currentInput > 0 || currentOutput > 0) {
			this._persistSpendIncrement(addedCost, currentInput, currentOutput);
		}

		const config = this.getBudgetConfig();
		if (config.enabled) {
			const utilizationPct = config.budgetUsd > 0
				? Number(((this.dailySpendUsd / config.budgetUsd) * 100).toFixed(1))
				: 0;

			// Warning threshold crossed
			if (utilizationPct >= config.warnThresholdPct && !this.warningAlertSent) {
				this._triggerThresholdAlert('warning', config, utilizationPct).catch(() => {});
			}

			// Hard budget limit breached
			if (utilizationPct >= 100 && !this.limitAlertSent) {
				this._triggerThresholdAlert('limit', config, utilizationPct).catch(() => {});
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

	async _sendAdminNotification(type, data) {
		const adminChatId = process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID;
		const message = type === 'warning'
			? `⚠️ Token Budget Warning\nDaily spend: $${data.dailySpendUsd.toFixed(4)} / $${data.budgetUsd.toFixed(2)} (${data.utilizationPct.toFixed(1)}%)\nWarning threshold: ${data.warnThresholdPct}%\nLLM calls will be blocked when 100% is reached.`
			: `🚨 Token Budget Exceeded\nDaily spend: $${data.dailySpendUsd.toFixed(4)} / $${data.budgetUsd.toFixed(2)} (${data.utilizationPct.toFixed(1)}%)\nHard budget limit reached. New LLM calls will fail open until daily reset (00:00 UTC).`;

		if (typeof this.notifyAdmin === 'function') {
			try {
				const res = await this.notifyAdmin({ type, message, ...data });
				return res !== false;
			} catch (err) {
				console.warn(`[TokenCostBudget] notifyAdmin failed: ${err.message}`);
				return false;
			}
		}

		if (!adminChatId) {
			return false;
		}

		try {
			const manager = this.notificationManager || this._getNotificationManager();
			const telegramService = manager?.channels?.get?.('telegram');
			if (telegramService && typeof telegramService.send === 'function' && telegramService.isEnabled()) {
				const res = await telegramService.send({
					text: message,
					telegramChatId: adminChatId,
				});
				return Boolean(res && res.success === true);
			}
			return false;
		} catch (err) {
			console.warn(`[TokenCostBudget] Failed to send admin telegram notification: ${err.message}`);
			return false;
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
		this.currentDay = getUtcDay();
		this.warningAlertSent = false;
		this.limitAlertSent = false;
		this.alertsSent = 0;
		this.notificationManager = null;
		this.notifyAdmin = null;
		this.firestore = null;
		this._lastSyncAt = 0;
		this._inFlightSync = null;
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
