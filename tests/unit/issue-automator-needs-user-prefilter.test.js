/** Exercises the shipped jq filter and CLI with fixtures; no GitHub/network writes.
 * Normal selection skips handoffs; explicit reconciliation can inspect them
 * without permitting implementation or bypassing genuine prerequisites.
 */

const { readFileSync, mkdtempSync, writeFileSync, rmSync } = require('fs');
const { tmpdir } = require('os');
const { spawnSync } = require('child_process');
const { join } = require('path');

const SCRIPT = join(__dirname, '../../.agents/skills/issue-automator/scripts/get-oldest-issue.sh');
const SCRIPT_SOURCE = readFileSync(SCRIPT, 'utf8');

/**
 * Pull the real `jq -c '...'` label filter out of the shipped script. The
 * single-quoted anchor cannot match the later double-quoted skip-list filter,
 * so this resolves to the label pre-filter specifically.
 */
function extractBatchFilter() {
	const match = SCRIPT_SOURCE.match(/batch=\$\(echo "\$batch" \| jq -c[^\n]*'([\s\S]*?)'\)/);
	if (!match) throw new Error('Could not locate the batch label filter in get-oldest-issue.sh');
	return match[1];
}

const BATCH_FILTER = extractBatchFilter();

/** Apply the script's real filter to a batch; returns surviving issue numbers. */
function survivingNumbers(issues, reconsider = false, priorityOrder = false) {
	const result = spawnSync('jq', ['-c', '--argjson', 'reconsider', String(reconsider), '--argjson', 'priorityOrder', String(priorityOrder), BATCH_FILTER], {
		input: JSON.stringify(issues),
		encoding: 'utf8',
	});
	if (result.status !== 0) {
		throw new Error(`jq filter failed (status ${result.status}): ${result.stderr}`);
	}
	return JSON.parse(result.stdout).map((i) => i.number);
}

const issue = (number, labelNames) => ({
	number,
	title: `Issue ${number}`,
	createdAt: `2026-01-${String(number).padStart(2, '0')}T00:00:00Z`,
	labels: labelNames.map((name) => ({ name })),
	url: `https://github.com/francovp/cabros-bot/issues/${number}`,
});

/** A labelled issue must be dropped, leaving only the next eligible one. */
const excludesLabel = (labelNames) =>
	expect(survivingNumbers([issue(708, labelNames), issue(900, ['bug'])])).toEqual([900]);

describe('#1357 — the cursor filter excludes terminal NEEDS_USER issues', () => {
	it('resolves a usable filter from the shipped script', () => {
		expect(BATCH_FILTER).toContain('ascii_downcase');
		// A truncated capture would make every `survivingNumbers` call throw, so
		// this also fails loudly if the script's filter shape ever changes.
		expect(() => survivingNumbers([issue(1, [])])).not.toThrow();
	});

	// One row per distinct literal the filter must reject. SKILL.md documents
	// `NEEDS_USER`, `HUMAN NEEDED`, `NEEDS USER` and the `need user` variant; the
	// lowercase rows double as proof that `ascii_downcase` folds case.
	it.each([
		['NEEDS_USER', ['NEEDS_USER']],
		['needs_user', ['needs_user']],
		['NEEDS_USERS', ['NEEDS_USERS']],
		['NEEDS USER', ['NEEDS USER']],
		['needs user', ['needs user']],
		['HUMAN NEEDED', ['HUMAN NEEDED']],
		['need user', ['need user']],
		['need manual PR deploy', ['need manual PR deploy']],
		['brainstorming', ['brainstorming']],
		['brainstorm', ['brainstorm']],
	])('excludes an issue labelled %s', (_name, labels) => {
		excludesLabel(labels);
	});

	it('excludes an issue carrying a terminal label alongside others', () => {
		excludesLabel(['enhancement', 'area/trading', 'NEEDS_USER']);
	});

	it('keeps issues whose labels are all non-terminal, or absent', () => {
		expect(survivingNumbers([issue(708, ['bug', 'priority/4-security', 'area/api']), issue(709, [])])).toEqual([
			708, 709,
		]);
	});

	it('empties the batch when every candidate awaits operator input', () => {
		expect(survivingNumbers([issue(708, ['NEEDS_USER']), issue(901, ['HUMAN NEEDED'])])).toEqual([]);
	});
});

describe('decision reconciliation without queue starvation', () => {
	it.each(['NEEDS_USER', 'NEEDS_USERS', 'needs user', 'HUMAN NEEDED', 'need user', 'need manual PR deploy'])(
		'includes %s for an explicit decision audit', (label) => {
			expect(survivingNumbers([issue(708, [label])], true)).toEqual([708]);
		},
	);

	it('still excludes brainstorms and respects informational automation/skip', () => {
		expect(survivingNumbers([issue(1, ['brainstorm', 'NEEDS_USER']), issue(2, ['automation/skip'])], true)).toEqual([2]);
	});

	it('orders numeric priorities first, then named priorities without inventing a numeric mapping', () => {
		expect(survivingNumbers([
			issue(1, ['priority/medium']), issue(2, ['priority/critical']),
			issue(3, ['priority/7-build']), issue(4, ['priority/1-roi']),
			issue(5, ['priority/high']), issue(6, ['priority/2-qol']),
			issue(7, []),
		], false, true)).toEqual([4, 6, 3, 2, 5, 1, 7]);
	});

	it('keeps oldest-first order when priority ordering is not requested', () => {
		expect(survivingNumbers([issue(1, ['priority/high']), issue(2, ['priority/1-roi'])])).toEqual([1, 2]);
	});
});


describe('selector CLI with isolated GitHub fixture', () => {
	let dir;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), 'issue-selector-'));
		writeFileSync(join(dir, 'gh'), `#!/bin/sh
case "$1 $2" in
  "auth status") echo "logged in to github.com as francovp" ;;
  "auth switch") exit 0 ;;
  "issue list") cat "$ISSUE_FIXTURE" ;;
  *) echo "unexpected gh operation" >&2; exit 99 ;;
esac
`, { mode: 0o755 });
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	function run(items, args = []) {
		const fixture = join(dir, 'issues.json');
		writeFileSync(fixture, JSON.stringify(items));
		return spawnSync('bash', [SCRIPT, ...args], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ISSUE_FIXTURE: fixture },
		});
	}

	it('passes reconciliation, priority ordering and exclusions through the real CLI', () => {
		const result = run([issue(1, ['priority/high']), issue(2, ['NEEDS_USER', 'priority/1-roi']), issue(3, ['priority/2-qol'])], ['3', '--reconsider', '--priority-order']);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)[0].number).toBe(2);
	});

	it('reports no eligible issue when a complete small batch contains only handoffs', () => {
		const result = run([issue(1, ['NEEDS_USER'])]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('No eligible open issues found.');
	});

	it('fails an incomplete priority inventory instead of claiming queue exhaustion', () => {
		const result = run(Array.from({ length: 1000 }, (_, n) => issue(n + 1, [])), ['--priority-order']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('search cap');
	});

	it('rejects unknown flags before attempting a GitHub operation', () => {
		const result = run([], ['--typo']);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain('unknown option');
	});
});
