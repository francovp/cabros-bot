# Outcome Contract and Deadlock Policy

This reference defines the required outcomes and the deadlock policy for issue automation.

## Outcome Contract

Every processed issue must end with exactly one of these outcomes:

1. `DONE`: The issue is already completed and trackers were synced.
2. `IN_REVIEW`: A PR is ready for review and trackers were synced.
3. `SHIPPED`: The code is already on `master` or covered by a merged PR.
4. `SYNCED`: Only tracker synchronization was needed.
5. `LOCAL_DEADLOCK`: The issue is blocked by an issue-specific blocker.
6. `GLOBAL_BLOCKED`: Tooling, auth, repo, CI, Render, Linear, or GitHub access prevents safe work.
7. `NEEDS_USER`: Safe progress requires user input.
8. `AMBIGUOUS`: Safe progress requires resolving ambiguity.

Only a `LOCAL_DEADLOCK` on the primary issue, or an `IN_REVIEW` outcome with no agent writes performed, permits processing the second issue.

## Deadlock Policy

1. **Local Deadlock Definition**: `LOCAL_DEADLOCK` means the issue is blocked by an issue-specific blocker that does not prevent safe work on a different issue.
2. **Fallback Allowance**: A local deadlock on the primary issue allows exactly one fallback issue. An `IN_REVIEW` outcome with no agent writes also allows exactly one fallback issue. A local deadlock or `IN_REVIEW` (no writes) on the fallback issue stops the run.
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
7. **Resolution**: If a global blocker is encountered, end the run with outcome `GLOBAL_BLOCKED`.
8. **Limits**: Never retry indefinitely. Never continue past the fallback issue.
