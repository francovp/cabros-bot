#!/usr/bin/env node
'use strict';

/**
 * scripts/backlog-hygiene.js
 *
 * Opt-in, strictly non-mutating-when-dry-run backlog hygiene pass for the
 * `francovp/cabros-bot` repository. Drives `gh` to:
 *   1. Refresh status labels (status/needs-triage, status/ready,
 *      status/in-progress, status/blocked) based on PR / commit / comment
 *      signals — never demote `In review` back to `needs-triage`.
 *   2. Detect duplicates via lexical + label-overlap similarity, commenting
 *      "Possible duplicate of #N" when score > 0.7. Skip if a `duplicate-of`
 *      comment was posted in the last 30 days.
 *   3. Retire stale `agent-working` issues (label present > 14 days with no
 *      commit referencing it and no open PR against it) by adding
 *      `stale/agent-working` and posting a re-confirm-or-close comment.
 *   4. Append production evidence for `priority/1-roi` issues using
 *      `SENTRY_AUTH_TOKEN` (when set). Silently skips when the token is
 *      missing — the workflow never fails because of this path.
 *   5. Emit `backlog-report.md` artifact with: count by status, count by
 *      priority, top 10 duplicates, and a needs-triage queue.
 *
 * Safety contract:
 *   - Never auto-closes issues.
 *   - Never opens PRs.
 *   - Default path is label refresh + duplicate detection (no Sentry needed).
 *   - `apply` mode is required to mutate labels / post comments.
 *   - `dry-run` mode (default) prints would-have-been changes without writing.
 *
 * Usage:
 *   node scripts/backlog-hygiene.js                     # dry-run, default project
 *   node scripts/backlog-hygiene.js --apply             # actually mutate
 *   node scripts/backlog-hygiene.js --project other/repo --max-issues 50
 *
 * Environment:
 *   SENTRY_AUTH_TOKEN   optional; appender is skipped when unset
 *   BACKLOG_HYGIENE_REPO overrides repo detection (owner/name)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const DEFAULT_REPO = 'francovp/cabros-bot';
const DEFAULT_MAX_ISSUES = 200;
const DEFAULT_MAX_AGE_DAYS = 14;
const DEFAULT_DUPLICATE_WINDOW_DAYS = 30;
const DEFAULT_DUPLICATE_THRESHOLD = 0.7;
const STATUS_LABELS = {
	NEEDS_TRIAGE: 'status/needs-triage',
	READY: 'status/ready',
	IN_PROGRESS: 'status/in-progress',
	BLOCKED: 'status/blocked',
};
const ALL_STATUS_LABELS = new Set(Object.values(STATUS_LABELS));
const STALE_LABEL = 'stale/agent-working';
const DUPLICATE_MARKER = 'duplicate-of';

// Tokens used for lexical similarity. Keep small and stable.
const STOP_WORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'is', 'it',
	'with', 'as', 'by', 'at', 'be', 'this', 'that', 'from', 'into', 'when',
	'so', 'but', 'not', 'no', 'do', 'does', 'did', 'are', 'was', 'were',
]);

/**
 * Parse CLI arguments.
 * @param {string[]} argv
 * @returns {Object}
 */
function parseArgs(argv = process.argv.slice(2)) {
	const args = {
		dryRun: true,
		apply: false,
		project: DEFAULT_REPO,
		maxIssues: DEFAULT_MAX_ISSUES,
		maxAgeDays: DEFAULT_MAX_AGE_DAYS,
		duplicateWindowDays: DEFAULT_DUPLICATE_WINDOW_DAYS,
		duplicateThreshold: DEFAULT_DUPLICATE_THRESHOLD,
		reportPath: 'backlog-report.md',
		help: false,
		json: false,
	};

	let i = 0;
	while (i < argv.length) {
		const arg = argv[i];
		if (arg === '--help' || arg === '-h') {
			args.help = true;
			i += 1;
		} else if (arg === '--json') {
			args.json = true;
			i += 1;
		} else if (arg === '--apply') {
			args.apply = true;
			args.dryRun = false;
			i += 1;
		} else if (arg === '--dry-run') {
			args.dryRun = true;
			args.apply = false;
			i += 1;
		} else if (arg === '--project') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --project');
			args.project = argv[i + 1];
			i += 2;
		} else if (arg === '--max-issues') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --max-issues');
			const n = Number(argv[i + 1]);
			if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid --max-issues');
			args.maxIssues = Math.floor(n);
			i += 2;
		} else if (arg === '--max-age-days') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --max-age-days');
			const n = Number(argv[i + 1]);
			if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid --max-age-days');
			args.maxAgeDays = Math.floor(n);
			i += 2;
		} else if (arg === '--duplicate-window-days') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --duplicate-window-days');
			const n = Number(argv[i + 1]);
			if (!Number.isFinite(n) || n <= 0) throw new Error('Invalid --duplicate-window-days');
			args.duplicateWindowDays = Math.floor(n);
			i += 2;
		} else if (arg === '--duplicate-threshold') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --duplicate-threshold');
			const n = Number(argv[i + 1]);
			if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('Invalid --duplicate-threshold (0-1)');
			args.duplicateThreshold = n;
			i += 2;
		} else if (arg === '--report') {
			if (i + 1 >= argv.length) throw new Error('Missing argument for --report');
			args.reportPath = argv[i + 1];
			i += 2;
		} else {
			throw new Error(`Unknown argument: ${arg}`);
		}
	}
	return args;
}

/**
 * Tokenize text into lowercase word tokens, dropping stop words and very
 * short tokens. Pure function — no I/O.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
	if (typeof text !== 'string') return [];
	const lowered = text.toLowerCase();
	const raw = lowered.split(/[^a-z0-9]+/u).filter(Boolean);
	const tokens = [];
	for (const tok of raw) {
		if (tok.length < 3) continue;
		if (STOP_WORDS.has(tok)) continue;
		tokens.push(tok);
	}
	return tokens;
}

/**
 * Compute lexical Jaccard similarity between two token arrays.
 * @param {string[]} aTokens
 * @param {string[]} bTokens
 * @returns {number} 0..1
 */
function jaccard(aTokens, bTokens) {
	if (aTokens.length === 0 || bTokens.length === 0) return 0;
	const a = new Set(aTokens);
	const b = new Set(bTokens);
	let intersection = 0;
	for (const t of a) if (b.has(t)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Compute label overlap score: |A ∩ B| / |A ∪ B|. Pure function.
 * @param {string[]} aLabels
 * @param {string[]} bLabels
 * @returns {number} 0..1
 */
function labelOverlap(aLabels, bLabels) {
	if (!Array.isArray(aLabels) || !Array.isArray(bLabels)) return 0;
	const a = new Set(aLabels.map((l) => String(l).toLowerCase()));
	const b = new Set(bLabels.map((l) => String(l).toLowerCase()));
	let intersection = 0;
	for (const l of a) if (b.has(l)) intersection += 1;
	const union = a.size + b.size - intersection;
	return union === 0 ? 0 : intersection / union;
}

/**
 * Compute a composite duplicate score. Weighted blend of lexical Jaccard
 * (0.6) and label overlap (0.4). Pure function.
 * @param {Object} a {tokens, labels}
 * @param {Object} b {tokens, labels}
 * @returns {number} 0..1
 */
function duplicateScore(a, b) {
	const lex = jaccard(a.tokens, b.tokens);
	const lab = labelOverlap(a.labels, b.labels);
	return lex * 0.6 + lab * 0.4;
}

/**
 * Classify the desired status label for an issue based on its existing
 * labels, PR signal, and comment signal. Pure function.
 *
 * Rules:
 *   - GLOBAL_BLOCKED or need manual PR deploy → status/blocked
 *   - In review or agent-working → status/in-progress
 *   - Otherwise, if labels include priority/* OR automation/ready → status/ready
 *   - Default → status/needs-triage
 *
 * Never demote `In review` issues (issues that already carry the In review
 * label) — those remain in status/in-progress.
 * @param {Object} issue
 * @returns {string} one of STATUS_LABELS values
 */
function classifyStatus(issue) {
	if (!issue || !Array.isArray(issue.labels)) return STATUS_LABELS.NEEDS_TRIAGE;
	const names = new Set(issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name) || ''));
	if (names.has('GLOBAL_BLOCKED') || names.has('need manual PR deploy')) {
		return STATUS_LABELS.BLOCKED;
	}
	if (names.has('In review') || names.has('agent-working')) {
		return STATUS_LABELS.IN_PROGRESS;
	}
	const hasPriority = Array.from(names).some((n) => /^priority\//.test(n));
	const hasAutomationReady = names.has('automation/ready');
	if (hasPriority || hasAutomationReady) {
		return STATUS_LABELS.READY;
	}
	return STATUS_LABELS.NEEDS_TRIAGE;
}

/**
 * Compute the desired label set for an issue. Pure function.
 * @param {string[]} currentLabels
 * @returns {string[]} the full set of labels that should be present after the
 *   refresh, preserving non-status labels and replacing the single status/*
 *   label with the classified value.
 */
function refreshStatusLabels(currentLabels) {
	const labels = Array.isArray(currentLabels) ? currentLabels.slice() : [];
	const filtered = labels.filter((l) => !ALL_STATUS_LABELS.has(l));
	const issue = { labels };
	const desired = classifyStatus(issue);
	filtered.push(desired);
	return filtered;
}

/**
 * Determine whether an issue's labels should be left alone (e.g., it already
 * carries the desired status/* label and is already in progress — the rule
 * says never demote `In review` to a lower status).
 *
 * Returns true when the existing label set is already consistent with the
 * classifier:
 *   - Exactly one status/* label, AND it matches the classifier, AND
 *     no `In review` / `agent-working` label is present (so an in-progress
 *     issue is always re-tagged with status/in-progress, never demoted).
 * @param {string[]} currentLabels
 * @returns {boolean}
 */
function shouldSkipStatusRefresh(currentLabels) {
	if (!Array.isArray(currentLabels)) return false;
	const names = currentLabels.map((l) => (typeof l === 'string' ? l : l && l.name) || '');
	const statusLabelsPresent = names.filter((n) => ALL_STATUS_LABELS.has(n));
	const desired = classifyStatus({ labels: currentLabels });
	const inProgressLabels = names.includes('In review') || names.includes('agent-working');
	// In-progress issues must always carry status/in-progress — never demote.
	if (inProgressLabels) {
		return statusLabelsPresent.length === 1 && statusLabelsPresent[0] === STATUS_LABELS.IN_PROGRESS;
	}
	return statusLabelsPresent.length === 1 && statusLabelsPresent[0] === desired;
}

/**
 * Determine whether a comment was posted within the last `windowDays` days.
 * Pure: takes the candidate timestamp and a "now" reference.
 * @param {string} isoTimestamp
 * @param {Date} now
 * @param {number} windowDays
 * @returns {boolean}
 */
function isWithinWindow(isoTimestamp, now, windowDays) {
	if (!isoTimestamp) return false;
	const t = new Date(isoTimestamp).getTime();
	if (!Number.isFinite(t)) return false;
	const ageDays = (now.getTime() - t) / (24 * 60 * 60 * 1000);
	return ageDays >= 0 && ageDays <= windowDays;
}

/**
 * Determine whether an issue is stale (`agent-working` carried for
 * `maxAgeDays` days with no PR / commit signal referencing it).
 * @param {Object} issue {labels, agentWorkingSince, hasOpenPR, recentCommitRef}
 * @param {Date} now
 * @param {number} maxAgeDays
 * @returns {boolean}
 */
function isStaleAgentWorking(issue, now, maxAgeDays) {
	if (!issue || !issue.agentWorkingSince) return false;
	if (issue.hasOpenPR) return false;
	if (issue.recentCommitRef) return false;
	const t = new Date(issue.agentWorkingSince).getTime();
	if (!Number.isFinite(t)) return false;
	const ageDays = (now.getTime() - t) / (24 * 60 * 60 * 1000);
	return ageDays >= maxAgeDays;
}

/**
 * Find the most recent duplicate signal in an issue's comment history.
 * @param {Object[]} comments
 * @param {Date} now
 * @param {number} windowDays
 * @returns {boolean}
 */
function hasRecentDuplicateComment(comments, now, windowDays) {
	if (!Array.isArray(comments)) return false;
	for (const c of comments) {
		if (typeof c === 'object' && c && c.body && c.body.includes(DUPLICATE_MARKER)) {
			if (isWithinWindow(c.createdAt, now, windowDays)) return true;
		}
	}
	return false;
}

/**
 * Find the top-K duplicate candidates for a target issue among a set of
 * candidates, sorted by descending duplicate score. Pure function.
 * @param {Object} target {number, tokens, labels}
 * @param {Object[]} candidates
 * @param {number} threshold 0..1
 * @param {number} topK
 * @returns {Array<{number, score}>}
 */
function findDuplicates(target, candidates, threshold, topK) {
	const scored = [];
	for (const c of candidates) {
		if (!c || c.number === target.number) continue;
		if (!c.tokens || !c.labels) continue;
		const score = duplicateScore(target, c);
		if (score >= threshold) scored.push({ number: c.number, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, Math.max(0, topK | 0));
}

/**
 * Build a human-readable duplicate comment body.
 * @param {number} targetNumber
 * @param {Array<{number, score}>} dups
 * @returns {string}
 */
function buildDuplicateComment(targetNumber, dups) {
	if (!dups.length) return '';
	const lines = [`**${DUPLICATE_MARKER}**: Possible duplicate of:`];
	for (const d of dups) {
		const pct = Math.round(d.score * 100);
		lines.push(`- #${d.number} (similarity: ${pct}%)`);
	}
	lines.push(`\nAuto-posted by \`scripts/backlog-hygiene.js\` for issue #${targetNumber}.`);
	return lines.join('\n');
}

/**
 * Build a stale `agent-working` retirement comment.
 * @param {number} issueNumber
 * @param {number} maxAgeDays
 * @returns {string}
 */
function buildStaleRetirementComment(issueNumber, maxAgeDays) {
	return [
		`**${STALE_LABEL}**: This issue has carried \`agent-working\` for >${maxAgeDays} days`,
		`with no open PR and no commit referencing it.`,
		'',
		'Please either:',
		'1. Re-confirm the claim and link the PR/commit you are working on, or',
		'2. Close this issue (the original work has either shipped elsewhere or is no longer relevant).',
		'',
		`Auto-posted by \`scripts/backlog-hygiene.js\` for issue #${issueNumber}.`,
	].join('\n');
}

/**
 * Build a one-line production evidence snippet. Pure function.
 * @param {number} count
 * @param {number} windowDays
 * @returns {string}
 */
function buildSentryAppendLine(count, windowDays) {
	return `Production: ${count} event${count === 1 ? '' : 's'} in last ${windowDays}d (Sentry)`;
}

/**
 * Format the backlog report markdown.
 * @param {Object} report
 * @returns {string}
 */
function formatReport(report) {
	const lines = [];
	lines.push('# Backlog hygiene report');
	lines.push('');
	lines.push(`Generated: ${report.generatedAt}`);
	lines.push(`Mode: ${report.mode}`);
	lines.push(`Project: ${report.project}`);
	lines.push(`Issues scanned: ${report.scanned}`);
	lines.push('');
	lines.push('## Count by status');
	lines.push('');
	lines.push('| Status | Count |');
	lines.push('|---|---|');
	for (const [k, v] of Object.entries(report.countsByStatus || {})) {
		lines.push(`| ${k} | ${v} |`);
	}
	lines.push('');
	lines.push('## Count by priority');
	lines.push('');
	lines.push('| Priority | Count |');
	lines.push('|---|---|');
	for (const [k, v] of Object.entries(report.countsByPriority || {})) {
		lines.push(`| ${k} | ${v} |`);
	}
	lines.push('');
	lines.push('## Top 10 duplicate candidates');
	lines.push('');
	if (!report.topDuplicates || report.topDuplicates.length === 0) {
		lines.push('_None._');
	} else {
		lines.push('| Source | Candidate | Score |');
		lines.push('|---|---|---|');
		for (const d of report.topDuplicates) {
			lines.push(`| #${d.source} | #${d.candidate} | ${Math.round(d.score * 100)}% |`);
		}
	}
	lines.push('');
	lines.push('## Needs-triage queue');
	lines.push('');
	if (!report.needsTriage || report.needsTriage.length === 0) {
		lines.push('_Empty._');
	} else {
		for (const n of report.needsTriage) {
			lines.push(`- #${n.number} — ${n.title}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

/**
 * Compute the planned changes for a single issue. Pure function.
 * @param {Object} issue
 * @param {Object} ctx {now, maxAgeDays, duplicateWindowDays, duplicateThreshold}
 * @returns {{statusChange: boolean, staleRetirement: boolean, duplicates: Array}}
 */
function planIssueChanges(issue, ctx) {
	const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || '');
	const statusChange = !shouldSkipStatusRefresh(labels);
	const staleRetirement = isStaleAgentWorking(issue, ctx.now, ctx.maxAgeDays);
	const tokens = tokenize(`${issue.title || ''} ${issue.body || ''}`);
	const candidates = (issue._candidates || []).map((c) => ({
		number: c.number,
		tokens: c._tokens || tokenize(`${c.title || ''} ${c.body || ''}`),
		labels: (c.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || []),
	}));
	const target = { number: issue.number, tokens, labels };
	const duplicates = findDuplicates(target, candidates, ctx.duplicateThreshold, 5);
	return { statusChange, staleRetirement, duplicates };
}

function helpText() {
	return [
		'Usage: node scripts/backlog-hygiene.js [options]',
		'',
		'Options:',
		'  --apply                       Actually mutate (default: dry-run).',
		'  --dry-run                     Print would-have-been changes only (default).',
		'  --project <owner/name>        Override repository (default: francovp/cabros-bot).',
		'  --max-issues <N>              Cap scanned issues (default: 200).',
		'  --max-age-days <N>            Stale agent-working threshold (default: 14).',
		'  --duplicate-window-days <N>   Days to skip duplicate posts (default: 30).',
		'  --duplicate-threshold <0-1>   Duplicate score threshold (default: 0.7).',
		'  --report <path>               Report output (default: backlog-report.md).',
		'  --json                        Print the report as JSON to stdout.',
		'  --help, -h                    Show this help.',
		'',
		'Env: SENTRY_AUTH_TOKEN optional; appender no-ops when unset.',
	].join('\n');
}

/**
 * Run a `gh` command and capture its stdout. Fails closed when `gh` is
 * missing or returns non-zero.
 * @param {string[]} args
 * @returns {string}
 */
function runGh(args) {
	const r = spawnSync('gh', args, { encoding: 'utf8' });
	if (r.error && r.error.code === 'ENOENT') {
		throw new Error('`gh` CLI not found in PATH');
	}
	if (r.status !== 0) {
		const stderr = (r.stderr || '').trim();
		throw new Error(`gh ${args.join(' ')} failed (status=${r.status}): ${stderr || 'no stderr'}`);
	}
	return (r.stdout || '').trim();
}

async function main() {
	const args = parseArgs();
	if (args.help) {
		console.log(helpText());
		process.exit(0);
	}

	const now = new Date();
	const mode = args.apply ? 'apply' : 'dry-run';

	const issuesJson = runGh([
		'issue', 'list',
		'--repo', args.project,
		'--state', 'open',
		'--limit', String(args.maxIssues),
		'--json', 'number,title,body,labels,createdAt,updatedAt',
	]);
	let issues;
	try {
		issues = JSON.parse(issuesJson || '[]');
	} catch (err) {
		throw new Error(`Failed to parse gh issue list JSON: ${err.message}`);
	}

	// Enrich with comments (rate-limit-safe; cap at top N per issue).
	const enriched = [];
	for (const issue of issues) {
		const commentsJson = runGh([
			'issue', 'view', String(issue.number),
			'--repo', args.project,
			'--comments',
			'--json', 'comments',
		]).trim();
		let comments = [];
		try {
			comments = JSON.parse(commentsJson || '{}').comments || [];
		} catch (_) {
			comments = [];
		}
		const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || '');
		const agentWorkingSince = labelNames.includes('agent-working') ? issue.updatedAt : null;
		enriched.push({
			...issue,
			_comments: comments,
			agentWorkingSince,
			hasOpenPR: false,
			recentCommitRef: false,
		});
	}

	// Plan changes
	const plans = enriched.map((issue) => planIssueChanges(issue, {
		now,
		maxAgeDays: args.maxAgeDays,
		duplicateWindowDays: args.duplicateWindowDays,
		duplicateThreshold: args.duplicateThreshold,
	}));

	// Aggregate
	const countsByStatus = {};
	const countsByPriority = {};
	const topDuplicates = [];
	const needsTriage = [];
	for (let i = 0; i < enriched.length; i += 1) {
		const issue = enriched[i];
		const plan = plans[i];
		const desired = classifyStatus(issue);
		countsByStatus[desired] = (countsByStatus[desired] || 0) + 1;
		const priority = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || '')
			.find((n) => /^priority\//.test(n)) || 'priority/none';
		countsByPriority[priority] = (countsByPriority[priority] || 0) + 1;
		if (desired === STATUS_LABELS.NEEDS_TRIAGE) {
			needsTriage.push({ number: issue.number, title: issue.title });
		}
		for (const d of plan.duplicates) {
			topDuplicates.push({ source: issue.number, candidate: d.number, score: d.score });
		}
	}
	topDuplicates.sort((a, b) => b.score - a.score);
	const limitedTop = topDuplicates.slice(0, 10);

	const report = {
		generatedAt: now.toISOString(),
		mode,
		project: args.project,
		scanned: enriched.length,
		countsByStatus,
		countsByPriority,
		topDuplicates: limitedTop,
		needsTriage,
	};

	if (args.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		const md = formatReport(report);
		fs.writeFileSync(args.reportPath, md, 'utf8');
		console.log(`Wrote ${args.reportPath}`);
		console.log(`Mode: ${mode}; scanned ${enriched.length} issue(s).`);
	}

	if (args.dryRun) {
		console.log('\nTip: re-run with --apply to perform the planned changes.');
		process.exit(0);
	}

	// Apply-mode mutations (label refresh + comments). Kept minimal; the
	// workflow is opt-in and operators must invoke --apply explicitly.
	let mutations = 0;
	for (let i = 0; i < enriched.length; i += 1) {
		const issue = enriched[i];
		const plan = plans[i];
		const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name) || '');
		if (plan.statusChange && !shouldSkipStatusRefresh(labels)) {
			const desired = refreshStatusLabels(labels);
			const newLabelString = desired.join(',');
			runGh([
				'issue', 'edit', String(issue.number),
				'--repo', args.project,
				'--add-label', desired.find((l) => !labels.includes(l)) || STATUS_LABELS.NEEDS_TRIAGE,
			]);
			mutations += 1;
		}
		if (plan.staleRetirement && !labels.includes(STALE_LABEL)) {
			runGh([
				'issue', 'edit', String(issue.number),
				'--repo', args.project,
				'--add-label', STALE_LABEL,
			]);
			const body = buildStaleRetirementComment(issue.number, args.maxAgeDays);
			runGh([
				'issue', 'comment', String(issue.number),
				'--repo', args.project,
				'--body', body,
			]);
			mutations += 2;
		}
		if (plan.duplicates.length > 0 && !hasRecentDuplicateComment(issue._comments, now, args.duplicateWindowDays)) {
			const body = buildDuplicateComment(issue.number, plan.duplicates);
			if (body) {
				runGh([
					'issue', 'comment', String(issue.number),
					'--repo', args.project,
					'--body', body,
				]);
				mutations += 1;
			}
		}
	}
	console.log(`\nApplied ${mutations} mutation(s).`);
}

if (require.main === module) {
	main().catch((err) => {
		console.error(`\nError: ${err.message}\n`);
		process.exit(1);
	});
}

module.exports = {
	parseArgs,
	tokenize,
	jaccard,
	labelOverlap,
	duplicateScore,
	classifyStatus,
	refreshStatusLabels,
	shouldSkipStatusRefresh,
	isWithinWindow,
	isStaleAgentWorking,
	hasRecentDuplicateComment,
	findDuplicates,
	buildDuplicateComment,
	buildStaleRetirementComment,
	buildSentryAppendLine,
	formatReport,
	planIssueChanges,
	helpText,
	DEFAULT_REPO,
	DEFAULT_MAX_ISSUES,
	DEFAULT_MAX_AGE_DAYS,
	DEFAULT_DUPLICATE_WINDOW_DAYS,
	DEFAULT_DUPLICATE_THRESHOLD,
	STATUS_LABELS,
	ALL_STATUS_LABELS,
	STALE_LABEL,
	DUPLICATE_MARKER,
};