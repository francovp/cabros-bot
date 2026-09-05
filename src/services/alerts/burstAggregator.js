'use strict';

/**
 * Burst aggregator for webhook alerts.
 *
 * Buffers parsed TradingView signals during a short rolling window and,
 * once the configured minimum of same-direction signals has accumulated
 * with identical effective routing, emits a single aggregated message
 * instead of N individual channel deliveries. Every participating alert
 * is still persisted individually with a `burstAggregateId` marker so
 * outcome analytics keep per-symbol granularity.
 */

const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');
const {
	parseTradingViewSignal,
	TIMEFRAME_MAP,
} = require('../tradingview/parseTradingViewSignal');

const DEFAULT_WINDOW_MS = 3000;
const MIN_WINDOW_MS = 1000;
const MAX_WINDOW_MS = 15000;
const DEFAULT_MIN_SIGNALS = 3;
const MIN_MIN_SIGNALS = 2;
const MAX_MIN_SIGNALS = 20;
const MAX_ACTIVE_WINDOWS = 100;
const MAX_SIGNALS_PER_WINDOW = 50;
const DEFAULT_MAX_AGE_MS = 60 * 1000;

function resolveWindowMs() {
	const configured = getRuntimeConfig().ALERT_BURST_WINDOW_MS;
	if (!Number.isFinite(configured)) {
		return DEFAULT_WINDOW_MS;
	}
	return Math.min(Math.max(configured, MIN_WINDOW_MS), MAX_WINDOW_MS);
}

function resolveMinSignals() {
	const configured = getRuntimeConfig().ALERT_BURST_MIN_SIGNALS;
	if (!Number.isFinite(configured)) {
		return DEFAULT_MIN_SIGNALS;
	}
	return Math.min(Math.max(configured, MIN_MIN_SIGNALS), MAX_MIN_SIGNALS);
}

function resolveEnabled() {
	return getRuntimeConfig().ENABLE_ALERT_SYNTH_BURST_AGGREGATION === true;
}

function hashRouting(routing) {
	const channels = Array.isArray(routing && routing.channels)
		? [...new Set(routing.channels.map(String))].sort()
		: [];
	const payload = {
		channels,
		telegramChatId: routing && typeof routing.telegramChatId === 'string' ? routing.telegramChatId : null,
		telegramThreadId: routing && (typeof routing.telegramThreadId === 'number' || typeof routing.telegramThreadId === 'string')
			? routing.telegramThreadId
			: null,
		whatsappChatId: routing && typeof routing.whatsappChatId === 'string' ? routing.whatsappChatId : null,
		discordWebhookUrl: routing && typeof routing.discordWebhookUrl === 'string' ? routing.discordWebhookUrl : null,
	};
	return JSON.stringify(payload);
}

function parseSignalSafely(text) {
	try {
		return parseTradingViewSignal(text);
	} catch (_) {
		return null;
	}
}

function hasUsableTimeframe(parsed) {
	if (!parsed || typeof parsed !== 'object')		return false;
	if (!parsed.rawTimeframe)		return false;
	return Object.prototype.hasOwnProperty.call(TIMEFRAME_MAP, parsed.rawTimeframe)
		&& TIMEFRAME_MAP[parsed.rawTimeframe] === parsed.timeframe;
}

function generateAggregateId() {
	try {
		return `burst_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
	} catch (_) {
		return `burst_${Date.now()}`;
	}
}

function createBurstAggregator(options = {}) {
	const timerFactory = typeof options.schedule === 'function' ? options.schedule : setTimeout;
	const cancelTimer = typeof options.cancel === 'function' ? options.cancel : clearTimeout;
	const nowFn = typeof options.now === 'function' ? options.now : Date.now;

	const windows = new Map();
	const state = {
		windows,
		aggregatedCount: 0,
		flushedCount: 0,
		failedOpenCount: 0,
		lastAggregatedAt: null,
		lastFlushedAt: null,
	};

	function evictWindow(key) {
		try {
			const existing = windows.get(key);
			if (existing && existing.timerHandle !== null && existing.timerHandle !== undefined) {
				try { cancelTimer(existing.timerHandle); } catch (_) {}
			}
			windows.delete(key);
		} catch (_) {}
	}

	function evictStaleWindows(nowMs) {
		try {
			for (const [key, window] of windows.entries()) {
				if (!window || !Number.isFinite(window.openedAt)) {
					windows.delete(key);
					continue;
				}
				if (nowMs - window.openedAt >= DEFAULT_MAX_AGE_MS) {
					if (window.timerHandle !== null && window.timerHandle !== undefined) {
						try { cancelTimer(window.timerHandle); } catch (_) {}
					}
					windows.delete(key);
				}
			}
		} catch (_) {}
		if (windows.size <= MAX_ACTIVE_WINDOWS) return;
		const oldest = Array.from(windows.entries())
			.sort(([, left], [, right]) => (left && left.openedAt || 0) - (right && right.openedAt || 0));
		for (const [key] of oldest) {
			if (windows.size <= MAX_ACTIVE_WINDOWS) break;
			windows.delete(key);
		}
	}

	function buildAggregatePayload(window) {
		if (!window || !Array.isArray(window.signals) || window.signals.length === 0) {
			return null;
		}
		const side = window.side;
		const directionLabel = side === 'BUY' ? 'COMPRA' : side === 'SELL' ? 'VENTA' : side;
		const symbols = window.signals.map((signal) => {
			const tf = signal && signal.parsed && signal.parsed.timeframe
				? signal.parsed.timeframe
				: (signal && signal.parsed && signal.parsed.rawTimeframe) || '?';
			const ex = signal && signal.parsed && signal.parsed.exchange
				? `${signal.parsed.exchange}:`
				: '';
			const symbol = signal && signal.parsed && signal.parsed.symbol
				? signal.parsed.symbol
				: '?';
			return `${ex}${symbol} (${tf})`;
		});
		const head = `\u26A1 Regime: ${directionLabel} \u2014 ${window.signals.length} sen\u0301ales`;
		const body = symbols.join(', ');
		return {
			text: `${head}\n${body}`,
			side,
			signalCount: window.signals.length,
			aggregateId: window.aggregateId,
			constituentAlertIds: window.signals.map((signal) => signal.alertId).filter(Boolean),
			constituentSymbols: window.signals.map((signal) => ({
				exchange: signal.parsed && signal.parsed.exchange || null,
				symbol: signal.parsed && signal.parsed.symbol || null,
				timeframe: signal.parsed && signal.parsed.timeframe || null,
				rawTimeframe: signal.parsed && signal.parsed.rawTimeframe || null,
				alertId: signal.alertId,
			})),
		};
	}

	function deliverIndividually(window) {
		if (!window || !Array.isArray(window.signals)) return;
		for (const signal of window.signals) {
			if (typeof signal.onFlush === 'function') {
				try { signal.onFlush({ aggregated: false }); }
				catch (error) { console.warn('[BurstAggregator] onFlush callback threw:', error && error.message); }
			}
		}
	}

	function flushWindow(windowKey) {
		let window;
		try { window = windows.get(windowKey); } catch (_) { window = null; }
		if (!window) return null;
		evictWindow(windowKey);
		state.lastFlushedAt = new Date(nowFn()).toISOString();
		try {
			const payload = buildAggregatePayload(window);
			const minSignals = resolveMinSignals();
			if (payload && window.signals.length >= minSignals && window.onComplete) {
				state.aggregatedCount += 1;
				state.lastAggregatedAt = state.lastAggregatedAt || state.lastFlushedAt;
				try {
					window.onComplete(null, payload, {
						aggregateId: window.aggregateId,
						individualDeliveries: window.signals.map((signal) => ({
							alertId: signal.alertId,
							burstAggregateId: window.aggregateId,
						})),
					});
				} catch (callbackError) {
					console.warn('[BurstAggregator] onComplete callback threw, falling back to individual delivery:', callbackError && callbackError.message);
					deliverIndividually(window);
				}
				return payload;
			}
			state.flushedCount += 1;
			deliverIndividually(window);
			return null;
		} catch (error) {
			console.warn('[BurstAggregator] flush failed, falling back to individual delivery:', error && error.message);
			state.failedOpenCount += 1;
			deliverIndividually(window);
			return null;
		}
	}

	function scheduleWindowClose(windowKey, windowMs) {
		try {
			const timerHandle = timerFactory(() => { flushWindow(windowKey); }, windowMs);
			const existing = windows.get(windowKey);
			if (existing) existing.timerHandle = timerHandle;
			return timerHandle;
		} catch (error) {
			console.warn('[BurstAggregator] timer scheduling failed, flushing immediately:', error && error.message);
			flushWindow(windowKey);
			return null;
		}
	}

	function accept({ text, requestId, routing, onFlush, onComplete }) {
		if (!resolveEnabled()) return { aggregated: false, accepted: false, reason: 'disabled' };
		if (typeof text !== 'string' || text.length === 0) {
			return { aggregated: false, accepted: false, reason: 'invalid_text' };
		}

		const parsed = parseSignalSafely(text);
		if (!parsed || !hasUsableTimeframe(parsed)) {
			return { aggregated: false, accepted: false, reason: 'unparsed' };
		}
		const side = parsed.side;
		if (side !== 'BUY' && side !== 'SELL') {
			return { aggregated: false, accepted: false, reason: 'unparsed' };
		}

		const routingHash = hashRouting(routing || {});
		const windowKey = `${side}|${routingHash}`;
		const nowMs = nowFn();
		evictStaleWindows(nowMs);

		const alertId = typeof requestId === 'string' && requestId.length > 0
			? requestId
			: `alert_${nowMs}_${Math.random().toString(36).slice(2, 8)}`;

		let window = null;
		try { window = windows.get(windowKey); } catch (_) { window = null; }

		const windowMs = resolveWindowMs();
		const minSignals = resolveMinSignals();

		if (!window) {
			window = {
				side,
				routingHash,
				routing: routing || {},
				openedAt: nowMs,
				closeAt: nowMs + windowMs,
				signals: [],
				aggregateId: generateAggregateId(),
				timerHandle: null,
				onComplete: typeof onComplete === 'function' ? onComplete : null,
			};
			try { windows.set(windowKey, window); }
			catch (error) {
				state.failedOpenCount += 1;
				console.warn('[BurstAggregator] window registration failed, falling back to individual delivery:', error && error.message);
				if (typeof onFlush === 'function') {
					try { onFlush({ aggregated: false, failOpen: true }); } catch (_) {}
				}
				return { aggregated: false, accepted: false, reason: 'store_error', failOpen: true };
			}
			const scheduled = scheduleWindowClose(windowKey, windowMs);
			if (scheduled === null) {
				// Scheduling failed → discard the window so we never strand
				// buffered alerts without a close timer.
				evictWindow(windowKey);
				state.failedOpenCount += 1;
				if (typeof onFlush === 'function') {
					try { onFlush({ aggregated: false, failOpen: true }); } catch (_) {}
				}
				return { aggregated: false, accepted: false, reason: 'store_error', failOpen: true };
			}
		}

		if (Array.isArray(window.signals) && window.signals.length >= MAX_SIGNALS_PER_WINDOW) {
			if (typeof onFlush === 'function') {
				try { onFlush({ aggregated: false, reason: 'window_full' }); } catch (_) {}
			}
			return { aggregated: false, accepted: true, reason: 'window_full' };
		}

		const signalEntry = {
			alertId,
			parsed,
			text,
			receivedAt: nowMs,
			onFlush: typeof onFlush === 'function' ? onFlush : null,
		};

		try { window.signals.push(signalEntry); }
		catch (error) {
			state.failedOpenCount += 1;
			console.warn('[BurstAggregator] signal buffer append failed:', error && error.message);
			if (typeof onFlush === 'function') {
				try { onFlush({ aggregated: false, failOpen: true }); } catch (_) {}
			}
			return { aggregated: false, accepted: false, reason: 'store_error', failOpen: true };
		}

		return {
			aggregated: false,
			accepted: true,
			pending: true,
			side,
			aggregateId: window.aggregateId,
			windowKey,
			minSignals,
			windowMs,
			signalCount: window.signals.length,
			reason: 'buffered',
		};
	}

	function flushAll() {
		let flushed = 0;
		try {
			const keys = Array.from(windows.keys());
			for (const key of keys) {
				const result = flushWindow(key);
				if (result) flushed += 1;
			}
		} catch (error) { console.warn('[BurstAggregator] flushAll failed:', error && error.message); }
		return { flushedWindows: flushed };
	}

	function getStats() {
		let activeWindows = 0;
		try {
			for (const window of windows.values()) {
				if (window && Array.isArray(window.signals) && window.signals.length > 0) activeWindows += 1;
			}
		} catch (_) { activeWindows = 0; }
		return {
			enabled: resolveEnabled(),
			windowMs: resolveWindowMs(),
			minSignals: resolveMinSignals(),
			activeWindows,
			aggregatedCount: state.aggregatedCount,
			flushedCount: state.flushedCount,
			failedOpenCount: state.failedOpenCount,
			lastAggregatedAt: state.lastAggregatedAt,
			lastFlushedAt: state.lastFlushedAt,
		};
	}

	function reset() {
		try {
			for (const [, window] of windows) {
				if (window && window.timerHandle !== null && window.timerHandle !== undefined) {
					try { cancelTimer(window.timerHandle); } catch (_) {}
				}
			}
		} catch (_) {}
		windows.clear();
		state.aggregatedCount = 0;
		state.flushedCount = 0;
		state.failedOpenCount = 0;
		state.lastAggregatedAt = null;
		state.lastFlushedAt = null;
	}

	return {
		isEnabled: resolveEnabled,
		accept,
		flushAll,
		getStats,
		reset,
		hasUsableTimeframe,
		hashRouting,
	};
}

const singleton = createBurstAggregator();

module.exports = {
	createBurstAggregator,
	burstAggregator: singleton,
	hashRouting,
	DEFAULT_WINDOW_MS,
	MIN_WINDOW_MS,
	MAX_WINDOW_MS,
	DEFAULT_MIN_SIGNALS,
	MIN_MIN_SIGNALS,
	MAX_MIN_SIGNALS,
	MAX_ACTIVE_WINDOWS,
	MAX_SIGNALS_PER_WINDOW,
};
