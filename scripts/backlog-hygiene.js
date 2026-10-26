#!/usr/bin/env node
/**
 * scripts/backlog-hygiene.js
 * Opt-in GitHub Actions backlog hygiene automation:
 * - Refreshes status labels (exactly one of needs-triage, ready, in-progress, blocked)
 * - Detects duplicate issues via lexical + label overlap
 * - Retires stale agent-working issues (>14 days without referencing PR or commits)
 * - Optionally appends production Sentry event evidence for priority/1-roi issues
 * - Emits a structured backlog-report.md artifact
 *
 * Strict safety rules:
 * - Never auto-closes issues or opens PRs
 * - Defaults to dry-run mode unless --apply is passed
 * - Fails closed if gh authentication is missing
 */

const fs = require('fs');
const { execFileSync } = require('child_process');

function defaultExecGh(args, options = {}) {
	return execFileSync('gh', args, {
		stdio: 'pipe',
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
		...options,
	});
}

const STOP_WORDS = new Set([
	'the', 'a', 'an', 'and', 'or', 'in', 'on', 'for', 'to', 'of', 'with', 'is', 'are',
	'was', 'were', 'this', 'that', 'it', 'from', 'as', 'at', 'by', 'be', 'has', 'have',
	'had', 'not', 'but', 'if', 'all', 'any', 'can', 'do', 'we', 'you', 'so', 'fix',
	'add', 'update', 'feat', 'bug', 'issue', 'chore', 'when', 'during', 'while', 'how',
]);

const STATUS_LABELS = [
	'status/blocked',
	'status/in-progress',
	'status/ready',
	'status/needs-triage',
];

/**
 * Parses CLI arguments.
 */
function parseArgs(argv = process.argv.slice(2)) {
	const options = {
		dryRun: true,
		repo: '',
		reportPath: 'backlog-report.md',
		limit: 200,
		staleDays: 14,
		threshold: 0.7,
	};

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--apply') {
			options.dryRun = false;
		} else if (arg === '--dry-run') {
			options.dryRun = true;
		} else if (arg === '--repo' && i + 1 < argv.length) {
			options.repo = argv[++i];
		} else if (arg === '--report' && i + 1 < argv.length) {
			options.reportPath = argv[++i];
		} else if (arg === '--limit' && i + 1 < argv.length) {
			options.limit = parseInt(argv[++i], 10) || 200;
		} else if (arg === '--stale-days' && i + 1 < argv.length) {
			options.staleDays = parseInt(argv[++i], 10) || 14;
		} else if (arg === '--threshold' && i + 1 < argv.length) {
			options.threshold = parseFloat(argv[++i]) || 0.7;
		}
	}

	return options;
}

/**
 * Determines canonical status label for an issue based on current labels and signals.
 * Rules:
 * 1. status/blocked if GLOBAL_BLOCKED is present.
 * 2. status/in-progress if agent-working or In review is present (never demote In review).
 * 3. status/ready if status/ready or automation/ready is present.
 * 4. status/needs-triage otherwise (or if status/triage is present).
 */
function determineStatusLabel(issue) {
	const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
	const labelSet = new Set(labels);

	if (labelSet.has('GLOBAL_BLOCKED')) {
		return 'status/blocked';
	}
	if (labelSet.has('agent-working') || labelSet.has('In review')) {
		return 'status/in-progress';
	}
	if (labelSet.has('status/ready') || labelSet.has('automation/ready')) {
		return 'status/ready';
	}
	return 'status/needs-triage';
}

/**
 * Tokenizes text into a set of lowercased, stemmed/stopword-filtered tokens.
 */
function tokenize(text = '') {
	return new Set(
		text
			.toLowerCase()
			.replace(/[^a-z0-9\s-]/g, ' ')
			.split(/\s+/)
			.filter((word) => word.length > 2 && !STOP_WORDS.has(word))
	);
}

/**
 * Computes Sørensen-Dice similarity between two sets.
 */
function diceSimilarity(setA, setB) {
	if (!setA.size && !setB.size) return 0;
	let intersection = 0;
	for (const item of setA) {
		if (setB.has(item)) intersection += 1;
	}
	const total = setA.size + setB.size;
	return total > 0 ? (2 * intersection) / total : 0;
}

/**
 * Calculates similarity between two issues using weighted lexical + label overlap.
 */
function calculateSimilarity(issueA, issueB) {
	const titleTokensA = tokenize(issueA.title || '');
	const titleTokensB = tokenize(issueB.title || '');
	const bodyTokensA = tokenize(issueA.body || '');
	const bodyTokensB = tokenize(issueB.body || '');

	const titleSim = diceSimilarity(titleTokensA, titleTokensB);
	const bodySim = diceSimilarity(bodyTokensA, bodyTokensB);

	const labelsA = new Set(
		(issueA.labels || [])
			.map((l) => (typeof l === 'string' ? l : l.name))
			.filter((l) => !l.startsWith('status/'))
	);
	const labelsB = new Set(
		(issueB.labels || [])
			.map((l) => (typeof l === 'string' ? l : l.name))
			.filter((l) => !l.startsWith('status/'))
	);
	const labelSim = diceSimilarity(labelsA, labelsB);

	if (labelsA.size > 0 && labelsB.size > 0) {
		return 0.7 * titleSim + 0.2 * bodySim + 0.1 * labelSim;
	}
	return 0.8 * titleSim + 0.2 * bodySim;
}

/**
 * Identifies duplicate issues among open issues and recent closed issues.
 */
function findDuplicates(openIssues, closedIssues = [], options = {}) {
	const threshold = options.threshold ?? 0.7;
	const duplicates = [];
	const candidatePool = [...openIssues, ...closedIssues];
	const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

	for (const openIssue of openIssues) {
		// Check if the issue already received a duplicate-of comment
		const existingDuplicateComment = (openIssue.comments || []).some((c) => {
			const text = (c.body || '').toLowerCase();
			return text.includes('possible duplicate of #') || text.includes('duplicate-of');
		});

		if (existingDuplicateComment) {
			continue;
		}

		for (const candidate of candidatePool) {
			// Compare only against older issues to nominate the newer issue as duplicate of older
			if (candidate.number >= openIssue.number) continue;

			const score = calculateSimilarity(openIssue, candidate);
			if (score >= threshold) {
				duplicates.push({
					targetIssueNumber: openIssue.number,
					targetTitle: openIssue.title,
					duplicateOfNumber: candidate.number,
					duplicateOfTitle: candidate.title,
					score: Math.round(score * 100) / 100,
				});
				// Record at most one primary duplicate per issue
				break;
			}
		}
	}

	return duplicates;
}

/**
 * Identifies issues with stale agent-working status (>14 days without PR or commit).
 */
function findStaleAgentWorking(issues, options = {}) {
	const staleDays = options.staleDays ?? 14;
	const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
	const stale = [];

	for (const issue of issues) {
		const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
		if (!labels.includes('agent-working') || labels.includes('stale/agent-working')) continue;

		const updatedAt = issue.updatedAt ? new Date(issue.updatedAt).getTime() : 0;
		const isStale = updatedAt < cutoff;
		const hasActivity = Boolean(issue.hasReferencingPr || issue.hasReferencingCommit);

		if (isStale && !hasActivity) {
			stale.push({
				number: issue.number,
				title: issue.title,
				updatedAt: issue.updatedAt,
			});
		}
	}

	return stale;
}

/**
 * Queries Sentry API for event count over last 30 days for an issue tag (fail-open).
 */
async function fetchSentryEventCount(tag, options = {}) {
	const token = options.token ?? process.env.SENTRY_AUTH_TOKEN;
	if (!token) return null;

	const fetchFn = options.fetchFn ?? globalThis.fetch;
	if (typeof fetchFn !== 'function') return null;

	const org = options.org || process.env.SENTRY_ORG || 'cabros-bot';
	const project = options.project || process.env.SENTRY_PROJECT || 'crypto-bot-node';
	const url = `https://sentry.io/api/0/projects/${org}/${project}/events/?query=tag:${encodeURIComponent(tag)}&statsPeriod=30d`;

	try {
		const res = await fetchFn(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				'Content-Type': 'application/json',
			},
		});
		if (!res.ok) return null;
		const data = await res.json();
		if (Array.isArray(data) && data.length > 0 && typeof data[0].count === 'number') {
			return data[0].count;
		}
		if (Array.isArray(data)) {
			return data.length;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Generates Markdown report summarizing backlog hygiene state.
 */
function generateBacklogReport(stats) {
	const lines = [];
	lines.push('# Backlog Hygiene Report');
	lines.push(`Generated: ${new Date().toISOString()}`);
	lines.push('');

	lines.push('## Status Summary');
	const statusCounts = stats.countsByStatus || {};
	for (const [status, count] of Object.entries(statusCounts)) {
		lines.push(`- ${status}: ${count}`);
	}
	lines.push('');
	lines.push('| Status | Count |');
	lines.push('| ------ | ----- |');
	for (const [status, count] of Object.entries(statusCounts)) {
		lines.push(`| \`${status}\` | ${count} |`);
	}
	lines.push('');

	lines.push('## Priority Distribution');
	const priorityCounts = stats.countsByPriority || {};
	lines.push('| Priority | Count |');
	lines.push('| -------- | ----- |');
	for (const [priority, count] of Object.entries(priorityCounts)) {
		lines.push(`| \`${priority}\` | ${count} |`);
	}
	lines.push('');

	if (stats.duplicates && stats.duplicates.length > 0) {
		lines.push('## Flagged Duplicates');
		for (const d of stats.duplicates) {
			lines.push(`- #${d.targetIssueNumber} ("${d.targetTitle || ''}") → Possible duplicate of #${d.duplicateOfNumber} ("${d.duplicateOfTitle || ''}") (score: ${d.score})`);
		}
		lines.push('');
	}

	if (stats.staleAgentWorking && stats.staleAgentWorking.length > 0) {
		lines.push('## Stale `agent-working` Issues (>14d without PR/activity)');
		for (const s of stats.staleAgentWorking) {
			lines.push(`- #${s.number}: ${s.title}`);
		}
		lines.push('');
	}

	if (stats.needsTriageQueue && stats.needsTriageQueue.length > 0) {
		lines.push('## Needs Triage Queue');
		for (const t of stats.needsTriageQueue.slice(0, 20)) {
			lines.push(`- #${t.number}: ${t.title}`);
		}
		lines.push('');
	}

	return lines.join('\n');
}

/**
 * Main execution function for backlog hygiene pass.
 */
async function runBacklogHygiene(options = {}) {
	const dryRun = options.dryRun ?? true;
	const repo = options.repo || '';
	const execGh = options.execGh || defaultExecGh;

	// Verify gh authentication - fail closed if not authenticated
	try {
		execGh(['auth', 'status']);
	} catch {
		console.error('[backlog-hygiene] Error: gh CLI is not authenticated. Backlog hygiene fails closed.');
		process.exit(1);
	}

	console.log(`[backlog-hygiene] Running backlog hygiene pass (dryRun=${dryRun})...`);

	// Fetch open issues
	let openIssues = [];
	try {
		const listArgs = [
			'issue',
			'list',
			'--state',
			'open',
			'--limit',
			String(options.limit || 200),
			'--json',
			'number,title,body,labels,updatedAt,comments',
		];
		if (repo) listArgs.push('--repo', repo);
		const raw = execGh(listArgs);
		openIssues = JSON.parse(raw);
	} catch (err) {
		console.error('[backlog-hygiene] Failed to fetch open issues via gh:', err.message);
		process.exit(1);
	}

	// Fetch recent closed issues for duplicate comparison
	let closedIssues = [];
	try {
		const closedArgs = [
			'issue',
			'list',
			'--state',
			'closed',
			'--limit',
			'50',
			'--json',
			'number,title,body,labels,updatedAt',
		];
		if (repo) closedArgs.push('--repo', repo);
		const rawClosed = execGh(closedArgs);
		closedIssues = JSON.parse(rawClosed);
	} catch {
		closedIssues = [];
	}

	// Fetch open PRs to cross-reference referencing PRs
	let openPrs = [];
	try {
		const prArgs = [
			'pr',
			'list',
			'--state',
			'open',
			'--limit',
			'100',
			'--json',
			'number,title,headRefName,body',
		];
		if (repo) prArgs.push('--repo', repo);
		const rawPrs = execGh(prArgs);
		openPrs = JSON.parse(rawPrs);
	} catch {
		openPrs = [];
	}

	// Cross-reference issues with PR branches or bodies
	for (const issue of openIssues) {
		const issueRefPattern = new RegExp(`(#|/|gh-)${issue.number}\\b`, 'i');
		issue.hasReferencingPr = openPrs.some(
			(pr) => issueRefPattern.test(pr.headRefName || '') || issueRefPattern.test(pr.title || '') || issueRefPattern.test(pr.body || '')
		);
	}

	const countsByStatus = {};
	const countsByPriority = {};
	const needsTriageQueue = [];

	// 1. Status label normalization
	for (const issue of openIssues) {
		const targetStatus = determineStatusLabel(issue);
		countsByStatus[targetStatus] = (countsByStatus[targetStatus] || 0) + 1;

		if (targetStatus === 'status/needs-triage') {
			needsTriageQueue.push({ number: issue.number, title: issue.title });
		}

		// Count priorities
		const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
		for (const label of labels) {
			if (label.startsWith('priority/')) {
				countsByPriority[label] = (countsByPriority[label] || 0) + 1;
			}
		}

		const currentStatusLabels = labels.filter((l) => l.startsWith('status/'));
		const needsUpdate = currentStatusLabels.length !== 1 || currentStatusLabels[0] !== targetStatus;

		if (needsUpdate) {
			console.log(`[backlog-hygiene] Issue #${issue.number}: update status -> ${targetStatus} (current: ${currentStatusLabels.join(', ') || 'none'})`);
			if (!dryRun) {
				const editArgs = ['issue', 'edit', String(issue.number)];
				if (repo) editArgs.push('--repo', repo);
				for (const old of currentStatusLabels) {
					editArgs.push('--remove-label', old);
				}
				editArgs.push('--add-label', targetStatus);
				try {
					execGh(editArgs);
				} catch (err) {
					console.warn(`[backlog-hygiene] Failed to update labels for #${issue.number}:`, err.message);
				}
			}
		}
	}

	// 2. Duplicate detection
	const duplicates = findDuplicates(openIssues, closedIssues, { threshold: options.threshold });
	console.log(`[backlog-hygiene] Found ${duplicates.length} possible duplicate(s).`);
	for (const dup of duplicates) {
		console.log(`[backlog-hygiene] Issue #${dup.targetIssueNumber} is possible duplicate of #${dup.duplicateOfNumber} (score: ${dup.score})`);
		if (!dryRun) {
			const commentBody = `Possible duplicate of #${dup.duplicateOfNumber} ("${dup.duplicateOfTitle || ''}") with similarity score ${dup.score}. Cross-referencing for backlog hygiene.`;
			const commentArgs = ['issue', 'comment', String(dup.targetIssueNumber)];
			if (repo) commentArgs.push('--repo', repo);
			commentArgs.push('--body', commentBody);
			try {
				execGh(commentArgs);
			} catch (err) {
				console.warn(`[backlog-hygiene] Failed to comment on #${dup.targetIssueNumber}:`, err.message);
			}
		}
	}

	// 3. Stale agent-working retirement
	const staleAgentWorking = findStaleAgentWorking(openIssues, { staleDays: options.staleDays });
	console.log(`[backlog-hygiene] Found ${staleAgentWorking.length} stale agent-working issue(s).`);
	for (const stale of staleAgentWorking) {
		console.log(`[backlog-hygiene] Issue #${stale.number} has stale agent-working status.`);
		if (!dryRun) {
			try {
				const editArgs = ['issue', 'edit', String(stale.number)];
				if (repo) editArgs.push('--repo', repo);
				editArgs.push('--add-label', 'stale/agent-working');
				execGh(editArgs);

				const commentArgs = ['issue', 'comment', String(stale.number)];
				if (repo) commentArgs.push('--repo', repo);
				commentArgs.push(
					'--body',
					'This issue has carried the `agent-working` label for over 14 days without recent referencing pull requests or branch activity. Labeling as `stale/agent-working`. Owner: please re-confirm status or unassign.'
				);
				execGh(commentArgs);
			} catch (err) {
				console.warn(`[backlog-hygiene] Failed to update stale issue #${stale.number}:`, err.message);
			}
		}
	}

	// 4. Production evidence appender (priority/1-roi issues via Sentry)
	let sentryAppendedCount = 0;
	const sentryToken = options.sentryToken ?? process.env.SENTRY_AUTH_TOKEN;
	if (sentryToken) {
		for (const issue of openIssues) {
			const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
			if (labels.includes('priority/1-roi')) {
				const currentBody = issue.body || '';
				if (!currentBody.includes('Production:') && !currentBody.includes('events in last 30d')) {
					try {
						const tag = `issue-${issue.number}`;
						const count = await fetchSentryEventCount(tag, {
							token: sentryToken,
							fetchFn: options.fetchFn,
						});
						if (typeof count === 'number' && count > 0) {
							console.log(`[backlog-hygiene] Appending Sentry evidence (${count} events) to #${issue.number}`);
							sentryAppendedCount++;
							if (!dryRun) {
								const newBody = `${currentBody}\n\nProduction: ${count} events in last 30d`;
								const editArgs = ['issue', 'edit', String(issue.number)];
								if (repo) editArgs.push('--repo', repo);
								editArgs.push('--body', newBody);
								execGh(editArgs);
							}
						}
					} catch (err) {
						console.warn(`[backlog-hygiene] Failed to append Sentry evidence for #${issue.number}:`, err.message);
					}
				}
			}
		}
	}

	// 5. Generate report
	const reportMarkdown = generateBacklogReport({
		countsByStatus,
		countsByPriority,
		duplicates,
		staleAgentWorking,
		needsTriageQueue,
	});

	if (options.reportPath) {
		fs.writeFileSync(options.reportPath, reportMarkdown, 'utf8');
		console.log(`[backlog-hygiene] Report written to ${options.reportPath}`);
	}

	return {
		countsByStatus,
		countsByPriority,
		duplicatesCount: duplicates.length,
		staleAgentWorkingCount: staleAgentWorking.length,
		needsTriageCount: needsTriageQueue.length,
		sentryAppendedCount,
	};
}

// Execute when invoked directly
if (require.main === module) {
	const options = parseArgs();
	runBacklogHygiene(options).catch((err) => {
		console.error('[backlog-hygiene] Fatal error:', err);
		process.exit(1);
	});
}

module.exports = {
	parseArgs,
	determineStatusLabel,
	tokenize,
	diceSimilarity,
	calculateSimilarity,
	findDuplicates,
	findStaleAgentWorking,
	fetchSentryEventCount,
	generateBacklogReport,
	runBacklogHygiene,
};
