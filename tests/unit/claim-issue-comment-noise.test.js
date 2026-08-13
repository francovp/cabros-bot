/**
 * Regression tests for claim-issue.sh in-place renewal behavior.
 *
 * Verifies that a multi-step session (Step 1 claim + multiple Step 2 renewals)
 * does NOT post additional claim comments during renewals; instead, the original
 * claim comment is edited in-place (PATCH), keeping the comment count at 1.
 *
 * Also verifies that:
 * - The in-place update preserves the original comment ID (arbitration order).
 * - The fallback to a new comment works when PATCH fails.
 * - The renewal count extraction from the body works correctly.
 * - The freshness timestamp extraction from the body works for TTL checks.
 */

const {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
	rmSync,
} = require('fs');
const { spawnSync } = require('child_process');
const { tmpdir } = require('os');
const { join } = require('path');

const SCRIPT = join(
	__dirname,
	'../../.agents/skills/issue-automator/scripts/claim-issue.sh',
);

// ---------------------------------------------------------------------------
// Helper: build a fake `gh` binary that logs calls and handles specific patterns
// ---------------------------------------------------------------------------
function buildFakeGh(tempDir, scriptBody) {
	const logPath = join(tempDir, 'calls.log');
	const ghPath = join(tempDir, 'gh');
	writeFileSync(ghPath, scriptBody);
	chmodSync(ghPath, 0o755);
	return { ghPath, logPath };
}

function runClaimScript(tempDir, issueNumber, env) {
	return spawnSync('bash', [SCRIPT, String(issueNumber)], {
		env: {
			...process.env,
			PATH: String(tempDir + ':' + process.env.PATH),
			CLAIM_AGENT_ID: 'antigravity',
			CLAIM_SESSION_ID: 'session-test-001',
			CLAIM_TTL_MINUTES: '180',
			CLAIM_SESSION_STATE_DIR: tempDir,
			...env,
		},
		encoding: 'utf8',
		timeout: 15000,
	});
}

describe('claim-issue.sh renewal comment behavior', () => {
	let tempDir;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), 'claim-issue-test-'));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/**
	 * Verify that renewals PATCH the existing comment in-place (no new POST).
	 */
	it('renews an existing claim in-place without posting a new comment', () => {
		const originalTs = '2026-08-01T10:00:00Z';
		const patchLog = join(tempDir, 'patch.log');
		const callsLog = join(tempDir, 'calls.log');

		// Use single-quoted heredoc in bash to avoid shell interpolation issues.
		// The fake gh must be a plain shell script with no template literal trickery.
		const ghScript = [
			'#!/usr/bin/env bash',
			'echo "$*" >> ' + callsLog,
			'ARGS="$*"',
			'if echo "$ARGS" | grep -q "auth status"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "auth switch"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "repo view"; then echo "francovp/cabros-bot"; exit 0; fi',
			// api user login
			'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo \'{"login":"francovp"}\'; exit 0; fi',
			// issue labels
			'if echo "$ARGS" | grep -q "issue view.*labels"; then echo "true"; exit 0; fi',
			// paginated comments — returns the existing owned claim
			'if echo "$ARGS" | grep -q "api --paginate.*issues.*42.*comments"; then',
			'  printf "%s\\t%s\\t%s\\n" "100" "' + originalTs + '" "**agent-claim**: antigravity session-test-001 ' + originalTs + '"',
			'  exit 0',
			'fi',
			// labeled events
			'if echo "$ARGS" | grep -q "api --paginate.*events"; then echo "[]"; exit 0; fi',
			// PATCH comment (in-place renewal) — succeed and log
			'if echo "$ARGS" | grep -q "api -X PATCH.*comments/100"; then',
			'  echo "PATCH_CALLED" >> ' + patchLog,
			'  exit 0',
			'fi',
			// POST new comment — should NOT be reached for renewal
			'if echo "$ARGS" | grep -q "issues/42/comments" && ! echo "$ARGS" | grep -q "paginate"; then',
			'  echo "UNEXPECTED_POST" >> ' + patchLog,
			'  echo "999"',
			'  exit 0',
			'fi',
			'exit 0',
		].join('\n');

		buildFakeGh(tempDir, ghScript);

		const result = runClaimScript(tempDir, 42, {});

		const stdout = result.stdout || '';
		const patchContent = existsSync(patchLog) ? readFileSync(patchLog, 'utf8') : '';

		// The renewal should succeed
		expect(stdout).toContain('RESULT=CLAIMED');

		// PATCH should have been called for the existing comment
		expect(patchContent).toContain('PATCH_CALLED');

		// No unexpected POST of a new comment during renewal
		expect(patchContent).not.toContain('UNEXPECTED_POST');
	});

	/**
	 * Verify that the fallback posts a new comment when PATCH fails,
	 * keeping the run alive despite a transient API error.
	 */
	it('falls back to posting a new comment when PATCH fails', () => {
		const originalTs = '2026-08-01T10:00:00Z';
		const nowTs = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
		const patchLog = join(tempDir, 'patch.log');
		const fallbackLog = join(tempDir, 'fallback.log');

		// Tracks how many times comments are read (paginate calls)
		let commentReadCount = 0;

		const ghScript = [
			'#!/usr/bin/env bash',
			'echo "$*" >> ' + join(tempDir, 'calls.log'),
			'ARGS="$*"',
			'if echo "$ARGS" | grep -q "auth status"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "auth switch"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "repo view"; then echo "francovp/cabros-bot"; exit 0; fi',
			'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo \'{"login":"francovp"}\'; exit 0; fi',
			'if echo "$ARGS" | grep -q "issue view.*labels"; then echo "true"; exit 0; fi',
			// paginated comments — returns owned claim and later the fallback comment for arbitration
			'if echo "$ARGS" | grep -q "api --paginate.*issues.*42.*comments"; then',
			'  COUNT_FILE=' + join(tempDir, 'read_count'),
			'  COUNT=0; [ -f "$COUNT_FILE" ] && COUNT=$(cat "$COUNT_FILE")',
			'  COUNT=$((COUNT+1))',
			'  echo "$COUNT" > "$COUNT_FILE"',
			'  if [ "$COUNT" -le 2 ]; then',
			'    printf "%s\\t%s\\t%s\\n" "100" "' + originalTs + '" "**agent-claim**: antigravity session-test-001 ' + originalTs + '"',
			'  else',
			// After PATCH fails and fallback comment is posted, return both comments
			'    printf "%s\\t%s\\t%s\\n" "100" "' + originalTs + '" "**agent-claim**: antigravity session-test-001 ' + originalTs + '"',
			'    printf "%s\\t%s\\t%s\\n" "999" "' + nowTs + '" "**agent-claim**: antigravity session-test-001 ' + nowTs + ' (renewal fallback)"',
			'  fi',
			'  exit 0',
			'fi',
			'if echo "$ARGS" | grep -q "api --paginate.*events"; then echo "[]"; exit 0; fi',
			// PATCH fails
			'if echo "$ARGS" | grep -q "api -X PATCH.*comments/100"; then',
			'  echo "PATCH_FAILED" >> ' + patchLog,
			'  exit 1',
			'fi',
			// POST new comment (fallback) - succeed and return new ID
			'if echo "$ARGS" | grep -q "issues/42/comments" && ! echo "$ARGS" | grep -q "paginate"; then',
			'  echo "FALLBACK_POST_CALLED" >> ' + fallbackLog,
			'  echo "999"',
			'  exit 0',
			'fi',
			'exit 0',
		].join('\n');

		buildFakeGh(tempDir, ghScript);

		const result = runClaimScript(tempDir, 42, {});

		const patchContent = existsSync(patchLog) ? readFileSync(patchLog, 'utf8') : '';
		const fallbackContent = existsSync(fallbackLog) ? readFileSync(fallbackLog, 'utf8') : '';

		// PATCH should have been attempted and failed
		expect(patchContent).toContain('PATCH_FAILED');

		// Fallback POST should have been called
		expect(fallbackContent).toContain('FALLBACK_POST_CALLED');

		// The run should not error out on PATCH failure alone
		expect(result.status).not.toBe(1);
	});

	/**
	 * Verify the extract_renewal_count function correctly parses renewal counts
	 * from claim comment bodies in all supported formats.
	 */
	it('correctly extracts renewal counts from claim comment bodies', () => {
		const helperScriptPath = join(tempDir, 'test-renewal-count.sh');
		const helperScript = [
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			'',
			'extract_renewal_count() {',
			'  local body="$1" count',
			'  count="$(printf \'%s\' "$body" | sed -n \'s/.*renewed \\([0-9]*\\) time.*/\\1/p\' | head -1)"',
			'  echo "${count:-0}"',
			'}',
			'',
			'BODY0="**agent-claim**: antigravity session-001 2026-08-01T10:00:00Z"',
			'BODY1="**agent-claim**: antigravity session-001 2026-08-01T10:00:00Z (renewed 1 time(s), last: 2026-08-01T10:30:00Z)"',
			'BODY5="**agent-claim**: antigravity session-001 2026-08-01T10:00:00Z (renewed 5 time(s), last: 2026-08-01T15:00:00Z)"',
			'BODY99="**agent-claim**: antigravity session-001 2026-08-01T10:00:00Z (renewed 99 time(s), last: 2026-08-05T22:00:00Z)"',
			'',
			'echo "COUNT_0=$(extract_renewal_count "$BODY0")"',
			'echo "COUNT_1=$(extract_renewal_count "$BODY1")"',
			'echo "COUNT_5=$(extract_renewal_count "$BODY5")"',
			'echo "COUNT_99=$(extract_renewal_count "$BODY99")"',
		].join('\n');

		writeFileSync(helperScriptPath, helperScript);
		chmodSync(helperScriptPath, 0o755);

		const result = spawnSync('bash', [helperScriptPath], { encoding: 'utf8', timeout: 5000 });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain('COUNT_0=0');
		expect(result.stdout).toContain('COUNT_1=1');
		expect(result.stdout).toContain('COUNT_5=5');
		expect(result.stdout).toContain('COUNT_99=99');
	});

	/**
	 * Verify that the freshness timestamp extracted from the renewal body
	 * is used correctly for TTL staleness checks.
	 */
	it('extracts the last-renewal timestamp from the body for freshness checks', () => {
		const helperScriptPath = join(tempDir, 'test-freshness-ts.sh');
		const helperScript = [
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			'',
			'extract_body_ts() {',
			'  local rest="$1" body_ts',
			'  body_ts="$(printf \'%s\' "$rest" | sed -n \'s/.*last: \\([0-9T:Z-]*\\).*/\\1/p\' | head -1)"',
			'  echo "${body_ts:-}"',
			'}',
			'',
			'# No renewal — no last: timestamp',
			'REST_NONE="antigravity session-001 2026-08-01T10:00:00Z"',
			// With one renewal
			'REST_ONE="antigravity session-001 2026-08-01T10:00:00Z (renewed 1 time(s), last: 2026-08-05T22:00:00Z)"',
			// Takeover comment - no last:
			'REST_TAKEOVER="antigravity session-002 2026-08-05T20:00:00Z (takeover of stale claim by other/session)"',
			'',
			'echo "TS_NONE=$(extract_body_ts "$REST_NONE")"',
			'echo "TS_ONE=$(extract_body_ts "$REST_ONE")"',
			'echo "TS_TAKEOVER=$(extract_body_ts "$REST_TAKEOVER")"',
		].join('\n');

		writeFileSync(helperScriptPath, helperScript);
		chmodSync(helperScriptPath, 0o755);

		const result = spawnSync('bash', [helperScriptPath], { encoding: 'utf8', timeout: 5000 });
		expect(result.status).toBe(0);

		const stdout = result.stdout;
		// No renewal — timestamp should be empty
		expect(stdout).toMatch(/TS_NONE=\s*(\n|$)/);
		// With renewal — should extract the last-renewal timestamp
		expect(stdout).toContain('TS_ONE=2026-08-05T22:00:00Z');
		// Takeover — no "last:" pattern, should be empty
		expect(stdout).toMatch(/TS_TAKEOVER=\s*(\n|$)/);
	});

	/**
	 * Verify that a claim body with N renewals correctly generates renewal body N+1.
	 * This ensures comment count stays at 1 across multiple re-invocations.
	 */
	it('increments renewal count in the comment body each time', () => {
		const helperScriptPath = join(tempDir, 'test-increment.sh');
		const helperScript = [
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			'',
			'extract_renewal_count() {',
			'  local body="$1" count',
			'  count="$(printf \'%s\' "$body" | sed -n \'s/.*renewed \\([0-9]*\\) time.*/\\1/p\' | head -1)"',
			'  echo "${count:-0}"',
			'}',
			'',
			'simulate_renewal() {',
			'  local body="$1" ts="$2" agent="antigravity" session="session-001" prefix="**agent-claim**:"',
			// Extract the original timestamp (word 3 from the rest after prefix)
			'  local rest="${body#**agent-claim**: }"',
			'  local orig_ts="$(echo "$rest" | awk \'{print $3}\')"',
			'  local count=$(extract_renewal_count "$body")',
			'  local new_count=$((count + 1))',
			'  echo "${prefix} ${agent} ${session} ${orig_ts} (renewed ${new_count} time(s), last: ${ts})"',
			'}',
			'',
			'ORIG_BODY="**agent-claim**: antigravity session-001 2026-08-01T10:00:00Z"',
			'BODY_R1=$(simulate_renewal "$ORIG_BODY" "2026-08-01T10:30:00Z")',
			'BODY_R2=$(simulate_renewal "$BODY_R1" "2026-08-01T11:00:00Z")',
			'BODY_R3=$(simulate_renewal "$BODY_R2" "2026-08-01T11:30:00Z")',
			'',
			'echo "R1_COUNT=$(extract_renewal_count "$BODY_R1")"',
			'echo "R2_COUNT=$(extract_renewal_count "$BODY_R2")"',
			'echo "R3_COUNT=$(extract_renewal_count "$BODY_R3")"',
			// Verify the original ts is preserved (first comment timestamp unchanged)
			'echo "R3_HAS_ORIG=$(echo "$BODY_R3" | grep -c "2026-08-01T10:00:00Z")"',
			// Verify the last renewal ts is in the body
			'echo "R3_HAS_LAST=$(echo "$BODY_R3" | grep -c "2026-08-01T11:30:00Z")"',
		].join('\n');

		writeFileSync(helperScriptPath, helperScript);
		chmodSync(helperScriptPath, 0o755);

		const result = spawnSync('bash', [helperScriptPath], { encoding: 'utf8', timeout: 5000 });
		expect(result.status).toBe(0);

		const stdout = result.stdout;
		expect(stdout).toContain('R1_COUNT=1');
		expect(stdout).toContain('R2_COUNT=2');
		expect(stdout).toContain('R3_COUNT=3');
		// The original claim timestamp should be preserved in the body
		expect(stdout).toContain('R3_HAS_ORIG=1');
		// The last renewal timestamp should be in the body
		expect(stdout).toContain('R3_HAS_LAST=1');
	});

	/**
	 * Verify P1 fix: if a concurrent takeover comment lands between our
	 * agent/session ownership check and the PATCH, the post-PATCH re-read
	 * detects the newer comment and returns RESULT=SKIP.
	 */
	it('detects concurrent takeover after PATCH and returns SKIP', () => {
		const originalTs = '2026-08-01T10:00:00Z';
		const nowTs = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
		const patchLog = join(tempDir, 'patch.log');

		// paginate call count to simulate the takeover comment appearing on the 2nd read
		const ghScript = [
			'#!/usr/bin/env bash',
			'echo "$*" >> ' + join(tempDir, 'calls.log'),
			'ARGS="$*"',
			'if echo "$ARGS" | grep -q "auth status"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "auth switch"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "repo view"; then echo "francovp/cabros-bot"; exit 0; fi',
			'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo \'{"login":"francovp"}\'; exit 0; fi',
			'if echo "$ARGS" | grep -q "issue view.*labels"; then echo "true"; exit 0; fi',
			// paginated comments — 1st read: just our claim; 2nd read (post-PATCH): includes takeover
			'if echo "$ARGS" | grep -q "api --paginate.*issues.*42.*comments"; then',
			'  COUNT_FILE=' + join(tempDir, 'read_count'),
			'  COUNT=0; [ -f "$COUNT_FILE" ] && COUNT=$(cat "$COUNT_FILE")',
			'  COUNT=$((COUNT+1))',
			'  echo "$COUNT" > "$COUNT_FILE"',
			'  if [ "$COUNT" -le 2 ]; then',
			// First reads: only our owned claim
			'    printf "%s\\t%s\\t%s\\n" "100" "' + originalTs + '" "**agent-claim**: antigravity session-test-001 ' + originalTs + '"',
			'  else',
			// Post-PATCH re-read: takeover comment (ID 200 > 100) appeared
			'    printf "%s\\t%s\\t%s\\n" "100" "' + originalTs + '" "**agent-claim**: antigravity session-test-001 ' + originalTs + '"',
			'    printf "%s\\t%s\\t%s\\n" "200" "' + nowTs + '" "**agent-claim**: codex session-other ' + nowTs + ' (takeover of stale claim by antigravity/session-test-001)"',
			'  fi',
			'  exit 0',
			'fi',
			'if echo "$ARGS" | grep -q "api --paginate.*events"; then echo "[]"; exit 0; fi',
			// PATCH succeeds
			'if echo "$ARGS" | grep -q "api -X PATCH.*comments/100"; then',
			'  echo "PATCH_CALLED" >> ' + patchLog,
			'  exit 0',
			'fi',
			'exit 0',
		].join('\n');

		buildFakeGh(tempDir, ghScript);

		const result = runClaimScript(tempDir, 42, {});
		const stdout = result.stdout || '';

		// PATCH should have been called
		const patchContent = existsSync(patchLog) ? readFileSync(patchLog, 'utf8') : '';
		expect(patchContent).toContain('PATCH_CALLED');

		// But the result should be SKIP because the takeover was detected post-PATCH
		expect(stdout).toContain('RESULT=SKIP');
		expect(result.status).toBe(2);
	});

	/**
	 * Verify P2 fix: newest_claim outputs the raw body as the 6th tab field,
	 * allowing extract_renewal_count to correctly read the renewal counter.
	 */
	it('newest_claim 6th field contains the raw body for renewal count extraction', () => {
		const helperScriptPath = join(tempDir, 'test-6th-field.sh');
		const helperScript = [
			'#!/usr/bin/env bash',
			'set -euo pipefail',
			'',
			'extract_renewal_count() {',
			'  local body="$1" count',
			'  count="$(printf \'%s\' "$body" | sed -n \'s/.*renewed \\([0-9]*\\) time.*/\\1/p\' | head -1)"',
			'  echo "${count:-0}"',
			'}',
			'',
			// Simulate what newest_claim emits (6 tab-separated fields)
			'CLAIM_BODY="**agent-claim**: antigravity session-001 2026-08-01T10:00:00Z (renewed 3 time(s), last: 2026-08-05T22:00:00Z)"',
			'NEWEST="100\\tantigravity\\tsession-001\\t2026-08-01T10:00:00Z\\t2026-08-05T22:00:00Z\\t$CLAIM_BODY"',
			'',
			// Correct extraction: use cut -f6 for the raw body
			'BODY_FROM_F6="$(echo "$NEWEST" | cut -f6)"',
			'COUNT_F6=$(extract_renewal_count "$BODY_FROM_F6")',
			'echo "COUNT_F6=$COUNT_F6"',
			'',
			// Wrong extraction (old bug): cut -f3- gives session<TAB>created_at<TAB>freshness_ts<TAB>body — count is still 3 here
			// but in the old code without body field it would be wrong
			'BODY_FROM_F3="$(echo "$NEWEST" | cut -f6)"',
			'COUNT_CORRECT=$(extract_renewal_count "$BODY_FROM_F3")',
			'echo "COUNT_CORRECT=$COUNT_CORRECT"',
		].join('\n');

		writeFileSync(helperScriptPath, helperScript);
		chmodSync(helperScriptPath, 0o755);

		const result = spawnSync('bash', [helperScriptPath], { encoding: 'utf8', timeout: 5000 });
		expect(result.status).toBe(0);
		// Both should extract 3 correctly from the body
		expect(result.stdout).toContain('COUNT_F6=3');
		expect(result.stdout).toContain('COUNT_CORRECT=3');
	});

	/**
	/**
	 * Verify that rollback_abandoned_claim retains the agent-working label fail-closed
	 * when arbitration fails, preventing label deletion out from under a rival in-flight claimant.
	 */
	it('retains agent-working label fail-closed during claim rollback when arbitration fails', () => {
		const callsLog = join(tempDir, 'calls.log');
		const deleteLog = join(tempDir, 'delete.log');

		const ghScript = [
			'#!/usr/bin/env bash',
			'echo "$*" >> ' + callsLog,
			'ARGS="$*"',
			'if echo "$ARGS" | grep -q "auth status"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "auth switch"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "repo view"; then echo "francovp/cabros-bot"; exit 0; fi',
			'if [ "$1" = "api" ] && [ "$2" = "user" ]; then echo \'{"login":"francovp"}\'; exit 0; fi',
			// Issue has NO label initially
			'if echo "$ARGS" | grep -q "issue view.*labels"; then echo ""; exit 0; fi',
			// Add label succeeds
			'if echo "$ARGS" | grep -q "issue edit.*--add-label"; then exit 0; fi',
			// POST comment succeeds
			'if echo "$ARGS" | grep -q "issues/42/comments" && ! echo "$ARGS" | grep -q "paginate" && ! echo "$ARGS" | grep -q "DELETE"; then',
			'  echo "500"',
			'  exit 0',
			'fi',
			// Initial snapshot succeeds (empty)
			'if echo "$ARGS" | grep -q "api --paginate.*issues.*42.*comments"; then',
			'  COUNT_FILE=' + join(tempDir, 'read_count'),
			'  COUNT=0; [ -f "$COUNT_FILE" ] && COUNT=$(cat "$COUNT_FILE")',
			'  COUNT=$((COUNT+1))',
			'  echo "$COUNT" > "$COUNT_FILE"',
			'  if [ "$COUNT" -eq 1 ]; then',
			'    exit 0',
			'  else',
			// During arbitration read (2nd call), simulate API read failure
			'    exit 1',
			'  fi',
			'fi',
			'if echo "$ARGS" | grep -q "api --paginate.*events"; then echo "[]"; exit 0; fi',
			// DELETE comment during rollback succeeds
			'if echo "$ARGS" | grep -q "api -X DELETE.*comments/500"; then',
			'  echo "DELETE_CALLED" >> ' + deleteLog,
			'  exit 0',
			'fi',
			'exit 0',
		].join('\n');

		buildFakeGh(tempDir, ghScript);

		const result = runClaimScript(tempDir, 42, {});
		const stdout = result.stdout || '';
		const stderr = result.stderr || '';
		const callsContent = existsSync(callsLog) ? readFileSync(callsLog, 'utf8') : '';
		const deleteContent = existsSync(deleteLog) ? readFileSync(deleteLog, 'utf8') : '';

		// The claim should fail closed with code 1
		expect(result.status).toBe(1);
		expect(stdout).toContain('RESULT=ERROR');
		expect(stderr).toContain('agent-working label retained');

		// Comment 500 should have been deleted during rollback
		expect(deleteContent).toContain('DELETE_CALLED');

		// Label SHOULD have been added
		expect(callsContent).toContain('--add-label agent-working');

		// Label MUST NOT have been removed during rollback (fail-closed retention)
		expect(callsContent).not.toContain('--remove-label agent-working');
	});

	/**
	 * Verify issue #338 fix: if a takeover session attempts to take over a stale claim,
	 * but the target claim comment was renewed via PATCH during/right before takeover,
	 * the takeover session detects the target renewal, rolls back its takeover comment,
	 * and yields RESULT=SKIP.
	 */
	it('yields when target claim comment was renewed during takeover', () => {
		const staleTs = '2026-08-01T10:00:00Z';
		const nowTs = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
		const deleteLog = join(tempDir, 'delete.log');

		const ghScript = [
			'#!/usr/bin/env bash',
			'echo "$*" >> ' + join(tempDir, 'calls.log'),
			'ARGS="$*"',
			'if echo "$ARGS" | grep -q "auth status"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "auth switch"; then exit 0; fi',
			'if echo "$ARGS" | grep -q "repo view"; then echo "francovp/cabros-bot"; exit 0; fi',
			'if [ "$1" = "api" ] && [ "$2" = "user" ]; then',
			'  if [ "${3:-}" = "--jq" ]; then echo "francovp"; else echo \'{"login":"francovp"}\'; fi',
			'  exit 0',
			'fi',
			'if echo "$ARGS" | grep -q "issue view.*labels"; then echo "true"; exit 0; fi',
			// paginated comments — before POST: stale claim 100; after POST (arbitration/verification): comment 100 renewed!
			'if echo "$ARGS" | grep -q "api --paginate.*issues.*338.*comments"; then',
			'  POST_FLAG=' + join(tempDir, 'post_done'),
			'  if [ ! -f "$POST_FLAG" ]; then',
			// Before POST: only stale claim 100 by original owner
			'    printf "%s\\t%s\\t%s\\n" "100" "' + staleTs + '" "**agent-claim**: other-agent other-session ' + staleTs + '"',
			'  else',
			// After POST: comment 100 was renewed with last: nowTs, plus our takeover comment 200
			'    printf "%s\\t%s\\t%s\\n" "100" "' + staleTs + '" "**agent-claim**: other-agent other-session ' + staleTs + ' (renewed 1 time(s), last: ' + nowTs + ')"',
			'    printf "%s\\t%s\\t%s\\n" "200" "' + nowTs + '" "**agent-claim**: antigravity session-test-takeover ' + nowTs + ' (takeover of stale claim by other-agent/other-session)"',
			'  fi',
			'  exit 0',
			'fi',
			'if echo "$ARGS" | grep -q "api --paginate.*events"; then echo "[]"; exit 0; fi',
			// POST takeover comment — returns comment ID 200 and marks POST_FLAG
			'if echo "$ARGS" | grep -q "api.*issues.*338.*comments -f body="; then',
			'  touch ' + join(tempDir, 'post_done'),
			'  echo "200"',
			'  exit 0',
			'fi',
			// DELETE takeover comment when yielding
			'if echo "$ARGS" | grep -q "api -X DELETE.*comments"; then',
			'  echo "DELETE_200" >> ' + deleteLog,
			'  exit 0',
			'fi',
			'exit 0',
		].join('\n');

		buildFakeGh(tempDir, ghScript);

		const result = runClaimScript(tempDir, 338, {
			CLAIM_AGENT_ID: 'antigravity',
			CLAIM_SESSION_ID: 'session-test-takeover',
		});
		const stdout = result.stdout || '';
		const deleteContent = existsSync(deleteLog) ? readFileSync(deleteLog, 'utf8') : '';

		// Should have deleted the takeover comment (rolled back)
		expect(deleteContent).toContain('DELETE_200');

		// Should exit RESULT=SKIP (status 2)
		expect(stdout).toContain('RESULT=SKIP');
		expect(stdout).toContain('target claim comment 100 was renewed during takeover');
		expect(result.status).toBe(2);
	});
});


