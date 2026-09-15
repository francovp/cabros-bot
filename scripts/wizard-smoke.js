#!/usr/bin/env node
'use strict';

const http = require('node:http');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DEFAULT_PATHS = ['/healthcheck', '/api/status'];
const REQUEST_TIMEOUT_MS = 5000;

function buildRequest(url) {
	return new Promise((resolve) => {
		const req = http.request(url, { method: 'GET', headers: { Accept: 'application/json' } }, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', (error) => resolve({ status: 0, error: error.message }));
		req.setTimeout(REQUEST_TIMEOUT_MS, () => {
			req.destroy(new Error(`request to ${url.href} timed out`));
		});
		req.end();
	});
}

async function checkEndpoint(host, port, path) {
	const url = new URL(`http://${host}:${port}${path}`);
	const result = await buildRequest(url);
	const ok = result.status >= 200 && result.status < 500;
	return { path, status: result.status, ok, error: result.error };
}

async function main() {
	const host = process.env.WIZARD_SMOKE_HOST || DEFAULT_HOST;
	const port = Number.parseInt(process.env.WIZARD_SMOKE_PORT || `${DEFAULT_PORT}`, 10);
	const paths = (process.env.WIZARD_SMOKE_PATHS || DEFAULT_PATHS.join(',')).split(',').map((p) => p.trim()).filter(Boolean);

	process.stdout.write(`Wizard smoke test → ${host}:${port}\n`);
	const checks = await Promise.all(paths.map((p) => checkEndpoint(host, port, p)));
	let failures = 0;
	for (const c of checks) {
		const tag = c.ok ? 'PASS' : 'FAIL';
		process.stdout.write(`  [${tag}] ${c.path} → HTTP ${c.status}${c.error ? ` (${c.error})` : ''}\n`);
		if (!c.ok) failures += 1;
	}
	if (failures > 0) {
		process.stderr.write(`Smoke test failed: ${failures}/${checks.length} endpoint(s) unhealthy.\n`);
		process.exit(1);
	}
	process.stdout.write(`\nWizard smoke test passed: ${checks.length}/${checks.length} endpoint(s) healthy.\n`);
	process.stdout.write('\nSummary:\n');
	process.stdout.write(`  • Service is reachable at http://${host}:${port}\n`);
	process.stdout.write('  • Healthcheck and capability endpoints respond.\n');
	process.stdout.write('  • No LLM credentials required for this smoke test.\n');
}

if (require.main === module) {
	main().catch((error) => {
		process.stderr.write(`smoke test failed: ${error && error.message ? error.message : error}\n`);
		process.exit(1);
	});
}

module.exports = { checkEndpoint, buildRequest };