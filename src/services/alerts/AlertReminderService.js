const { buildReminderKey, buildReminderText, isReminderEligible, normalizeActionableAlert } = require('./actionableAlert');

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

class AlertReminderService {
	constructor(config = {}) {
		this.ttlMs = Number.isInteger(config.ttlMs) ? config.ttlMs : DEFAULT_TTL_MS;
		this.maxEntries = Number.isInteger(config.maxEntries) ? config.maxEntries : DEFAULT_MAX_ENTRIES;
		this.entries = new Map();
	}

	annotate(enriched = {}) {
		const normalized = normalizeActionableAlert(enriched);
		if (!isReminderEligible(normalized)) {
			return normalized;
		}

		const key = buildReminderKey(normalized);
		if (!key) {
			return normalized;
		}

		const now = Date.now();
		this.cleanup(now);

		const entry = this.entries.get(key);
		if (!entry) {
			this.entries.set(key, {
				hits: 1,
				firstSeenAt: now,
				lastSeenAt: now,
				reminderSent: false,
			});
			this.enforceMaxEntries();
			return normalized;
		}

		entry.hits += 1;
		entry.lastSeenAt = now;
		const shouldTriggerReminder = !entry.reminderSent;
		if (shouldTriggerReminder) {
			entry.reminderSent = true;
		}
		this.entries.set(key, entry);

		if (!shouldTriggerReminder) {
			return normalized;
		}

		return {
			...normalized,
			reminder: {
				triggered: true,
				text: buildReminderText(normalized),
			},
		};
	}

	cleanup(now = Date.now()) {
		for (const [key, entry] of this.entries.entries()) {
			if ((now - entry.lastSeenAt) > this.ttlMs) {
				this.entries.delete(key);
			}
		}
	}

	enforceMaxEntries() {
		if (this.entries.size <= this.maxEntries) {
			return;
		}

		const oldest = [...this.entries.entries()]
			.sort((left, right) => left[1].lastSeenAt - right[1].lastSeenAt)
			.slice(0, this.entries.size - this.maxEntries);

		oldest.forEach(([key]) => this.entries.delete(key));
	}

	reset() {
		this.entries.clear();
	}
}

const alertReminderService = new AlertReminderService();

module.exports = {
	AlertReminderService,
	alertReminderService,
};
