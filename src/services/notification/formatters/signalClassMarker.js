'use strict';

const remoteConfigService = require('../../remoteConfig/RemoteConfigService');

const SIGNAL_CLASS_MARKERS = Object.freeze({
	breakout: { emoji: '🎯', label: 'breakout' },
	mean_reversion: { emoji: '🔄', label: 'mean_reversion' },
	trend_continuation: { emoji: '📈', label: 'trend_continuation' },
	reversal: { emoji: '↩️', label: 'reversal' },
	volume_spike: { emoji: '⚡', label: 'volume_spike' },
	news_event: { emoji: '📰', label: 'news_event' },
	manual: { emoji: '✍️', label: 'manual' },
});

function isSignalClassMarkerEnabled() {
	try {
		const config = remoteConfigService.getRuntimeConfig();
		if (config && config.ENABLE_SIGNAL_CLASS_MARKER !== undefined) {
			return config.ENABLE_SIGNAL_CLASS_MARKER !== false;
		}
	} catch (_) {
		// Fall through to env check
	}
	return process.env.ENABLE_SIGNAL_CLASS_MARKER !== 'false';
}

/**
 * Formats a small notification marker for an alert's signalClass.
 *
 * @param {string} signalClass - Signal class (e.g. breakout, reversal, mean_reversion)
 * @param {Object} [options]
 * @param {boolean} [options.markdownV2=false] - Whether to escape for Telegram MarkdownV2
 * @returns {string|null} Formatted marker string or null if disabled / unknown / invalid
 */
function formatSignalClassMarker(signalClass, options = {}) {
	if (!isSignalClassMarkerEnabled()) {
		return null;
	}

	if (!signalClass || typeof signalClass !== 'string') {
		return null;
	}

	const normalized = signalClass.trim().toLowerCase();
	if (normalized === 'unknown' || !SIGNAL_CLASS_MARKERS[normalized]) {
		return null;
	}

	const { emoji, label } = SIGNAL_CLASS_MARKERS[normalized];
	if (options.markdownV2) {
		// In Telegram MarkdownV2, escape underscores so they don't trigger italic formatting
		const escapedLabel = label.replace(/_/g, '\\_');
		return `${emoji} ${escapedLabel}`;
	}

	return `${emoji} ${label}`;
}

module.exports = {
	SIGNAL_CLASS_MARKERS,
	formatSignalClassMarker,
	isSignalClassMarkerEnabled,
};
