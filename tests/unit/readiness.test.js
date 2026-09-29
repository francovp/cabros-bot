'use strict';

const {
	createReadinessService,
	resolveTimeoutMs,
	clampTimeoutMs,
	DEFAULT_PROBE_TIMEOUT_MS,
	MIN_PROBE_TIMEOUT_MS,
	MAX_PROBE_TIMEOUT_MS,
	timed,
	skippedResult,
} = require('../../src/lib/readiness');

function setEnv(map) {
	const previous = {};
	for (const [key, value] of Object.entries(map)) {
		previous[key] = process.env[key];
		if (value === undefined || value === null) {
			delete process.env[key];
		} else {
			process.env[key] = String(value);
		}
	}
	return () => {
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	};
}

describe('readiness utilities', () => {
	it('clamps out-of-range timeout values to the documented bounds', () => {
		expect(clampTimeoutMs('0')).toBe(DEFAULT_PROBE_TIMEOUT_MS);
		expect(clampTimeoutMs('-50')).toBe(DEFAULT_PROBE_TIMEOUT_MS);
		expect(clampTimeoutMs('garbage')).toBe(DEFAULT_PROBE_TIMEOUT_MS);
		expect(clampTimeoutMs('500')).toBe(MIN_PROBE_TIMEOUT_MS);
		expect(clampTimeoutMs('60000')).toBe(MAX_PROBE_TIMEOUT_MS);
		expect(clampTimeoutMs('2500')).toBe(2500);
	});

	it('resolveTimeoutMs falls back when the input is empty', () => {
		expect(resolveTimeoutMs(undefined)).toBe(DEFAULT_PROBE_TIMEOUT_MS);
		expect(resolveTimeoutMs('')).toBe(DEFAULT_PROBE_TIMEOUT_MS);
		expect(resolveTimeoutMs('2500', 2000)).toBe(2500);
	});

	it('skippedResult marks the dep as disabled', () => {
		expect(skippedResult('gemini_disabled')).toEqual({
			ready: false,
			enabled: false,
			skipped: true,
			reason: 'gemini_disabled',
		});
	});

	it('timed resolves with the success payload when the call returns before the deadline', async () => {
		const result = await timed(async () => ({ backend: 'unit' }), 500);
		expect(result.ready).toBe(true);
		expect(result.backend).toBe('unit');
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
	});

	it('timed falls back to a timeout error when the call exceeds the deadline', async () => {
		const result = await timed(() => new Promise(() => { /* never */ }), 100);
		expect(result.ready).toBe(false);
		expect(result.error).toMatch(/timeout_after_/);
	});

	it('timed captures thrown errors as failure metadata', async () => {
		const result = await timed(async () => {
			throw new Error('boom');
		}, 200);
		expect(result.ready).toBe(false);
		expect(result.error).toBe('boom');
	});
});

describe('createReadinessService', () => {
	it('returns ready:false and no per-dep data when every feature flag is off', async () => {
		const restore = setEnv({
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'false',
			ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: 'false',
			ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT: 'false',
			ENABLE_MARKET_SCANNER: 'false',
			ENABLE_BINANCE_TRADING: 'false',
			ENABLE_BINANCE_PRICE_CHECK: 'false',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
			ENABLE_TELEGRAM_BOT: 'false',
		});

		try {
			const service = createReadinessService({ timeoutMs: 1500 });
			const report = await service.collectReadiness();
			expect(report.ready).toBe(false);
			expect(report.dependencies.firestore.skipped).toBe(true);
			expect(report.dependencies.gemini.skipped).toBe(true);
			expect(report.dependencies.tradingViewMcp.skipped).toBe(true);
			expect(report.dependencies.binance.skipped).toBe(true);
			expect(report.dependencies.telegram.skipped).toBe(true);
		} finally {
			restore();
		}
	});

	it('reports firestore as ready when listCollections succeeds', async () => {
		const restore = setEnv({
			ENABLE_FIRESTORE_ALERT_STORAGE: 'true',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
		});

		try {
			const fakeClient = { listCollections: jest.fn(async () => [{ id: 'alerts' }]) };
			const service = createReadinessService({
				timeoutMs: 1500,
				isFirestoreConfigured: () => true,
				getFirestoreClient: () => fakeClient,
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.firestore.ready).toBe(true);
			expect(report.dependencies.firestore.backend).toBe('firestore');
			expect(fakeClient.listCollections).toHaveBeenCalledTimes(1);
		} finally {
			restore();
		}
	});

	it('reports firestore failure when listCollections throws', async () => {
		const restore = setEnv({ ENABLE_FIRESTORE_ALERT_STORAGE: 'true' });
		try {
			const fakeClient = { listCollections: jest.fn(async () => { throw new Error('firestore_offline'); }) };
			const service = createReadinessService({
				timeoutMs: 1500,
				isFirestoreConfigured: () => true,
				getFirestoreClient: () => fakeClient,
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.firestore.ready).toBe(false);
			expect(report.dependencies.firestore.error).toMatch(/firestore_offline/);
		} finally {
			restore();
		}
	});

	it('marks firestore as failed when configured but no client is returned', async () => {
		const restore = setEnv({ ENABLE_FIRESTORE_ALERT_STORAGE: 'true' });
		try {
			const service = createReadinessService({
				timeoutMs: 1500,
				isFirestoreConfigured: () => true,
				getFirestoreClient: () => null,
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.firestore.ready).toBe(false);
			expect(report.dependencies.firestore.error).toBe('firestore_uninitialized');
		} finally {
			restore();
		}
	});

	it('returns ready:false when a considered dependency reports failure', async () => {
		const restore = setEnv({
			ENABLE_BINANCE_TRADING: 'true',
			ENABLE_BINANCE_PRICE_CHECK: 'false',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
		});
		try {
			const originalFetch = global.fetch;
			global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
			const service = createReadinessService({ timeoutMs: 1500 });
			const report = await service.collectReadiness();
			expect(report.dependencies.binance.ready).toBe(false);
			expect(report.dependencies.binance.error).toMatch(/binance_http_500/);
			expect(report.ready).toBe(false);
			global.fetch = originalFetch;
		} finally {
			restore();
		}
	});

	it('reports telegram as not-initialized (skipped) when the bot instance is missing', async () => {
		// The bot is constructed after the probe can first run, so an absent
		// instance is a startup state, not a dependency failure. Reporting it as
		// a hard error held the fail-closed gate at 503 for the whole process life.
		const restore = setEnv({ ENABLE_TELEGRAM_BOT: 'true' });
		try {
			const service = createReadinessService({
				timeoutMs: 1500,
				isBotEnabled: () => true,
				getBot: () => null,
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.telegram.ready).toBe(false);
			expect(report.dependencies.telegram.skipped).toBe(true);
			expect(report.dependencies.telegram.reason).toBe('telegram_not_initialized');
		} finally {
			restore();
		}
	});

	it('honors TradingView MCP runtime readiness override', async () => {
		const restore = setEnv({
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true',
			ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: 'false',
			ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT: 'false',
			ENABLE_MARKET_SCANNER: 'false',
		});
		try {
			const service = createReadinessService({
				timeoutMs: 1500,
				getTradingViewReadiness: () => ({ status: 'degraded', lastError: 'circuit_open' }),
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.tradingViewMcp.ready).toBe(false);
			// The status is surfaced, not the raw lastError, so an unverified or
			// provider-specific string never reaches the public probe surface.
			expect(report.dependencies.tradingViewMcp.error).toBe('tradingview_degraded');
		} finally {
			restore();
		}
	});

	it('treats TradingView readiness reports with status:ready as healthy without outbound calls', async () => {
		const restore = setEnv({
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true',
			ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: 'false',
			ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT: 'false',
			ENABLE_MARKET_SCANNER: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			ENABLE_BINANCE_TRADING: 'false',
			ENABLE_BINANCE_PRICE_CHECK: 'false',
			ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
			ENABLE_TELEGRAM_BOT: 'false',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
			GEMINI_API_KEY: '',
		});
		try {
			const originalFetch = global.fetch;
			global.fetch = jest.fn();
			const service = createReadinessService({
				timeoutMs: 1500,
				getTradingViewReadiness: () => ({ status: 'ready' }),
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.tradingViewMcp.ready).toBe(true);
			expect(global.fetch).not.toHaveBeenCalled();
			global.fetch = originalFetch;
		} finally {
			restore();
		}
	});
	it('does not report an unverified TradingView status as healthy', async () => {
		const restore = setEnv({ ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true' });
		try {
			// 'unknown' means the provider was never contacted; it must not pass
			// a fail-closed gate the same way an explicit 'ready' does.
			const service = createReadinessService({
				timeoutMs: 1500,
				getTradingViewReadiness: () => ({ status: 'unknown' }),
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.tradingViewMcp.ready).toBe(false);
			expect(report.dependencies.tradingViewMcp.error).toBe('tradingview_unknown');
		} finally {
			restore();
		}
	});

	it('reports enabled-but-unconfigured Firestore as a failure, not a skip', async () => {
		const restore = setEnv({ ENABLE_FIRESTORE_ALERT_STORAGE: 'true' });
		try {
			// The feature is switched on but its credentials are unusable. Treating
			// this as 'skipped' excluded it from the verdict and returned 200 from
			// the traffic-gating surface.
			const service = createReadinessService({
				timeoutMs: 1500,
				isFirestoreConfigured: () => false,
				getFirestoreClient: () => null,
			});
			const report = await service.collectReadiness();
			expect(report.dependencies.firestore.ready).toBe(false);
			expect(report.dependencies.firestore.skipped).toBeUndefined();
			expect(report.dependencies.firestore.enabled).toBe(true);
			expect(report.dependencies.firestore.error).toBe('firestore_not_configured');
		} finally {
			restore();
		}
	});

	it('redacts credentials that leak through provider fetch error messages', async () => {
		const restore = setEnv({ ENABLE_BINANCE_PRICE_CHECK: 'true' });
		try {
			const originalFetch = global.fetch;
			// undici embeds the full failing URL in its error message, and
			// TRADINGVIEW_MCP_URL routinely carries a token.
			global.fetch = jest.fn().mockRejectedValue(
				new Error('fetch failed for https://mcp.example.com/mcp?api-key=SUPERSECRET123'),
			);
			const service = createReadinessService({
				timeoutMs: 1500,
				getTradingViewReadiness: () => ({ status: 'degraded' }),
			});
			const report = await service.collectReadiness();
			const serialized = JSON.stringify(report);
			expect(serialized).not.toContain('SUPERSECRET123');
			global.fetch = originalFetch;
		} finally {
			restore();
		}
	});

	it('coalesces concurrent probe runs into a single outbound fan-out', async () => {
		const restore = setEnv({
			ENABLE_BINANCE_PRICE_CHECK: 'true',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			ENABLE_TELEGRAM_BOT: 'false',
		});
		try {
			const originalFetch = global.fetch;
			global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
			const service = createReadinessService({ timeoutMs: 1500 });
			await Promise.all([
				service.collectReadiness(),
				service.collectReadiness(),
				service.collectReadiness(),
			]);
			// A load balancer polling every few seconds would otherwise fan out to
			// every provider on every hit.
			expect(global.fetch).toHaveBeenCalledTimes(1);
			global.fetch = originalFetch;
		} finally {
			restore();
		}
	});

	it('reuses the cached report within the TTL instead of re-probing', async () => {
		const restore = setEnv({
			ENABLE_BINANCE_PRICE_CHECK: 'true',
			ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
			ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
			ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
			ENABLE_FIRESTORE_JOB_STORAGE: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			ENABLE_TELEGRAM_BOT: 'false',
		});
		try {
			const originalFetch = global.fetch;
			global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
			const service = createReadinessService({ timeoutMs: 1500 });
			await service.collectReadiness();
			await service.collectReadiness();
			await service.collectReadiness();
			expect(global.fetch).toHaveBeenCalledTimes(1);
			// cacheTtlMs: 0 opts out of caching for callers that need a fresh read.
			await service.collectReadiness({ cacheTtlMs: 0 });
			await service.collectReadiness({ cacheTtlMs: 0 });
			expect(global.fetch).toHaveBeenCalledTimes(3);
			global.fetch = originalFetch;
		} finally {
			restore();
		}
	});
});
