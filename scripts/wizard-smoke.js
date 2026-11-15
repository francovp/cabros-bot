#!/usr/bin/env node
'use strict';

require('dotenv').config();

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.PORT || '3000', 10);
const DEFAULT_PATHS = ['/healthcheck', '/api/status'];
const REQUEST_TIMEOUT_MS = 5000;

function isStatusOk(path, status) {
	if (status >= 200 && status < 300) {
		return true;
	}
	if (path === '/healthcheck') {
		return false;
	}
	return status === 401 || status === 403;
}

async function requestEndpoint(url, apiKey) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	const headers = {
		Accept: 'application/json',
	};
	if (apiKey) {
		headers['x-api-key'] = apiKey;
	}
	try {
		const response = await fetch(url, {
			method: 'GET',
			headers,
			signal: controller.signal,
		});
		return { status: response.status, ok: response.ok };
	} catch (error) {
		const isAbort = error && (error.name === 'AbortError' || error.name === 'TimeoutError');
		return { status: 0, error: isAbort ? `request to ${url} timed out` : (error && error.message ? error.message : String(error)) };
	} finally {
		clearTimeout(timeout);
	}
}

async function checkEndpoint(host, port, path, apiKey = process.env.WEBHOOK_API_KEY) {
	const url = `http://${host}:${port}${path}`;
	const result = await requestEndpoint(url, apiKey);
	const ok = isStatusOk(path, result.status);
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

module.exports = { checkEndpoint, requestEndpoint, isStatusOk };
