# Readiness Gate and Verification Policy

This reference defines the verification rules, readiness criteria, and quiet window policies for PR submission.

## Documentation-only PRs

Use the docs-only classification in SKILL.md Hard Rule 23. Mark code tests, lint, code checks, and preview deployment verification as `N/A (documentation-only)`; do not manually trigger them or wait for automatic runs. A PR integration may start a preview automatically; do not wait for or verify it. Use `[skip ci]` in the commit message to suppress supported GitHub Actions workflows. Continue the pre-PR review sessions and Codex review workflow. Never bypass required branch protection; if a skipped required check blocks merge, hand the PR off for human handling.

## Merge Gate

A PR is ready to merge directly only if all of these are true and the agent is confident no human review is needed:

1. **No Unresolved Discussions**: No open actionable inline discussions, review threads, or top-level PR conversation comments remain, especially from `@francovp` and Codex. Establish inline state with paginated GraphQL `reviewThreads`, paginate and track every thread comment by ID and `createdAt`/`updatedAt`, and track paginated top-level conversation comments by ID and timestamp; flat comments alone are not proof of inline resolution. Match automated review authors by their actual login, including `chatgpt-codex-connector` when present, before applying the Codex rate-limit fallback below. A thread requiring product authority or human clarification is an explicit `IN_REVIEW` handoff exception, not a merge-ready state.
2. **All Checks Green**: For code changes, all required checks are green or conclusively non-blocking. This gate is not applicable to documentation-only PRs.
3. **Preview Live**: For code changes, the configured preview deployment is live and operational, verified against the URL resolved for that PR. This gate is not applicable to documentation-only PRs.
4. **Direct Verification**: For code changes, direct `curl` verification against the resolved preview succeeds (see Preview and E2E). This gate is not applicable to documentation-only PRs.
5. **Criteria Matched**: The implementation matches all issue acceptance criteria.
6. **No Ownership Conflict**: No active ownership conflicts remain.
7. **Stability Period**: The head SHA has been stable for at least 5 minutes with no new Codex reviews or unresolved threads appearing.
8. **Codex Review Disposition**: Codex gave its configured 👍 approval on the PR description, or the complete quiet window ended without new actionable feedback. A rate-limit response uses the fallback below; any other review error blocks merge. If Codex still requests changes after the third review request, hand off for human revision.

If any criterion is uncertain, or a discussion requires human input, keep the same gate but hand the PR off through `In review` instead of merging it directly.

## Preview and E2E

These steps apply to code changes. For documentation-only PRs, do not create, trigger, or verify a preview deployment.

1. **Preview URL Resolution (dynamic)**: Never assume a host from the PR number. Resolve the live preview URL with `scripts/get-pr-deployment-url.sh <PR_NUMBER>`, which returns the `environment_url` of the latest `success`/`active` GitHub Deployment for that PR — so the target may be Railway, OpenClaw, Tailscale, Fly.io, or any other provider the PR was deployed to. Only when no GitHub deployment exists does the resolver fall back to the Railway host pattern `https://cabros-bot-cabros-bot-pr-<PR_NUMBER>.up.railway.app`, and it prints a warning when it does; treat that warning as "this URL is unproven", not as a deployment fact. Production (`master`) is the fixed `https://cabros-crypto-bot-telegram.onrender.com`, also returned by the resolver for the `production` / `prod` / `master` aliases. `scripts/verify-preview.sh` performs this resolution internally and echoes the resolved base URL, so prefer it over hand-built URLs.
2. **Deploy Proof**: Perform a direct `curl` call against the resolved preview base URL as final deploy proof — at minimum `/healthcheck`, plus `/openapi.json` and any new endpoints introduced by the PR.
3. **Healthcheck Ping**: Use `/healthcheck` for liveness; use `/openapi.json` for contract reachability; use auth-gated `/api/status` with `x-api-key` when verifying private endpoints.
4. **Root Route 404s**: Treat `GET /` returning `404` as acceptable only if the service intentionally lacks a root route.
5. **Stale Deployments**: Pass the PR head SHA as the third `EXPECTED_SHA` argument — `scripts/verify-preview.sh <PR_NUMBER> "/healthcheck,/openapi.json,/api/your-new-endpoint" "$(gh pr view <PR_NUMBER> --json headRefOid --jq .headRefOid)"`. The deployed SHA is read from the GitHub Deployments API, so this works for every provider. A mismatch exits `2` and routes to Step 6.5 recovery.
6. **E2E Executions**: Run the relevant E2E flow against the resolved preview. Pass new-endpoint paths to `scripts/verify-preview.sh <PR_NUMBER> "/healthcheck,/openapi.json,/api/your-new-endpoint"`.
7. **Repeated Failures**: If preview or E2E checks fail repeatedly due to the same issue-specific blocker, end the run with outcome `LOCAL_DEADLOCK`.
8. **Stale Deployments**: Railway is unavailable. If the resolver reports `source=railway-fallback` or selects a Railway URL, do not probe that URL or trigger a Railway deploy. Follow SKILL.md Step 6.5: update the branch against its base, wait for an active OpenClaw deployment, and resolve the URL and SHA again. When no usable deployment record exists, the OpenClaw URL in SKILL.md is only a candidate; verify health and require `service.commit` to equal the PR head. If a required deployment environment variable is missing, add `need manual PR deploy` and send the prescribed WhatsApp notification without its value.
9. **Other Preview Providers**: Use the URL and SHA from the active GitHub deployment record, even when its host differs from the PR-number naming pattern. After the bounded wait, resolve again and verify the new active record; escalate to `need manual PR deploy` only for a concrete operator prerequisite such as a missing environment variable.
10. **Firebase Hosting previews**: `RESOURCE_EXHAUSTED` / channel quota errors from `firebase hosting:channel:deploy` are NOT a blocker. Run `node scripts/cleanup-preview-channels.js --apply` locally to free channels, then retry the preview deployment. Do not mark the PR `GLOBAL_BLOCKED` for this reason.

## Retry and Livelock Control

1. **Bounded Checks**: Each quiet-window check is bounded; check paginated inline `reviewThreads` plus every paginated comment within each thread and paginated top-level PR conversation comments, and do not poll continuously outside the required midpoint and endpoint checks.
2. **Verification Limit**: Allow at most 3 full verification cycles for an unchanged head SHA. Discussion-only activity does not reset this counter.
3. **Reset Trigger**: A concrete new head commit resets the verification-cycle counter and quiet window. A new discussion resets only the quiet window; address it without resetting the cycle budget.
   - This verification-cycle limit is separate from the maximum of 3 Codex review requests per PR; the first request counts, and failed requests still use the cap.
4. **Baseline Discussions**: Before the quiet window starts, triage every unresolved inline thread and actionable top-level conversation comment in the baseline snapshot. Do not treat an existing item as already handled merely because it predates the snapshot.
5. **Human Input**: If a thread needs product authority or missing requirements, stop the loop and use Step 7 for `IN_REVIEW`; do not force resolution or classify it as a polling blocker.
6. **Repeated Blockers**: If the same blocker persists across cycles, end with outcome `LOCAL_DEADLOCK`.
7. **Action Duplication**: Do not retry the same failed action unless there is a clear reason it may now succeed.
8. **Polling Constraints**: Do not poll indefinitely without review activity. Repeat the quiet-window cycle after new discussions, but if 3 unchanged-head cycles are exhausted with unresolved actionable feedback, end with `LOCAL_DEADLOCK` or use Step 7 when human input is required.

## Quiet Window

1. **Window Duration**: After the latest commit, wait a quiet window of 10 minutes before calling the PR clean or ready.
2. **Midpoint & Endpoint Checks**: During the quiet window, re-check reviews, thread comments, and top-level comments once around the midpoint (5 minutes) and once at the end.
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
