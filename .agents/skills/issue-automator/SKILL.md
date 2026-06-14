---
name: issue-automator
description: >-
  Automates the end-to-end processing of open GitHub issues for the current repository. Use when the user requests automating issue resolution, synchronizing Linear tracker states, verifying Render preview deployments, or resolving review threads. Do not use for repositories other than the current repository or for general Git operations unrelated to issue lifecycle automation.
---

## Hard Rules

1. If the user explicitly provides a GitHub issue number (e.g. `#42`, `issue 42`, `GH-42`), use that specific issue. Otherwise, work on the oldest open GitHub issue.
2. Process only one issue by default.
3. Process a second issue only if the first issue ends with explicit outcome `LOCAL_DEADLOCK` or `IN_REVIEW` with no agent writes.
4. Never process more than 2 GitHub issues in one run.
5. Never process, inspect deeply, plan, or create TODOs for a third issue.
6. Never build an unbounded work queue.
7. Never continue to another issue after `DONE`, `SHIPPED`, `SYNCED`, `GLOBAL_BLOCKED`, `NEEDS_USER`, or `AMBIGUOUS`. For `IN_REVIEW`, stop only if the agent actively produced a PR or made changes; if the issue was already in review with no code/PR/Linear writes needed, treat it like `LOCAL_DEADLOCK` and continue to the next oldest issue.
8. Never create duplicate Linear issues or duplicate PRs.
9. Treat `agent-working` as an ownership claim, not as a decorative label.
10. Use the GitHub issue number as the dedupe key for Linear.
11. Prefer live repo state over assumptions.
12. Prefer `gh` and `linear` CLIs over MCP tools when available.
13. Distinguish local blockers from global blockers.
14. Stop cleanly on global blockers, ambiguity, or missing ownership.

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
2. **PR in review** — when a PR is moved to `In review` in Step 7, notifying that human review is needed.

## Procedural Workflow

Follow these steps in strict chronological order to automate issue resolution:

### Step 1: Pre-flight & Selection
1. Determine the target issue:
   - **If the user specifies an issue number** (via `#42`, `issue 42`, `GH-42`, or similar): fetch that specific issue with `gh issue view <NUMBER> --json number,title,createdAt,labels,url`.
   - **If no issue number is given**: run `scripts/get-oldest-issue.sh` to fetch the oldest open GitHub issue.
2. Select it as the primary issue.
3. Do not fetch, inspect, select, plan, or create TODOs for any second issue at this stage.
4. If no open GitHub issues exist (and none was specified), stop execution immediately.
5. For the primary issue:
   - Check any linked or related Linear issue.
   - Check all open, closed, merged, and draft PRs that reference the issue.
   - Check unresolved review threads and CI status if a PR exists.

### Step 2: Ownership & Takeover Check
1. Inspect the issue and PR for an active `agent-working` label.
2. Do not duplicate work if the label was recently updated by another active agent.
3. If ownership is unclear or takeover is unsafe, stop and end the issue with outcome `NEEDS_USER`.
4. If the ownership claim is stale, note the takeover in the issue/PR thread and reclaim it by updating the label.

### Step 3: Align with Linear Tracker
1. Check if a linked Linear issue exists. Refer to `references/outcomes-and-deadlocks.md` for specific tracker sync rules.
2. If no Linear issue exists:
   - Create a new Linear backlog issue.
   - Use the GitHub issue number as the external dedupe key.
   - Link the Linear issue back to the GitHub issue.
   - Add `agent-working` label to the GitHub issue.
3. If a Linear issue exists:
   - Evaluate status: if `Blocked`, end the issue with `LOCAL_DEADLOCK`. If `Needs info`, end with `NEEDS_USER`. If `Canceled`/`Duplicate`, sync GitHub and end with `SYNCED`.
   - If multiple Linear issues remain ambiguous, end with `AMBIGUOUS`.

### Step 4: Action Plan & Implementation
1. Check out a clean branch locally.
2. Implement the changes matching the issue acceptance criteria.
3. Run local tests to verify changes:
   ```bash
   pnpm test
   ```
4. If an open PR exists, reuse it. Do not create a parallel PR.
5. Push changes and create/update the PR.
6. Add `agent-working` to the PR once created.

### Step 5: Verification & Deploy Check
1. Ensure the PR meets all criteria in `references/readiness-and-verification.md`.
2. Retrieve the PR number and run `scripts/verify-preview.sh <PR_NUMBER>` to verify the Render preview deployment is live and healthy.
3. Address any unresolved discussions, especially review comments from `@francovp` or `@codex`.
4. Observe the quiet window and retry policies specified in `references/readiness-and-verification.md`.
5. If the verification fails repeatedly with issue-specific errors, end with outcome `LOCAL_DEADLOCK`.

### Step 6: Fallback Trigger (Conditional)
1. If the primary issue ends with `LOCAL_DEADLOCK`:
   - Write a concise blocker summary on the issue or PR.
   - Sync GitHub, Linear, and PR states.
   - Re-run `scripts/get-oldest-issue.sh` to fetch the next oldest open issue.
   - Process this second issue as the fallback issue.
   - If no fallback issue exists or if the fallback issue fails, stop execution.
2. If the primary issue ends with `IN_REVIEW` and the agent made **no code/PR/Linear writes** (the issue was already handled):
   - Do not modify the issue, PR, or Linear state — everything is already correct.
   - Re-run `scripts/get-oldest-issue.sh` to fetch the next oldest open issue.
   - Process this second issue as the fallback issue.
   - If no fallback issue exists or if the fallback issue fails, stop execution.
3. If the primary issue ends with any other outcome, or if `IN_REVIEW` with agent writes, stop execution immediately.

### Step 7: Finalization & Sync
1. Remove `agent-working` from the GitHub issue and PR.
2. Add the `In review` label to the GitHub issue and PR.
3. Move the Linear issue to the `In review` column.
4. Record the final outcome according to the contract in `references/outcomes-and-deadlocks.md`.
5. Send an `In review` notification to alert humans that a PR needs review:
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

## Outcome Summary Contract

Always include a final summary of execution containing:
1. Primary issue processed and its outcome.
2. Fallback issue processed (only if primary ended in `LOCAL_DEADLOCK` or `IN_REVIEW` with no agent writes) and its outcome.
3. Tools utilized (`gh`, `linear`, MCP, or scripts).
4. Details of any global blockers.
5. Performed verification steps (CI, reviews, Render preview ping, and E2E).

## Error Handling & Troubleshooting

Refer to this section when encountering execution issues:
- **CLI Authentication Failures**: If `gh` or `linear` CLI calls fail due to auth, check if the respective environment tokens (`GITHUB_TOKEN`, `LINEAR_API_KEY`) are loaded. If CLI is unavailable, fallback to MCP commands. If both fail:
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
