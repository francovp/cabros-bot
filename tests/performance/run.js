'use strict';

const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');

const budgets = require('./budgets.json');

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

function run(command, args, env) {
	const child = spawn(command, args, { env, stdio: 'inherit' });
	return once(child, 'exit').then(([code, signal]) => {
		if (code !== 0) throw new Error(`${command} exited with ${code || signal}`);
	});
}

async function waitForHealth(baseUrl) {
	const deadline = Date.now() + 15000;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`${baseUrl}/healthcheck`);
			if (response.status === 200) return;
		} catch (_) {
			// The local child may still be booting.
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`Local server did not become healthy at ${baseUrl}`);
}

async function stop(child) {
	if (child.exitCode !== null) return;
	child.kill('SIGTERM');
	await Promise.race([
		once(child, 'exit'),
		new Promise((resolve) => setTimeout(() => {
			child.kill('SIGKILL');
			resolve();
		}, 10000)),
	]);
}

async function main() {
	if (spawnSync('k6', ['version'], { stdio: 'ignore' }).status !== 0) {
		throw new Error('k6 is required for pnpm test:perf; install it locally or use the perf workflow');
	}

	const port = Number(process.env.PERF_PORT || 18080);
	const baseUrl = process.env.BASE_URL || `http://127.0.0.1:${port}`;
	const child = process.env.BASE_URL ? null : spawn(process.execPath, ['index.js'], {
		cwd: path.resolve(__dirname, '../..'),
		 env: {
			...process.env,
			NODE_ENV: 'test',
			PORT: String(port),
			BOT_TOKEN: 'performance-test-token',
			WEBHOOK_API_KEY: 'performance-test-key',
			ENABLE_API_ONLY_MODE: 'true',
			ENABLE_TELEGRAM_BOT: 'false',
			ENABLE_GEMINI_GROUNDING: 'false',
			ENABLE_TRADINGVIEW_MCP_ENRICHMENT: 'false',
			ENABLE_NEWS_MONITOR: 'false',
			EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS: '1000',
			MARKET_SCANNER_TIMEOUT_MS: '1000',
		},
		stdio: 'inherit',
	});

	try {
		await waitForHealth(baseUrl);
		const env = {
			...process.env,
			BASE_URL: baseUrl,
			WEBHOOK_API_KEY: process.env.WEBHOOK_API_KEY || 'performance-test-key',
		};
		await run('k6', ['run', path.join(__dirname, 'load/k6-alert-pipeline.js')], env);
		if (process.argv.includes('--soak')) {
			await run('k6', ['run', path.join(__dirname, 'load/k6-soak-30m.js')], env);
		}
		await run('pnpm', ['exec', 'jest', 'tests/performance/chaos/dependency-outage.test.js', '--runInBand'], env);
	} finally {
		if (child) await stop(child);
	}
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`[performance] ${error.message}`);
		process.exitCode = 1;
	});
}

module.exports = { buildLoadScenarios, getPerformanceEndpoints };
