# Readiness Gate and Verification Policy

This reference defines the verification rules, readiness criteria, and quiet window policies for PR submission.

## Merge Gate

A PR is ready to merge directly only if all of these are true and the agent is confident no human review is needed:

1. **No Unresolved Discussions**: No open actionable discussions or review threads remain, especially from `@francovp` and Codex. Establish this with paginated GraphQL `reviewThreads`; flat PR comments and collector counts are context only, not proof. Match automated review authors by their actual login, including `chatgpt-codex-connector` when present, before applying the Codex rate-limit fallback below. A thread requiring product authority or human clarification is an explicit `IN_REVIEW` handoff exception, not a merge-ready state.
2. **All Checks Green**: All required checks are green or conclusively non-blocking.
3. **Preview Live**: The preview deploy is live and operational.
4. **Direct Verification**: Direct `curl` verification against the Render preview succeeds.
5. **Criteria Matched**: The implementation matches all issue acceptance criteria.
6. **No Ownership Conflict**: No active ownership conflicts remain.
7. **Stability Period**: The head SHA has been stable for at least 5 minutes with no new Codex reviews or unresolved threads appearing.

If any criterion is uncertain, or a discussion requires human input, keep the same gate but hand the PR off through `In review` instead of merging it directly.

## Preview and E2E

1. **Preview URL Scheme**: Construct the preview URL as `https://${RENDER_SERVICE_NAME}-pr-${PR_NUMBER}.onrender.com`. The `RENDER_SERVICE_NAME` is resolved from the `$RENDER_SERVICE_NAME` env var (natively set by Render), falling back to the GitHub repository name, then to a hardcoded default.
2. **Deploy Proof**: Perform a direct `curl` call against the preview URL as final deploy proof.
3. **Healthcheck Ping**: Use `/healthcheck` for signaling status.
4. **Root Route 404s**: Treat `GET /` returning `404` as acceptable only if the service intentionally lacks a root route.
5. **E2E Executions**: Run the relevant E2E flow against the deployed preview.
6. **Repeated Failures**: If preview or E2E checks fail repeatedly due to the same issue-specific blocker, end the run with outcome `LOCAL_DEADLOCK`.

## Retry and Livelock Control

1. **Bounded Checks**: Each quiet-window check is bounded; do not poll continuously outside the required midpoint and endpoint checks.
2. **Verification Limit**: Allow at most 3 full verification cycles for an unchanged head SHA. A new concrete change or newly appeared discussion starts a fresh cycle.
3. **Reset Trigger**: If a new concrete change is pushed or a new discussion appears, address it and reset the verification cycle counter and quiet window for that issue.
4. **Baseline Threads**: Before the quiet window starts, triage every unresolved thread in the baseline snapshot. Do not treat an existing thread as already handled merely because it predates the snapshot.
5. **Human Input**: If a thread needs product authority or missing requirements, stop the loop and use Step 7 for `IN_REVIEW`; do not force resolution or classify it as a polling blocker.
6. **Repeated Blockers**: If the same blocker persists across cycles, end with outcome `LOCAL_DEADLOCK`.
7. **Action Duplication**: Do not retry the same failed action unless there is a clear reason it may now succeed.
8. **Polling Constraints**: Do not poll indefinitely without review activity. When a discussion appears, address it and repeat the quiet-window cycle until one complete cycle finishes with no new discussions or Step 7 is selected for human input.

## Quiet Window

1. **Window Duration**: After the latest commit, wait a quiet window of 10 minutes before calling the PR clean or ready.
2. **Midpoint & Endpoint Checks**: During the quiet window, re-check reviews and threads once around the midpoint (5 minutes) and once at the end.
3. **Reset Trigger**: If Codex posts a new review or a new thread appears, reset the quiet window from that event or from the new commit (whichever is later).
   - **Exception — rate‑limited review**: If the Codex review body text starts with `You have reached your Codex usage limits for code reviews`, this is a review failure, not a real review. Do NOT reset the quiet window. Instead, perform a self-review (see Codex Review Rate Limit Handling section below).
4. **Instability Handling**: If the quiet window cannot complete due to repeated issue-specific instability, end with outcome `LOCAL_DEADLOCK`.

## Codex Review Rate Limit Handling

Codex reviews may fail when the Codex usage quota for code reviews is exhausted. Detect and fall back to a self-review.

1. **Detection**: When checking for Codex reviews on the PR, inspect the review body text. If it starts with `You have reached your Codex usage limits for code reviews`, the automated Codex review has failed due to rate limiting.
2. **Self-Review Fallback**: Immediately perform a code review using available tools:
   - Use `caveman-review` skill via `task(load_skills=["caveman-review"], ...)` for compressed, one-line-per-finding review output, OR
   - Deploy a `deep` subagent with explicit instructions to review the PR diff for: logic correctness, edge case coverage, error handling, type safety, security concerns, and alignment with issue acceptance criteria and existing code patterns.
3. **Thread Handling**: If the failed Codex review created a blocking review thread (e.g., Codex requested changes), resolve or address that thread once the self-review passes.
4. **Gate Effect**: A passing self-review satisfies the "no unresolved discussions" criterion in the merge gate. The quiet window is NOT reset for a usage-limited Codex review — it continues normally.
5. **Outcome**: If the self-review passes all criteria, the agent may proceed to merge (if otherwise ready) or hand off for human review per Step 7.
