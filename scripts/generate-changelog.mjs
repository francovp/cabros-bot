#!/usr/bin/env node
// scripts/generate-changelog.mjs
//
// Build a structured, machine-readable changelog from git log on master
// (or any branch passed via --branch). Output is changelog.json at the
// repository root, with entries classified by Conventional Commits prefix.

import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const OUTPUT_PATH = join(REPO_ROOT, 'changelog.json');

const VALID_TYPES = new Set([
	'feat', 'fix', 'perf', 'chore', 'docs', 'refactor',
	'test', 'build', 'style', 'ci', 'revert',
]);

function parseArgs(argv) {
	const args = { branch: 'master', since: null, limit: 200, tag: null };
	for (const arg of argv.slice(2)) {
		if (arg.startsWith('--branch=')) args.branch = arg.slice('--branch='.length);
		else if (arg.startsWith('--since=')) args.since = arg.slice('--since='.length);
		else if (arg.startsWith('--limit=')) {
			const parsed = Number.parseInt(arg.slice('--limit='.length), 10);
			if (Number.isInteger(parsed) && parsed > 0) args.limit = parsed;
		}
		else if (arg.startsWith('--tag=')) args.tag = arg.slice('--tag='.length);
		else if (arg === '--help' || arg === '-h') args.help = true;
	}
	return args;
}

function readLatestTag() {
	try {
		const out = execFileSync('git', ['describe', '--tags', '--abbrev=0'],
			{ cwd: REPO_ROOT, encoding: 'utf8' });
		return out.trim() || null;
	} catch { return null; }
}

function safeExec(args) {
	try {
		return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
	} catch (error) {
		return { error: error.message || String(error) };
	}
}

function listCommits({ branch, since, limit, tag }) {
	const rangeArgs = [];
	if (tag) rangeArgs.push(`${tag}..${branch}`);
	else if (since) rangeArgs.push(`--since=${since}`, branch);
	else rangeArgs.push(branch);

	const result = safeExec(['log', '--no-merges',
		'--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e',
		'-n', String(limit), ...rangeArgs]);

	if (typeof result !== 'string') return result;
	if (!result.trim()) return [];

	return result.split('\x1e').map(l => l.replace(/\n$/, '')).filter(Boolean).map(line => {
		const [sha, shortSha, author, isoDate, subject] = line.split('\x1f');
		return { sha, shortSha, author, isoDate, subject };
	});
}

function classifyEntry(subject) {
	const match = /^(?<type>[a-z]+)(?:\((?<scope>[^)]+)\))?(?<bang>!)?: (?<summary>.+)$/i.exec(subject);
	if (!match || !match.groups) return { type: 'other', scope: null, summary: subject, breaking: false };
	const type = match.groups.type.toLowerCase();
	if (!VALID_TYPES.has(type)) return { type: 'other', scope: null, summary: subject, breaking: false };
	return { type, scope: match.groups.scope || null, summary: match.groups.summary.trim(), breaking: Boolean(match.groups.bang) };
}

function extractIssueNumbers(text) {
	const m = text.match(/#\d+/g) || [];
	return Array.from(new Set(m.map(s => Number.parseInt(s.slice(1), 10))));
}

function extractPrNumbers(text) {
	const m = text.match(/\(#(\d+)\)/g) || [];
	return Array.from(new Set(m.map(s => Number.parseInt(s.match(/\d+/)[0], 10))));
}

function buildEntries(commits) {
	return commits.map(commit => {
		const classification = classifyEntry(commit.subject);
		return {
			type: classification.type,
			scope: classification.scope,
			summary: classification.summary,
			breaking: classification.breaking,
			pr: extractPrNumbers(commit.subject)[0] || null,
			author: commit.author,
			mergedAt: commit.isoDate,
			commitSha: commit.sha,
			shortSha: commit.shortSha,
			issues: extractIssueNumbers(commit.subject),
		};
	});
}

function mergeWithExisting(entries) {
	if (!existsSync(OUTPUT_PATH)) return entries;
	try {
		const raw = JSON.parse(readFileSync(OUTPUT_PATH, 'utf8'));
		const seen = new Set(entries.map(e => e.commitSha));
		const older = (raw.entries || []).filter(e => !seen.has(e.commitSha));
		return [...entries, ...older];
	} catch { return entries; }
}

function readPackageVersion() {
	try {
		const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
		return pkg.version || '0.0.0';
	} catch { return '0.0.0'; }
}

function main() {
	const args = parseArgs(process.argv);
	if (args.help) {
		process.stdout.write('Usage: generate-changelog.mjs [--branch=BRANCH] [--since=DATE] [--limit=N] [--tag=TAG]\n');
		return 0;
	}

	const tag = args.tag || readLatestTag();
	const commitsOrError = listCommits({ branch: args.branch, since: args.since, limit: args.limit, tag });

	if (commitsOrError && commitsOrError.error) {
		const payload = {
			version: readPackageVersion(),
			generatedAt: new Date().toISOString(),
			branch: args.branch,
			sinceTag: tag,
			sinceDate: args.since,
			entries: [],
			reason: 'git_enumeration_failed',
			error: commitsOrError.error,
		};
		writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
		process.stderr.write(`[generate-changelog] git enumeration failed: ${commitsOrError.error}\n`);
		return 0;
	}

	const entries = buildEntries(commitsOrError);
	const merged = mergeWithExisting(entries);

	const payload = {
		version: readPackageVersion(),
		generatedAt: new Date().toISOString(),
		branch: args.branch,
		sinceTag: tag,
		sinceDate: args.since,
		entries: merged,
	};

	writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2));
	process.stdout.write(`[generate-changelog] wrote ${merged.length} entries to ${OUTPUT_PATH} (branch=${args.branch}, tag=${tag || 'none'})\n`);
	return 0;
}

process.exit(main());
