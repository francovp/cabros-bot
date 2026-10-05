/* global jest, describe, it, expect, beforeEach, afterEach */
/* global saveEnv, restoreEnv */

const {
	createBurstAggregator,
	burstAggregator,
	buildBurstGroupKey,
	buildRoutingIdentity,
	buildBurstAggregateText,
	DEFAULT_WINDOW_MS,
	MIN_WINDOW_MS,
	MAX_WINDOW_MS,
	DEFAULT_MIN_SIGNALS,
	MIN_SIGNALS_FLOOR,
	MAX_SIGNALS_CEILING,
	MAX_MEMBERS_PER_WINDOW,
	MAX_AGGREGATE_TEXT_LENGTH,
	MAX_LISTED_SYMBOLS,
} = require('../../src/services/alerts/burstAggregator');

const MarkdownV2Formatter = require('../../src/services/notification/formatters/markdownV2Formatter');
const { parseTradingViewSignal } = require('../../src/services/tradingview/parseTradingViewSignal');

function signal(symbol, { exchange = 'BINANCE', timeframe = '1D', side = 'SELL' } = {}) {
	return { symbol, exchange, timeframe, rawTimeframe: timeframe, side };
}

/** Deterministic clock so window boundaries are exercised without real waiting. */
function createFakeClock() {
	let now = 1000000;
	let nextHandle = 1;
	const timers = new Map();

	return {
		now: () => now,
		setTimeout(fn, ms) {
			const handle = nextHandle++;
			timers.set(handle, { fn, at: now + (Number.isFinite(ms) ? ms : 0) });
			return handle;
		},
		clearTimeout(handle) {
			timers.delete(handle);
		},
		advance(ms) {
			const target = now + ms;
			// Fire due timers in chronological order, allowing async work to run.
			for (;;) {
				let next = null;
				for (const [handle, timer] of timers) {
					if (timer.at <= target && (next === null || timer.at < next[1].at)) {
						next = [handle, timer];
					}
				}
				if (!next) break;
				timers.delete(next[0]);
				now = Math.max(now, next[1].at);
				next[1].fn();
			}
			now = target;
		},
		pendingCount: () => timers.size,
	};
}

function createHarness({ windowMs = 3000, minSignals = 3, store } = {}) {
	const clock = createFakeClock();
	const aggregator = createBurstAggregator({
		store,
		setTimeout: clock.setTimeout,
		clearTimeout: clock.clearTimeout,
		generateId: (() => {
			let counter = 0;
			return () => `aggregate-${++counter}`;
		})(),
	});

	const deliveries = [];
	const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

	const makeDeliver = (label) => (overrides = {}) => {
		deliveries.push({
			label,
			alert: overrides.alert || null,
			dropRepeatCooldown: overrides.dropRepeatCooldown === true,
		});
		return Promise.resolve([{ channel: label, success: true }]);
	};

	return { clock, aggregator, deliveries, makeDeliver, flushMicrotasks, windowMs, minSignals };
}

describe('burstAggregator', () => {
	let savedEnv;

	beforeEach(() => {
		// Restore the whole environment after each test: the gate and window keys
		// are process-global, and the suite runs with maxWorkers 1, so a value left
		// behind here would be observed by whichever suite loads next.
		savedEnv = saveEnv();
		delete process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION;
		delete process.env.ALERT_BURST_WINDOW_MS;
		delete process.env.ALERT_BURST_MIN_SIGNALS;
		burstAggregator.reset();
	});

	afterEach(() => {
		burstAggregator.reset();
		restoreEnv(savedEnv);
	});

	describe('feature gate', () => {
		it('is disabled by default', () => {
			expect(burstAggregator.isEnabled()).toBe(false);
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'false';
			expect(burstAggregator.isEnabled()).toBe(false);
		});

		it('is enabled only with the exact "true" value', () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			expect(burstAggregator.isEnabled()).toBe(true);
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'TRUE';
			expect(burstAggregator.isEnabled()).toBe(false);
		});
	});

	describe('buildRoutingIdentity', () => {
		it('sorts channels so ordering does not split a destination set', () => {
			expect(buildRoutingIdentity({ channels: ['telegram', 'discord'] }))
				.toBe(buildRoutingIdentity({ channels: ['discord', 'telegram'] }));
		});

		it('deduplicates repeated channels', () => {
			expect(buildRoutingIdentity({ channels: ['telegram', 'telegram'] }))
				.toBe(buildRoutingIdentity({ channels: ['telegram'] }));
		});

		it('keeps an omitted channel list distinct from an explicit one', () => {
			expect(buildRoutingIdentity({}))
				.not.toBe(buildRoutingIdentity({ channels: ['telegram'] }));
		});

		it('separates every per-channel destination override', () => {
			const base = { channels: ['telegram'] };
			expect(buildRoutingIdentity(base)).not.toBe(buildRoutingIdentity({ ...base, telegramChatId: '-1001' }));
			expect(buildRoutingIdentity({ ...base, telegramThreadId: 0 }))
				.not.toBe(buildRoutingIdentity({ ...base, telegramThreadId: 7 }));
			expect(buildRoutingIdentity({ ...base, telegramThreadId: 0 }))
				.not.toBe(buildRoutingIdentity(base));
			expect(buildRoutingIdentity({ ...base, whatsappChatId: '1203631@c.us' })).not.toBe(buildRoutingIdentity(base));
			expect(buildRoutingIdentity({ ...base, discordWebhookUrl: 'https://discord.com/x' }))
				.not.toBe(buildRoutingIdentity(base));
		});
	});

	describe('buildBurstGroupKey', () => {
		it('groups by normalized side', () => {
			expect(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { side: 'SELL' }), routing: {} }))
				.toBe('SELL|broadcast||||');
			expect(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { side: 'sell' }), routing: {} }))
				.toBe('SELL|broadcast||||');
		});

		it('bypasses a side that is not already normalized to BUY/SELL', () => {
			// `parseTradingViewSignal` normalizes VENTA/COMPRA to SELL/BUY, so an
			// un-normalized side reaching the aggregator means an unknown direction.
			// Merging it would risk putting opposite directions in one message.
			expect(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { side: 'VENTA' }), routing: {} })).toBeNull();
		});

		it('never merges opposite directions', () => {
			expect(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { side: 'BUY' }), routing: {} }))
				.not.toBe(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { side: 'SELL' }), routing: {} }));
		});

		it('does not group by exchange, so a market-wide burst collapses into one message', () => {
			const crypto = buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { exchange: 'BINANCE' }), routing: {} });
			const equity = buildBurstGroupKey({ parsedSignal: signal('TSM', { exchange: 'BATS' }), routing: {} });
			expect(crypto).toBe(equity);
		});

		it('bypasses an unparsed signal', () => {
			expect(buildBurstGroupKey({ parsedSignal: null, routing: {} })).toBeNull();
			expect(buildBurstGroupKey({ parsedSignal: { symbol: 'BTCUSDT' }, routing: {} })).toBeNull();
			expect(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT', { side: 'HOLD' }), routing: {} })).toBeNull();
		});

		it('bypasses symbolRoutes because one message cannot honour per-symbol channels', () => {
			expect(buildBurstGroupKey({
				parsedSignal: signal('BTCUSDT'),
				routing: { symbolRoutes: { BTCUSDT: { channels: ['telegram'] } } },
			})).toBeNull();
		});

		it('bypasses an explicitly empty channel list', () => {
			expect(buildBurstGroupKey({ parsedSignal: signal('BTCUSDT'), routing: { channels: [] } })).toBeNull();
		});
	});

	describe('buildBurstAggregateText', () => {
		it('renders a regime label and every symbol with its timeframe', () => {
			const text = buildBurstAggregateText([
				signal('BTCUSDT', { timeframe: '1D' }),
				signal('ETHUSDT', { timeframe: '4h' }),
				signal('BNBUSDT', { timeframe: '1D' }),
			], { side: 'SELL', windowMs: 3000, spanMs: 2300 });

			expect(text).toContain('RISK-OFF');
			expect(text).toContain('Direction: SELL');
			expect(text).toContain('3 same-direction signals');
			expect(text).toContain('BINANCE:BTCUSDT (1D)');
			expect(text).toContain('BINANCE:ETHUSDT (4h)');
			expect(text).toContain('BINANCE:BNBUSDT (1D)');
			expect(text).toContain('3000ms window');
			expect(text).toContain('2300ms span');
		});

		it('labels BUY as RISK-ON', () => {
			const text = buildBurstAggregateText([
				signal('TSM', { exchange: 'BATS', side: 'BUY' }),
				signal('ORCL', { exchange: 'BATS', side: 'BUY' }),
				signal('QCOM', { exchange: 'BATS', side: 'BUY' }),
			], { side: 'BUY' });
			expect(text).toContain('RISK-ON');
			expect(text).toContain('BATS:TSM (1D)');
		});

		it('is MarkdownV2-safe because every parsed symbol character is escaped', () => {
			// The repo's shared formatter deliberately leaves `_` and `*`
			// unescaped, so the safety of the aggregate rests on the parser's
			// symbol charset. Pin it: if that regex ever widens, the aggregate can
			// start producing a Telegram parse failure that raw alerts never had.
			const parsed = ['BRK.B (1D)', 'A-B-C (4h)', 'X.Y.Z (1D)']
				.map((text) => parseTradingViewSignal(`BINANCE:${text} VENTA`));

			expect(parsed.every(Boolean)).toBe(true);
			for (const item of parsed) {
				expect(item.symbol).toMatch(/^[A-Z0-9._-]+$/);
			}

			const aggregateText = buildBurstAggregateText(parsed, { side: 'SELL' });
			const escaped = new MarkdownV2Formatter().format(aggregateText);

			expect(escaped).toContain('A\\-B\\-C');
			expect(escaped).toContain('X\\.Y\\.Z');
			expect(escaped).toContain('\\(1D\\)');
			expect(escaped).not.toMatch(/(?<!\\)[_*]/);
		});

		it('caps the listed symbols and reports how many were omitted', () => {
			const signals = Array.from({ length: MAX_LISTED_SYMBOLS + 7 }, (_, index) =>
				signal(`SYM${index}USDT`));
			const text = buildBurstAggregateText(signals, { side: 'SELL' });

			expect(text).toContain('+7 more signals not listed');
			expect(text).not.toContain(`SYM${MAX_LISTED_SYMBOLS}USDT`);
		});

		it('never exceeds the aggregate length budget', () => {
			const signals = Array.from({ length: MAX_MEMBERS_PER_WINDOW }, (_, index) =>
				signal(`VERYLONGSYMBOLNAME${index}USDT`, { exchange: 'NASDAQ_ARCA' }));
			const text = buildBurstAggregateText(signals, { side: 'BUY', windowMs: 3000, spanMs: 2999 });
			expect(text.length).toBeLessThanOrEqual(MAX_AGGREGATE_TEXT_LENGTH);
		});

		it('returns an empty string for malformed input instead of throwing', () => {
			expect(buildBurstAggregateText(null)).toBe('');
			expect(buildBurstAggregateText([])).toBe('');
			expect(buildBurstAggregateText([signal('BTCUSDT', { side: 'HOLD' })])).toBe('');
			expect(buildBurstAggregateText('not-an-array')).toBe('');
		});
	});

	describe('defence-in-depth bounds', () => {
		it('clamps a value the runtime-config layer failed to bound', () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			jest.resetModules();
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				getRuntimeConfig: () => ({
					ENABLE_ALERT_SYNTH_BURST_AGGREGATION: true,
					ALERT_BURST_WINDOW_MS: 99999999,
					ALERT_BURST_MIN_SIGNALS: 0,
				}),
			}));
			const { createBurstAggregator: createBounded } = require('../../src/services/alerts/burstAggregator');
			const bounded = createBounded();

			expect(bounded.getStats().windowMs).toBe(MAX_WINDOW_MS);
			expect(bounded.getStats().minSignals).toBe(MIN_SIGNALS_FLOOR);

			jest.dontMock('../../src/services/remoteConfig/RemoteConfigService');
			jest.resetModules();
		});

		it('stays enabled when the runtime-config read throws', () => {
			jest.resetModules();
			jest.doMock('../../src/services/remoteConfig/RemoteConfigService', () => ({
				getRuntimeConfig: () => {
					throw new Error('config exploded');
				},
			}));
			const { createBurstAggregator: createBroken } = require('../../src/services/alerts/burstAggregator');
			const broken = createBroken();

			expect(broken.isEnabled()).toBe(false);
			expect(broken.getStats()).toMatchObject({
				windowMs: DEFAULT_WINDOW_MS,
				minSignals: DEFAULT_MIN_SIGNALS,
			});

			jest.dontMock('../../src/services/remoteConfig/RemoteConfigService');
			jest.resetModules();
		});
	});

	describe('dispatch', () => {
		it('delivers immediately when the flag is off, without buffering', async () => {
			const { aggregator, deliveries, makeDeliver } = createHarness();
			const deliver = makeDeliver('telegram');

			const outcome = await aggregator.dispatch({
				parsedSignal: signal('BTCUSDT'),
				routing: {},
				deliver,
			});

			expect(outcome.aggregated).toBe(false);
			expect(deliveries).toHaveLength(1);
			expect(deliveries[0].alert).toBeNull();
		});

		it('delivers immediately for an unparsed alert', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, deliveries, makeDeliver } = createHarness();
			const deliver = makeDeliver('telegram');

			const outcome = await aggregator.dispatch({ parsedSignal: null, routing: {}, deliver });

			expect(outcome.aggregated).toBe(false);
			expect(deliveries).toHaveLength(1);
			expect(aggregator.getOpenWindowCount()).toBe(0);
		});

		it('holds signals until the window closes, then sends one aggregate message', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver, flushMicrotasks } = createHarness();

			const outcomes = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(symbol) }));

			// Nothing is dispatched while the window is open.
			await flushMicrotasks();
			expect(deliveries).toHaveLength(0);
			expect(aggregator.getOpenWindowCount()).toBe(1);

			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);

			expect(deliveries).toHaveLength(1);
			expect(deliveries[0].alert.source).toBe('webhook-alert-burst');
			expect(deliveries[0].alert.text).toContain('RISK-OFF');
			expect(deliveries[0].alert.text).toContain('BTCUSDT');
			expect(deliveries[0].alert.text).toContain('ETHUSDT');
			expect(deliveries[0].alert.text).toContain('BNBUSDT');
			expect(deliveries[0].dropRepeatCooldown).toBe(true);

			for (const outcome of resolved) {
				expect(outcome.aggregated).toBe(true);
				expect(outcome.burstAggregateId).toBe('aggregate-1');
				expect(outcome.burstSignalCount).toBe(3);
				expect(outcome.results).toHaveLength(1);
			}
		});

		it('never merges mixed directions and evaluates each side independently', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver } = createHarness();

			const sells = ['BTCUSDT', 'ETHUSDT'].map((symbol) => aggregator.dispatch({
				parsedSignal: signal(symbol, { side: 'SELL' }), routing: {}, deliver: makeDeliver(`sell-${symbol}`),
			}));
			const buys = ['TSM', 'ORCL', 'QCOM'].map((symbol) => aggregator.dispatch({
				parsedSignal: signal(symbol, { exchange: 'BATS', side: 'BUY' }), routing: {}, deliver: makeDeliver(`buy-${symbol}`),
			}));

			expect(aggregator.getOpenWindowCount()).toBe(2);
			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = [...await Promise.all(sells), ...await Promise.all(buys)];

			// Two separate windows: the 2 SELLs fall below the minimum, the 3 BUYs aggregate.
			const aggregated = resolved.filter((outcome) => outcome.aggregated);
			const individual = resolved.filter((outcome) => !outcome.aggregated);
			expect(aggregated).toHaveLength(3);
			expect(individual).toHaveLength(2);
			expect(new Set(aggregated.map((outcome) => outcome.burstAggregateId)).size).toBe(1);

			// 2 individual SELL deliveries + 1 aggregate BUY message.
			expect(deliveries).toHaveLength(3);
			const aggregateMessages = deliveries.filter((entry) => entry.alert !== null);
			expect(aggregateMessages).toHaveLength(1);
			expect(aggregateMessages[0].alert.text).toContain('RISK-ON');
		});

		it('releases every held alert individually when the burst is below the minimum', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver } = createHarness();

			const outcomes = ['BTCUSDT', 'ETHUSDT'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(symbol) }));

			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);

			expect(deliveries).toHaveLength(2);
			expect(deliveries.every((entry) => entry.alert === null)).toBe(true);
			expect(resolved.every((outcome) => outcome.aggregated === false)).toBe(true);
		});

		it('honours ALERT_BURST_MIN_SIGNALS', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			process.env.ALERT_BURST_MIN_SIGNALS = '4';
			const { aggregator, clock, deliveries, makeDeliver } = createHarness();

			const outcomes = ['A', 'B', 'C'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(symbol) }));
			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);

			expect(deliveries).toHaveLength(3);
			expect(resolved.every((outcome) => outcome.aggregated === false)).toBe(true);
		});

		it('honours a valid ALERT_BURST_WINDOW_MS', () => {
			process.env.ALERT_BURST_WINDOW_MS = '1000';
			expect(burstAggregator.getStats().windowMs).toBe(1000);
			process.env.ALERT_BURST_WINDOW_MS = '15000';
			expect(burstAggregator.getStats().windowMs).toBe(MAX_WINDOW_MS);
		});

		it('falls back to the default window for out-of-range or malformed values', () => {
			process.env.ALERT_BURST_WINDOW_MS = '5';
			expect(burstAggregator.getStats().windowMs).toBe(DEFAULT_WINDOW_MS);
			process.env.ALERT_BURST_WINDOW_MS = '999999';
			expect(burstAggregator.getStats().windowMs).toBe(DEFAULT_WINDOW_MS);
			process.env.ALERT_BURST_WINDOW_MS = 'not-a-number';
			expect(burstAggregator.getStats().windowMs).toBe(DEFAULT_WINDOW_MS);
		});

		it('falls back to the default minimum for out-of-range or malformed values', () => {
			expect(burstAggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
			process.env.ALERT_BURST_MIN_SIGNALS = '2';
			expect(burstAggregator.getStats().minSignals).toBe(MIN_SIGNALS_FLOOR);
			process.env.ALERT_BURST_MIN_SIGNALS = '1';
			expect(burstAggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
			process.env.ALERT_BURST_MIN_SIGNALS = '999';
			expect(burstAggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
			process.env.ALERT_BURST_MIN_SIGNALS = 'oops';
			expect(burstAggregator.getStats().minSignals).toBe(DEFAULT_MIN_SIGNALS);
		});

		it('never merges alerts with different channel or chat routing', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver } = createHarness();

			const routing = [
				{ channels: ['telegram'] },
				{ channels: ['telegram', 'discord'] },
				{ channels: ['telegram'], telegramChatId: '-1001234' },
				{ channels: ['telegram'], telegramThreadId: 5 },
				{ channels: ['telegram'], telegramThreadId: 0 },
				{ channels: ['whatsapp'], whatsappChatId: '1203631@c.us' },
				{},
			];
			const outcomes = routing.map((entry, index) =>
				aggregator.dispatch({ parsedSignal: signal(`SYM${index}`), routing: entry, deliver: makeDeliver(`d${index}`) }));

			expect(aggregator.getOpenWindowCount()).toBe(routing.length);
			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);

			// Every window holds exactly one alert, so every one falls below the minimum.
			expect(resolved.every((outcome) => outcome.aggregated === false)).toBe(true);
			expect(deliveries).toHaveLength(routing.length);
			expect(deliveries.every((entry) => entry.alert === null)).toBe(true);
		});

		it('merges alerts whose routing only differs by channel ordering', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver } = createHarness();

			const outcomes = [
				aggregator.dispatch({
					parsedSignal: signal('BTCUSDT'), routing: { channels: ['telegram', 'discord'] }, deliver: makeDeliver('a'),
				}),
				aggregator.dispatch({
					parsedSignal: signal('ETHUSDT'), routing: { channels: ['discord', 'telegram'] }, deliver: makeDeliver('b'),
				}),
				aggregator.dispatch({
					parsedSignal: signal('BNBUSDT'), routing: { channels: ['telegram', 'discord'] }, deliver: makeDeliver('c'),
				}),
			];

			expect(aggregator.getOpenWindowCount()).toBe(1);
			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);

			expect(deliveries).toHaveLength(1);
			expect(resolved.every((outcome) => outcome.aggregated === true)).toBe(true);
		});

		it('closes the window early once the member cap is reached', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver, flushMicrotasks } = createHarness();

			const outcomes = Array.from({ length: MAX_MEMBERS_PER_WINDOW }, (_, index) =>
				aggregator.dispatch({ parsedSignal: signal(`SYM${index}`), routing: {}, deliver: makeDeliver(`d${index}`) }));

			await flushMicrotasks();
			expect(aggregator.getOpenWindowCount()).toBe(0);
			expect(deliveries).toHaveLength(1);

			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);
			expect(resolved.every((outcome) => outcome.aggregated === true)).toBe(true);
		});

		it('starts a fresh window after the previous one closed', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, deliveries, makeDeliver } = createHarness();

			const first = ['A', 'B', 'C'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(`first-${symbol}`) }));
			clock.advance(DEFAULT_WINDOW_MS);
			const resolvedFirst = await Promise.all(first);
			expect(aggregator.getOpenWindowCount()).toBe(0);

			const second = ['D', 'E', 'F'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(`second-${symbol}`) }));
			clock.advance(DEFAULT_WINDOW_MS);
			const resolvedSecond = await Promise.all(second);

			expect(deliveries).toHaveLength(2);
			const aggregateIds = new Set([
				...resolvedFirst.map((outcome) => outcome.burstAggregateId),
				...resolvedSecond.map((outcome) => outcome.burstAggregateId),
			]);
			expect(aggregateIds.size).toBe(2);
			expect(aggregator.getStats().aggregatedBurstCount).toBe(2);
			expect(aggregator.getStats().aggregatedSignalCount).toBe(6);
		});
	});

	describe('fail-open behaviour', () => {
		it('delivers individually when the window store throws on get', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			class ThrowingStore extends Map {
				get() {
					throw new Error('store read exploded');
				}

				set() {
					throw new Error('store write exploded');
				}
			}
			const brokenStore = new ThrowingStore();
			const aggregator = createBurstAggregator({ store: brokenStore });

			const outcome = await aggregator.dispatch({
				parsedSignal: signal('BTCUSDT'),
				routing: {},
				deliver: () => Promise.resolve([{ channel: 'telegram', success: true }]),
			});

			expect(outcome.aggregated).toBe(false);
			expect(outcome.results).toEqual([{ channel: 'telegram', success: true }]);
		});

		it('falls back to individual delivery when the aggregate send throws', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, makeDeliver } = createHarness();
			const seen = [];

			const outcomes = ['A', 'B', 'C'].map((symbol) => aggregator.dispatch({
				parsedSignal: signal(symbol),
				routing: {},
				deliver: (overrides = {}) => {
					seen.push(overrides.alert === undefined ? symbol : 'aggregate');
					if (overrides.alert !== undefined) {
						return Promise.reject(new Error('aggregate send exploded'));
					}
					return Promise.resolve([{ channel: 'telegram', success: true, symbol }]);
				},
			}));

			clock.advance(DEFAULT_WINDOW_MS);
			const resolved = await Promise.all(outcomes);

			expect(seen.filter((entry) => entry === 'aggregate')).toHaveLength(1);
			expect(seen.filter((entry) => entry !== 'aggregate')).toHaveLength(3);
			expect(resolved.every((outcome) => outcome.aggregated === false)).toBe(true);
			expect(aggregator.getStats().aggregatedFailoverCount).toBe(1);
		});

		it('rejects only the affected member when an individual release throws', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock } = createHarness();

			const failing = aggregator.dispatch({
				parsedSignal: signal('A'),
				routing: {},
				deliver: () => Promise.reject(new Error('telegram exploded')),
			});
			const ok = aggregator.dispatch({
				parsedSignal: signal('B'),
				routing: {},
				deliver: () => Promise.resolve([{ channel: 'telegram', success: true }]),
			});

			clock.advance(DEFAULT_WINDOW_MS);
			await expect(failing).rejects.toThrow('telegram exploded');
			await expect(ok).resolves.toMatchObject({ aggregated: false });
		});

		it('returns an empty result set without a deliver function', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			await expect(burstAggregator.dispatch({ parsedSignal: signal('A'), routing: {} }))
				.resolves.toEqual({ results: [], aggregated: false });
		});
	});

	describe('flushAll (shutdown)', () => {
		it('closes every open window and aggregates what is already held', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, deliveries, makeDeliver, flushMicrotasks } = createHarness();

			const outcomes = ['A', 'B', 'C'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(symbol) }));
			await flushMicrotasks();
			expect(aggregator.getOpenWindowCount()).toBe(1);

			const flushed = await aggregator.flushAll('shutdown');
			const resolved = await Promise.all(outcomes);

			expect(flushed).toBe(1);
			expect(aggregator.getOpenWindowCount()).toBe(0);
			expect(deliveries).toHaveLength(1);
			expect(resolved.every((outcome) => outcome.aggregated === true)).toBe(true);
		});

		it('releases below-minimum windows individually on shutdown', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, deliveries, makeDeliver } = createHarness();

			const outcomes = ['A', 'B'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(symbol) }));

			await aggregator.flushAll('shutdown');
			const resolved = await Promise.all(outcomes);

			expect(deliveries).toHaveLength(2);
			expect(resolved.every((outcome) => outcome.aggregated === false)).toBe(true);
		});

		it('is a no-op when no window is open', async () => {
			await expect(burstAggregator.flushAll('shutdown')).resolves.toBe(0);
		});
	});

	describe('getStats', () => {
		it('reports bounded, non-secret counters', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, makeDeliver, flushMicrotasks } = createHarness();
			const pending = aggregator.dispatch({ parsedSignal: signal('A'), routing: {}, deliver: makeDeliver('a') });
			await flushMicrotasks();

			const stats = aggregator.getStats();
			expect(stats).toMatchObject({
				openWindows: 1,
				aggregatedBurstCount: 0,
				aggregatedSignalCount: 0,
				lastAggregatedAt: null,
			});
			expect(stats.lastWindowClosedAt).toBeNull();

			clock.advance(DEFAULT_WINDOW_MS);
			await pending;
			expect(aggregator.getStats().lastWindowClosedAt).not.toBeNull();
		});

		it('counts released signals for windows below the minimum', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, clock, makeDeliver } = createHarness();
			const outcomes = ['A', 'B'].map((symbol) =>
				aggregator.dispatch({ parsedSignal: signal(symbol), routing: {}, deliver: makeDeliver(symbol) }));
			clock.advance(DEFAULT_WINDOW_MS);
			await Promise.all(outcomes);

			expect(aggregator.getStats().releasedSignalCount).toBe(2);
		});

		it('resets counters and windows', async () => {
			process.env.ENABLE_ALERT_SYNTH_BURST_AGGREGATION = 'true';
			const { aggregator, makeDeliver, flushMicrotasks } = createHarness();
			aggregator.dispatch({ parsedSignal: signal('A'), routing: {}, deliver: makeDeliver('a') });
			await flushMicrotasks();
			aggregator.reset();

			expect(aggregator.getOpenWindowCount()).toBe(0);
			expect(aggregator.getStats()).toMatchObject({
				aggregatedBurstCount: 0,
				aggregatedSignalCount: 0,
				releasedSignalCount: 0,
				lastAggregatedAt: null,
				lastWindowClosedAt: null,
			});
		});
	});
});