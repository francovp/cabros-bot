'use strict';

const fs = require('fs');
const path = require('path');
const {
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
} = require('../../scripts/backlog-hygiene');

describe('backlog-hygiene tool', () => {
	describe('parseArgs', () => {
		it('defaults to dry-run with safe defaults', () => {
			const args = parseArgs([]);
			expect(args.dryRun).toBe(true);
			expect(args.apply).toBe(false);
			expect(args.project).toBe(DEFAULT_REPO);
			expect(args.maxIssues).toBe(DEFAULT_MAX_ISSUES);
			expect(args.maxAgeDays).toBe(DEFAULT_MAX_AGE_DAYS);
			expect(args.duplicateWindowDays).toBe(DEFAULT_DUPLICATE_WINDOW_DAYS);
			expect(args.duplicateThreshold).toBe(DEFAULT_DUPLICATE_THRESHOLD);
		});

		it('parses every flag', () => {
			const args = parseArgs([
				'--apply',
				'--project', 'other/repo',
				'--max-issues', '50',
				'--max-age-days', '21',
				'--duplicate-window-days', '7',
				'--duplicate-threshold', '0.85',
				'--report', '/tmp/report.md',
				'--json',
			]);
			expect(args.apply).toBe(true);
			expect(args.dryRun).toBe(false);
			expect(args.project).toBe('other/repo');
			expect(args.maxIssues).toBe(50);
			expect(args.maxAgeDays).toBe(21);
			expect(args.duplicateWindowDays).toBe(7);
			expect(args.duplicateThreshold).toBe(0.85);
			expect(args.reportPath).toBe('/tmp/report.md');
			expect(args.json).toBe(true);
		});

		it('--dry-run overrides --apply', () => {
			const args = parseArgs(['--apply', '--dry-run']);
			expect(args.apply).toBe(false);
			expect(args.dryRun).toBe(true);
		});

		it('--help short-circuits flag parsing only for help', () => {
			const args = parseArgs(['--help']);
			expect(args.help).toBe(true);
		});

		it('rejects unknown flags', () => {
			expect(() => parseArgs(['--bogus'])).toThrow(/Unknown argument/);
		});

		it('rejects missing values', () => {
			expect(() => parseArgs(['--project'])).toThrow(/Missing argument/);
			expect(() => parseArgs(['--max-issues', 'abc'])).toThrow(/Invalid/);
			expect(() => parseArgs(['--duplicate-threshold', '1.5'])).toThrow(/Invalid/);
		});
	});

	describe('tokenize', () => {
		it('lowercases and drops stop words + short tokens', () => {
			expect(tokenize('Add the Backlog-Hygiene Pass to the repo')).toEqual([
				'add', 'backlog', 'hygiene', 'pass', 'repo',
			]);
		});

		it('returns [] for non-strings', () => {
			expect(tokenize(null)).toEqual([]);
			expect(tokenize(undefined)).toEqual([]);
			expect(tokenize(123)).toEqual([]);
		});
	});

	describe('jaccard', () => {
		it('returns 1 for identical token sets', () => {
			expect(jaccard(['a', 'b'], ['b', 'a'])).toBe(1);
		});
		it('returns 0 for disjoint sets', () => {
			expect(jaccard(['a'], ['b'])).toBe(0);
		});
		it('returns 0 when either input is empty', () => {
			expect(jaccard([], ['a'])).toBe(0);
			expect(jaccard(['a'], [])).toBe(0);
		});
		it('computes partial overlap correctly', () => {
			// {a,b,c} ∩ {b,c,d} = {b,c} (2); ∪ = {a,b,c,d} (4); 2/4 = 0.5
			expect(jaccard(['a', 'b', 'c'], ['b', 'c', 'd'])).toBe(0.5);
		});
	});

	describe('labelOverlap', () => {
		it('returns 1 for identical label sets', () => {
			expect(labelOverlap(['a', 'b'], ['b', 'a'])).toBe(1);
		});
		it('returns 0 for disjoint sets', () => {
			expect(labelOverlap(['x'], ['y'])).toBe(0);
		});
		it('is case-insensitive', () => {
			expect(labelOverlap(['Enhancement'], ['enhancement'])).toBe(1);
		});
		it('handles non-array input as 0', () => {
			expect(labelOverlap(null, ['x'])).toBe(0);
			expect(labelOverlap(['x'], null)).toBe(0);
		});
	});

	describe('duplicateScore', () => {
		it('blends lexical and label signals (0.6 + 0.4)', () => {
			// lex: {a,b,c} ∩ {b,c,d} = {b,c} (2); ∪ = {a,b,c,d} (4); lex = 0.5
			// label: {p,q} ∩ {q,r} = {q} (1); ∪ = {p,q,r} (3); label = 0.3333
			// score = 0.5 * 0.6 + 0.3333 * 0.4 = 0.3 + 0.1333 = 0.4333
			const score = duplicateScore(
				{ tokens: ['a', 'b', 'c'], labels: ['p', 'q'] },
				{ tokens: ['b', 'c', 'd'], labels: ['q', 'r'] },
			);
			expect(score).toBeCloseTo(0.4333, 3);
		});
		it('returns 0 when both signals are 0', () => {
			const score = duplicateScore(
				{ tokens: ['x'], labels: ['a'] },
				{ tokens: ['y'], labels: ['b'] },
			);
			expect(score).toBe(0);
		});
	});

	describe('classifyStatus', () => {
		it('classifies priority/* issues as ready', () => {
			expect(classifyStatus({ labels: [{ name: 'priority/2-qol' }] })).toBe(STATUS_LABELS.READY);
		});
		it('classifies automation/ready as ready', () => {
			expect(classifyStatus({ labels: ['automation/ready'] })).toBe(STATUS_LABELS.READY);
		});
		it('classifies GLOBAL_BLOCKED as blocked', () => {
			expect(classifyStatus({ labels: ['GLOBAL_BLOCKED'] })).toBe(STATUS_LABELS.BLOCKED);
		});
		it('classifies need manual PR deploy as blocked', () => {
			expect(classifyStatus({ labels: ['need manual PR deploy'] })).toBe(STATUS_LABELS.BLOCKED);
		});
		it('classifies In review as in-progress', () => {
			expect(classifyStatus({ labels: ['In review'] })).toBe(STATUS_LABELS.IN_PROGRESS);
		});
		it('classifies agent-working as in-progress', () => {
			expect(classifyStatus({ labels: ['agent-working'] })).toBe(STATUS_LABELS.IN_PROGRESS);
		});
		it('classifies issues without status signals as needs-triage', () => {
			expect(classifyStatus({ labels: [] })).toBe(STATUS_LABELS.NEEDS_TRIAGE);
			expect(classifyStatus({ labels: [{ name: 'random-tag' }] })).toBe(STATUS_LABELS.NEEDS_TRIAGE);
		});
		it('returns needs-triage for invalid input', () => {
			expect(classifyStatus(null)).toBe(STATUS_LABELS.NEEDS_TRIAGE);
			expect(classifyStatus({})).toBe(STATUS_LABELS.NEEDS_TRIAGE);
		});
	});

	describe('refreshStatusLabels', () => {
		it('replaces any existing status/* with the desired status', () => {
			const labels = refreshStatusLabels([
				'enhancement', 'priority/2-qol', 'status/needs-triage',
			]);
			expect(labels).toContain('status/ready');
			expect(labels).not.toContain('status/needs-triage');
			expect(labels).toContain('enhancement');
			expect(labels).toContain('priority/2-qol');
		});

		it('keeps non-status labels untouched', () => {
			const labels = refreshStatusLabels(['a', 'b', 'status/ready']);
			expect(labels.filter((l) => !ALL_STATUS_LABELS.has(l)).sort()).toEqual(['a', 'b']);
		});
	});

	describe('shouldSkipStatusRefresh', () => {
		it('skips when exactly one status label and it matches', () => {
			expect(shouldSkipStatusRefresh(['priority/2-qol', 'status/ready'])).toBe(true);
			expect(shouldSkipStatusRefresh(['status/needs-triage'])).toBe(true);
		});

		it('does NOT skip when In review lacks status/in-progress (must add it)', () => {
			expect(shouldSkipStatusRefresh(['In review'])).toBe(false);
		});

		it('does NOT skip when In review carries the wrong status label (would demote)', () => {
			expect(shouldSkipStatusRefresh(['In review', 'status/needs-triage'])).toBe(false);
		});

		it('skips when In review already has status/in-progress', () => {
			expect(shouldSkipStatusRefresh(['In review', 'status/in-progress'])).toBe(true);
			expect(shouldSkipStatusRefresh(['agent-working', 'status/in-progress'])).toBe(true);
		});

		it('does NOT skip when multiple status labels are present (consistency cleanup)', () => {
			expect(shouldSkipStatusRefresh(['status/ready', 'status/blocked'])).toBe(false);
		});

		it('handles non-array gracefully', () => {
			expect(shouldSkipStatusRefresh(null)).toBe(false);
		});
	});

	describe('isWithinWindow', () => {
		const now = new Date('2026-09-01T00:00:00Z');
		it('returns true for timestamps inside the window', () => {
			expect(isWithinWindow('2026-08-15T00:00:00Z', now, 30)).toBe(true);
		});
		it('returns false for timestamps outside the window', () => {
			expect(isWithinWindow('2026-01-01T00:00:00Z', now, 30)).toBe(false);
		});
		it('returns false for invalid input', () => {
			expect(isWithinWindow('', now, 30)).toBe(false);
			expect(isWithinWindow(null, now, 30)).toBe(false);
			expect(isWithinWindow('not-a-date', now, 30)).toBe(false);
		});
	});

	describe('isStaleAgentWorking', () => {
		const now = new Date('2026-09-01T00:00:00Z');
		it('flags issues older than maxAgeDays with no PR', () => {
			expect(isStaleAgentWorking(
				{ agentWorkingSince: '2026-08-01T00:00:00Z', hasOpenPR: false, recentCommitRef: false },
				now,
				14,
			)).toBe(true);
		});
		it('does not flag issues with open PR', () => {
			expect(isStaleAgentWorking(
				{ agentWorkingSince: '2026-08-01T00:00:00Z', hasOpenPR: true, recentCommitRef: false },
				now,
				14,
			)).toBe(false);
		});
		it('does not flag issues with recent commit reference', () => {
			expect(isStaleAgentWorking(
				{ agentWorkingSince: '2026-08-01T00:00:00Z', hasOpenPR: false, recentCommitRef: true },
				now,
				14,
			)).toBe(false);
		});
		it('does not flag fresh issues', () => {
			expect(isStaleAgentWorking(
				{ agentWorkingSince: '2026-08-30T00:00:00Z', hasOpenPR: false, recentCommitRef: false },
				now,
				14,
			)).toBe(false);
		});
		it('does not flag when agentWorkingSince is missing', () => {
			expect(isStaleAgentWorking({ hasOpenPR: false }, now, 14)).toBe(false);
		});
	});

	describe('hasRecentDuplicateComment', () => {
		const now = new Date('2026-09-01T00:00:00Z');
		it('detects a recent duplicate-of comment', () => {
			const comments = [{ body: `**${DUPLICATE_MARKER}**: of #1`, createdAt: '2026-08-25T00:00:00Z' }];
			expect(hasRecentDuplicateComment(comments, now, 30)).toBe(true);
		});
		it('ignores comments without the duplicate marker', () => {
			const comments = [{ body: 'totally unrelated', createdAt: '2026-08-25T00:00:00Z' }];
			expect(hasRecentDuplicateComment(comments, now, 30)).toBe(false);
		});
		it('ignores duplicate-of comments outside the window', () => {
			const comments = [{ body: `**${DUPLICATE_MARKER}**: of #1`, createdAt: '2026-01-01T00:00:00Z' }];
			expect(hasRecentDuplicateComment(comments, now, 30)).toBe(false);
		});
		it('handles non-array input', () => {
			expect(hasRecentDuplicateComment(null, now, 30)).toBe(false);
		});
	});

	describe('findDuplicates', () => {
		const target = {
			number: 100,
			tokens: ['add', 'opt-in', 'backlog', 'hygiene', 'pass'],
			labels: ['enhancement', 'priority/6-developer-experience'],
		};
		const dup = {
			number: 101,
			tokens: ['add', 'opt-in', 'backlog', 'hygiene', 'workflow'],
			labels: ['enhancement', 'priority/6-developer-experience'],
		};
		const unrelated = {
			number: 102,
			tokens: ['completely', 'different', 'thing'],
			labels: ['type/bug'],
		};

		it('returns matches above the threshold sorted by score', () => {
			const dups = findDuplicates(target, [unrelated, dup], 0.5, 5);
			expect(dups).toHaveLength(1);
			expect(dups[0].number).toBe(101);
			expect(dups[0].score).toBeGreaterThan(0.5);
		});

		it('excludes the target itself', () => {
			const self = { ...target };
			const dups = findDuplicates(target, [self], 0, 5);
			expect(dups).toEqual([]);
		});

		it('caps results to topK', () => {
			const many = [dup, dup, dup].map((d, i) => ({ ...d, number: 200 + i }));
			const dups = findDuplicates(target, many, 0.5, 2);
			expect(dups).toHaveLength(2);
		});

		it('returns [] when threshold is unreachable', () => {
			const dups = findDuplicates(target, [unrelated], 0.99, 5);
			expect(dups).toEqual([]);
		});

		it('skips candidates missing tokens or labels', () => {
			const dups = findDuplicates(target, [{ number: 999 }], 0, 5);
			expect(dups).toEqual([]);
		});
	});

	describe('buildDuplicateComment', () => {
		it('renders a markdown list and never empty when dups exist', () => {
			const body = buildDuplicateComment(747, [{ number: 800, score: 0.85 }, { number: 801, score: 0.71 }]);
			expect(body).toContain(`**${DUPLICATE_MARKER}**`);
			expect(body).toContain('#800');
			expect(body).toContain('#801');
			expect(body).toContain('85%');
			expect(body).toContain('71%');
			expect(body).toContain('#747');
		});
		it('returns empty string for empty dups', () => {
			expect(buildDuplicateComment(1, [])).toBe('');
		});
	});

	describe('buildStaleRetirementComment', () => {
		it('mentions the issue and the threshold', () => {
			const body = buildStaleRetirementComment(747, 14);
			expect(body).toContain('#747');
			expect(body).toContain('>14 days');
			expect(body).toContain(STALE_LABEL);
		});
	});

	describe('buildSentryAppendLine', () => {
		it('uses singular when count is 1', () => {
			expect(buildSentryAppendLine(1, 30)).toContain('1 event in last 30d');
		});
		it('uses plural otherwise', () => {
			expect(buildSentryAppendLine(27, 30)).toContain('27 events in last 30d');
		});
	});

	describe('formatReport', () => {
		it('renders counts, top duplicates, and needs-triage queue', () => {
			const md = formatReport({
				generatedAt: '2026-09-01T00:00:00Z',
				mode: 'dry-run',
				project: 'francovp/cabros-bot',
				scanned: 3,
				countsByStatus: { 'status/ready': 2, 'status/needs-triage': 1 },
				countsByPriority: { 'priority/6-developer-experience': 2, 'priority/none': 1 },
				topDuplicates: [{ source: 1, candidate: 2, score: 0.85 }],
				needsTriage: [{ number: 3, title: 'Add a thing' }],
			});
			expect(md).toContain('# Backlog hygiene report');
			expect(md).toContain('| Status | Count |');
			expect(md).toContain('| Priority | Count |');
			expect(md).toContain('85%');
			expect(md).toContain('#3 — Add a thing');
		});
		it('renders "_None._" when no duplicates exist', () => {
			const md = formatReport({
				generatedAt: '2026-09-01T00:00:00Z',
				mode: 'dry-run',
				project: 'francovp/cabros-bot',
				scanned: 0,
				countsByStatus: {},
				countsByPriority: {},
				topDuplicates: [],
				needsTriage: [],
			});
			expect(md).toContain('_None._');
			expect(md).toContain('_Empty._');
		});
	});

	describe('planIssueChanges', () => {
		const now = new Date('2026-09-01T00:00:00Z');
		it('flags statusChange when no matching status/* label', () => {
			const issue = {
				number: 1,
				title: 'Add a thing',
				body: 'body',
				labels: [{ name: 'priority/6-developer-experience' }],
			};
			const plan = planIssueChanges(issue, {
				now, maxAgeDays: 14, duplicateWindowDays: 30, duplicateThreshold: 0.7,
			});
			expect(plan.statusChange).toBe(true);
		});

		it('skips statusChange when status is already correct', () => {
			const issue = {
				number: 1,
				title: 'Add a thing',
				body: 'body',
				labels: [{ name: 'priority/6-developer-experience' }, { name: 'status/ready' }],
			};
			const plan = planIssueChanges(issue, {
				now, maxAgeDays: 14, duplicateWindowDays: 30, duplicateThreshold: 0.7,
			});
			expect(plan.statusChange).toBe(false);
		});

		it('flags staleRetirement when agent-working is old with no PR', () => {
			const issue = {
				number: 1,
				title: 'Add a thing',
				body: 'body',
				labels: [{ name: 'agent-working' }],
				agentWorkingSince: '2026-08-01T00:00:00Z',
				hasOpenPR: false,
				recentCommitRef: false,
			};
			const plan = planIssueChanges(issue, {
				now, maxAgeDays: 14, duplicateWindowDays: 30, duplicateThreshold: 0.7,
			});
			expect(plan.staleRetirement).toBe(true);
		});

		it('does NOT flag staleRetirement when PR is open', () => {
			const issue = {
				number: 1,
				title: 'Add a thing',
				body: 'body',
				labels: [{ name: 'agent-working' }],
				agentWorkingSince: '2026-08-01T00:00:00Z',
				hasOpenPR: true,
				recentCommitRef: false,
			};
			const plan = planIssueChanges(issue, {
				now, maxAgeDays: 14, duplicateWindowDays: 30, duplicateThreshold: 0.7,
			});
			expect(plan.staleRetirement).toBe(false);
		});

		it('finds duplicates against candidate issues', () => {
			const issue = {
				number: 1,
				title: 'Add an opt-in backlog hygiene pass',
				body: 'Refresh labels, detect duplicates',
				labels: ['enhancement', 'priority/6-developer-experience'],
			};
			issue._candidates = [{
				number: 2,
				title: 'Add an opt-in backlog hygiene workflow',
				body: 'Refresh labels and detect duplicates',
				labels: ['enhancement', 'priority/6-developer-experience'],
			}];
			const plan = planIssueChanges(issue, {
				now, maxAgeDays: 14, duplicateWindowDays: 30, duplicateThreshold: 0.5,
			});
			expect(plan.duplicates.length).toBeGreaterThanOrEqual(1);
			expect(plan.duplicates[0].number).toBe(2);
		});
	});

	describe('helpText', () => {
		it('lists every CLI flag', () => {
			const text = helpText();
			expect(text).toContain('--apply');
			expect(text).toContain('--dry-run');
			expect(text).toContain('--project');
			expect(text).toContain('--max-issues');
			expect(text).toContain('--max-age-days');
			expect(text).toContain('--duplicate-window-days');
			expect(text).toContain('--duplicate-threshold');
			expect(text).toContain('--report');
			expect(text).toContain('--json');
			expect(text).toContain('--help');
			expect(text).toContain('SENTRY_AUTH_TOKEN');
		});
	});
});