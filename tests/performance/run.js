'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const budgets = require('./budgets.json');
const requests = require('./request-cases.json');
const { startMockTradingViewMcp } = require('./support/mock-tradingview-mcp');

const PERFORMANCE_API_KEY = 'performance-test-key';

function getPerformanceEndpoints() {
	return Object.keys(budgets);
}

function buildLoadScenarios() {
	return [10, 50, 200].map((rate, index) => ({
		name: `rps_${rate}`,
		rate,
		duration: '10s',
		startTime: `${index * 15}s`,
	}));
}

function getPerformanceRequests() {
	return requests;
}

function buildK6Thresholds(budgetContract, profile) {
	if (!['load', 'soak'].includes(profile)) {
		throw new Error(`Unknown performance budget profile: ${profile}`);
	}
	const thresholds = {
		checks: ['rate==1'],
		dropped_iterations: ['count<1'],
		channel_429_count: ['count<1'],
	};
	for (const budget of Object.values(budgetContract)) {
		if (!budget || typeof budget.name !== 'string') {
			throw new Error('Every performance budget must include an endpoint name');
		}
		const percentiles = profile === 'soak' ? ['p95Ms', 'p99Ms'] : ['p95Ms'];
		thresholds[`http_req_duration{endpoint:${budget.name}}`] = percentiles.map((key) => {
			if (!Number.isFinite(budget[key]) || budget[key] <= 0) {
				throw new Error(`Missing valid ${key} budget for ${budget.name}`);
			}
			const percentile = key === 'p95Ms' ? 95 : 99;
			return `p(${percentile})<${budget[key]}`;
		});
	}
	return thresholds;
}

function buildLocalAppEnvironment(baseEnv, port, mcpUrl) {
	return {
		PATH: baseEnv.PATH,
		NO_PROXY: '*',
		no_proxy: '*',
		npm_config_no_proxy: '*',
		NODE_ENV: 'test',
		PORT: String(port),
		BOT_TOKEN: 'performance-test-token',
		WEBHOOK_API_KEY: PERFORMANCE_API_KEY,
		ENABLE_API_ONLY_MODE: 'true',
		ENABLE_MAINTENANCE_MODE: 'false',
		ENABLE_TELEGRAM_BOT: 'false',
		ENABLE_TELEGRAM_COMMAND_RATE_LIMITING: 'false',
		ENABLE_WHATSAPP_ALERTS: 'false',
		ENABLE_WHATSAPP_COMMANDS: 'false',
		ENABLE_DISCORD_ALERTS: 'false',
		ENABLE_GEMINI_GROUNDING: 'false',
		ENABLE_AUTO_TRADE: 'false',
		ENABLE_ALERT_MODERATION: 'false',
		ENABLE_SENTRY: 'false',
		ENABLE_LANGFUSE_PROMPTS: 'false',
		ENABLE_FIREBASE_REMOTE_CONFIG: 'false',
		ENABLE_FIREBASE_ADMIN_AUTH: 'false',
		ENABLE_FIRESTORE_ALERT_STORAGE: 'false',
		ENABLE_FIRESTORE_JOB_STORAGE: 'false',
		ENABLE_FIRESTORE_IDEMPOTENCY: 'false',
		ENABLE_FIRESTORE_SCANNER_PRESETS: 'false',
		ENABLE_SIGNAL_OUTCOME_TRACKING: 'false',
		SIGNAL_OUTCOME_WORKER_ROLE: 'disabled',
		ENABLE_NOTIFICATION_REDRIVE: 'false',
		NOTIFICATION_REDRIVE_WORKER_ROLE: 'disabled',
		ENABLE_JOB_BACKLOG_MONITOR: 'false',
		ENABLE_USER_PRICE_ALERTS: 'false',
		ENABLE_NEWS_MONITOR_SCHEDULER: 'false',
		ENABLE_ALERT_SCHEDULER: 'false',
		ENABLE_TRADINGVIEW_MCP_WARMUP: 'false',
		ENABLE_MARKET_SCANNER: 'true',
		ENABLE_NEWS_MONITOR: 'true',
		ENABLE_NEWS_MONITOR_TEST_MODE: 'true',
		ENABLE_BINANCE_PRICE_CHECK: 'false',
		ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP: 'false',
		ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'true',
		ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION: 'false',
		ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT: 'false',
		ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME: 'false',
		ENABLE_ALERT_HTF_RENDER: 'false',
		ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT: 'false',
		TRADINGVIEW_MCP_URL: mcpUrl,
		TRADINGVIEW_MCP_TIMEOUT_MS: '2000',
		TRADINGVIEW_MCP_MAX_RETRIES: '0',
		TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS: '5000',
		EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS: '5000',
		MARKET_SCANNER_TIMEOUT_MS: '5000',
		JOB_EXECUTION_MODE: 'local',
		ENABLE_TEST_RATE_LIMITER: 'false',
	};
}

function buildLoadEnvironment(baseEnv, baseUrl, isLocal) {
	const apiKey = isLocal ? PERFORMANCE_API_KEY : baseEnv.WEBHOOK_API_KEY;
	if (!apiKey) {
		throw new Error('WEBHOOK_API_KEY is required when BASE_URL targets an external performance test service');
	}
	return {
		PATH: baseEnv.PATH,
		HOME: baseEnv.HOME,
		BASE_URL: baseUrl,
		WEBHOOK_API_KEY: apiKey,
		...Object.fromEntries(Object.entries(baseEnv).filter(([key]) => key.startsWith('K6_'))),
	};
}

function run(command, args, env) {
	const child = spawn(command, args, { env, stdio: 'inherit' });
	return once(child, 'exit').then(([code, signal]) => {
		if (code !== 0) throw new Error(`${command} exited with ${code || signal}`);
	});
}

async function waitForHealth(baseUrl, options = {}) {
	const timeoutMs = options.timeoutMs ?? 15000;
	const probeTimeoutMs = options.probeTimeoutMs ?? 1000;
	const pollIntervalMs = options.pollIntervalMs ?? 250;
	const fetchImpl = options.fetchImpl || fetch;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const controller = new AbortController();
		const requestTimeoutMs = Math.max(1, Math.min(probeTimeoutMs, deadline - Date.now()));
		let timeoutId;
		let onAbort;
		try {
			const aborted = new Promise((_, reject) => {
				onAbort = () => reject(new Error('Health probe deadline exceeded'));
				controller.signal.addEventListener('abort', onAbort, { once: true });
			});
			timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);
			const response = await Promise.race([
				fetchImpl(`${baseUrl}/healthcheck`, { signal: controller.signal }),
				aborted,
			]);
			if (response.status === 200) return;
		} catch (_) {
			// The local child may still be booting.
		} finally {
			clearTimeout(timeoutId);
			if (onAbort) controller.signal.removeEventListener('abort', onAbort);
		}
		const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
		if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
	}
	throw new Error(`Local server did not become healthy at ${baseUrl}`);
}

async function stop(child) {
	if (child.exitCode !== null) return;
	const exitPromise = once(child, 'exit');
	child.kill('SIGTERM');
	let forceKillTimer;
	try {
		await Promise.race([
			exitPromise,
			new Promise((resolve) => {
				forceKillTimer = setTimeout(() => {
					child.kill('SIGKILL');
					resolve();
				}, 10000);
				forceKillTimer.unref?.();
			}),
		]);
	} finally {
		clearTimeout(forceKillTimer);
	}
}

async function main() {
	if (spawnSync('k6', ['version'], { stdio: 'ignore' }).status !== 0) {
		throw new Error('k6 is required for pnpm test:perf; install it locally or use the perf workflow');
	}

	const port = Number(process.env.PERF_PORT || 18080);
	const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${port}`;
	const isLocal = !process.env.BASE_URL;
	if (!isLocal && process.argv.includes('--soak')) {
		throw new Error('The protected /diag soak diagnostics are available only with the local test server');
	}
	let serverProcess;
	let mockMcp;
	let localRuntimeDir;

	try {
		if (isLocal) {
			mockMcp = await startMockTradingViewMcp();
			// Keep dotenv from loading a developer's repository-level .env into
			// the synthetic performance process.
			localRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cabros-bot-performance-'));
			serverProcess = spawn(process.execPath, [path.resolve(__dirname, '../../index.js')], {
				cwd: localRuntimeDir,
				env: buildLocalAppEnvironment(process.env, port, mockMcp.url),
				stdio: 'inherit',
			});
		}
		await waitForHealth(baseUrl);
		const env = buildLoadEnvironment(process.env, baseUrl, isLocal);
		await run('k6', ['run', path.join(__dirname, 'load/k6-alert-pipeline.js')], env);
		if (process.argv.includes('--soak')) {
			await run('k6', ['run', path.join(__dirname, 'load/k6-soak-30m.js')], env);
		}
		await run('pnpm', ['exec', 'jest', '--config', 'tests/performance/chaos/jest.config.js', '--runInBand'], env);
	} finally {
		if (serverProcess) await stop(serverProcess);
		if (mockMcp) await mockMcp.close();
		if (localRuntimeDir) fs.rmSync(localRuntimeDir, { recursive: true, force: true });
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[performance] ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = {
	buildK6Thresholds,
	buildLoadEnvironment,
	buildLoadScenarios,
	buildLocalAppEnvironment,
	getPerformanceEndpoints,
	getPerformanceRequests,
	waitForHealth,
};
