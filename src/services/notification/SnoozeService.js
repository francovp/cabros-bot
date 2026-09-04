/**
 * SnoozeService - Operator-initiated global incident snooze for notification channels.
 *
 * The service short-circuits `NotificationManager.sendToAll` / `sendToChannels`
 * for the named channels while a snooze is active, returning a `SendResult`
 * with `success: false, category: 'SNOOZED', snoozedUntil: <iso>` so the
 * webhook response can surface the suppression to the TradingView caller and
 * the alert can still be persisted to Firestore.
 *
 * Default storage is in-process per replica (no Firestore dependency). Optional
 * cross-replica persistence is gated by `ENABLE_FIRESTORE_SNOOZE=true`; the
 * in-memory map remains the source of truth for delivery short-circuiting.
 *
 * The service is fail-open: errors reading/writing the in-memory map are
 * logged but never block alert delivery.
 */

const sentryService = require('../monitoring/SentryService');

const DEFAULT_CHANNELS = ['telegram', 'whatsapp', 'discord'];
const MIN_DURATION_MS = 60 * 1000; // 1 minute
const MAX_DURATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const VALID_CHANNEL_NAMES = new Set(['telegram', 'whatsapp', 'discord']);

function normalizeChannelList(channels) {
	if (channels == null) {
		return [...DEFAULT_CHANNELS];
	}
	if (!Array.isArray(channels)) {
		return null;
	}
	const filtered = channels
		.filter((c) => typeof c === 'string')
		.map((c) => c.trim().toLowerCase())
		.filter((c) => VALID_CHANNEL_NAMES.has(c));
	if (filtered.length === 0) {
		return [];
	}
	return [...new Set(filtered)];
}

function clampDurationMs(durationMs) {
	if (typeof durationMs !== 'number' || !Number.isFinite(durationMs)) {
		return null;
	}
	if (durationMs < MIN_DURATION_MS) {
		return MIN_DURATION_MS;
	}
	if (durationMs > MAX_DURATION_MS) {
		return MAX_DURATION_MS;
	}
	return Math.floor(durationMs);
}

function sanitizeReason(reason) {
	if (typeof reason !== 'string') {
		return '';
	}
	const trimmed = reason.trim();
	if (trimmed.length === 0) {
		return '';
	}
	return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
}

class SnoozeService {
	constructor({ clock = () => Date.now(), logger = console } = {}) {
		this._active = null;
		this._clock = clock;
		this._logger = logger;
		this._listeners = new Set();
	}

	/**
	 * Activate a snooze for the given duration.
	 * @param {Object} input
	 * @param {number} input.durationMs - Duration in ms; clamped to [60s, 6h].
	 * @param {string} [input.reason] - Free-text reason for audit.
	 * @param {string[]} [input.channels] - Channels to snooze; defaults to all known channels.
	 * @param {string} [input.actorIp] - Optional operator IP for audit.
	 * @returns {{ok: boolean, error?: string, snooze?: object}}
	 */
	activate({ durationMs, reason, channels, actorIp } = {}) {
		const clamped = clampDurationMs(durationMs);
		if (clamped == null) {
			return { ok: false, error: 'INVALID_DURATION' };
		}
		const channelList = normalizeChannelList(channels);
		if (channelList == null) {
			return { ok: false, error: 'INVALID_CHANNELS' };
		}
		const reasonText = sanitizeReason(reason);
		const activatedAt = this._clock();
		const expiresAt = activatedAt + clamped;
		const previous = this._active;
		this._active = {
			active: true,
			activatedAt,
			expiresAt,
			durationMs: clamped,
			reason: reasonText,
			channels: channelList,
			actorIp: typeof actorIp === 'string' ? actorIp.slice(0, 64) : null,
		};
		const logLine = `[Snooze] active until ${new Date(expiresAt).toISOString()} reason: ${reasonText || 'unspecified'}`;
		try {
			if (this._logger && typeof this._logger.info === 'function') {
				this._logger.info(logLine);
			}
		} catch (logErr) {
			// Logger failures must not break activation.
		}
		if (!previous) {
			this._notify({ type: 'activated', snooze: this._active });
		} else {
			this._notify({ type: 'reactivated', snooze: this._active });
		}
		return { ok: true, snooze: this._getSnapshot() };
	}

	/**
	 * Cancel any active snooze.
	 * @returns {{ok: boolean, snooze?: object}}
	 */
	cancel() {
		if (!this._active) {
			return { ok: true, snooze: { active: false } };
		}
		const previous = this._active;
		this._active = null;
		const logLine = `[Snooze] cancelled (was active until ${new Date(previous.expiresAt).toISOString()})`;
		try {
			if (this._logger && typeof this._logger.info === 'function') {
				this._logger.info(logLine);
			}
		} catch (logErr) {
			// ignore
		}
		this._notify({ type: 'cancelled', previous });
		return { ok: true, snooze: { active: false } };
	}

	/**
	 * Check if the given channel is currently snoozed.
	 * @param {string} channelName
	 * @returns {boolean}
	 */
	isSnoozed(channelName) {
		const snapshot = this._getSnapshot();
		if (!snapshot) {
			return false;
		}
		if (typeof channelName !== 'string') {
			return false;
		}
		return snapshot.channels.includes(channelName.trim().toLowerCase());
	}

	/**
	 * Return the active snooze snapshot, or `null` if no snooze is active.
	 * @returns {object|null}
	 */
	getActive() {
		return this._getSnapshot();
	}

	/**
	 * Get a status object suitable for /api/status and /api/capabilities.
	 * @returns {{active: boolean, expiresAt?: string, reason?: string, channels?: string[], activatedAt?: string}}
	 */
	getStatus() {
		const snapshot = this._getSnapshot();
		if (!snapshot) {
			return { active: false };
		}
		return {
			active: true,
			activatedAt: new Date(snapshot.activatedAt).toISOString(),
			expiresAt: new Date(snapshot.expiresAt).toISOString(),
			reason: snapshot.reason || null,
			channels: snapshot.channels.slice(),
		};
	}

	/**
	 * Subscribe to snooze state changes (activated, reactivated, cancelled, expired).
	 * Returns an unsubscribe function.
	 * @param {(event: object) => void} listener
	 * @returns {() => void}
	 */
	subscribe(listener) {
		if (typeof listener !== 'function') {
			return () => {};
		}
		this._listeners.add(listener);
		return () => {
			this._listeners.delete(listener);
		};
	}

	/**
	 * Reset the service (used by tests).
	 */
	resetForTesting() {
		this._active = null;
		this._listeners.clear();
	}

	_getSnapshot() {
		if (!this._active) {
			return null;
		}
		const now = this._clock();
		if (now >= this._active.expiresAt) {
			const expired = this._active;
			this._active = null;
			try {
				if (this._logger && typeof this._logger.info === 'function') {
					this._logger.info(`[Snooze] expired (was active until ${new Date(expired.expiresAt).toISOString()})`);
				}
			} catch (logErr) {
				// ignore
			}
			this._notify({ type: 'expired', previous: expired });
			return null;
		}
		return {
			activatedAt: this._active.activatedAt,
			expiresAt: this._active.expiresAt,
			durationMs: this._active.durationMs,
			reason: this._active.reason,
			channels: this._active.channels.slice(),
			actorIp: this._active.actorIp,
		};
	}

	_notify(event) {
		for (const listener of this._listeners) {
			try {
				listener(event);
			} catch (err) {
				if (this._logger && typeof this._logger.warn === 'function') {
					this._logger.warn(`[Snooze] listener error: ${err.message}`);
				}
			}
		}
	}
}

const snoozeService = new SnoozeService();

module.exports = {
	SnoozeService,
	snoozeService,
	MIN_DURATION_MS,
	MAX_DURATION_MS,
	VALID_CHANNEL_NAMES,
};
