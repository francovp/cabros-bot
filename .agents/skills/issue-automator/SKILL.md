---
name: issue-automator
description: >-
  Automates the end-to-end processing of open GitHub issues for the current repository. Use when the user requests automating issue resolution, synchronizing Linear tracker states, verifying Render preview deployments, merging ready PRs without human review, or resolving review threads. Do not use for repositories other than the current repository or for general Git operations unrelated to issue lifecycle automation.
---

## Hard Rules

1. If the user explicitly provides a GitHub issue number (e.g. `#42`, `issue 42`, `GH-42`), use that specific issue. Otherwise, work on the oldest open GitHub issue.
2. Process only one issue by default.
3. Process a further issue only after a skip outcome (`LOCAL_DEADLOCK` or `IN_REVIEW` with no agent writes). Non-skip outcomes stop the run — do not touch further issues.
4. Never process more than 2 GitHub issues that require agent writes in one run. Issues already `IN_REVIEW` with no agent writes (skips) are zero-work — they do not consume this budget and only advance the cursor to the next oldest issue.
5. Never inspect deeply, plan, or create TODOs for issues beyond the current cursor in the skip loop — only the issue currently being processed is touched at a time.
6. Never build an unbounded work queue.
7. Never continue to another issue after `DONE`, `SHIPPED`, `SYNCED`, `GLOBAL_BLOCKED`, `NEEDS_USER`, or `AMBIGUOUS`. For `IN_REVIEW`, stop only if the agent actively produced a PR or made changes; if the issue was already in review with no code/PR/Linear writes needed, skip it — keep fetching the next oldest open issue until a non-skip outcome or no issues remain (see Step 6 skip loop).
8. Never create duplicate Linear issues or duplicate PRs.
9. Treat `agent-working` as an ownership claim with a strict lifecycle: **add it when work starts (issue and PR), remove it when work ends (merged or handed off for review).** Never leave `agent-working` on closed/merged issues or PRs.
10. Use the GitHub issue number as the dedupe key for Linear.
11. Prefer live repo state over assumptions.
12. Prefer `gh` and `linear` CLIs over MCP tools when available.
13. Distinguish local blockers from global blockers.
14. Stop cleanly on global blockers, ambiguity, or missing ownership.
15. **GitHub user switching**: Before any `gh` CLI command, always switch to the `francovp` user with `gh auth switch --user francovp`. After all `gh` commands are complete, restore the original user with `gh auth switch --user <original_user>`. The helper script `scripts/gh-auth-utils.sh` provides `save_gh_user`, `switch_to_francovp`, and `restore_gh_user` functions for this pattern. All script-based `gh` calls (in `get-oldest-issue.sh`, `verify-preview.sh`) already source this helper — just call them as-is. For inline `gh` commands in the workflow below, execute the switch pattern manually or use the helper.
16. Always use the `create-pr` skill to create or update PRs. Do not hand-roll PR creation with raw `gh pr create` or `gh pr edit` calls from this skill. The PR body must come from `context/<git-branch-name>.md` and follow the repository PR summary format enforced by `create-pr`.
17. When creating or updating a Linear issue, write a readable ticket body with `Summary`, `Context`, `Acceptance Criteria`, and `References` sections so the tracker stays self-contained.
18. **Always include the Linear issue ID (e.g., `CB-01`) in the PR title in parentheses at the end.** Example: `feat: my awesome feature (CB-01)`. Also include the Linear issue ID in the description/body of both the GitHub issue and the PR.

## Notification Webhook

The skill sends notifications to a Telegram bot webhook for alert-worthy events. The webhook endpoint expects a JSON payload with `x-api-key` auth header.

**Configuration** — set these environment variables before running the skill:
- `NOTIFY_WEBHOOK_URL` — defaults to `https://cabros-crypto-bot-telegram.onrender.com/api/webhook/message`
- `NOTIFY_API_KEY` — the `x-api-key` header value (required)
- `NOTIFY_CHANNELS` — comma-separated, defaults to `telegram,whatsapp`
- `NOTIFY_TELEGRAM_CHAT_ID` — defaults to `-1001234567890`
- `NOTIFY_WHATSAPP_CHAT_ID` — defaults to `120363422033474991@g.us`

**Notification helper** — use this curl template whenever a notification is required:

```bash
curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-crypto-bot-telegram.onrender.com/api/webhook/message}" \
  --header 'Content-Type: application/json' \
  --header "x-api-key: ${NOTIFY_API_KEY}" \
  --data-raw '{
    "message": "'"${NOTIFY_MESSAGE}"'",
    "channels": ["telegram", "whatsapp"],
    "telegramChatId": "'"${NOTIFY_TELEGRAM_CHAT_ID:--1001234567890}"'",
    "whatsappChatId": "'"${NOTIFY_WHATSAPP_CHAT_ID:-120363422033474991@g.us}"'"
  }'
```

**Events that trigger a notification:**
1. **Global deadlock** — when `GLOBAL_BLOCKED` outcome is set, alerting humans that tooling/auth/infra prevents safe work.
2. **PR in review** — when a PR is intentionally handed off for human review in Step 7, notifying that human review is needed.

## Procedural Workflow

Follow these steps in strict chronological order to automate issue resolution:

### Step 1: Pre-flight & Selection
1. **Switch gh to francovp user** — save the current user and switch to francovp for all `gh` commands in this session:
   ```bash
   source scripts/gh-auth-utils.sh && save_gh_user && switch_to_francovp
   ```
2. Determine the target issue:
   - **If the user specifies an issue number** (via `#42`, `issue 42`, `GH-42`, or similar): fetch that specific issue with `gh issue view <NUMBER> --json number,title,createdAt,labels,url`.
   - **If no issue number is given**: run `scripts/get-oldest-issue.sh` to fetch the oldest open GitHub issue (the script handles switching to francovp internally).
3. Select it as the primary issue.
4. Do not fetch, inspect, select, plan, or create TODOs for any second issue at this stage.
5. If no open GitHub issues exist (and none was specified), stop execution immediately.
6. For the primary issue:
   - Check any linked or related Linear issue.
   - Check all open, closed, merged, and draft PRs that reference the issue.
   - Check unresolved review threads and CI status if a PR exists.
   - **Check if any linked PR is already merged**: If a PR that references this issue was already merged into `master`/`main`, clean up the `agent-working` label if present (issue + PR), sync Linear to `Shipped`, and end with outcome `SHIPPED`.
   - **Claim ownership immediately**: Add the `agent-working` label to the GitHub issue **right now**, before any further analysis, so other agents see this issue is being handled. If the label already exists (stale takeover), note the takeover in an issue comment.
   - **Extract any existing Linear ID** from the issue body (scan for patterns like `CB-XX` or `(CB-XX)`) and store it as `LINEAR_ISSUE_ID` for use in later steps. If no ID is found, set `LINEAR_ISSUE_ID=""`.

### Step 2: Ownership & Takeover Check
1. Inspect the issue and PR for an active `agent-working` label.
2. Do not duplicate work if the label was recently updated by another active agent.
3. If ownership is unclear or takeover is unsafe, stop and end the issue with outcome `NEEDS_USER`.
4. If the ownership claim is stale, note the takeover in the issue/PR thread and reclaim it by updating the label.
5. **If the `agent-working` label is not already on the issue** (e.g., a fresh issue with no prior agent work), add it now. Ownership is mandatory before any real work begins.

### Step 3: Align with Linear Tracker
1. Check if a linked Linear issue exists. Refer to `references/outcomes-and-deadlocks.md` for specific tracker sync rules.
2. If no Linear issue exists:
   - Create a new Linear backlog issue.
   - Use the GitHub issue number as the external dedupe key.
   - Give the issue a concise, action-oriented title.
   - Format the description with clear sections:
     - `Summary` — one sentence on the problem or request
     - `Context` — why the work exists and any important background
     - `Acceptance Criteria` — what must be true to consider the issue done
     - `References` — GitHub issue URL, related PRs, or docs
   - Link the Linear issue back to the GitHub issue.
   - **Capture the Linear issue ID** from the creation response (e.g., `CB-42`) and store it as `LINEAR_ISSUE_ID`.
   - **Update the GitHub issue description** to include the Linear ID: append a `---` separator and a `**Linear**: [CB-XX](https://linear.app/...)` reference line at the bottom of the issue body. This makes the connection visible in the GitHub UI without editing the original issue content.
   - Add `agent-working` label to the GitHub issue (if not already present).

3. If a Linear issue exists:
   - Evaluate status: if `Blocked`, end the issue with `LOCAL_DEADLOCK`. If `Needs info`, end with `NEEDS_USER`. If `Canceled`/`Duplicate`, sync GitHub and end with `SYNCED`.
   - If multiple Linear issues remain ambiguous, end with `AMBIGUOUS`.
   - **Extract the Linear issue ID** from the existing issue and store it as `LINEAR_ISSUE_ID`.
   - **Ensure the GitHub issue description** includes the Linear ID reference. If missing, add `**Linear**: [CB-XX](...)` to the issue body.

### Step 4: Action Plan & Implementation
1. Check out a clean branch locally.
2. Implement the changes matching the issue acceptance criteria.
3. Run local tests to verify changes:
   ```bash
   pnpm test
   ```
4. If an open PR exists, reuse it. Do not create a parallel PR.
   - **If reusing an existing PR**, check its title. If the title is missing the Linear ID suffix (e.g., `(CB-42)`), update the PR title with `gh pr edit <NUMBER> --title "original title (CB-42)"` to append it. Also update the PR body to include the Linear ID in the References section.
5. **Create the context file** `context/<git-branch-name>.md` with the branch summary:
   - **First line (title)**: MUST end with `(LINEAR_ISSUE_ID)` if `LINEAR_ISSUE_ID` is set. Example: `feat: add volume confirmation endpoint (CB-42)`. If no Linear ID yet, omit the suffix.
   - **Body sections**: Use the repository's PR description format (`Summary`, `Key Changes`, `Technical Implementation`, `Testing`, `References`).
   - **References section**: Include `**Linear**: [CB-XX](https://linear.app/...)` with the actual issue URL.
   - This file is the required input for the `create-pr` skill and determines both the PR title and PR body.
6. Use the `create-pr` skill to push changes and create/update the PR. Do not call raw `gh pr create` or `gh pr edit` directly from this workflow.
7. **Immediately add `agent-working`** to the PR once created:
   ```bash
   PR_NUMBER="$(gh pr view --json number --jq .number)"
   gh pr edit "$PR_NUMBER" --add-label "agent-working"
   ```
8. **Verify the PR title** contains the Linear ID suffix `(LINEAR_ISSUE_ID)`. If `LINEAR_ISSUE_ID` is set and the PR title is missing it, fix it:
   ```bash
   CURRENT_TITLE="$(gh pr view "$PR_NUMBER" --json title --jq .title)"
   gh pr edit "$PR_NUMBER" --title "${CURRENT_TITLE} (${LINEAR_ISSUE_ID})"
   ```

### Step 5: Verification & Deploy Check
1. Ensure the PR meets all criteria in `references/readiness-and-verification.md`.
2. Retrieve the PR number and run `scripts/verify-preview.sh <PR_NUMBER>` to verify the Render preview deployment is live and healthy.
3. **Address any unresolved discussions**, especially review comments from `@francovp` or `@codex`.
   - **Codex review failure detection**: If a Codex review body text starts with `You have reached your Codex usage limits for code reviews`, the automated Codex review has failed due to rate limiting. Do NOT wait for Codex. Instead, immediately perform the code review yourself:
     - Use `caveman-review` skill (`task(load_skills=["caveman-review"], ...)`) for compressed review findings, OR
     - Deploy a `deep` subagent with explicit instructions to review the PR diff for correctness, edge cases, security concerns, type safety, and alignment with acceptance criteria.
     - If the failed Codex review created a blocking review thread, resolve or address it after your self-review completes.
     - A passing self-review satisfies the "no unresolved discussions" criterion in the merge gate — do NOT reset the quiet window for a usage-limited Codex review.
4. Observe the quiet window and retry policies specified in `references/readiness-and-verification.md`.
5. **Verify the PR title has the Linear ID suffix**: If `LINEAR_ISSUE_ID` is set and the PR title is missing `(LINEAR_ISSUE_ID)` at the end, fix it:
   ```bash
   CURRENT_TITLE="$(gh pr view "$PR_NUMBER" --json title --jq .title)"
   gh pr edit "$PR_NUMBER" --title "${CURRENT_TITLE} (${LINEAR_ISSUE_ID})"
   ```
6. If the PR is ready to land and the agent is confident no human review is needed:
   - Merge the PR.
   - **Remove `agent-working` from the issue and the PR**:
     ```bash
     gh issue edit <ISSUE_NUMBER> --remove-label "agent-working"
     gh pr edit "$PR_NUMBER" --remove-label "agent-working"
     ```
   - Sync GitHub/Linear to the shipped state.
   - End with outcome `SHIPPED`.
7. If human review is still needed, continue to Step 7 instead. If the verification fails repeatedly with issue-specific errors, end with outcome `LOCAL_DEADLOCK`.
### Step 6: Skip Loop — Advance Past Blocked or Already-Handled Issues

Both `LOCAL_DEADLOCK` and `IN_REVIEW` with no agent writes are **skip outcomes** — the agent did not produce a PR or make changes for this issue. Keep advancing until a non-skip outcome or no issues remain.

1. If `LOCAL_DEADLOCK`: Write a concise blocker summary on the issue or PR. Sync GitHub, Linear, and PR states.
2. **If the issue has a merged PR**: Clean up stale `agent-working` labels (issue + PR), sync Linear to `Shipped`, and end with outcome `SHIPPED` (same handling as Step 1).
3. If `IN_REVIEW` with no agent writes: Do not modify the issue, PR, or Linear state — everything is already correct.
4. Re-run `scripts/get-oldest-issue.sh` to fetch the next oldest open issue.
5. If no more open issues exist, stop execution.
6. Process this next issue from Steps 1–5 (treat it as the new primary).
7. If it again ends with a skip outcome (`IN_REVIEW` no-writes or `LOCAL_DEADLOCK`), repeat from step 1.
8. If it ends with any other outcome, proceed to Step 7 with that outcome.

Skip outcomes do not count toward the max-2 issues-that-require-writes limit (Hard Rule #4).

If the primary issue ends with any other outcome (including `IN_REVIEW` with agent writes), stop execution immediately.

### Step 7: Human Review Handoff & Sync
1. Use this path only when human review is needed and the PR should not be merged directly.
2. **Verify the PR title has the Linear ID suffix** (same as Step 5). If `LINEAR_ISSUE_ID` is set and the PR title is missing `(LINEAR_ISSUE_ID)`, fix it:
   ```bash
   CURRENT_TITLE="$(gh pr view "$PR_NUMBER" --json title --jq .title)"
   gh pr edit "$PR_NUMBER" --title "${CURRENT_TITLE} (${LINEAR_ISSUE_ID})"
   ```
3. **Remove `agent-working` from the GitHub issue and PR**:
   ```bash
   ISSUE_NUMBER="$(gh issue view --json number --jq .number)"
   gh issue edit "$ISSUE_NUMBER" --remove-label "agent-working"
   gh pr edit "$PR_NUMBER" --remove-label "agent-working"
   ```
4. Add the `In review` label to the GitHub issue and PR:
   ```bash
   gh issue edit "$ISSUE_NUMBER" --add-label "In review"
   gh pr edit "$PR_NUMBER" --add-label "In review"
   ```
5. Move the Linear issue to the `In review` column.
6. Record the final outcome as `IN_REVIEW` according to `references/outcomes-and-deadlocks.md`.
7. Send an `In review` notification to alert humans that a PR needs review:
   ```bash
   PR_URL="$(gh pr view --json url --jq .url 2>/dev/null || echo "N/A")"
   ISSUE_NUM="$(gh issue view --json number --jq .number 2>/dev/null || echo "N/A")"
   NOTIFY_MESSAGE="[IN_REVIEW] PR ready for review — Issue #${ISSUE_NUM}. Review at: ${PR_URL}" \
     curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-crypto-bot-telegram.onrender.com/api/webhook/message}" \
     --header 'Content-Type: application/json' \
     --header "x-api-key: ${NOTIFY_API_KEY}" \
     --data-raw '{
       "message": "'"${NOTIFY_MESSAGE}"'",
       "channels": ["telegram", "whatsapp"],
       "telegramChatId": "'"${NOTIFY_TELEGRAM_CHAT_ID:--1001234567890}"'",
       "whatsappChatId": "'"${NOTIFY_WHATSAPP_CHAT_ID:-120363422033474991@g.us}"'"
     }'
   ```
8. **Restore original GitHub user** after all `gh` commands are done:
   ```bash
   restore_gh_user
   ```

## Outcome Summary Contract

Always include a final summary of execution containing:
1. Primary issue processed and its outcome.
2. Outcome of the first non-skip issue, if any (issues with skip outcomes `LOCAL_DEADLOCK` or `IN_REVIEW` no-writes are counted as skipped and listed).
3. Tools utilized (`gh`, `linear`, MCP, or scripts).
4. Details of any global blockers.
5. Performed verification steps (CI, reviews, Render preview ping, and E2E).
6. **Linear issue ID** associated with each processed issue (e.g., `CB-42`).
7. **`agent-working` lifecycle confirmation**: For each issue confirm: label was added at start, and removed at end (merged or `In review`).

## Error Handling & Troubleshooting

Refer to this section when encountering execution issues:
- **CLI Authentication Failures**: If `gh` or `linear` CLI calls fail due to auth:
  - First ensure the current user is `francovp` — run `gh auth switch --user francovp` and retry.
  - Verify the `francovp` account has valid credentials with `gh auth status`.
  - If the user switch itself fails, check if `GITHUB_TOKEN` env var is overriding the keyring-based auth.
  - As last resort, check if `GITHUB_TOKEN` or `LINEAR_API_KEY` env vars are loaded. If CLI is unavailable, fallback to MCP commands. If both fail:
  - Send a global-deadlock notification:
    ```bash
    NOTIFY_MESSAGE="[GLOBAL_BLOCKED] Issue automator halted: CLI + MCP auth both failed for $repo/$issue. Human intervention required." \
      curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-crypto-bot-telegram.onrender.com/api/webhook/message}" \
      --header 'Content-Type: application/json' \
      --header "x-api-key: ${NOTIFY_API_KEY}" \
      --data-raw '{
        "message": "'"${NOTIFY_MESSAGE}"'",
        "channels": ["telegram", "whatsapp"],
        "telegramChatId": "'"${NOTIFY_TELEGRAM_CHAT_ID:--1001234567890}"'",
        "whatsappChatId": "'"${NOTIFY_WHATSAPP_CHAT_ID:-120363422033474991@g.us}"'"
      }'
    ```
  - Then end with outcome `GLOBAL_BLOCKED`.
- **Merge Conflicts**: If branch checkout or pushes fail due to conflicts, pull from `master`, resolve conflicts locally, and re-run tests. If resolving conflicts introduces ambiguity, end with `AMBIGUOUS`.
- **Render Preview deployment timeout**: If `scripts/verify-preview.sh` fails after 3 attempts, inspect the Render logs via the Render dashboard. If it is an infrastructure timeout, wait and retry. If it is an application error/crash, treat it as a `LOCAL_DEADLOCK`.
- **Takeover Conflict**: Do not force-remove the `agent-working` label of an active run. Wait or exit with `NEEDS_USER` to allow coordination.
