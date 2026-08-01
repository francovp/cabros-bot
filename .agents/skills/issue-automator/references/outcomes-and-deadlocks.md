# Outcome Contract and Deadlock Policy

This reference defines the required outcomes and the deadlock policy for issue automation.

## Outcome Contract

Every processed issue must end with exactly one of these outcomes:

1. `DONE`: The issue is already completed and trackers were synced.
2. `IN_REVIEW`: A PR is intentionally handed off for human review and trackers were synced.
3. `SHIPPED`: The code is already on `master` or covered by a merged PR.
4. `SYNCED`: Only tracker synchronization was needed.
5. `LOCAL_DEADLOCK`: The issue is blocked by an issue-specific blocker.
6. `GLOBAL_BLOCKED`: Tooling, auth, repo, CI, Render, Linear, or GitHub access prevents safe work.
7. `NEEDS_USER`: Safe progress requires user input.
8. `AMBIGUOUS`: Safe progress requires resolving ambiguity.

`LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes (still blocked after an unblock attempt), and `IN_REVIEW` with no agent writes are **skip outcomes** — the agent produced no code changes, PR, or Linear writes for this issue. They permit advancing to the next oldest issue in a skip loop until a non-skip outcome (`IN_REVIEW` with writes, `DONE`, `SHIPPED`, `SYNCED`, write-producing `GLOBAL_BLOCKED`, etc.) or no issues remain. A `GLOBAL_BLOCKED` raised after the iteration already changed code or created/updated a PR is write-producing and is NOT a skip outcome.

Use `SHIPPED` for direct merges. Use `IN_REVIEW` only when the PR is intentionally paused for human review.

## Deadlock Policy

1. **Local Deadlock Definition**: `LOCAL_DEADLOCK` means the issue is blocked by an issue-specific blocker that does not prevent safe work on a different issue.
2. **Skip Loop Allowance**: `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes (still blocked after an unblock attempt), and `IN_REVIEW` with no agent writes are **skip outcomes** — they do not consume the issue-processing budget. The agent keeps fetching the next oldest issue in a skip loop until a non-skip outcome or no issues remain. Write-producing `GLOBAL_BLOCKED` outcomes consume the budget and stop the run.
3. **Local Blocker Examples**:
   - Failed checks that do not converge after the retry budget.
   - Preview deploy failures after retry budget.
   - Draft PRs with no safe next action.
   - Repeated implementation failure with no new evidence.
   - Closed unmerged PR where safe progress requires reopening or recreating it.
   - Issue-specific missing requirement that can be documented without blocking all work.
4. **Actionable PR Work vs Blocker**: Unresolved review threads on an `In review` PR are not a local deadlock; treat them as active PR work.
5. **Ambiguity/User Input**: Issue ambiguity that requires user input is `AMBIGUOUS` or `NEEDS_USER`, not `LOCAL_DEADLOCK`.
6. **Global Blockers**: Global blockers prevent safe work in general. Examples:
   - Missing authentication for both CLI and MCP paths.
   - Unavailable GitHub, Linear, CI, Render, or repository tooling.
   - Broken local workspace.
   - Missing repository access.
   - Failures that prevent safe work in general.
7. **Resolution**: If a global blocker is encountered on an issue/PR (e.g., a `GLOBAL_BLOCKED` label) while tooling is functional, first attempt to unblock it with a bounded retry of the failing action. If the PR still cannot be unblocked, write a concise blocker summary (exact missing capability + smallest human action needed), send the global-deadlock notification, keep the `GLOBAL_BLOCKED` label, remove `agent-working` from the issue and PR, and treat the issue as a skip outcome — advance to the next oldest issue instead of halting the run. The skip loop passes an accumulated `SKIPPED_ISSUES` list (every issue number already skipped in this run) to `get-oldest-issue.sh`, so the cursor cannot alternate between two adjacent skipped issues. If the blocker is a total tooling/access failure (e.g., CLI + MCP auth both fail), stop the run with `GLOBAL_BLOCKED`; advancing is impossible without a working `gh`/`linear` path.
8. **Limits**: Never retry indefinitely. After a non-skip outcome (`IN_REVIEW` with writes, `DONE`, `SHIPPED`, `SYNCED`, or write-producing `GLOBAL_BLOCKED`), stop the run — do not process further issues. `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` no-writes (still blocked), and `IN_REVIEW` no-writes loop freely in a skip loop until a non-skip outcome — an unblocked PR `SHIPPED` or `IN_REVIEW` — or no issues remain.
