# Readiness Gate and Verification Policy

This reference defines the verification rules, readiness criteria, and quiet window policies for PR submission.

## Merge Gate

A PR is ready to merge directly only if all of these are true and the agent is confident no human review is needed:

1. **No Unresolved Discussions**: No open discussions or review threads remain, especially from `@francovp` and `@codex`.
2. **All Checks Green**: All required checks are green or conclusively non-blocking.
3. **Preview Live**: The preview deploy is live and operational.
4. **Direct Verification**: Direct `curl` verification against the Render preview succeeds.
5. **Criteria Matched**: The implementation matches all issue acceptance criteria.
6. **No Ownership Conflict**: No active ownership conflicts remain.
7. **Stability Period**: The head SHA has been stable for at least 5 minutes with no new Codex reviews or unresolved threads appearing.

If any criterion is uncertain, keep the same gate but hand the PR off through `In review` instead of merging it directly.

## Preview and E2E

1. **Preview URL Scheme**: Construct the preview URL as `https://${RENDER_SERVICE_NAME}-pr-${PR_NUMBER}.onrender.com`. The `RENDER_SERVICE_NAME` is resolved from the `$RENDER_SERVICE_NAME` env var (natively set by Render), falling back to the GitHub repository name, then to a hardcoded default.
2. **Deploy Proof**: Perform a direct `curl` call against the preview URL as final deploy proof.
3. **Healthcheck Ping**: Use `/healthcheck` for signaling status.
4. **Root Route 404s**: Treat `GET /` returning `404` as acceptable only if the service intentionally lacks a root route.
5. **E2E Executions**: Run the relevant E2E flow against the deployed preview.
6. **Repeated Failures**: If preview or E2E checks fail repeatedly due to the same issue-specific blocker, end the run with outcome `LOCAL_DEADLOCK`.

## Retry and Livelock Control

1. **Bounded Loops**: Re-check CI, preview, and review threads in a bounded loop.
2. **Verification Limit**: Allow at most 3 full verification cycles unless a new concrete change lands.
3. **Reset Trigger**: If a new concrete change is pushed, reset the verification cycle counter for that issue.
4. **Repeated Blockers**: If the same blocker persists across cycles, end with outcome `LOCAL_DEADLOCK`.
5. **Action Duplication**: Do not retry the same failed action unless there is a clear reason it may now succeed.
6. **Polling Constraints**: Do not keep polling indefinitely during the same run.

## Quiet Window

1. **Window Duration**: After the latest commit, wait a quiet window of 5 minutes before calling the PR clean or ready.
2. **Midpoint & Endpoint Checks**: During the quiet window, re-check reviews and threads once around the midpoint (2.5 minutes) and once at the end.
3. **Reset Trigger**: If Codex posts a new review or a new thread appears, reset the quiet window from that event or from the new commit (whichever is later).
4. **Instability Handling**: If the quiet window cannot complete due to repeated issue-specific instability, end with outcome `LOCAL_DEADLOCK`.
