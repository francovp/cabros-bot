#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

function readAuditReport() {
	let stdout;
	let exitCode = 0;
	try {
		stdout = execFileSync(
			'pnpm',
			['audit', '--audit-level=high', '--json', '--ignore-registry-errors'],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
		);
	} catch (error) {
		stdout = error.stdout;
		exitCode = typeof error.status === 'number' ? error.status : 1;
	}

	// `--ignore-registry-errors` lets pnpm exit 0 when the registry is
	// unreachable, so a non-JSON payload here means the report is unusable and
	// we must not silently pass it off as a clean audit.
	const trimmed = String(stdout || '').trim();
	if (trimmed === '' || trimmed[0] !== '{') {
		throw new Error(`pnpm audit produced no parsable report (exit ${exitCode})`);
	}
	return { report: JSON.parse(trimmed), exitCode };
}

function main() {
	let parsed;
	try {
		parsed = readAuditReport();
	} catch (error) {
		console.error(`[audit-gate] inconclusive: ${error.message}`);
		console.error('[audit-gate] this is a registry/tooling failure, not a clean audit');
		return 2;
	}

	const advisories = Object.values(parsed.report.advisories || {});
	const blocking = advisories.filter((a) => BLOCKING_SEVERITIES.has(a.severity));

	for (const advisory of blocking) {
		console.error(
			`[audit-gate] ${advisory.severity} ${advisory.module_name} ${advisory.github_advisory_id || advisory.cves?.join(',') || ''}`.trim()
		);
	}

	if (blocking.length > 0 || parsed.exitCode !== 0) {
		console.error(`[audit-gate] FAILED: ${blocking.length} blocking advisory/advisories`);
		return 1;
	}

	console.log(`[audit-gate] OK: no high or critical advisories (${advisories.length} reported at or above the threshold)`);
	return 0;
}

process.exit(main());