'use strict';

/**
 * Same-direction burst aggregator for webhook alerts (issue #1104).
 *
 * A market-wide risk-off / risk-on event fires many symbols in the same
 * direction within a few seconds. Delivering each one individually turns one
 * regime shift into N*channels messages and buries the shared driver. This
 * service holds parsed signals for a short window, groups them by
 * `(side, routing identity)`, and either
 *
 *   - sends ONE aggregated "regime" message per channel when the group reaches
 *     `ALERT_BURST_MIN_SIGNALS` inside the window, or
 *   - releases every held alert to its own normal delivery path when the window
 *     closes below the minimum (so the only cost is the window latency).
 *
 * Invariants worth preserving:
 *
 * - **Grouping is by direction, not by exchange.** A risk-off moment spans
 *   crypto and equities at once (the 2026-08-27 production burst was 6 BATS
 *   equities plus 1 BINANCE crypto, all BUY). Exchange is *displayed* in the
 *   aggregated message rather than used as a grouping dimension, so a
 *   market-wide event collapses to one message instead of one per asset class.
 * - **Routing identity is part of the bucket key.** Alerts with different
 *   `channels`, chat overrides, thread ids or Discord webhook URLs are never
 *   merged: an aggregate could only be delivered to one destination.
 * - **`symbolRoutes` bypasses the buffer entirely.** Per-symbol channel routing
 *   cannot be expressed by one synthetic message, so those requests take the
 *   normal path instead of being merged into something they did not ask for.
 * - **Every failure mode is fail-open.** A store error, a throwing aggregate
 *   send, or an evicted window releases the held alert to its own delivery. The
 *   only thing an operator can lose to this feature is noise reduction, never
 *   an alert. Nothing may leave a held request unresolved, so every exit path
 *   settles each member exactly once.
 * - **The window is in-process.** Multi-replica deployments may partially
 *   aggregate; this matches every other in-process store in the repo.
 */

const { v4: uuidv4 } = require('uuid');
const { getRuntimeConfig } = require('../remoteConfig/RemoteConfigService');

const DEFAULT_WINDOW_MS = 3000;
const MIN_WINDOW_MS = 1000;
const MAX_WINDOW_MS = 15000;

const DEFAULT_MIN_SIGNALS = 3;
const MIN_SIGNALS_FLOOR = 2;
const MAX_SIGNALS_CEILING = 20;

/**
 * Upper bound on alerts held in a single window. A watchlist wider than this
 * would otherwise let one bucket grow without limit; hitting the cap closes the
 * window early so the burst is still aggregated, just over a longer span.
 */
const MAX_MEMBERS_PER_WINDOW = 50;

/** Maximum number of open windows retained in-process. */
const MAX_OPEN_WINDOWS = 100;

/** Symbols listed in the aggregated message before it is truncated. */
const MAX_LISTED_SYMBOLS = 25;

/**
 * Hard ceiling on the aggregated message body. Discord rejects content above
 * 2000 characters, and the message is escaped per channel afterwards, so the
 * unescaped budget is kept well below that.
 */
const MAX_AGGREGATE_TEXT_LENGTH = 900;

const MAX_SYMBOL_LENGTH = 24;
const MAX_EXCHANGE_LENGTH = 16;

const REGIME_LABELS = Object.freeze({
	BUY: 'RISK-ON',
	SELL: 'RISK-OFF',
});

function readRuntimeValue(key, fallback) {
	try {
		const value = getRuntimeConfig()[key];
		return value === undefined ? fallback : value;
	} catch (error) {
		// Runtime config must never decide whether an alert is delivered.
		console.warn(`[AlertBurstAggregator] Runtime config read failed for ${key}:`, error.message);
		return fallback;
	}
}

function resolveWindowMs() {
	const configured = readRuntimeValue('ALERT_BURST_WINDOW_MS', DEFAULT_WINDOW_MS);
	if (!Number.isFinite(configured)) {
		return DEFAULT_WINDOW_MS;
	}
	return Math.min(Math.max(Math.trunc(configured), MIN_WINDOW_MS), MAX_WINDOW_MS);
}

function resolveMinSignals() {
	const configured = readRuntimeValue('ALERT_BURST_MIN_SIGNALS', DEFAULT_MIN_SIGNALS);
	if (!Number.isFinite(configured)) {
		return DEFAULT_MIN_SIGNALS;
	}
	return Math.min(Math.max(Math.trunc(configured), MIN_SIGNALS_FLOOR), MAX_SIGNALS_CEILING);
}

function normalizeSide(side) {
	if (typeof side !== 'string') {
		return null;
	}
	const normalized = side.trim().toUpperCase();
	return normalized === 'BUY' || normalized === 'SELL' ? normalized : null;
}

/**
 * Canonical, order-independent identity of "where would this alert go".
 *
 * Two alerts may only be merged when this string matches exactly. `channels` is
 * sorted so `['telegram','discord']` and `['discord','telegram']` are the same
 * destination set, and an omitted `channels` (broadcast to every enabled
 * channel) stays distinct from an explicit list.
 */
function buildRoutingIdentity(routing = {}) {
	const channels = Array.isArray(routing.channels) && routing.channels.length > 0
		? [...new Set(routing.channels.map(String))].sort()
		: null;
	return [
		channels ? channels.join(',') : 'broadcast',
		String(routing.telegramChatId || ''),
		String(routing.telegramThreadId ?? ''),
		String(routing.whatsappChatId || ''),
		String(routing.discordWebhookUrl || ''),
	].join('|');
}

/**
 * Bucket key for a parsed signal plus its effective routing, or `null` when the
 * alert must bypass aggregation entirely.
 *
 * @param {Object} params
 * @param {Object|null} params.parsedSignal - Result of `parseTradingViewSignal`
 * @param {Object} [params.routing] - Effective (post-cooldown) notification routing
 * @returns {string|null}
 */
function buildBurstGroupKey({ parsedSignal, routing } = {}) {
	if (!parsedSignal || typeof parsedSignal !== 'object') {
		return null;
	}
	const side = normalizeSide(parsedSignal.side);
	if (!side) {
		return null;
	}
	// Per-symbol channel routing cannot be represented by one synthetic message.
	if (routing && routing.symbolRoutes) {
		return null;
	}
	// An explicitly empty channel list is malformed routing; never buffer it.
	if (routing && routing.channels !== undefined
		&& (!Array.isArray(routing.channels) || routing.channels.length === 0)) {
		return null;
	}
	return `${side}|${buildRoutingIdentity(routing || {})}`;
}

function truncateToken(value, maxLength) {
	const text = String(value == null ? '' : value).trim();
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * `BINANCE:BTCUSDT (D)` style entry, keeping the exchange when the signal
 * carried one so a cross-asset burst still reads as cross-asset.
 */
function describeSignal(parsedSignal) {
	const symbol = truncateToken(parsedSignal?.symbol, MAX_SYMBOL_LENGTH);
	if (!symbol) {
		return null;
	}
	const exchange = truncateToken(parsedSignal?.exchange, MAX_EXCHANGE_LENGTH);
	const timeframe = truncateToken(parsedSignal?.timeframe || parsedSignal?.rawTimeframe, 8);
	const qualified = exchange ? `${exchange}:${symbol}` : symbol;
	return timeframe ? `${qualified} (${timeframe})` : qualified;
}

function buildAggregateBody(entries, { header, direction, meta, omitted }) {
	const omittedLine = omitted > 0
		? `\n(+${omitted} more signal${omitted === 1 ? '' : 's'} not listed)`
		: '';
	return [
		header,
		`Direction: ${direction}`,
		'Symbols:',
		entries.join(', '),
		...(meta ? [`Window: ${meta}`] : []),
	].join('\n') + omittedLine;
}

/**
 * Build the aggregated regime message as PLAIN text.
 *
 * It is deliberately left unescaped here: every channel service runs the result
 * through its own formatter (`MarkdownV2Formatter` for Telegram), so a symbol
 * containing `_`, `-`, `.` or `(` cannot produce a parse failure. The function
 * is total — malformed input returns an empty string rather than throwing, so a
 * formatting bug can never cost an alert.
 *
 * @param {Array<Object>} signals - Parsed signals in arrival order
 * @param {Object} [options]
 * @param {string} [options.side] - Normalized side (BUY/SELL)
 * @param {number} [options.windowMs] - Configured window length
 * @param {number} [options.spanMs] - Observed arrival span
 * @returns {string}
 */
function buildBurstAggregateText(signals, { side, windowMs, spanMs } = {}) {
	if (!Array.isArray(signals) || signals.length === 0) {
		return '';
	}
	const direction = normalizeSide(side) || normalizeSide(signals[0]?.side);
	if (!direction) {
		return '';
	}

	const total = signals.length;
	const regime = REGIME_LABELS[direction] || direction;
	const header = `⚡ Regime shift: ${regime} — ${total} same-direction signals`;
	const meta = [
		Number.isFinite(windowMs) ? `${Math.round(windowMs)}ms window` : null,
		Number.isFinite(spanMs) && spanMs >= 0 ? `${Math.round(spanMs)}ms span` : null,
	].filter(Boolean).join(', ');

	const listed = [];
	for (const signal of signals) {
		const entry = describeSignal(signal);
		if (entry) {
			listed.push(entry);
		}
		if (listed.length >= MAX_LISTED_SYMBOLS) {
			break;
		}
	}

	const hiddenBeforeTrim = total - listed.length;
	const render = (entries, omitted) => buildAggregateBody(entries, {
		header,
		direction,
		meta,
		omitted,
	});

	const initial = render(listed, hiddenBeforeTrim);
	if (initial.length <= MAX_AGGREGATE_TEXT_LENGTH) {
		return initial;
	}

	// Hard budget: the symbol list is the only unbounded part, so trim it until
	// the whole message fits rather than emitting something Discord rejects.
	let kept = listed.slice(0, Math.max(1, listed.length - 1));
	while (kept.length > 1) {
		const candidate = render(kept, hiddenBeforeTrim + (listed.length - kept.length));
		if (candidate.length <= MAX_AGGREGATE_TEXT_LENGTH) {
			return candidate;
		}
		kept = kept.slice(0, kept.length - 1);
	}

	// Even one entry does not fit: degrade to counts only rather than truncating
	// a symbol into something misleading.
	return render([], hiddenBeforeTrim + listed.length);
}

function createBurstAggregator(options = {}) {
	const store = options.store instanceof Map ? options.store : new Map();
	const setTimer = typeof options.setTimeout === 'function'
		? options.setTimeout
		: (fn, ms) => setTimeout(fn, ms);
	const clearTimer = typeof options.clearTimeout === 'function'
		? options.clearTimeout
		: (handle) => clearTimeout(handle);
	const generateId = typeof options.generateId === 'function' ? options.generateId : () => uuidv4();

	const state = {
		aggregatedBurstCount: 0,
		aggregatedSignalCount: 0,
		aggregatedFailoverCount: 0,
		releasedSignalCount: 0,
		lastAggregatedAt: null,
		lastWindowClosedAt: null,
	};

	function settle(member, payload) {
		if (member.settled) {
			return;
		}
		member.settled = true;
		member.resolve(payload);
	}

	function settleWithError(member, error) {
		if (member.settled) {
			return;
		}
		member.settled = true;
		member.reject(error);
	}

	async function releaseIndividually(members) {
		for (const member of members) {
			if (member.settled) {
				continue;
			}
			try {
				const results = await member.deliver({});
				settle(member, { results, aggregated: false });
			} catch (error) {
				settleWithError(member, error);
			}
		}
	}

	async function closeWindow(bucket, { reason }) {
		if (!bucket || bucket.closing) {
			return;
		}
		bucket.closing = true;
		if (bucket.timer !== null && bucket.timer !== undefined) {
			try {
				clearTimer(bucket.timer);
			} catch (error) {
				console.warn('[AlertBurstAggregator] Failed to clear window timer:', error.message);
			}
			bucket.timer = null;
		}
		if (store.get(bucket.key) === bucket) {
			store.delete(bucket.key);
		}

		const members = bucket.members.slice();
		bucket.members.length = 0;
		state.lastWindowClosedAt = new Date().toISOString();

		if (members.length === 0) {
			return;
		}

		try {
			const minSignals = resolveMinSignals();
			if (members.length < minSignals) {
				state.releasedSignalCount += members.length;
				console.debug(
					`[AlertBurstAggregator] Window closed below minimum (${members.length}/${minSignals}, reason=${reason}); delivering individually`,
				);
				await releaseIndividually(members);
				return;
			}

			const aggregateId = generateId();
			const aggregateText = buildBurstAggregateText(
				members.map((member) => member.parsedSignal),
				{
					side: bucket.side,
					windowMs: bucket.windowMs,
					spanMs: Math.max(0, Date.now() - bucket.openedAt),
				},
			);

			let aggregateResults = null;
			try {
				aggregateResults = await members[0].deliver({
					alert: { text: aggregateText, source: 'webhook-alert-burst' },
					dropRepeatCooldown: true,
				});
			} catch (error) {
				// Fail-open: aggregation is a noise-reduction optimization. If the
				// single synthetic send throws we cannot tell whether anything was
				// delivered, so fall back to per-alert delivery rather than risk
				// losing the burst. Per-channel delivery failures come back as
				// `{ success: false }` results rather than throws, so this path is
				// reached only for validation or programming errors.
				console.warn('[AlertBurstAggregator] Aggregate delivery failed, falling back to individual delivery:', error.message);
				state.aggregatedFailoverCount += 1;
				state.releasedSignalCount += members.length;
				await releaseIndividually(members);
				return;
			}

			state.aggregatedBurstCount += 1;
			state.aggregatedSignalCount += members.length;
			state.lastAggregatedAt = new Date().toISOString();
			console.log(
				`[AlertBurstAggregator] Collapsed ${members.length} ${bucket.side} signals into one regime message (aggregateId=${aggregateId}, reason=${reason})`,
			);

			for (const member of members) {
				settle(member, {
					results: aggregateResults,
					aggregated: true,
					burstAggregateId: aggregateId,
					burstSignalCount: members.length,
				});
			}
		} catch (error) {
			// Last-resort net: an unexpected failure here must never leave a held
			// HTTP request unresolved (it would hang until the request deadline).
			console.warn('[AlertBurstAggregator] Window close failed, releasing held alerts:', error.message);
			await releaseIndividually(members);
		}
	}

	function openWindow(key, parsedSignal, windowMs) {
		const bucket = {
			key,
			side: normalizeSide(parsedSignal.side),
			windowMs,
			openedAt: Date.now(),
			members: [],
			timer: null,
			closing: false,
		};
		bucket.timer = setTimer(() => {
			Promise.resolve(closeWindow(bucket, { reason: 'window_elapsed' })).catch((error) => {
				console.warn('[AlertBurstAggregator] Window close failed:', error.message);
			});
		}, windowMs);
		if (bucket.timer && typeof bucket.timer.unref === 'function') {
			bucket.timer.unref();
		}
		store.set(key, bucket);
		evictOldestWindows();
		return bucket;
	}

	/**
	 * Bound the number of concurrently open windows. The oldest window is
	 * *closed*, never dropped: silently deleting a bucket would leave its held
	 * requests unresolved until the request deadline fired.
	 */
	function evictOldestWindows() {
		while (store.size > MAX_OPEN_WINDOWS) {
			const oldest = [...store.entries()]
				.sort(([, left], [, right]) => left.openedAt - right.openedAt)[0];
			if (!oldest) {
				return;
			}
			store.delete(oldest[0]);
			Promise.resolve(closeWindow(oldest[1], { reason: 'window_evicted' })).catch((error) => {
				console.warn('[AlertBurstAggregator] Evicted window close failed:', error.message);
			});
		}
	}

	async function dispatch({ parsedSignal, routing, deliver } = {}) {
		const immediate = async () => {
			const results = await deliver({});
			return { results, aggregated: false };
		};

		if (typeof deliver !== 'function') {
			return { results: [], aggregated: false };
		}
		if (!this.isEnabled()) {
			return immediate();
		}

		let key;
		try {
			key = buildBurstGroupKey({ parsedSignal, routing });
		} catch (error) {
			console.warn('[AlertBurstAggregator] Group key build failed, delivering individually:', error.message);
			return immediate();
		}
		if (!key) {
			return immediate();
		}

		const windowMs = resolveWindowMs();
		let bucket;
		try {
			bucket = store.get(key);
			if (!bucket || bucket.closing) {
				bucket = openWindow(key, parsedSignal, windowMs);
			}
			if (!bucket || !Array.isArray(bucket.members)) {
				throw new Error('window bucket is not usable');
			}
		} catch (error) {
			console.warn('[AlertBurstAggregator] Window store failed, delivering individually:', error.message);
			return immediate();
		}

		const member = { parsedSignal, deliver, settled: false };
		const promise = new Promise((resolve, reject) => {
			member.resolve = resolve;
			member.reject = reject;
			bucket.members.push(member);
		});

		if (bucket.members.length >= MAX_MEMBERS_PER_WINDOW) {
			Promise.resolve(closeWindow(bucket, { reason: 'member_cap' })).catch((error) => {
				console.warn('[AlertBurstAggregator] Window close failed:', error.message);
			});
		}

		return promise;
	}

	async function flushAll(reason = 'flush') {
		const buckets = [...store.values()];
		store.clear();
		for (const bucket of buckets) {
			try {
				await closeWindow(bucket, { reason });
			} catch (error) {
				console.warn('[AlertBurstAggregator] Flush failed for window:', error.message);
				await releaseIndividually(bucket.members.slice());
			}
		}
		return buckets.length;
	}

	return {
		isEnabled() {
			return readRuntimeValue('ENABLE_ALERT_SYNTH_BURST_AGGREGATION', false) === true;
		},
		dispatch,
		flushAll,
		getOpenWindowCount() {
			return store.size;
		},
		getStats() {
			return {
				openWindows: store.size,
				windowMs: resolveWindowMs(),
				minSignals: resolveMinSignals(),
				aggregatedBurstCount: state.aggregatedBurstCount,
				aggregatedSignalCount: state.aggregatedSignalCount,
				aggregatedFailoverCount: state.aggregatedFailoverCount,
				releasedSignalCount: state.releasedSignalCount,
				lastAggregatedAt: state.lastAggregatedAt,
				lastWindowClosedAt: state.lastWindowClosedAt,
			};
		},
		reset() {
			for (const bucket of store.values()) {
				if (bucket.timer !== null && bucket.timer !== undefined) {
					try {
						clearTimer(bucket.timer);
					} catch (error) {
						// Timer cleanup must never break a reset.
					}
				}
			}
			store.clear();
			state.aggregatedBurstCount = 0;
			state.aggregatedSignalCount = 0;
			state.aggregatedFailoverCount = 0;
			state.releasedSignalCount = 0;
			state.lastAggregatedAt = null;
			state.lastWindowClosedAt = null;
		},
	};
}

const singleton = createBurstAggregator();

module.exports = {
	createBurstAggregator,
	burstAggregator: singleton,
	buildBurstGroupKey,
	buildRoutingIdentity,
	buildBurstAggregateText,
	normalizeSide,
	DEFAULT_WINDOW_MS,
	MIN_WINDOW_MS,
	MAX_WINDOW_MS,
	DEFAULT_MIN_SIGNALS,
	MIN_SIGNALS_FLOOR,
	MAX_SIGNALS_CEILING,
	MAX_MEMBERS_PER_WINDOW,
	MAX_OPEN_WINDOWS,
	MAX_LISTED_SYMBOLS,
	MAX_AGGREGATE_TEXT_LENGTH,
	REGIME_LABELS,
};