'use strict';

/**
 * scripts/generate-feature-matrix.js
 *
 * Generates `docs/FEATURE_MATRIX.md` from a static analysis of the codebase,
 * `src/openapi/openapi.json`, and `src/controllers/status.js` so the matrix
 * cannot drift from the runtime.
 *
 * Columns:
 *   - Feature
 *   - Primary env var
 *   - Secondary env vars
 *   - Default
 *   - Status endpoint key
 *   - OpenAPI path
 *   - Notes
 *
 * Reads the same `process.env.*` patterns as `tests/unit/docs-alignment.test.js`
 * so a drift between this matrix and `.env.example` can be caught by the same
 * documentation-alignment guard (CB-131).
 *
 * Usage:
 *   node scripts/generate-feature-matrix.js
 *   node scripts/generate-feature-matrix.js --check   # exit 1 if matrix would change
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const OUTPUT_PATH = path.join(REPO_ROOT, 'docs', 'FEATURE_MATRIX.md');
const OPENAPI_PATH = path.join(REPO_ROOT, 'src', 'openapi', 'openapi.json');
const STATUS_PATH = path.join(REPO_ROOT, 'src', 'controllers', 'status.js');

// Curated feature map. Each entry mirrors what an operator needs to know
// to enable the feature. The generator will not infer feature names from
// env vars — that produces drift instead of reducing it. Instead, the
// generator validates the curated entries against the static analysis:
// primary env vars must appear in src/, status keys must be defined in
// status.js, and OpenAPI paths must exist in openapi.json.
const FEATURES = [
	{
		name: 'Telegram bot',
		primaryEnv: 'ENABLE_TELEGRAM_BOT',
		secondaryEnv: ['BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
		default: 'false',
		statusKey: 'featureFlags.telegramBot',
		openapiPath: null,
		notes: 'Requires `BOT_TOKEN` and `TELEGRAM_CHAT_ID`. Disabled on Render PR previews and Vercel preview environments.',
	},
	{
		name: 'Webhook alert ingest',
		primaryEnv: 'WEBHOOK_API_KEY',
		secondaryEnv: ['WEBHOOK_IDEMPOTENCY_TTL_MS'],
		default: 'unset (503 in production)',
		statusKey: 'dependencies.webhookAuth',
		openapiPath: '/api/webhook/alert',
		notes: 'All `/api/webhook/*` POST endpoints require `x-api-key` header or `api-key` query parameter when `WEBHOOK_API_KEY` is configured.',
	},
	{
		name: 'Generic message webhook',
		primaryEnv: 'WEBHOOK_API_KEY',
		secondaryEnv: [],
		default: 'unset (503 in production)',
		statusKey: null,
		openapiPath: '/api/webhook/message',
		notes: '`POST /api/webhook/message` is the zero-fanout, no-storage alternative to `/api/webhook/alert`.',
	},
	{
		name: 'WhatsApp alerts (GreenAPI)',
		primaryEnv: 'ENABLE_WHATSAPP_ALERTS',
		secondaryEnv: ['WHATSAPP_API_URL', 'WHATSAPP_API_KEY', 'WHATSAPP_CHAT_ID'],
		default: 'false',
		statusKey: 'featureFlags.whatsappAlerts',
		openapiPath: null,
		notes: 'GreenAPI delivery uses native fetch with bounded AbortController timeouts. `WHATSAPP_PREVIEW_CHAT_ID` overrides destination on Render PR previews.',
	},
	{
		name: 'Discord webhook alerts',
		primaryEnv: 'ENABLE_DISCORD_ALERTS',
		secondaryEnv: ['DISCORD_WEBHOOK_URL'],
		default: 'false',
		statusKey: 'featureFlags.discordAlerts',
		openapiPath: null,
		notes: '429 responses parse floating-point `Retry-After` headers without integer truncation; respects exponential backoff cap.',
	},
	{
		name: 'Gemini grounding enrichment',
		primaryEnv: 'ENABLE_GEMINI_GROUNDING',
		secondaryEnv: ['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'BRAVE_SEARCH_API_KEY'],
		default: 'false',
		statusKey: 'featureFlags.geminiGrounding',
		openapiPath: null,
		notes: 'Single grounding call reused across Telegram/WhatsApp/Discord. Fail-open: original alert text is delivered if enrichment fails.',
	},
	{
		name: 'TradingView MCP enrichment',
		primaryEnv: 'ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT',
		secondaryEnv: ['TRADINGVIEW_MCP_URL', 'TRADINGVIEW_MCP_DEFAULT_TIMEFRAME', 'TRADINGVIEW_MCP_DEFAULT_EXCHANGE'],
		default: 'false',
		statusKey: 'featureFlags.tradingViewMcpEnrichment',
		openapiPath: '/api/webhook/expanded-analysis-alert',
		notes: 'Drives `/api/webhook/expanded-analysis-alert`, `/api/webhook/symbol-analysis`, `/api/webhook/volume-confirmation`, and market-scanner ranked output.',
	},
	{
		name: 'News monitor',
		primaryEnv: 'ENABLE_NEWS_MONITOR',
		secondaryEnv: ['NEWS_SYMBOLS_CRYPTO', 'NEWS_SYMBOLS_STOCKS', 'NEWS_ALERT_THRESHOLD', 'NEWS_TIMEOUT_MS', 'NEWS_GEMINI_CONCURRENCY', 'NEWS_GEMINI_QUOTA_MAX_RETRIES', 'NEWS_GEMINI_QUOTA_RETRY_BASE_MS'],
		default: 'false',
		statusKey: 'featureFlags.newsMonitor',
		openapiPath: '/api/news-monitor',
		notes: 'In-memory dedup cache with optional Firestore persistence via `ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP`.',
	},
	{
		name: 'Firestore alert storage',
		primaryEnv: 'ENABLE_FIRESTORE_ALERT_STORAGE',
		secondaryEnv: ['ALERT_STORAGE_RETENTION_DAYS'],
		default: 'false',
		statusKey: 'featureFlags.firestoreAlertStorage',
		openapiPath: '/api/alerts',
		notes: 'Fire-and-forget after `res.json()` so storage never blocks delivery.',
	},
	{
		name: 'Firestore idempotency',
		primaryEnv: 'ENABLE_FIRESTORE_IDEMPOTENCY',
		secondaryEnv: ['WEBHOOK_IDEMPOTENCY_TTL_MS'],
		default: 'false',
		statusKey: 'featureFlags.firestoreIdempotency',
		openapiPath: null,
		notes: 'Fail-open to in-memory when Firestore unavailable.',
	},
	{
		name: 'Async TradingView jobs',
		primaryEnv: 'JOB_EXECUTION_MODE',
		secondaryEnv: ['REDIS_URL'],
		default: 'local',
		statusKey: 'featureFlags.jobExecutionWorker',
		openapiPath: '/api/jobs/tradingview-analysis',
		notes: '`render-worker` mode requires Redis + durable Firestore. `firestore-poller` skips Redis entirely.',
	},
	{
		name: 'Signal outcome tracking',
		primaryEnv: 'ENABLE_SIGNAL_OUTCOME_TRACKING',
		secondaryEnv: ['SIGNAL_OUTCOME_WORKER_ROLE', 'SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS', 'SIGNAL_OUTCOME_RETENTION_DAYS'],
		default: 'false',
		statusKey: 'featureFlags.signalOutcomeTracking',
		openapiPath: null,
		notes: 'Role-gated scheduling: `web` runs in web, `worker` runs in `src/workers/signalOutcomeWorker.js`, `disabled` prevents scheduler startup.',
	},
	{
		name: 'Binance Spot trading',
		primaryEnv: 'ENABLE_BINANCE_TRADING',
		secondaryEnv: ['BINANCE_API_KEY', 'BINANCE_API_SECRET', 'BINANCE_TRADING_ENV', 'BINANCE_TRADING_ALLOWED_SYMBOLS', 'BINANCE_TRADING_MAX_NOTIONAL', 'BINANCE_TRADING_TIMEOUT_MS'],
		default: 'false',
		statusKey: 'featureFlags.binanceTrading',
		openapiPath: '/api/trading/binance/orders',
		notes: 'Testnet stays pinned to `https://testnet.binance.vision`. Live requires HTTPS-only base URL.',
	},
	{
		name: 'Sentry runtime monitoring',
		primaryEnv: 'ENABLE_SENTRY',
		secondaryEnv: ['SENTRY_DSN', 'SENTRY_TRACES_SAMPLE_RATE', 'SENTRY_CONSOLE_LOG_LEVELS', 'SENTRY_ENVIRONMENT', 'SENTRY_RELEASE'],
		default: 'false',
		statusKey: 'featureFlags.sentryMonitoring',
		openapiPath: null,
		notes: 'Side-effect only — does not change HTTP responses or notification fallbacks.',
	},
	{
		name: 'Firebase Remote Config',
		primaryEnv: 'ENABLE_FIREBASE_REMOTE_CONFIG',
		secondaryEnv: [],
		default: 'false',
		statusKey: 'featureFlags.firebaseRemoteConfig',
		openapiPath: null,
		notes: 'Server-side template loaded via `admin.remoteConfig().initServerTemplate()`. Publish via `.github/workflows/firebase-remote-config.yml` after green deploy.',
	},
	{
		name: 'Equity market data (Twelve Data)',
		primaryEnv: 'ENABLE_EQUITY_MARKET_DATA',
		secondaryEnv: ['TWELVE_DATA_API_KEY', 'TWELVE_DATA_BASE_URL', 'EQUITY_MARKET_DATA_RPM', 'TWELVE_DATA_RPM'],
		default: 'false',
		statusKey: 'featureFlags.equityMarketData',
		openapiPath: null,
		notes: 'Bounded historical `/time_series` for return/MFE/MAE evaluation. Fail-open on provider errors.',
	},
	{
		name: 'Demo mode',
		primaryEnv: 'ENABLE_DEMO_MODE',
		secondaryEnv: [],
		default: 'false',
		statusKey: 'featureFlags.demoMode',
		openapiPath: '/api/demo/alert',
		notes: 'Synthetic data only. Excluded from `shadowModeMetrics`, `signalOutcomeService.recordSignal`, and `alertFeedback` writes. Wraps output in a DEMO banner.',
	},
	{
		name: 'Demo Telegram command',
		primaryEnv: 'ENABLE_TELEGRAM_BOT',
		secondaryEnv: ['ENABLE_DEMO_MODE'],
		default: 'false',
		statusKey: 'featureFlags.demoMode',
		openapiPath: null,
		notes: '`/demo alert`, `/demo outcomes`, `/demo scanner` subcommands. Requires both `ENABLE_TELEGRAM_BOT=true` and `ENABLE_DEMO_MODE=true`.',
	},
];

const PLATFORM_INJECTED = new Set([
	'APPDATA', 'COMMIT_SHA', 'FUNCTION_NAME', 'FUNCTION_TARGET',
	'GAE_SERVICE', 'GCE_METADATA_HOST', 'GCE_METADATA_IP', 'GCLOUD_PROJECT',
	'GITHUB_SHA', 'GIT_COMMIT', 'GOOGLE_CLOUD_PROJECT', 'HOME',
	'JEST_WORKER_ID', 'K_REVISION', 'K_SERVICE', 'NODE_ENV',
	'RENDER_GIT_COMMIT', 'RENDER_GIT_REPO_SLUG',
	'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_GIT_COMMIT_SHA',
	'RAILWAY_GIT_PULL_REQUEST_NUMBER', 'RAILWAY_GIT_REPO_NAME',
	'RAILWAY_GIT_REPO_OWNER', 'RENDER_INSTANCE_ID', 'RENDER_SERVICE_ID',
	'SOURCE_VERSION',
]);

function getJavaScriptFiles(dirPath, arrayOfFiles = []) {
	if (!fs.existsSync(dirPath)) return arrayOfFiles;
	for (const file of fs.readdirSync(dirPath)) {
		const fullPath = path.join(dirPath, file);
		if (fs.statSync(fullPath).isDirectory()) {
			getJavaScriptFiles(fullPath, arrayOfFiles);
		} else if (file.endsWith('.js')) {
			arrayOfFiles.push(fullPath);
		}
	}
	return arrayOfFiles;
}

function getEnvReferencesFromContent(content) {
	const names = new Set();
	const patterns = [
		/\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
		/\bprocess\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]/g,
		// dynamic-read helpers used throughout src/ (see docs-alignment test).
		/\bparseEnvInt\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
		/\bgetSymbolsFromEnv\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g,
		// runtime-config property access (`getRuntimeConfig().WEBHOOK_IDEMPOTENCY_TTL_MS`).
		/\bgetRuntimeConfig\(\)\.([A-Z][A-Z0-9_]*)\b/g,
	];
	for (const pattern of patterns) {
		for (const match of content.matchAll(pattern)) names.add(match[1]);
	}
	return names;
}

function collectEnvReadsFromSource(repoRoot) {
	const sourceFiles = [
		path.join(repoRoot, 'index.js'),
		path.join(repoRoot, 'app.js'),
		path.join(repoRoot, 'instrument.js'),
		...getJavaScriptFiles(path.join(repoRoot, 'src')),
	];
	const all = new Set();
	for (const file of sourceFiles) {
		if (!fs.existsSync(file)) continue;
		const content = fs.readFileSync(file, 'utf8');
		for (const name of getEnvReferencesFromContent(content)) {
			all.add(name);
		}
	}
	return all;
}

function loadOpenApiPaths(openApiPath) {
	try {
		const raw = fs.readFileSync(openApiPath, 'utf8');
		const parsed = JSON.parse(raw);
		return new Set(Object.keys(parsed.paths || {}));
	} catch (err) {
		console.error(`[feature-matrix] failed to parse ${openApiPath}: ${err.message}`);
		return new Set();
	}
}

function extractObjectBlock(content, name) {
	const startMarker = new RegExp(`\\b${name}\\s*:\\s*\\{`);
	const sm = startMarker.exec(content);
	if (!sm) return null;
	let depth = 0;
	let start = -1;
	for (let i = sm.index; i < content.length; i++) {
		const ch = content[i];
		if (ch === '{') { if (depth === 0) start = i; depth++; }
		else if (ch === '}') { depth--; if (depth === 0) return content.slice(start, i + 1); }
	}
	return null;
}

function loadStatusKeys(statusPath) {
	try {
		const content = fs.readFileSync(statusPath, 'utf8');
		const matches = new Set();
		// Match keys inside the featureFlags and dependencies object literals,
		// supporting both longhand (`key: value`) and shorthand (`key,` or
		// `key }`/`,`) property forms.
		for (const blockName of ['featureFlags', 'dependencies']) {
			const block = extractObjectBlock(content, blockName);
			if (!block) continue;
			for (const line of block.split('\n')) {
				const longhand = line.match(/^\s+([a-zA-Z][a-zA-Z0-9_]*)\s*:/);
				if (longhand) {
					matches.add(`${blockName}.${longhand[1]}`);
					continue;
				}
				const shorthand = line.match(/^\s+([a-zA-Z][a-zA-Z0-9_]*)\s*[,}]/);
				if (shorthand) {
					matches.add(`${blockName}.${shorthand[1]}`);
				}
			}
		}
		return matches;
	} catch (err) {
		console.error(`[feature-matrix] failed to read ${statusPath}: ${err.message}`);
		return new Set();
	}
}

function renderMatrix({ features, envRefs, openApiPaths, statusKeys, platformInjected }) {
	const drift = [];
	const rows = [];
	for (const feature of features) {
		const issues = [];
		if (!envRefs.has(feature.primaryEnv) && !platformInjected.has(feature.primaryEnv)) {
			issues.push(`primary env var \`${feature.primaryEnv}\` is not referenced in src/`);
		}
		for (const env of feature.secondaryEnv) {
			if (!envRefs.has(env) && !platformInjected.has(env)) {
				issues.push(`secondary env var \`${env}\` is not referenced in src/`);
			}
		}
		if (feature.statusKey && !statusKeys.has(feature.statusKey)) {
			issues.push(`status key \`${feature.statusKey}\` is not present in src/controllers/status.js`);
		}
		if (feature.openapiPath && !openApiPaths.has(feature.openapiPath)) {
			issues.push(`OpenAPI path \`${feature.openapiPath}\` is not present in src/openapi/openapi.json`);
		}
		if (issues.length > 0) drift.push({ feature: feature.name, issues });
		rows.push(feature);
	}
	return { drift, rows };
}

function renderMarkdown({ rows, drift, envRefs, openApiPaths, statusKeys }) {
	const lines = [];
	lines.push('# Feature matrix');
	lines.push('');
	lines.push('> Generated by `scripts/generate-feature-matrix.js`. Do not edit by hand — re-run the generator.');
	lines.push('');
	lines.push('This matrix maps every application-owned feature to its primary environment variable, default behavior, status endpoint key, and OpenAPI path. Drift between this file and the source is detected at generation time and reported below; re-run `node scripts/generate-feature-matrix.js` to regenerate.');
	lines.push('');
	lines.push('## Features');
	lines.push('');
	lines.push('| Feature | Primary env var | Secondary env vars | Default | Status endpoint key | OpenAPI path | Notes |');
	lines.push('| --- | --- | --- | --- | --- | --- | --- |');
	for (const feature of rows) {
		const primary = feature.primaryEnv ? `\`${feature.primaryEnv}\`` : '—';
		const secondary = feature.secondaryEnv.length
			? feature.secondaryEnv.map((e) => `\`${e}\``).join('<br>')
			: '—';
		const statusKey = feature.statusKey ? `\`${feature.statusKey}\`` : '—';
		const openapi = feature.openapiPath ? `\`${feature.openapiPath}\`` : '—';
		lines.push(`| ${feature.name} | ${primary} | ${secondary} | ${feature.default} | ${statusKey} | ${openapi} | ${feature.notes} |`);
	}
	lines.push('');
	lines.push('## Drift report');
	lines.push('');
	if (drift.length === 0) {
		lines.push('No drift detected. All curated entries are backed by source code.');
	} else {
		lines.push('Drift detected — the matrix is out of sync with the codebase. Update the curated `FEATURES` list in `scripts/generate-feature-matrix.js` and regenerate.');
		lines.push('');
		for (const entry of drift) {
			lines.push(`- **${entry.feature}**`);
			for (const issue of entry.issues) lines.push(`  - ${issue}`);
		}
	}
	lines.push('');
	lines.push('## Source coverage');
	lines.push('');
	lines.push(`- **Environment variables referenced in source**: ${envRefs.size}`);
	lines.push(`- **OpenAPI paths declared**: ${openApiPaths.size}`);
	lines.push(`- **Status endpoint keys surfaced**: ${statusKeys.size}`);
	lines.push('');
	return lines.join('\n');
}

function main() {
	const argv = process.argv.slice(2);
	const checkOnly = argv.includes('--check');
	const envRefs = collectEnvReadsFromSource(REPO_ROOT);
	const openApiPaths = loadOpenApiPaths(OPENAPI_PATH);
	const statusKeys = loadStatusKeys(STATUS_PATH);
	const { drift, rows } = renderMatrix({
		features: FEATURES,
		envRefs,
		openApiPaths,
		statusKeys,
		platformInjected: PLATFORM_INJECTED,
	});
	const markdown = renderMarkdown({ rows, drift, envRefs, openApiPaths, statusKeys });
	if (checkOnly) {
		if (!fs.existsSync(OUTPUT_PATH)) {
			console.error(`[feature-matrix] --check failed: ${OUTPUT_PATH} does not exist. Run without --check to generate.`);
			process.exit(1);
		}
		const current = fs.readFileSync(OUTPUT_PATH, 'utf8');
		if (current !== markdown) {
			console.error(`[feature-matrix] --check failed: ${OUTPUT_PATH} is out of date. Re-run \`node scripts/generate-feature-matrix.js\`.`);
			process.exit(1);
		}
		console.log('[feature-matrix] --check passed.');
		return;
	}
	fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
	fs.writeFileSync(OUTPUT_PATH, markdown, 'utf8');
	console.log(`[feature-matrix] wrote ${OUTPUT_PATH} (${rows.length} features, ${drift.length} drift items)`);
	if (drift.length > 0) {
		process.exitCode = 2;
	}
}

if (require.main === module) {
	main();
}

module.exports = {
	FEATURES,
	PLATFORM_INJECTED,
	collectEnvReadsFromSource,
	loadOpenApiPaths,
	loadStatusKeys,
	renderMatrix,
	renderMarkdown,
};