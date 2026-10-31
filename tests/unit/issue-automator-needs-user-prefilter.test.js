/**
 * Contract test for issue #1357 — "get-oldest-issue.sh does not pre-filter
 * NEEDS_USER, so the automator re-selects and re-comments the same terminal
 * issue every session".
 *
 * The skill treats `NEEDS_USER` / `HUMAN NEEDED` as a **terminal handoff**
 * (Step 1 pre-flight -> Step 6 branch 5: notify, release claim, stop the run).
 * `get-oldest-issue.sh` pre-filtered two other zero-work label classes
 * (`need manual PR deploy`, `brainstorming`/`brainstorm`) but never this one, so
 * the cursor kept handing the same terminal issue back as the oldest open issue
 * every session. Issue #708 accumulated eight `NEEDS_USER` comments and eight
 * identical WhatsApp pages from it.
 *
 * The label filter is lifted out of the shipped script and applied to synthetic
 * batches, so the assertions run against the real jq program rather than a copy
 * that can drift from it. That keeps this file free of subprocesses, which
 * matters here: the suite already shows timing flakiness in unrelated suites
 * under load, and Jest runs with `maxWorkers: 1`, so every blocking `spawnSync`
 * adds latency to the whole run. Prefer adding label cases over spawning bash.
 *
 * Read-only: it only reads the script and pipes fixtures through `jq`.
 */

const { readFileSync } = require('fs');
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
  const match = SCRIPT_SOURCE.match(/jq -c '\s*\n(\s*map\(select\([\s\S]*?\)\))\s*'\)/);
  if (!match) throw new Error('Could not locate the batch label filter in get-oldest-issue.sh');
  return match[1];
}

const BATCH_FILTER = extractBatchFilter();

/** Apply the script's real filter to a batch; returns surviving issue numbers. */
function survivingNumbers(issues) {
  const result = spawnSync('jq', ['-c', BATCH_FILTER], {
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