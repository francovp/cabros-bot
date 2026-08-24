#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const VALID_ENV_NAME_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DEFAULT_LOG_FILE = '.env-sync.log';

/**
 * Validates environment variable name and strictly rejects values passed on argv.
 * @param {string} name
 * @returns {string} validated name
 */
function validateVariableName(name) {
	if (!name || typeof name !== 'string' || !name.trim()) {
		throw new Error('Environment variable name is required.');
	}

	const trimmed = name.trim();
	if (trimmed.includes('=')) {
		throw new Error(
			'Never pass variable values on argv to prevent leaking secrets in shell history and process listings. Pass only the variable name (e.g. --key MY_VAR).'
		);
	}

	if (!VALID_ENV_NAME_REGEX.test(trimmed)) {
		throw new Error(
			`Invalid environment variable name "${trimmed}". Must match standard POSIX variable naming (/^[A-Za-z_][A-Za-z0-9_]*$/).`
		);
	}

	return trimmed;
}

/**
 * Parse CLI arguments
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv = process.argv.slice(2)) {
	const args = {
		key: null,
		dryRun: true,
		apply: false,
		noOpPlatforms: [],
		noOpReasons: {},
		logFile: DEFAULT_LOG_FILE,
		checkDrift: false,
		json: false,
		help: false,
	};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];

		if (arg === '--help' || arg === '-h') {
			args.help = true;
			i++;
		} else if (arg === '--json') {
			args.json = true;
			i++;
		} else if (arg === '--diff' || arg === '--check-drift') {
			args.checkDrift = true;
			i++;
		} else if (arg === '--apply') {
			args.apply = true;
			args.dryRun = false;
			i++;
		} else if (arg === '--dry-run') {
			args.dryRun = true;
			args.apply = false;
			i++;
		} else if (arg === '--key' || arg === '-k') {
			if (i + 1 >= argv.length) {
				throw new Error('Missing argument for --key');
			}
			args.key = validateVariableName(argv[i + 1]);
			i += 2;
		} else if (arg === '--no-op') {
			if (i + 1 >= argv.length) {
				throw new Error('Missing argument for --no-op');
			}
			const platforms = argv[i + 1].split(',').map((p) => p.trim().toLowerCase());
			args.noOpPlatforms.push(...platforms);
			i += 2;
		} else if (arg.startsWith('--no-op=')) {
			const platforms = arg.slice('--no-op='.length).split(',').map((p) => p.trim().toLowerCase());
			args.noOpPlatforms.push(...platforms);
			i++;
		} else if (arg === '--no-op-reason') {
			if (i + 1 >= argv.length) {
				throw new Error('Missing argument for --no-op-reason');
			}
			const reasonArg = argv[i + 1];
			if (reasonArg.includes('=')) {
				const [plat, ...rest] = reasonArg.split('=');
				args.noOpReasons[plat.trim().toLowerCase()] = rest.join('=');
			}
			i += 2;
		} else if (arg === '--log-file') {
			if (i + 1 >= argv.length) {
				throw new Error('Missing argument for --log-file');
			}
			args.logFile = argv[i + 1];
			i += 2;
		} else if (!arg.startsWith('-')) {
			if (!args.key) {
				args.key = validateVariableName(arg);
			} else {
				throw new Error(`Unexpected positional argument: ${arg}`);
			}
			i++;
		} else {
			throw new Error(`Unknown option: ${arg}`);
		}
	}

	return args;
}

/**
 * Parses render.yaml to detect which Render services define or reference a variable.
 * @param {string} key
 * @param {string} repoRoot
 * @returns {string[]} matching service names
 */
function detectRenderServices(key, repoRoot = path.join(__dirname, '..')) {
	const blueprintPath = path.join(repoRoot, 'render.yaml');
	if (!fs.existsSync(blueprintPath)) return [];

	const content = fs.readFileSync(blueprintPath, 'utf8');
	const lines = content.split('\n');
	const matchingServices = new Set();
	let currentService = null;

	for (const line of lines) {
		const serviceMatch = line.match(/^[\s-]*name:\s*([a-zA-Z0-9_-]+)/);
		if (serviceMatch && (line.startsWith('- name:') || line.startsWith('  name:'))) {
			currentService = serviceMatch[1];
		}

		if (currentService) {
			const keyMatch = line.match(/key:\s*([A-Za-z0-9_]+)/);
			const envVarKeyMatch = line.match(/envVarKey:\s*([A-Za-z0-9_]+)/);
			if ((keyMatch && keyMatch[1] === key) || (envVarKeyMatch && envVarKeyMatch[1] === key)) {
				matchingServices.add(currentService);
			}
		}
	}

	return Array.from(matchingServices);
}

/**
 * Generate platform-specific sync plan.
 * @param {string} key
 * @param {Object} options
 * @returns {Object}
 */
function generateSyncPlan(key, options = {}) {
	const repoRoot = options.repoRoot || path.join(__dirname, '..');
	const noOpPlatforms = (options.noOpPlatforms || []).map((p) => p.toLowerCase());
	const noOpReasons = options.noOpReasons || {};

	const renderServices = detectRenderServices(key, repoRoot);

	const isRenderNoOp = noOpPlatforms.includes('render');
	const isRailwayNoOp = noOpPlatforms.includes('railway');
	const isVercelNoOp = noOpPlatforms.includes('vercel');

	const plan = {
		key,
		generatedAt: new Date().toISOString(),
		platforms: {
			render: {
				platform: 'render',
				isNoOp: isRenderNoOp,
				noOpReason: isRenderNoOp
					? noOpReasons.render || 'Explicitly configured as no-op for Render'
					: null,
				services: renderServices,
				commands: isRenderNoOp
					? []
					: renderServices.length > 0
						? renderServices.map(
								(svc) =>
									`render services env set ${svc} ${key}  # Note: value entered interactively or securely via dashboard/CLI`
							)
						: [
								`# Note: ${key} not currently declared in render.yaml services. If needed, add to render.yaml or set on cabros-crypto-bot-telegram-iac:`,
								`render services env set cabros-crypto-bot-telegram-iac ${key}`,
							],
			},
			railway: {
				platform: 'railway',
				isNoOp: isRailwayNoOp,
				noOpReason: isRailwayNoOp
					? noOpReasons.railway || 'Explicitly configured as no-op for Railway'
					: null,
				project: 'cabros-bot',
				service: 'cabros-bot',
				environment: 'production',
				commands: isRailwayNoOp
					? []
					: [
							`# Interactive/secure Railway update (prompts or reads securely without embedding in command history):`,
							`railway variables --environment production --service cabros-bot  # or set interactively in Railway dashboard`,
							`# For scriptable non-secret values only:`,
							`# railway variables --set "${key}=<VALUE>" --environment production --service cabros-bot`,
						],
			},
			vercel: {
				platform: 'vercel',
				isNoOp: isVercelNoOp,
				noOpReason: isVercelNoOp
					? noOpReasons.vercel || 'Explicitly configured as no-op for Vercel (e.g. backend service unhosted on Vercel)'
					: null,
				project: 'cabros-bot',
				commands: isVercelNoOp
					? []
					: [
							`# Interactive Vercel variable addition (prompts securely for secret value):`,
							`vercel env add ${key} production`,
						],
			},
		},
	};

	return plan;
}

/**
 * Record a timestamped audit log entry into local log file.
 * @param {Object} entry
 * @returns {string} recorded line
 */
function recordSyncLog(entry) {
	const { key, logFile = DEFAULT_LOG_FILE, statuses = {} } = entry;
	const timestamp = new Date().toISOString();

	const renderStatus = statuses.render || 'PENDING';
	const railwayStatus = statuses.railway || 'PENDING';
	const vercelStatus = statuses.vercel || 'PENDING';

	const logLine = `[${timestamp}] KEY=${key} RENDER=${renderStatus} RAILWAY=${railwayStatus} VERCEL=${vercelStatus}\n`;

	const logDir = path.dirname(path.resolve(logFile));
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}

	fs.appendFileSync(logFile, logLine, 'utf8');
	return logLine;
}

/**
 * Scans .env.example and compares against render.yaml to detect drift.
 * @param {string} repoRoot
 * @returns {Object}
 */
function checkEnvironmentDrift(repoRoot = path.join(__dirname, '..')) {
	const envExamplePath = path.join(repoRoot, '.env.example');
	const blueprintPath = path.join(repoRoot, 'render.yaml');

	const envExampleKeys = new Set();
	if (fs.existsSync(envExamplePath)) {
		const lines = fs.readFileSync(envExamplePath, 'utf8').split('\n');
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const match = trimmed.match(/^([A-Za-z0-9_]+)=/);
			if (match) {
				envExampleKeys.add(match[1]);
			}
		}
	}

	const blueprintKeys = new Set();
	if (fs.existsSync(blueprintPath)) {
		const lines = fs.readFileSync(blueprintPath, 'utf8').split('\n');
		for (const line of lines) {
			const keyMatch = line.match(/key:\s*([A-Za-z0-9_]+)/);
			const envVarKeyMatch = line.match(/envVarKey:\s*([A-Za-z0-9_]+)/);
			if (keyMatch) blueprintKeys.add(keyMatch[1]);
			if (envVarKeyMatch) blueprintKeys.add(envVarKeyMatch[1]);
		}
	}

	const managed = [];
	const unmanaged = [];

	for (const key of envExampleKeys) {
		if (blueprintKeys.has(key)) {
			managed.push(key);
		} else {
			unmanaged.push(key);
		}
	}

	return {
		totalEnvExampleKeys: envExampleKeys.size,
		envExampleKeys: Array.from(envExampleKeys).sort(),
		blueprintManagedKeys: managed.sort(),
		unmanagedKeys: unmanaged.sort(),
	};
}

/**
 * CLI Main execution
 */
function main() {
	try {
		const args = parseArgs();

		if (args.help) {
			console.log(`
Cabros Bot - Production Environment Synchronization Tool

Usage:
  node scripts/sync-production-env.js --key <VAR_NAME> [options]
  node scripts/sync-production-env.js <VAR_NAME> [options]
  node scripts/sync-production-env.js --check-drift

Options:
  --key, -k <NAME>       Variable name to synchronize (required for sync plan)
  --dry-run              Print planned platform actions without mutating (default)
  --apply                Prompt and record applied sync
  --no-op <platform>     Mark platform as explicit no-op (e.g. --no-op vercel)
  --no-op-reason <p=r>   Reason for no-op (e.g. --no-op-reason vercel="Web-only host")
  --log-file <path>      Path to local sync log (default: .env-sync.log)
  --check-drift, --diff  Diff .env.example against platform deployment definitions
  --json                 Output results as JSON
  --help, -h             Show this help message

Security Rules:
  - NEVER pass variable values on argv (e.g. --key FOO=bar is strictly rejected).
  - Secrets must be entered interactively or through platform dashboard/CLI secret prompts.
`);
			process.exit(0);
		}

		const repoRoot = path.resolve(__dirname, '..');

		if (args.checkDrift) {
			const drift = checkEnvironmentDrift(repoRoot);
			if (args.json) {
				console.log(JSON.stringify(drift, null, 2));
			} else {
				console.log('\n=== Environment Drift Analysis ===\n');
				console.log(`Total .env.example variables: ${drift.totalEnvExampleKeys}`);
				console.log(`Variables declared in render.yaml: ${drift.blueprintManagedKeys.length}`);
				console.log(`Variables not declared in render.yaml: ${drift.unmanagedKeys.length}\n`);
				if (drift.unmanagedKeys.length > 0) {
					console.log('Unmanaged in blueprint:');
					drift.unmanagedKeys.forEach((k) => console.log(`  - ${k}`));
				}
			}
			process.exit(0);
		}

		if (!args.key) {
			console.error('Error: Variable name is required. Specify --key <NAME> or pass as positional argument.');
			console.error('Run with --help for usage details.');
			process.exit(1);
		}

		const plan = generateSyncPlan(args.key, {
			repoRoot,
			noOpPlatforms: args.noOpPlatforms,
			noOpReasons: args.noOpReasons,
		});

		if (args.json) {
			console.log(JSON.stringify(plan, null, 2));
			process.exit(0);
		}

		console.log(`\n=== Production Environment Sync Plan for ${plan.key} ===\n`);
		console.log(`Mode: ${args.dryRun ? 'DRY-RUN (Planned actions only)' : 'APPLY'}`);
		console.log(`Generated At: ${plan.generatedAt}\n`);

		// Render
		console.log('--- 1. Render Production ---');
		if (plan.platforms.render.isNoOp) {
			console.log(`Status: NO-OP (${plan.platforms.render.noOpReason})`);
		} else {
			console.log(`Affected Services: ${plan.platforms.render.services.join(', ') || 'cabros-crypto-bot-telegram-iac (default)'}`);
			console.log('Commands:');
			plan.platforms.render.commands.forEach((c) => console.log(`  ${c}`));
		}
		console.log('');

		// Railway
		console.log('--- 2. Railway Production ---');
		if (plan.platforms.railway.isNoOp) {
			console.log(`Status: NO-OP (${plan.platforms.railway.noOpReason})`);
		} else {
			console.log(`Project: ${plan.platforms.railway.project} | Environment: ${plan.platforms.railway.environment} | Service: ${plan.platforms.railway.service}`);
			console.log('Commands:');
			plan.platforms.railway.commands.forEach((c) => console.log(`  ${c}`));
		}
		console.log('');

		// Vercel
		console.log('--- 3. Vercel Production ---');
		if (plan.platforms.vercel.isNoOp) {
			console.log(`Status: NO-OP (${plan.platforms.vercel.noOpReason})`);
		} else {
			console.log(`Project: ${plan.platforms.vercel.project}`);
			console.log('Commands:');
			plan.platforms.vercel.commands.forEach((c) => console.log(`  ${c}`));
		}
		console.log('');

		// If apply mode, record to log
		if (args.apply) {
			const statuses = {
				render: plan.platforms.render.isNoOp ? `NO_OP (${plan.platforms.render.noOpReason})` : 'APPLIED',
				railway: plan.platforms.railway.isNoOp ? `NO_OP (${plan.platforms.railway.noOpReason})` : 'APPLIED',
				vercel: plan.platforms.vercel.isNoOp ? `NO_OP (${plan.platforms.vercel.noOpReason})` : 'APPLIED',
			};
			recordSyncLog({
				key: plan.key,
				logFile: args.logFile,
				statuses,
			});
			console.log(`\n✓ Sync audit record appended to ${args.logFile}`);
		} else {
			console.log(`Tip: Run with --apply to record timestamped execution in ${args.logFile}`);
		}
	} catch (error) {
		console.error(`\nError: ${error.message}\n`);
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}

module.exports = {
	validateVariableName,
	parseArgs,
	detectRenderServices,
	generateSyncPlan,
	recordSyncLog,
	checkEnvironmentDrift,
};
