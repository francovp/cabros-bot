# Outcome Contract and Deadlock Policy

This reference defines the required outcomes and the deadlock policy for issue automation.

## Outcome Contract

Every processed issue must end with exactly one of these outcomes:

1. `DONE`: The issue is already completed and trackers were synced.
2. `IN_REVIEW`: A PR is intentionally handed off for human review and trackers were synced.
3. `SHIPPED`: The code is already on `master` or covered by a merged PR.
4. `SYNCED`: Only tracker synchronization was needed.
5. `LOCAL_DEADLOCK`: The issue is blocked by an issue-specific blocker.
6. `GLOBAL_BLOCKED`: Tooling, auth, repo, CI, Railway, Linear, or GitHub access prevents safe work.
7. `NEEDS_USER`: Safe progress requires user input.
8. `AMBIGUOUS`: Safe progress requires resolving ambiguity.
9. `CLAIMED`: Another agent session owns the issue with a fresh claim (`scripts/claim-issue.sh` exit `2` / `RESULT=SKIP`). Zero-work skip outcome — the run advances to the next oldest issue without touching anything. Never counts toward the session's issue budget (e.g., 3 issues per session) or the max-2 write budget.

`CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes (still blocked after an unblock attempt), and `IN_REVIEW` with no agent writes are **skip outcomes** — the agent produced no code changes, PR, or Linear writes for this issue. They permit advancing to the next oldest issue in a skip loop until a non-skip outcome (`IN_REVIEW` with writes, `DONE`, `SHIPPED`, `SYNCED`, write-producing `GLOBAL_BLOCKED`, etc.) or no issues remain. A `GLOBAL_BLOCKED` raised after the iteration already produced agent writes (code changes, PR creation/update, or Linear issue creation/update) is write-producing and is NOT a skip outcome; the run releases `agent-working` from the issue/PR, notifies humans, and stops.

Use `SHIPPED` for direct merges. Use `IN_REVIEW` only when the PR is intentionally paused for human review.

## Deadlock Policy

1. **Local Deadlock Definition**: `LOCAL_DEADLOCK` means the issue is blocked by an issue-specific blocker that does not prevent safe work on a different issue.
2. **Skip Loop Allowance**: `CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes (still blocked after an unblock attempt), and `IN_REVIEW` with no agent writes are **skip outcomes** — they do not consume the issue-processing budget (including any session-level issue budget such as 3 issues per session). The agent keeps fetching the next oldest issue in a skip loop until a non-skip outcome or no issues remain. Write-producing `GLOBAL_BLOCKED` outcomes consume the budget and stop the run.
3. **Local Blocker Examples**:
   - Failed checks that do not converge after the retry budget.
   - Preview deploy failures after retry budget (excluding Railway stale-deploy recovery — see below).
   - Draft PRs with no safe next action.
   - Repeated implementation failure with no new evidence.
   - Closed unmerged PR where safe progress requires reopening or recreating it.
   - Issue-specific missing requirement that can be documented without blocking all work.
4. **Actionable PR Work vs Blocker**: Unresolved review threads on an `In review` PR are not a local deadlock; treat them as active PR work.
5. **Ambiguity/User Input**: Issue ambiguity that requires user input is `AMBIGUOUS` or `NEEDS_USER`, not `LOCAL_DEADLOCK`.
6. **Global Blockers**: Global blockers prevent safe work in general. Examples:
   - Missing authentication for both CLI and MCP paths.
   - Unavailable GitHub, Linear, CI, Railway, or repository tooling.
   - Broken local workspace.
   - Missing repository access.
   - Failures that prevent safe work in general.
7. **Resolution**: If a global blocker is encountered on an issue/PR (e.g., a `GLOBAL_BLOCKED` label) while tooling is functional, first attempt to unblock it with a bounded retry of the failing action. If the PR still cannot be unblocked, compare a stable blocker fingerprint (issue/PR, blocker class, expected PR head, and observed `service.commit` or missing capability) with the latest blocker summary. For an unchanged fingerprint, do not add a duplicate comment or notification; keep the label, remove `agent-working` from the issue and PR, and treat the issue as a skip outcome. For a changed fingerprint, write a concise blocker summary (exact missing capability + smallest human action needed), send one notification, keep the `GLOBAL_BLOCKED` label, remove `agent-working` from the issue and PR, and treat the issue as a skip outcome. Notify again only after the blocker clears and later reappears. Advance to the next oldest issue instead of halting the run. The skip loop passes an accumulated `SKIPPED_ISSUES` list (every issue number already skipped in this run) to `get-oldest-issue.sh`, so the cursor cannot alternate between two adjacent skipped issues. If the blocker is a total tooling/access failure (e.g., CLI + MCP auth both fail), stop the run with `GLOBAL_BLOCKED`; advancing is impossible without a working `gh`/`linear` path.
8. **Railway stale-deploy / bounded-retry recovery**: When `GLOBAL_BLOCKED` is caused by a Railway bounded retry (`429`/`rate-limit`) or an outdated Railway deployment (PR preview serving a commit older than the PR head), do not treat the PR as permanently blocked. First attempt the recovery described in SKILL.md Step 6.5: update the branch with `master` if behind, or trigger a Railway deploy via `railway up` / `railway redeploy` or the Railway API, wait for the new deployment to become healthy via `scripts/verify-preview.sh`, and on success remove `GLOBAL_BLOCKED` and `need manual PR deploy` labels and continue the normal flow. Only if the recovery cannot be performed (no `railway` CLI auth, no push permission, or deployment still unhealthy after bounded wait), add the `need manual PR deploy` label, send the WhatsApp notification with PR link, and skip to the next issue.
9. **Filtered labels**: Issues or PRs carrying `need manual PR deploy` are pre-filtered by `scripts/get-oldest-issue.sh` and by the Step 1 pre-flight in SKILL.md. They are zero-work skips. `brainstorming` / `Brainstorming` / `brainstorm` labeled issues are also pre-filtered — the Brainstorming skill is ignored by this automator.
10. **Firebase Hosting quota**: `RESOURCE_EXHAUSTED` / `channel quota reached` errors from Firebase Hosting preview channels are NOT a global blocker. Run `node scripts/cleanup-preview-channels.js --apply` locally to reclaim channels and retry; see SKILL.md for the exact command.
11. **Limits**: Never retry indefinitely. After a non-skip outcome (`IN_REVIEW` with writes, `DONE`, `SHIPPED`, `SYNCED`, or write-producing `GLOBAL_BLOCKED`), stop the run — do not process further issues. `CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` no-writes (still blocked), and `IN_REVIEW` no-writes loop freely in a skip loop until a non-skip outcome — an unblocked PR `SHIPPED` or `IN_REVIEW` — or no issues remain. `CLAIMED` skips also loop freely: a claimed issue is re-evaluated each session so stale claims can be taken over.
