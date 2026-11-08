'use strict';

/**
 * GlobalAlertBudget - in-process rolling 24h alert-delivery budget.
 *
 * Caps the total number of *successful* per-channel deliveries that the
 * NotificationManager can dispatch within a rolling 24-hour window, so a
 * runaway signal source, misconfigured scanner preset, or redrive loop
 * cannot drain Gemini/MCP quota or trigger Telegram/Discord rate-limit
 * bans.
 *
 * Counter increments per successful channel delivery; failed delivery
 * attempts do not consume budget. A dry-run path returns the current
 * used/remaining counter without incrementing.
 *
 * Counters reset on process restart (acceptable for operational capping -
 * the cap is intended as an emergency valve, not as a precise daily
 * counter). All methods are fail-open: errors are logged and never block
 * delivery.
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_CAPACITY = 500;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CAPACITY = 1000000;
const ADMIN_PAGE_COOLDOWN_MS = 5 * 60 * 1000;

function getCapacity() {
	const config = getRuntimeConfig();
	const value = Number(config.GLOBAL_ALERT_BUDGET_PER_24H);
	if (!Number.isFinite(value) || value < 0) {
		return DEFAULT_CAPACITY;
	}
	return Math.floor(value);
}

function isEnabled() {
	return getCapacity() > 0;
}

class GlobalAlertBudget {
	constructor() {
		this.entries = [];
	}

	prune(nowMs) {
		const cutoff = nowMs - WINDOW_MS;
		let writeIdx = 0;
		for (let readIdx = 0; readIdx < this.entries.length; readIdx += 1) {
			if (this.entries[readIdx].timestamp >= cutoff) {
				this.entries[writeIdx] = this.entries[readIdx];
				writeIdx += 1;
			}
		}
		this.entries.length = writeIdx;
	}

	count(nowMs) {
		this.prune(nowMs);
		let total = 0;
		for (let i = 0; i < this.entries.length; i += 1) {
			total += this.entries[i].count;
		}
		return total;
	}

	reserve(nowMs = Date.now()) {
		try {
			if (!isEnabled()) {
				const cap = getCapacity();
				return {
					allowed: true,
					used: 0,
					capacity: cap,
					remaining: cap,
					resetAt: this._resetAt(nowMs),
				};
			}
			const cap = getCapacity();
			const usedBefore = this.count(nowMs);
			if (usedBefore >= cap) {
				return {
					allowed: false,
					used: usedBefore,
					capacity: cap,
					remaining: 0,
					resetAt: this._resetAt(nowMs),
				};
			}
			this.entries.push({ timestamp: nowMs, count: 1 });
			const usedAfter = usedBefore + 1;
			return {
				allowed: true,
				used: usedAfter,
				capacity: cap,
				remaining: Math.max(0, cap - usedAfter),
				resetAt: this._resetAt(nowMs),
			};
		} catch (error) {
			console.warn('[GlobalAlertBudget] reserve failed (fail-open):', error.message);
			const cap = getCapacity();
			return {
				allowed: true,
				used: 0,
				capacity: cap,
				remaining: cap,
				resetAt: this._resetAt(nowMs),
			};
		}
	}

	dryRun(nowMs = Date.now()) {
		try {
			const cap = getCapacity();
			const enabled = isEnabled();
			if (!enabled) {
				return {
					enabled: false,
					used: 0,
					capacity: cap,
					remaining: cap,
					resetAt: this._resetAt(nowMs),
				};
			}
			const used = this.count(nowMs);
			return {
				enabled: true,
				used,
				capacity: cap,
				remaining: Math.max(0, cap - used),
				resetAt: this._resetAt(nowMs),
			};
		} catch (error) {
			console.warn('[GlobalAlertBudget] dryRun failed (fail-open):', error.message);
			return {
				enabled: false,
				used: 0,
				capacity: 0,
				remaining: 0,
				resetAt: this._resetAt(nowMs),
			};
		}
	}

	getStatus(nowMs = Date.now()) {
		return this.dryRun(nowMs);
	}

	_resetAt(nowMs) {
		const oldest = this.entries.length > 0 ? this.entries[0].timestamp : nowMs;
		return new Date(Math.max(oldest, nowMs - WINDOW_MS) + WINDOW_MS).toISOString();
	}

	resetForTesting() {
		this.entries = [];
	}

	isEnabled() {
		return isEnabled();
	}
}

const globalAlertBudget = new GlobalAlertBudget();

let lastAdminPageAt = 0;

async function notifyAdminBudgetExceeded({ used, capacity, resetAt, telegramService }) {
	const now = Date.now();
	if (now - lastAdminPageAt < ADMIN_PAGE_COOLDOWN_MS) {
		return;
	}
	lastAdminPageAt = now;

	if (!telegramService || typeof telegramService.send !== 'function') {
		return;
	}
	if (!process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID) {
		return;
	}

	const text = [
		'\u26a0\ufe0f *Global alert budget exceeded*',
		`Used: ${used} / ${capacity} deliveries in the last 24h`,
		`Reset: ${resetAt}`,
		'Further alerts return 429 ALERT_BUDGET_EXCEEDED until capacity frees up.',
	].join('\n');

	try {
		await telegramService.send({
			text,
			telegramChatId: process.env.TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID,
			parseMode: 'MarkdownV2',
		});
	} catch (error) {
		console.warn('[GlobalAlertBudget] admin notify failed:', error.message);
	}
}

module.exports = {
	GlobalAlertBudget,
	globalAlertBudget,
	notifyAdminBudgetExceeded,
	isEnabled,
	getCapacity,
	resetAdminPageCooldownForTesting: () => {
		lastAdminPageAt = 0;
	},
};
