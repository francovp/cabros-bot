'use strict';

/**
 * src/controllers/demo.js
 *
 * Synthetic, gated preview endpoints for new operators. Disabled by default
 * (`ENABLE_DEMO_MODE=false`); opt-in via the env flag.
 *
 * Endpoints (mounted behind API-key auth in `src/routes/index.js`):
 *   - GET  /api/demo/alert?text=...&channels=telegram,whatsapp
 *   - GET  /api/demo/outcomes?symbol=BINANCE:BTCUSDT
 *   - GET  /api/demo/scanner?exchange=BINANCE
 *
 * All responses are wrapped in `meta: { synthetic: true, demo: true }` so
 * downstream consumers can detect demo traffic. Demo output MUST NEVER reach
 * the Firestore `alerts` collection, the `signalOutcomeService.recordSignal`
 * path, or the `alertFeedback` collection — see the request handler in
 * `src/controllers/webhooks/handlers/alert/alert.js` (the demo path returns
 * before `saveAlert()`).
 *
 * The Telegram `/demo` command handler is wired in
 * `src/controllers/commands.js` and dispatched through `bot.command('demo', ...)`.
 */

const sentryService = require('../services/monitoring/SentryService');

const DEFAULT_DEMO_BANNER = '🧪 DEMO · synthetic data, do not trade';

function isDemoEnabled() {
	const value = process.env.ENABLE_DEMO_MODE;
	return value === 'true' || value === '1';
}

function buildDemoMeta(extra = {}) {
	return {
		demo: true,
		synthetic: true,
		banner: DEFAULT_DEMO_BANNER,
		requestedAt: new Date().toISOString(),
		...extra,
	};
}

function parseChannelsParam(value) {
	if (!value || typeof value !== 'string') return [];
	const parts = value.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
	const allowed = new Set(['telegram', 'whatsapp', 'discord']);
	const channels = [];
	for (const part of parts) {
		if (allowed.has(part) && !channels.includes(part)) channels.push(part);
	}
	return channels;
}

function buildDemoAlert({ text, channels }) {
	const safeText = typeof text === 'string' && text.trim().length > 0
		? text.trim()
		: 'Sample demo alert from Cabros Bot. Replace this text with your own message.';
	const seed = Date.now();
	const sentimentScore = Number(((seed % 200) / 100 - 1).toFixed(2));
	const sources = [
		{ title: 'Demo source — replace with real providers', url: 'https://example.com/demo' },
		{ title: 'Synthetic news feed', url: 'https://example.com/synthetic' },
	];
	const insights = [
		'This is synthetic data. No real provider was called.',
		'Demo output is excluded from signal-outcome tracking and feedback storage.',
	];
	const technicalLevels = {
		support: 100.0,
		resistance: 110.0,
		invalidation: 95.0,
		target: 115.0,
	};
	return {
		text: safeText,
		source: 'demo',
		enriched: {
			sentiment_score: sentimentScore,
			sentiment: sentimentScore > 0.2 ? 'bullish' : sentimentScore < -0.2 ? 'bearish' : 'neutral',
			insights,
			technical_levels: technicalLevels,
			sources,
			truncated: false,
			prompt_provenance: { name: 'demo', source: 'local', label: 'demo', version: 1, schema_drift_detected: false },
		},
		tokenUsage: {
			prompt_tokens: 0,
			completion_tokens: 0,
			total_tokens: 0,
			totalCost: 0,
			formattedSummary: 'demo · 0 tokens · $0.0000',
		},
		channels,
		delivery: channels.length === 0
			? { results: [], note: 'no channels requested — preview only' }
			: { results: channels.map((channel) => ({
				channel,
				success: true,
				demo: true,
				messageId: `demo-${seed}-${channel}`,
				attemptCount: 0,
				durationMs: 0,
			})) },
	};
}

function buildDemoOutcomes({ symbol }) {
	const safeSymbol = typeof symbol === 'string' && symbol.trim().length > 0
		? symbol.trim()
		: 'BINANCE:BTCUSDT';
	const seed = Date.now();
	const baseReturn = ((seed % 200) - 100) / 1000;
	return {
		symbol: safeSymbol,
		generatedAt: new Date().toISOString(),
		windows: [
			{ window: '+1h', returnPct: Number((baseReturn + 0.005).toFixed(4)), mfePct: 0.012, maePct: -0.004, hitRate: baseReturn > 0 },
			{ window: '+4h', returnPct: Number((baseReturn + 0.011).toFixed(4)), mfePct: 0.018, maePct: -0.009, hitRate: baseReturn > 0.005 },
			{ window: '+1D', returnPct: Number((baseReturn + 0.022).toFixed(4)), mfePct: 0.04, maePct: -0.022, hitRate: baseReturn > 0.01 },
			{ window: '+1W', returnPct: Number((baseReturn + 0.04).toFixed(4)), mfePct: 0.08, maePct: -0.05, hitRate: baseReturn > 0.02 },
		],
		hitRatePercent: 50,
		expectancyR: Number((baseReturn * 10).toFixed(2)),
		note: 'Synthetic cohort. Not derived from any historical bar query.',
	};
}

function buildDemoScanner({ exchange }) {
	const safeExchange = typeof exchange === 'string' && exchange.trim().length > 0
		? exchange.trim().toUpperCase()
		: 'BINANCE';
	const now = new Date().toISOString();
	return {
		exchange: safeExchange,
		generatedAt: now,
		items: [
			{ symbol: `${safeExchange}:BTCUSDT`, changePct: 1.42, volumeUsd: 12345678, demo: true },
			{ symbol: `${safeExchange}:ETHUSDT`, changePct: -0.83, volumeUsd: 8765432, demo: true },
			{ symbol: `${safeExchange}:SOLUSDT`, changePct: 3.21, volumeUsd: 4321098, demo: true },
		],
		note: 'Synthetic scanner output. Not derived from any TradingView MCP call.',
	};
}

function demoDisabledResponse(res) {
	return res.status(404).json({
		success: false,
		error: 'FEATURE_DISABLED',
		message: 'Demo endpoints are disabled. Set ENABLE_DEMO_MODE=true to enable them.',
	});
}

function getDemoAlert() {
	return async (req, res) => {
		try {
			if (!isDemoEnabled()) return demoDisabledResponse(res);
			const text = typeof req.query.text === 'string' ? req.query.text : undefined;
			const channels = parseChannelsParam(req.query.channels);
			return res.json({
				success: true,
				meta: buildDemoMeta({ endpoint: '/api/demo/alert' }),
				alert: buildDemoAlert({ text, channels }),
			});
		} catch (error) {
			console.error('[Demo] alert handler failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'demo',
				error,
				feature: 'demo',
				http: { endpoint: '/api/demo/alert', method: 'GET', statusCode: 500 },
			});
			return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
		}
	};
}

function getDemoOutcomes() {
	return async (req, res) => {
		try {
			if (!isDemoEnabled()) return demoDisabledResponse(res);
			const symbol = typeof req.query.symbol === 'string' ? req.query.symbol : undefined;
			return res.json({
				success: true,
				meta: buildDemoMeta({ endpoint: '/api/demo/outcomes' }),
				outcomes: buildDemoOutcomes({ symbol }),
			});
		} catch (error) {
			console.error('[Demo] outcomes handler failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'demo',
				error,
				feature: 'demo',
				http: { endpoint: '/api/demo/outcomes', method: 'GET', statusCode: 500 },
			});
			return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
		}
	};
}

function getDemoScanner() {
	return async (req, res) => {
		try {
			if (!isDemoEnabled()) return demoDisabledResponse(res);
			const exchange = typeof req.query.exchange === 'string' ? req.query.exchange : undefined;
			return res.json({
				success: true,
				meta: buildDemoMeta({ endpoint: '/api/demo/scanner' }),
				scanner: buildDemoScanner({ exchange }),
			});
		} catch (error) {
			console.error('[Demo] scanner handler failed:', error.message);
			sentryService.captureRuntimeError({
				channel: 'demo',
				error,
				feature: 'demo',
				http: { endpoint: '/api/demo/scanner', method: 'GET', statusCode: 500 },
			});
			return res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: error.message });
		}
	};
}

function getDemoStatus() {
	const enabled = isDemoEnabled();
	return {
		enabled,
		configured: enabled,
		ready: enabled,
		status: enabled ? 'ready' : 'disabled',
		source: 'env',
	};
}

module.exports = {
	isDemoEnabled,
	getDemoAlert,
	getDemoOutcomes,
	getDemoScanner,
	getDemoStatus,
	buildDemoAlert,
	buildDemoOutcomes,
	buildDemoScanner,
	parseChannelsParam,
	DEFAULT_DEMO_BANNER,
};