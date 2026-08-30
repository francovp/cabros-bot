#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_PROJECT = 'cabros-bot';
const DEFAULT_MAX_AGE_DAYS = 3;
const DEFAULT_LOG_FILE = '.preview-channels-cleanup.log';
const LIVE_CHANNEL = 'live';

/**
 * Extract the channel id from a Firebase Hosting channel resource name.
 * Format: projects/{project}/sites/{site}/channels/{channelId}
 * @param {string} name
 * @returns {string|null}
 */
function channelIdFromName(name) {
	if (!name || typeof name !== 'string') return null;
	return name.split('/').pop() || null;
}

/**
 * Extract the site id from a Firebase Hosting channel resource name.
 * @param {string} name
 * @returns {string|null}
 */
function siteFromName(name) {
	if (!name || typeof name !== 'string') return null;
	const parts = name.split('/');
	// Canonical channel resource name: projects/{p}/sites/{s}/channels/{c}
	if (parts.length < 6 || parts[0] !== 'projects' || parts[2] !== 'sites') {
		return null;
	}
	return parts[3] || null;
}

/**
 * Parse CLI arguments
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv = process.argv.slice(2)) {
	const args = {
		dryRun: true,
		apply: false,
		project: DEFAULT_PROJECT,
		maxAgeDays: DEFAULT_MAX_AGE_DAYS,
		site: null,
		json: false,
		help: false,
		logFile: DEFAULT_LOG_FILE,
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
		} else if (arg === '--apply') {
			args.apply = true;
			args.dryRun = false;
			i++;
		} else if (arg === '--dry-run') {
			args.dryRun = true;
			args.apply = false;
			i++;
		} else if (arg === '--project') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --project');
			args.project = argv[i + 1];
			i += 2;
		} else if (arg === '--site') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --site');
			args.site = argv[i + 1];
			i += 2;
		} else if (arg === '--max-age-days') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --max-age-days');
			const value = Number(argv[i + 1]);
			if (!Number.isFinite(value) || value <= 0) {
				throw new Error('--max-age-days must be a positive number');
			}
			args.maxAgeDays = value;
			i += 2;
		} else if (arg === '--log-file') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --log-file');
			args.logFile = argv[i + 1];
			i += 2;
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown option: ${arg}`);
		} else {
			throw new Error(`Unexpected positional argument: ${arg}`);
		}
	}

	return args;
}

/**
 * Parse the stdout of `firebase hosting:channel:list --json` into a channel array.
 * Handles the CLI success envelope `{ status, result: { channels } }`, a bare
 * `{ channels }` object, or a raw array for test convenience.
 * @param {string|Object|Array} raw
 * @returns {Array}
 */
function parseChannelList(raw) {
	let parsed = raw;
	if (typeof raw === 'string') {
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			throw new Error(`Failed to parse hosting:channel:list JSON output: ${e.message}`);
		}
	}
	if (parsed && parsed.result && Array.isArray(parsed.result.channels)) {
		return parsed.result.channels;
	}
	if (parsed && Array.isArray(parsed.channels)) {
		return parsed.channels;
	}
	if (Array.isArray(parsed)) {
		return parsed;
	}
	return [];
}

/**
 * Select the preview (non-live) channels whose createTime is older than maxAgeDays.
 * Channels without a parseable createTime are skipped (never deleted).
 * @param {Array} channels
 * @param {Object} [opts]
 * @param {number} [opts.maxAgeDays]
 * @param {string|number|Date} [opts.now]
 * @returns {Array}
 */
function selectExpiredPreviewChannels(channels, opts = {}) {
	const maxAgeDays = opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS;
	const now = opts.now ? new Date(opts.now) : new Date();
	const cutoff = now.getTime() - maxAgeDays * 24 * 3600 * 1000;

	return channels
		.filter((c) => c && c.name)
		.map((c) => ({
			channelId: channelIdFromName(c.name),
			site: siteFromName(c.name) || c.site || null,
			createTime: c.createTime || null,
			expireTime: c.expireTime || null,
			url: c.url || null,
		}))
		.filter((c) => c.channelId && c.channelId !== LIVE_CHANNEL)
		.filter((c) => {
			if (!c.createTime) return false;
			const t = Date.parse(c.createTime);
			return Number.isFinite(t) && t < cutoff;
		});
}

/**
 * Resolve the local firebase-tools bin entry to drive from Node.
 * @param {string} [repoRoot]
 * @returns {string}
 */
function resolveFirebaseBin(repoRoot = path.join(__dirname, '..')) {
	try {
		return require.resolve('firebase-tools/lib/bin/firebase.js');
	} catch (e) {
		return path.join(repoRoot, 'node_modules', '.bin', 'firebase');
	}
}

/**
 * Run a firebase CLI subcommand in --json mode and return its parsed result.
 * @param {string} binPath
 * @param {string[]} args
 * @param {Object} [opts]
 * @returns {Object} parsed JSON body
 */
function runFirebaseJson(binPath, args, opts = {}) {
	const result = spawnSync(process.execPath, [binPath, ...args], {
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
		cwd: opts.cwd || path.join(__dirname, '..'),
	});

	if (result.error) {
		throw new Error(`Failed to launch firebase CLI: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = (result.stderr || '').trim();
		throw new Error(`firebase command failed (exit ${result.status}): ${stderr || result.stdout}`);
	}

	let body;
	try {
		body = JSON.parse(result.stdout);
	} catch (e) {
		throw new Error(`firebase command returned non-JSON output: ${result.stdout}`);
	}
	if (body && body.status === 'error') {
		throw new Error(`firebase command error: ${body.error || 'unknown error'}`);
	}
	return body;
}

/**
 * Build the deleter args for a single channel.
 * @param {Object} channel
 * @param {Object} opts
 * @returns {string[]}
 */
function buildDeleteArgs(channel, opts = {}) {
	const project = opts.project || DEFAULT_PROJECT;
	const site = channel.site || opts.site;
	const args = ['hosting:channel:delete', channel.channelId, '--force', '--json', '--project', project];
	if (site) {
		args.push('--site', site);
	}
	return args;
}

/**
 * Record a timestamped audit log entry into the cleanup log file.
 * @param {Object} entry
 * @returns {string} recorded line
 */
function recordCleanupLog(entry) {
	const { project, maxAgeDays, deletions = [], logFile = DEFAULT_LOG_FILE } = entry;
	const timestamp = new Date().toISOString();
	const logLine = `[${timestamp}] PROJECT=${project} MAX_AGE_DAYS=${maxAgeDays} DELETED=${deletions.length} CHANNELS=${(deletions.join(',') || '-').replace(/\s+/g, '')}\n`;

	const logDir = path.dirname(path.resolve(logFile));
	if (!fs.existsSync(logDir)) {
		fs.mkdirSync(logDir, { recursive: true });
	}

	fs.appendFileSync(logFile, logLine, 'utf8');
	return logLine;
}

/**
 * CLI main execution
 */
function main() {
	try {
		const args = parseArgs();

		if (args.help) {
			console.log(`
Cabros Bot - Firebase Hosting Preview Channel Cleanup Tool

Deletes Firebase Hosting preview channels (non-"live") whose creation time is older
than --max-age-days (default: ${DEFAULT_MAX_AGE_DAYS} days). The "live" channel is never
deleted. Channels without a parseable create time are skipped.

Usage:
  node scripts/cleanup-preview-channels.js [options]

Options:
  --project <id>       Firebase project id (default: ${DEFAULT_PROJECT})
  --site <siteId>      Hosting site id (default: resolved from project)
  --max-age-days <n>   Delete preview channels older than n days (default: ${DEFAULT_MAX_AGE_DAYS})
  --dry-run            Print what would be deleted without mutating (default)
  --apply              Actually delete the matching channels
  --log-file <path>    Path to local cleanup audit log (default: ${DEFAULT_LOG_FILE})
  --json               Output results as JSON
  --help, -h           Show this help message

The script drives the locally pinned firebase-tools CLI (hosting:channel:list /
hosting:channel:delete) and requires an authenticated firebase session (firebase login
or FIREBASE_TOKEN) with permission to update the hosting site.
`);
			process.exit(0);
		}

		const repoRoot = path.resolve(__dirname, '..');
		const binPath = resolveFirebaseBin(repoRoot);

		const listArgs = ['hosting:channel:list', '--json', '--project', args.project];
		if (args.site) {
			listArgs.push('--site', args.site);
		}

		const listBody = runFirebaseJson(binPath, listArgs, { cwd: repoRoot });
		const channels = parseChannelList(listBody);
		const candidates = selectExpiredPreviewChannels(channels, {
			maxAgeDays: args.maxAgeDays,
		});

		const summary = {
			mode: args.apply ? 'apply' : 'dry-run',
			project: args.project,
			site: args.site || (candidates[0] && candidates[0].site) || null,
			maxAgeDays: args.maxAgeDays,
			totalChannels: channels.length,
			toDelete: candidates.map((c) => ({
				channelId: c.channelId,
				site: c.site,
				createTime: c.createTime,
				expireTime: c.expireTime,
				url: c.url,
			})),
		};

		if (args.json) {
			console.log(JSON.stringify(summary, null, 2));
			process.exit(0);
		}

		console.log(`\n=== Firebase Hosting Preview Channel Cleanup ===`);
		console.log(`Mode: ${args.dryRun ? 'DRY-RUN (nothing deleted)' : 'APPLY'}`);
		console.log(`Project: ${args.project} | Site: ${summary.site || '(default)'} | Max age: ${args.maxAgeDays} days`);
		console.log(`Total channels: ${summary.totalChannels}`);
		console.log(`\nPreview channels older than ${args.maxAgeDays} days: ${candidates.length}`);
		candidates.forEach((c) => {
			console.log(`  - ${c.channelId} (site: ${c.site}, created: ${c.createTime}, url: ${c.url || 'n/a'})`);
		});

		if (candidates.length === 0) {
			console.log('\nNothing to delete. Exiting.');
			process.exit(0);
		}

		if (args.dryRun) {
			console.log(`\nTip: Re-run with --apply to delete these ${candidates.length} channel(s).`);
			process.exit(0);
		}

		const deletions = [];
		for (const channel of candidates) {
			console.log(`\nDeleting ${channel.channelId}...`);
			const deleteArgs = buildDeleteArgs(channel, { project: args.project, site: args.site });
			runFirebaseJson(binPath, deleteArgs, { cwd: repoRoot });
			deletions.push(channel.channelId);
			console.log(`  Done.`);
		}

		const logLine = recordCleanupLog({
			project: args.project,
			maxAgeDays: args.maxAgeDays,
			deletions,
			logFile: args.logFile,
		});
		console.log(`\n✓ Cleanup audit record appended to ${args.logFile}: ${logLine.trim()}`);
	} catch (error) {
		console.error(`\nError: ${error.message}\n`);
		process.exit(1);
	}
}

if (require.main === module) {
	main();
}

module.exports = {
	channelIdFromName,
	siteFromName,
	parseArgs,
	parseChannelList,
	selectExpiredPreviewChannels,
	resolveFirebaseBin,
	runFirebaseJson,
	buildDeleteArgs,
	recordCleanupLog,
	DEFAULT_PROJECT,
	DEFAULT_MAX_AGE_DAYS,
	LIVE_CHANNEL,
};