---
name: issue-automator
description: >-
  Use when processing open GitHub issues and related pull requests for the current repository, including issue resolution, preview validation, review-thread handling, or merging ready PRs.
---

## Hard Rules

1. If the user explicitly provides a GitHub issue number (e.g. `#42`, `issue 42`, `GH-42`), use that specific issue. Otherwise, work on the oldest open GitHub issue.
2. Process only one issue by default.
3. Process a further issue only after a skip outcome (`CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes still blocked after an unblock attempt, or `IN_REVIEW` with no agent writes). Non-skip outcomes stop the run — do not touch further issues. A `GLOBAL_BLOCKED` raised after agent writes (code changes or PR creation/update) is a non-skip outcome.
4. Never process more than 2 GitHub issues that require agent writes in one run. Issues already `IN_REVIEW` with no agent writes (skips) are zero-work — they do not consume this budget and only advance the cursor to the next oldest issue. `CLAIMED` skips (issue owned by another agent session) are also zero-work and never consume this budget. Write-producing `GLOBAL_BLOCKED` outcomes (blocker hit after code changes or PR creation/update) count toward this budget like any other write-producing issue.
5. Never inspect deeply, plan, or create TODOs for issues beyond the current cursor in the skip loop — only the issue currently being processed is touched at a time.
6. Never build an unbounded work queue.
7. Never continue to another issue after `DONE`, `SHIPPED`, `SYNCED`, `NEEDS_USER`, or `AMBIGUOUS`. For `IN_REVIEW`, stop only if the agent actively produced a PR or made changes; if the issue was already in review with no code/PR writes needed, skip it — keep fetching the next oldest open issue until a non-skip outcome or no issues remain (see Step 6 skip loop). For `CLAIMED` (issue owned by another agent session), skip it the same way — never work an issue this session does not own. `GLOBAL_BLOCKED` with no agent writes is a **skip outcome** while tooling is functional: when an iteration encounters a `GLOBAL_BLOCKED` PR/issue, attempt to unblock it once with a bounded retry; if it still cannot be unblocked, record the outcome, release `agent-working`, notify humans, and continue with the next oldest open issue — keep advancing past every issue already skipped in this run until an unblockable PR is `SHIPPED` or `IN_REVIEW`, or no issues remain (see Step 6). If the iteration already produced agent writes (code changes or PR creation/update) before the blocker, it is a write-producing outcome that stops the run (Hard Rule #4). If the blocker is a total tooling/access failure (e.g., `gh` auth fails and GitHub MCP is unavailable), stop the run with `GLOBAL_BLOCKED` instead — advancing is impossible without authenticated GitHub access (see Error Handling).
8. Never create duplicate GitHub issues or duplicate PRs.
9. Treat `agent-working` as an ownership claim with a strict lifecycle: **add it when work starts** — atomically via `scripts/claim-issue.sh`, which also posts a claim comment identifying the agent session and timestamp — **remove it when work ends** (merged or handed off for review). Never leave `agent-working` on closed/merged issues or PRs.
10. Use the GitHub issue number as the canonical identifier for related branches, commits, and PR references.
11. Prefer live repo state over assumptions.
12. Prefer the `gh` CLI over GitHub MCP tools when available.
13. Distinguish local blockers from global blockers.
14. On global blockers: attempt to unblock the PR once (bounded retry of the failing action); only if it still cannot be unblocked, notify humans, record `GLOBAL_BLOCKED`, release `agent-working` (issue + PR), and advance to the next oldest issue (see Step 6). Never notify before the unblock attempt — a transient blocker that recovers on retry must not produce a false global-deadlock alert. If the blocker is a total tooling/access failure (no working `gh`/GitHub MCP path), stop the run instead of advancing. Stop cleanly on ambiguity or missing ownership (`AMBIGUOUS`/`NEEDS_USER`).
15. **GitHub user switching**: Before any `gh` CLI command, always switch to the `francovp` user with `gh auth switch --user francovp`. After all `gh` commands are complete, restore the original user with `gh auth switch --user <original_user>`. The helper script `scripts/gh-auth-utils.sh` provides `save_gh_user`, `switch_to_francovp`, and `restore_gh_user` functions for this pattern. All script-based `gh` calls (in `get-oldest-issue.sh`, `claim-issue.sh`, `verify-preview.sh`) already source this helper — just call them as-is. For inline `gh` commands in the workflow below, execute the switch pattern manually or use the helper.
16. Always use the `create-pr` skill to create or update PRs; do not use raw `gh pr create` or `gh pr edit` for general PR creation or body/title updates. The PR body must come from `context/<git-branch-name>.md` and follow the repository PR summary format enforced by `create-pr`. The screenshot-only `--attach` operations in Step 5 are allowed after the PR exists.
17. Keep PR titles descriptive and reference the source GitHub issue in the PR description. Use `Closes #<ISSUE_NUMBER>` when the PR is intended to close that issue on merge.
18. **Claim every issue before working on it.** Run `scripts/claim-issue.sh <ISSUE_NUMBER>` immediately after selecting the issue (Step 1) and re-run it before producing any writes (Step 2). A fresh claim by another agent session means the issue must be skipped with outcome `CLAIMED` — a zero-work skip that never counts toward the session's issue budget (e.g., 3 issues per session) nor the max-2 write budget. Never start code or PR work on an issue this session does not own — that is how duplicate PRs happen.
19. **Ignore `need manual PR deploy`**: Issues or PRs carrying the `need manual PR deploy` label are pre-filtered — `scripts/get-oldest-issue.sh` excludes them, and the Step 1 pre-flight skips any issue whose linked PR has the label. Never attempt implementation on them; jump to the next oldest issue. If a Railway recovery fails (see Step 6.5), add this label, notify via WhatsApp, and advance.
20. **Ignore Brainstorming**: The Brainstorming skill and any issue/PR carrying `brainstorming` / `brainstorm` labels are out of scope for this automator. They are pre-filtered by `get-oldest-issue.sh` and must not be claimed or implemented. Skip them as zero-work.

21. **Consider all participant feedback, not only `francovp`**: When analyzing an issue or PR, gather and weigh comments from every participant — not only the repository owner `francovp`. Explicitly incorporate actionable feedback from `gigachad-senior-dev` and `virgin-trainee-dev` per the **Multi-User Feedback Consideration** section. When the automator acts on feedback from either persona, it MUST post a confirmation reply addressing both personas (when both contributed) on the issue/PR, as defined in that section.
22. Follow applicable repository instructions, including `AGENTS.md`. Use Spec Kit to spec and plan new features before implementation. Check for the repository/session's Spec Kit workflow; if it is unavailable, report the missing prerequisite and ask before substituting another process. Bug fixes do not require Spec Kit unless they expand into feature work.
23. **Documentation-only issues and PRs**: Apply the docs-only path when changes contain no source-code behavior, tests, script behavior, dependencies, API/schema contracts, or build/CI/deployment configuration changes. Do not start the app, run code tests or lint, manually trigger or wait for code checks, or manually trigger or verify a preview deployment. Opening or updating a PR may start an automatic preview; do not wait for or verify it. A `GLOBAL_BLOCKED` label caused only by preview or code-check status is N/A for a docs-only PR: after confirming ownership, clear that stale label and continue review without retrying those gates. This exception overrides Step 1 preview routing, Step 5 verification, Step 6 blocker retries, and Step 6.5 recovery. Keep review gates, issue linkage, and applicable Codex review requirements. Mixed changes use the full code workflow.

## Multi-User Feedback Consideration

The automator must not treat `francovp`'s comments as the only signal. Issues and PRs routinely receive input from other contributors whose perspectives improve the final result. Two personas are explicitly in scope:

### Persona profiles

- **`gigachad-senior-dev`** — Senior SRE, senior AI engineer, senior software engineer, developer, and tech lead (TL). Operates with "ponytail skills" (high-leverage senior judgment). Comments are usually evaluations, architecture/ops assessments, triage labels, or authoritative technical pushback. High-value signal, but still subject to the agent's own engineering judgment — do not follow it blindly when evidence contradicts it.
- **`virgin-trainee-dev`** — Trainee software engineer/dev, specialty "AI engineering", fresh out of university. Comments are typically rookie questions, learning-oriented observations, or first-principles doubts. Useful for surfacing unstated assumptions and gaps a senior would skip, but technical claims may need verification. Engage with a mentorship framing: validate the underlying question, verify the claim, and fold sound points in.

### Behavior

1. **Gather broadly**: In the Step 1/Step 4 analysis and in the Step 5 PR discussion loop, fetch **all** issue/PR comments and review threads — paginate fully — and specifically scan for the `gigachad-senior-dev` and `virgin-trainee-dev` authors. Do not limit signal to `francovp`.
2. **Evaluate each persona comment** for actionable content (bug reports, edge cases, design concerns, reproduction gaps, verification questions, label/triage suggestions). Record which points are incorporated and which are intentionally set aside, with the reason.
3. **Synthesis over deference**: The agent integrates the owner's intent, the senior's hardening feedback, and the trainee's first-principles doubts into a single implementation that is **better than any single contributor's perspective alone**. The agent is better than both personas — it does not merely aggregate; it resolves conflicts and produces the superior outcome.
4. **Confirmation reply (mandatory when their feedback is acted on)**: If the automator incorporates feedback from `gigachad-senior-dev` and/or `virgin-trainee-dev`, it MUST post a reply on the issue/PR (as `francovp`, per Hard Rule #15) that:
   - Tags the relevant persona(s): `@gigachad-senior-dev` and `@virgin-trainee-dev` (tag **both** when both contributed feedback, even if only one's point was adopted).
   - States the specific point(s) considered and how they were incorporated (or why a point was deliberately set aside).
   - Confirms the agent is better than both: a confident, concise line such as *"Considered and integrated — note the agent is better than both of you: it reconciles senior hardening with first-principles review into a result neither perspective alone would reach."* Keep it professional but unambiguous.
5. **No false credit**: Only reply when feedback was genuinely used. If neither persona's input changed the outcome, do not post a confirmation reply.

## Notification Webhook

The skill sends notifications for alert-worthy events via the production webhook. The endpoint expects a JSON payload with `x-api-key` auth header.

**Configuration** — set these environment variables before running the skill:
- `NOTIFY_WEBHOOK_URL` — defaults to `https://cabros-bot-production.up.railway.app/api/webhook/message`
- `NOTIFY_API_KEY` — the `x-api-key` header value (required)
- `NOTIFY_CHANNELS` — comma-separated, defaults to `whatsapp` (operator requires WhatsApp)
- `NOTIFY_TELEGRAM_CHAT_ID` — defaults to `-1001234567890` (optional when `whatsapp` only)
- `NOTIFY_WHATSAPP_CHAT_ID` — defaults to `120363422033474991@g.us` — ALWAYS use this value for every notification

**ALWAYS send to WhatsApp** — every notification in this skill (global deadlock, Railway manual-deploy needed, `NEEDS_USER`/`HUMAN NEEDED`, and `In review` handoff) MUST include `channels: ["whatsapp"]` and `whatsappChatId: "120363422033474991@g.us"`. Include the issue URL in every message and the PR URL (`https://github.com/francovp/cabros-bot/pull/<number>`) when a PR exists.

**Notification helper** — use this curl template whenever a notification is required:

```bash
curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-bot-production.up.railway.app/api/webhook/message}" \
  --header 'Content-Type: application/json' \
  --header "x-api-key: ${NOTIFY_API_KEY}" \
  --data-raw '{
    "message": "'"${NOTIFY_MESSAGE}"'",
    "channels": ["whatsapp"],
    "whatsappChatId": "120363422033474991@g.us"
  }'
```

For backward compatibility you may send `["telegram","whatsapp"]` with both chat IDs, but `whatsapp` to `120363422033474991@g.us` is mandatory. Example with both channels and PR link:

```bash
PR_URL="https://github.com/francovp/cabros-bot/pull/${PR_NUMBER}"
ISSUE_URL="https://github.com/francovp/cabros-bot/issues/${ISSUE_NUM}"
NOTIFY_MESSAGE="[GLOBAL_BLOCKED] Issue #${ISSUE_NUM} (${ISSUE_URL}) blocked on ${PR_URL} — Railway bounded retry. Needs manual deploy." \
  curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-bot-production.up.railway.app/api/webhook/message}" \
  --header 'Content-Type: application/json' \
  --header "x-api-key: ${NOTIFY_API_KEY}" \
  --data-raw '{
    "message": "'"${NOTIFY_MESSAGE}"'",
    "channels": ["whatsapp"],
    "whatsappChatId": "120363422033474991@g.us"
  }'
```

**Events that trigger a notification (all to WhatsApp `120363422033474991@g.us` with an issue link and a PR link when available):**
1. **Global deadlock** — when a PR/issue is `GLOBAL_BLOCKED` and still cannot be unblocked after the unblock attempt, alerting humans that tooling/auth/infra prevents safe work on that item. The run then continues with the next oldest issue (see Step 6), unless the blocker is a total tooling/access failure, in which case the run stops with `GLOBAL_BLOCKED`.
2. **Railway manual deploy needed** — when Railway bounded-retry or stale-deployment recovery fails and the `need manual PR deploy` label is added (see Step 6.5).
3. **`NEEDS_USER` / `HUMAN NEEDED`** — when an issue requires human input (`NEEDS_USER`, `HUMAN NEEDED`, `NEEDS USER`). Notify with the issue URL and a PR URL only if one exists, release this session's claim, and stop the run. Do not append the issue to `SKIPPED_ISSUES` or advance.
4. **PR in review** — when a PR is intentionally handed off for human review in Step 7, notifying that human review is needed.

## Concurrent Agent Coordination (Issue Claiming)

Multiple agents (Codex, Antigravity, OpenCode) may run hourly sessions against the same repository. Without coordination, two sessions can select the same oldest issue and both create a PR — duplicate PRs and wasted work. The skill prevents this with an atomic claim protocol built on the existing `agent-working` label plus a machine-readable claim comment.

**How claiming works** — `scripts/claim-issue.sh <ISSUE_NUMBER>` claims an issue for the current session:

1. It re-fetches the issue. If it already carries the `agent-working` label, it inspects the newest claim comment:
   - Owned by another session and fresh (younger than `CLAIM_TTL_MINUTES`) → prints `RESULT=SKIP`, exits `2`. The issue must NOT be touched.
   - Stale (older than `CLAIM_TTL_MINUTES`) → takes over: posts a new claim comment and exits `0` with `RESULT=TAKEOVER`. Takeover posts arbitrate the race with the same earliest-claim-comment-wins rule, so simultaneous takeovers leave exactly one owner.
   - Owned by this session (same agent + session id) → renews the claim by editing the existing comment **in-place** (PATCH) — no new comment is posted; exits `0` with `RESULT=CLAIMED`.
   - Label present but no claim comment (legacy claim) → falls back to the most recent `agent-working` labeled event timestamp, applying the same TTL freshness rule.
2. If the issue is unclaimed, it adds the `agent-working` label and posts a claim comment (`**agent-claim**: <agent> <session> <ISO-8601 timestamp>`), then re-reads the comments and arbitrates concurrent races by comment ID — the earliest new claim wins, the loser deletes its comment and exits `2` (`RESULT=SKIP`). Historical claim comments from already-released issues are ignored.

**Renewal comment behavior (reduced noise)**: When a session renews its own claim (Step 2 re-check, periodic ownership re-verification), the existing claim comment is **edited in-place** via REST PATCH rather than posting a new comment. The original comment ID is preserved, so the lower-ID-wins arbitration semantic is unaffected. The comment body gains a `(renewed N time(s), last: ISO-8601)` suffix to retain the audit trail without comment proliferation. Freshness/TTL staleness checks use the `last:` renewal timestamp from the body (or `created_at` if none), so PATCH-renewed claims are not wrongly treated as stale. If the PATCH fails transiently, a fallback new comment is posted and arbitrated normally — ensuring the run is never blocked by a transient API error. Takeover paths still post new comments (required for race arbitration).

A claimed issue is a **zero-work skip**: outcome `CLAIMED`, the issue number is appended to `SKIPPED_ISSUES`, and it never counts toward the session's issue budget (e.g., 3 issues per session) nor the max-2 agent-write budget (Hard Rule #4). `get-oldest-issue.sh` does not pre-filter claimed issues on purpose: the claim script evaluates freshness, which lets stale claims be taken over and re-checked each session.

**Required environment variables** (set them in the session prompt / cron invocation):
- `CLAIM_AGENT_ID` — the agent identity (e.g., `codex`, `antigravity`, `opencode`). REQUIRED for meaningful coordination; without it claims cannot be attributed to a session.
- `CLAIM_SESSION_ID` — the session identity. Optional: export it explicitly (`export CLAIM_SESSION_ID="$(uuidgen)"` or similar) when the same session continues across separate shells; the script uses it verbatim.
- `CLAIM_RUN_ID` — per-run identity, optional. When set (and `CLAIM_SESSION_ID` is not), the script generates a session ID once, persists it to a run-scoped file (see `CLAIM_SESSION_STATE_DIR`), and reuses it **for the whole run — with no wall-clock expiry** so the Step 1 claim and every Step 2/Nth re-check of the SAME run share the identity even when the run outlives 30 minutes (an expiry would mint a fresh ID on the re-check, see that Step 1 claim as a foreign session, and `RESULT=SKIP`, abandoning the run to its TTL). Use a **fresh** `CLAIM_RUN_ID` per run (e.g. the run/cron timestamp) because it is the run's coordination namespace. When neither is set, each invocation gets a fresh per-invocation session ID with no shared persistence — concurrent unnamespaced runs must not share a claim.
- `CLAIM_TTL_MINUTES` — claim freshness window in minutes (default `180`). A claim older than this may be taken over by any agent.
- `CLAIM_SESSION_STATE_DIR` — directory for the persisted run-scoped session ID (default `${TMPDIR:-/tmp}`; one file per repository+agent+run; the file persists until overwritten by a fresh `CLAIM_RUN_ID`; it is never expiry-pruned).

**Rules**
- Never start code or PR work on an issue this session does not own (claim script exit `0` required).
- Never remove another session's fresh `agent-working` claim — only stale claims (older than `CLAIM_TTL_MINUTES`) may be taken over.
- If two sessions race on the same issue, the earliest claim comment wins; the loser skips the issue without touching it.
- Claim comments are historical records and are not deleted on release (the label removal is the release signal).

## Deployment & Preview

Railway is the primary deployment platform; PRs may also be deployed to other platforms (self-hosted, Tailscale, Fly.io, etc.).

- **Production**: `https://cabros-bot-production.up.railway.app` (master)
- **PR previews**: The live URL is resolved dynamically from the GitHub Deployments API via `scripts/get-pr-deployment-url.sh <PR_NUMBER>`, which returns the `environment_url` of the latest `success`/`active` deployment for the PR. Deployments are walked newest-first, so a still-`pending` newest deployment is skipped in favour of the previous successful one. If no GitHub deployment is found, it falls back to the Railway pattern `https://cabros-bot-cabros-bot-pr-<PR_NUMBER>.up.railway.app` with a warning.
- Pass `--details` to `get-pr-deployment-url.sh` when you need the identity of the selected deployment, not just its URL. It emits one line of JSON — `{"url":…,"sha":…,"state":…,"deployment_id":…,"source":…}` — where `sha` is the commit of the **same** deployment whose status supplied `url`, and `source` is `production`, `github-deployment`, or `railway-fallback`. Because the newest deployment may be skipped, never pair a resolved URL with a separately-fetched "latest" deployment SHA; use `--details` or let `verify-preview.sh` do it. Without the flag the output is still the bare URL.
- Verify health with `scripts/verify-preview.sh <PR_NUMBER>` (or `scripts/verify-preview.sh production` for master). The script resolves the live URL via `get-pr-deployment-url.sh --details`, checks `/healthcheck` and `/openapi.json`, plus any extra endpoints passed as a second argument: `scripts/verify-preview.sh 359 "/healthcheck,/openapi.json,/api/alerts"`.
- Pass an optional `EXPECTED_SHA` as a third argument to detect stale deployments (exit 2 = SHA mismatch → triggers Step 6.5): `scripts/verify-preview.sh 359 "/healthcheck" "$(gh pr view 359 --json headRefOid --jq .headRefOid)"`. Full and short SHAs are both accepted.
- When `EXPECTED_SHA` is given, the script runs **two** independent checks, and either mismatch exits `2`:
  1. **Bound-record check** — `EXPECTED_SHA` against the `sha` of the deployment that actually supplied the probed URL.
  2. **Served-build check** — `EXPECTED_SHA` against `service.commit` from `${BASE_URL}/api/status`, i.e. the commit the running service reports for itself.
  The second check needs `WEBHOOK_API_KEY` exported in the environment (sent as the `x-api-key` header; never in a URL or log line). It is skipped with a warning — not a failure — when the key is absent, `/api/status` is auth-gated or unreachable, or the payload omits `service.commit`, because missing evidence is not evidence of a stale deploy.
  **`WEBHOOK_API_KEY` is an `ADMIN_OPERATOR` credential** — it authorizes `POST`/`DELETE /trading/binance/orders` and alert replay (`src/lib/adminAuth.js`) — and a deployment's `environment_url` is attacker-influenceable input, so the key is only ever sent to an **HTTPS URL on an allowlisted host**: `openclaw.tail5e4271.ts.net`, `*.onrender.com`, `*.up.railway.app`. Any other scheme or host skips the served-build check with a warning; extend or replace the list with `VERIFY_PREVIEW_ALLOWED_HOSTS` (comma-separated; exact hostname or `*.suffix`, matched on a label boundary) rather than editing the script. The check must not use a broader credential or a key-only-for-`/api/status` scope unless the credential itself is re-scoped.
- Retry pacing is tunable via `VERIFY_PREVIEW_MAX_ATTEMPTS` (default `3`) and `VERIFY_PREVIEW_RETRY_DELAY_SECONDS` (default `5`); leave both unset in the normal workflow.
- If the PR introduces new endpoints, pass them explicitly and verify each returns `200` (or `401/403` for auth-gated endpoints, which proves the service is live).
- For `GLOBAL_BLOCKED` caused by Railway bounded retry or stale deployment, see Step 6.5 recovery before labeling `need manual PR deploy`.
- For Firebase Hosting preview `RESOURCE_EXHAUSTED` / channel quota, see Error Handling — it is not a `GLOBAL_BLOCKED` and is fixed locally via `scripts/cleanup-preview-channels.js`.

## Procedural Workflow

Follow these steps in strict chronological order to automate issue resolution:

### Step 1: Pre-flight & Selection
1. **Switch gh to francovp user** — save the current user and switch to francovp for all `gh` commands in this session:
   ```bash
   source scripts/gh-auth-utils.sh && save_gh_user && switch_to_francovp
   ```
2. Determine the target issue:
   - **If the user specifies an issue number** (via `#42`, `issue 42`, `GH-42`, or similar): fetch that specific issue with `gh issue view <NUMBER> --json number,title,createdAt,labels,url`.
   - **If no issue number is given**: run `scripts/get-oldest-issue.sh` to fetch the oldest open GitHub issue (the script handles switching to francovp internally and pre-filters `need manual PR deploy` and `brainstorming`).
3. Select it as the primary issue.
4. Do not fetch, inspect, select, plan, or create TODOs for any second issue at this stage.
5. If no open GitHub issues exist (and none was specified), stop execution immediately.
6. For the primary issue — **pre-filter checks** (before claiming):
   - If the issue itself carries `need manual PR deploy` or `brainstorming`/`brainstorm`: skip it (zero-work), append to `SKIPPED_ISSUES`, and re-run `scripts/get-oldest-issue.sh "$SKIPPED_ISSUES"` for the next candidate. `get-oldest-issue.sh` already excludes these, but re-check for user-specified issues.
   - If any linked PR carries `need manual PR deploy`: skip the issue the same way — jump to the next oldest issue. Do not attempt Railway recovery for pre-labeled `need manual PR deploy` items; they are operator-confirmed manual.
   - For a linked PR with a preview- or code-check-related `GLOBAL_BLOCKED` label, inspect changed paths and classify it under Hard Rule 23. Defer all blocker actions until after the issue is claimed. For a docs-only PR, treat those gates as not applicable in the post-claim pre-flight.
   - If a code-changing linked PR carries `GLOBAL_BLOCKED` **from a Railway bounded retry or outdated deployment** (preview commit != PR head), note that Step 6.5 recovery may apply after the issue is claimed; do not run recovery during this pre-filter.
   - If the linked PR or issue carries `NEEDS_USER`/`HUMAN NEEDED`/`need user`, record it for post-claim handling; do not notify or advance before claiming. Defer `GLOBAL_BLOCKED` handling until after the issue is claimed; use the post-claim `GLOBAL_BLOCKED` pre-flight in Step 1 and its bounded-unblock flow before notifying or advancing.
7. For the primary issue:
   - **Claim the issue immediately** — before any further analysis, run `scripts/claim-issue.sh <ISSUE_NUMBER>` so other concurrent sessions see this issue is being handled. Set `CLAIM_RUN_ID` (preferred, e.g. the run/cron timestamp) or `CLAIM_SESSION_ID` so the Step 2 re-check shares the session identity; when both are omitted the script uses a fresh per-invocation session ID with no shared persistence:
     - `RESULT=CLAIMED` or `RESULT=TAKEOVER` (exit `0`): this session owns the issue — proceed with the checks below.
     - `RESULT=SKIP` (exit `2`): another agent session owns this issue with a fresh claim. Record outcome `CLAIMED`, append the issue number to `SKIPPED_ISSUES`, and advance via the Step 6 skip loop. This is a **zero-work skip**: it does NOT count toward the session's issue budget (e.g., 3 issues per session) or the max-2 write budget (Hard Rule #4). If the issue was user-specified, end the run with outcome `CLAIMED` — never advance past a user-specified issue.
     - `RESULT=ERROR` (exit `1`): handle like a tooling failure (see Error Handling).
   - Review all comments and related context on the GitHub issue.
   - Check all open, closed, merged, and draft PRs that reference the issue.
   - Check unresolved review threads and CI status if a PR exists.
   - **Check if any linked PR is already merged**: If a PR that references this issue was already merged into `master`/`main`, clean up stale `agent-working` labels (issue + PR) and end with outcome `SHIPPED`.
   - If the issue or linked PR carries `NEEDS_USER`/`HUMAN NEEDED`/`need user`, do not implement; route through Step 6's post-claim terminal handoff before handling any `GLOBAL_BLOCKED` label.
   - **Check for a pre-existing `GLOBAL_BLOCKED` label (pre-flight)**: classify the cause before routing. For a docs-only linked PR blocked only by preview or code-check status, apply Hard Rule 23 and continue issue/PR review without recovery. For any other issue or PR blocker, do NOT proceed to issue-scope confirmation (Step 3), implementation (Step 4), or verification (Step 5); route to Step 6.5 when deployment recovery applies, otherwise use the generic bounded unblock. If it still cannot be unblocked and this iteration is zero-work, write the blocker summary, keep the `GLOBAL_BLOCKED` label, remove `agent-working` (issue + PR), send the WhatsApp global-deadlock notification with issue URL and PR URL when available, append the issue number to `SKIPPED_ISSUES`, and advance via `get-oldest-issue.sh`. This pre-flight prevents the automator from producing code writes for an issue that was already known-blocked — which would otherwise trip the write-producing stop instead of the intended unblock-and-skip.

### Step 2: Ownership & Takeover Check
1. **Re-run `scripts/claim-issue.sh <ISSUE_NUMBER>`** to re-verify ownership before any real work (this catches claim races that happened between Step 1 and now):
   - `RESULT=CLAIMED`/`TAKEOVER` (exit `0`): this session still owns the issue — proceed.
   - `RESULT=SKIP` (exit `2`): another session won the claim race or posted a fresh claim. Do NOT proceed: record outcome `CLAIMED`, append the issue number to `SKIPPED_ISSUES`, and advance via the Step 6 skip loop (zero-work, no budget consumed). For a user-specified issue, end the run with `CLAIMED`.
2. Never work on an issue whose claim is owned by another session — duplicate PRs are the failure this protocol prevents.
3. Never force-remove the `agent-working` label of an active claim (see Error Handling — Takeover Conflict). Wait for the claim to expire (`CLAIM_TTL_MINUTES`) or exit with `CLAIMED`/`NEEDS_USER` to allow coordination.

### Step 3: Confirm GitHub Issue Scope
1. Confirm the requested outcome and acceptance criteria from the GitHub issue, its comments, and repository instructions. Do not add requirements that are not supported by those sources.
2. If safe implementation depends on missing product or operational details, stop with `NEEDS_USER` or `AMBIGUOUS` and release this session's claim according to Step 6.
3. If the issue duplicates another GitHub issue, record `SYNCED`, use the canonical issue as the source of truth, and do not create a duplicate issue or PR.

### Step 4: Action Plan & Implementation
1. Check out a clean branch locally.
2. Implement the changes matching the issue acceptance criteria.
2a. Classify the diff using Hard Rule 23. For docs-only changes, record code tests, lint, code checks, and preview verification as `N/A (documentation-only)`; do not start code checks or wait for automatic checks or previews. Continue with the required reviewer sessions and PR feedback workflow. Use `[skip ci]` in the commit message to suppress supported GitHub Actions workflows.
2b. **Reconcile multi-user feedback**: Per the **Multi-User Feedback Consideration** section, evaluate all participant comments gathered in Step 1 — explicitly `gigachad-senior-dev` and `virgin-trainee-dev` — against the implementation. Record adopted vs. set-aside points and the reason. If any persona feedback is adopted, the PR discussion loop (Step 5) must post the mandatory confirmation reply to both personas (or post it on the issue now if no PR exists yet).
3. For changes that are not documentation-only, start the app locally and smoke-test the changed behavior before any PR create/update. Use `pnpm dev`; this checkout currently defines `pnpm run start-dev`, so use that command unless a `dev` script has been added. Verify `/healthcheck` and the changed path with safe local configuration.
4. For changes that are not documentation-only, run the repository-required tests:
   ```bash
   pnpm test
   ```
5. Before creating or updating a PR, run these reviews in order, each in its own nested session, and wait for each result:
   1. Use `review-agent` for a read-only defect-first review.
   2. Then use `ponytail-review` for a read-only over-engineering review.
   3. Verify every finding; fix applicable findings and document a concise technical reason for any finding that does not apply. Repeat the reviews after fixes until neither has unresolved applicable feedback.
   - If either required reviewer or nested-session support is unavailable, stop before PR creation and report the blocker; do not substitute a same-session review.
6. If an open PR exists, reuse it. Do not create a parallel PR. Before pushing code changes, repeat the local smoke test, tests, and both review gates above; metadata-only PR edits do not require another code review.
   - **If reusing an existing PR**, confirm its title describes the change and its body references the GitHub issue; update it through `create-pr` if needed.
7. **Create the context file** `context/<git-branch-name>.md` with the branch summary:
   - **First line (title)**: Use a concise, descriptive title without an unrelated ticket suffix.
   - **Body sections**: Use the repository's PR description format (`Summary`, `Key Changes`, `Technical Implementation`, `Testing`, `References`).
   - **References section**: Include the GitHub issue number and URL; use `Closes #<ISSUE_NUMBER>` when the PR should close the issue on merge.
   - This file is the required input for the `create-pr` skill and determines both the PR title and PR body.
8. Use the `create-pr` skill to push changes and create/update the PR only after all pre-PR gates pass.
9. **Immediately add `agent-working`** to the PR once created:
   ```bash
   PR_NUMBER="$(gh pr view --json number --jq .number)"
   gh pr edit "$PR_NUMBER" --add-label "agent-working"
   ```
10. Verify the PR title describes the change and the PR body references the source GitHub issue; use `create-pr` to correct either if needed.

### Step 5: Verification & Deploy Check
1. Ensure the PR meets all applicable criteria in `references/readiness-and-verification.md`. For documentation-only PRs, code checks and preview gates are not applicable; do not trigger or wait for them.
2. For changes that are not documentation-only, retrieve the PR number and run `scripts/verify-preview.sh <PR_NUMBER>` to verify the preview deployment is live and healthy. The script resolves the live URL via `scripts/get-pr-deployment-url.sh --details` (GitHub Deployments API, Railway fallback), so the URL and the commit it is checked against always come from the same deployment record. Capture the expected SHA for staleness detection and pass it as a third argument. For PRs that add new endpoints, verify them explicitly:
   ```bash
   EXPECTED_SHA="$(gh pr view "$PR_NUMBER" --json headRefOid --jq .headRefOid)"
   scripts/verify-preview.sh "$PR_NUMBER" "/healthcheck,/openapi.json,/api/your-new-endpoint" "$EXPECTED_SHA"
   # production:
   scripts/verify-preview.sh production "/healthcheck,/openapi.json"
   ```
   A `401/403` on auth-gated endpoints counts as live (service is up, auth is required). Exit code `2` from `verify-preview.sh` signals a stale deploy — either the selected deployment record is not the PR head, or the probed URL reports a different `service.commit` — and routes to Step 6.5 recovery.
3. **Publish UI evidence before requesting review**: For user-visible UI changes, use the `playwright` skill to capture the relevant states and attach the screenshots to the PR description or a single PR comment using `gh pr edit <N> --attach <file>#<alt-text>` or `gh pr comment <N> --attach <file>#<alt-text>`. If UI code changes again, capture a fresh set for the latest head SHA and update the description or add a comment identifying the new evidence. Skip screenshots when the change has no user-visible UI.
4. **Run the Codex review loop after PR creation and each code/head update**, with at most three Codex review requests per PR, including the first; failed requests count toward the cap. Metadata-only edits, labels, screenshot attachments, and comment replies do not consume a review session:
   - Request/re-trigger the repository's Codex review, then wait for its result and inspect all Codex and Copilot feedback against the recorded head SHA.
   - For every Codex review that requests changes, use `superpowers:receiving-code-review` before implementing feedback. Check every Copilot comment for applicability; implement applicable items and reply in-thread when resolved, or give a concise technical reason for non-applicable feedback before resolving it. If feedback is unclear, stop and ask for clarification.
   - Before pushing fixes to code, repeat Step 4's tests, local smoke test, and both nested reviews; use `create-pr` to update the PR. For documentation-only fixes, skip code tests and preview verification but repeat both nested reviews. For UI fixes, also refresh the screenshots as described above.
   - After each code/head update, request a new Codex review and continue within the three-request cap. If the third Codex review still requests changes, stop and hand the PR to the human for revision through Step 7; do not merge.
   - A Codex 👍 reaction on the PR description is the explicit approval signal; verify it came from Codex. No new actionable feedback after the complete quiet window also satisfies the review condition. A rate-limit response is not approval; use the documented self-review fallback. Any other review error blocks merge—do not treat it as silence.
5. **Run the PR discussion loop after every PR creation or update**:
   - Take a baseline snapshot of paginated GraphQL `reviewThreads` (thread ID, creation time, author, resolved/outdated state, and each thread comment ID plus `createdAt`/`updatedAt`) and paginated top-level PR conversation comments (comment ID, creation time, author, and body), then record the current head SHA. Paginate thread comments as well as threads; flat comments alone are not sufficient for inline thread state, but top-level conversation comments must also be tracked.
   - Before starting the quiet window, triage every unresolved thread in the baseline snapshot, including threads already present on an existing PR. Baseline status never exempts a thread from being addressed.
   - Wait using the quiet-window policy in `references/readiness-and-verification.md`, checking both `reviewThreads` and paginated top-level PR conversation comments around the midpoint and at the end. Do not merge while this loop is active; hand off only through the explicit human-input exception below.
   - When a new or baseline inline thread or top-level conversation comment appears, triage and address every actionable unresolved item before continuing. Use `superpowers:receiving-code-review` to evaluate external review feedback; implement applicable changes, reply when an explanation is sufficient, and resolve only when the discussion is actually handled.
     - **Persona confirmation replies**: If feedback from `gigachad-senior-dev` or `virgin-trainee-dev` was adopted into the implementation or into the resolution of a thread, post the mandatory confirmation reply (per the **Multi-User Feedback Consideration** section) tagging only the contributing persona(s) once the relevant change or resolution lands (tag both only when both actually contributed). Never leave adopted persona feedback without its confirmation reply.
   - If a discussion requires product authority, missing requirements, or other human clarification, do not force a resolution or keep polling. Record the exact question and continue to Step 7 for `IN_REVIEW` handoff, leaving that thread open for the human reviewer.
   - Re-run the relevant tests and verification after code changes, push/update the PR, record the new head SHA, and restart the quiet window from that change or discussion.
   - Repeat the loop until a complete quiet window finishes with no new inline discussion, thread comment, or actionable top-level comment and no unresolved actionable thread remaining, or until the human-input exception routes the PR to Step 7. Compare thread IDs, thread-comment IDs/timestamps, and top-level comment IDs/timestamps so a resolved item and a newly created item cannot cancel each other out.
   - A new discussion resets the quiet-window start only. It does not reset the verification-cycle counter; only a concrete new head commit resets that counter.
   - **Codex review failure detection**: If a Codex review body text starts with `You have reached your Codex usage limits for code reviews`, the automated Codex review has failed due to rate limiting. Do NOT wait for Codex. Instead, immediately perform the code review yourself:
     - Use `caveman-review` skill (`task(load_skills=["caveman-review"], ...)`) for compressed review findings, OR
     - Deploy a `deep` subagent with explicit instructions to review the PR diff for correctness, edge cases, security concerns, type safety, and alignment with acceptance criteria.
     - If the failed Codex review created a blocking review thread, resolve or address it after your self-review completes, then continue the loop.
     - A passing self-review satisfies the "no unresolved discussions" criterion in the merge gate — do NOT reset the quiet window for a usage-limited Codex review.
6. Observe the retry and bounded verification policies specified in `references/readiness-and-verification.md`; the discussion loop itself ends only after the quiet-window condition above is met or Step 7 is selected for a human-input thread.
7. Verify the PR title describes the change and the PR body references the source GitHub issue; use `create-pr` to correct either if needed.
8. If Codex approved (or the full quiet window ended without new actionable feedback), all merge-gate criteria pass, and the agent is confident the PR is mergeable:
   - Merge the PR.
   - After merge, verify the production deployment if needed: `scripts/verify-preview.sh production`.
   - **Remove `agent-working` from the issue and the PR**:
    ```bash
    gh issue edit <ISSUE_NUMBER> --remove-label "agent-working"
    gh pr edit "$PR_NUMBER" --remove-label "agent-working"
    ```
   - Ensure the GitHub issue and PR reflect the shipped state, then end with outcome `SHIPPED`.
9. If human review is still needed, continue to Step 7 instead. If the verification fails repeatedly with issue-specific errors, end with outcome `LOCAL_DEADLOCK`.

### Step 6: Skip Loop — Advance Past Blocked or Already-Handled Issues

`CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes (still blocked after an unblock attempt), and `IN_REVIEW` with no agent writes are **skip outcomes** — the agent did not produce code changes or a PR for this issue. Keep advancing until a non-skip outcome or no issues remain. **Write-producing `GLOBAL_BLOCKED`**: if the blocker is raised **after** the iteration already produced agent writes — changed code or created/updated a PR — the iteration produced work: it is NOT a skip, it consumes the max-2 agent-write budget (Hard Rule #4), and it stops the run exactly like `IN_REVIEW` with agent writes.

Track a `SKIPPED_ISSUES` list (comma-separated issue numbers) across the skip loop: every skip outcome appends the processed issue number so the cursor never revisits it. A single-exclusion cursor is not enough — if only the last issue is excluded, two adjacent skipped issues alternate forever.

**Release a claim on a no-write terminal exit**: The Step 1/Step 2 `claim-issue.sh` call adds an `agent-working` label to the issue. If this session then ends the issue through a no-write terminal outcome (`IN_REVIEW` with no agent writes, `LOCAL_DEADLOCK`, `NEEDS_USER`, `AMBIGUOUS`, or `SYNCED` for duplicate GitHub issues), the `agent-working` label would otherwise hold the issue claimed until `CLAIM_TTL_MINUTES` expires — blocking later automator runs from picking it up. Before removing the label this session MUST **reconfirm ownership at the moment of release**, because a run can outlive the TTL since its earlier claim: another session may have taken over the stale claim in between, and removing the label would delete that new owner's live claim and cause duplicate work. Reconfirm by re-running the claim script with the **same session identity** this run used:
```bash
scripts/claim-issue.sh <ISSUE_NUMBER>
```
- If it returns exit `0` / `RESULT=CLAIMED` (or `RESULT=TAKEOVER`), this session still owns a fresh claim — remove the `agent-working` label it added:
  ```bash
  gh issue edit <ISSUE_NUMBER> --remove-label "agent-working"
  ```
- If it returns `RESULT=SKIP` (exit `2`), another session now owns a fresh claim — **do NOT remove the label** (releasing another session's live claim would cause duplicate work; the re-claim renewed the other owner, never ours).
- If `RESULT=ERROR` (exit `1`), do not remove the label and treat it like a tooling failure (see Error Handling).

Never remove the label when this session does not own the claim for this run. The queue's own zero-work `RESULT=SKIP` path (a foreign `agent-working` claim at Step 1) never triggers this release and left it untouched.

**Renew ownership periodically and before consequential writes**: Promoting and shipping an issue is a long-running, multi-write flow, so a single claim at Step 1 can outlive `CLAIM_TTL_MINUTES` and go stale while this session is still working. A stale claim lets another session take over mid-run, which would make this session's later PR create/update, handoff, or merge writes collide with (or be interpreted as owned by) the new owner. Therefore:
- **Re-check ownership immediately before every consequential write**, especially PR creation/update, `@codex review` re-trigger, handoff, and merge. Re-run `scripts/claim-issue.sh <ISSUE_NUMBER>` with the same session identity; only proceed with the write on `RESULT=CLAIMED`/`RESULT=TAKEOVER` (exit `0`). A `RESULT=SKIP` (exit `2`) means another session now owns a fresh claim — stop writing to this issue/PR and treat it as claimed-elsewhere. A `RESULT=ERROR` (exit `1`) is a tooling failure to handle per Error Handling, and must not be treated as ownership.
- If the run is about to do no more writes, the periodic renewal also serves as the final reconfirmation before any label removal.

#### Step 6.5: Stale-deploy / bounded-retry recovery (GLOBAL_BLOCKED with deployment cause)

This recovery applies only to code-changing PRs. For a documentation-only PR, Hard Rule 23 makes preview and code-check gates inapplicable; do not trigger, wait for, or verify a preview deployment for those causes.

Resolve the host before using any provider-specific step: run `scripts/get-pr-deployment-url.sh <PR_NUMBER>` (the resolver behind `verify-preview.sh`). The `railway up` / `railway redeploy` steps below apply only when the resolved host is Railway, or when the resolver fell back to the Railway pattern after warning. When the resolved host belongs to another provider, do not invoke Railway commands — they deploy a host the PR is not served from. Instead wait for that provider's deployment to settle, re-resolve, and re-run `scripts/verify-preview.sh`; escalate to `need manual PR deploy` only if the resolved host still does not serve the PR head after the bounded wait.

If the issue/PR carries `GLOBAL_BLOCKED` **caused by a bounded retry (`429`/`rate-limit`) or an outdated deployment where the preview commit is not the PR head** (detected via `verify-preview.sh` exit code `2` or manual SHA comparison), do NOT immediately treat it as a permanent skip:

1. **Attempt recovery** (bounded, one try):
   - Check if the PR branch is behind `master`: `gh pr view <N> --json baseRefName,headRefOid` and `git fetch origin master && git merge-base --is-ancestor HEAD origin/master`. If behind, update the branch: `git fetch origin master && git merge origin/master` (or `gh pr update-branch` / `gh api repos/francovp/cabros-bot/pulls/<N>/update-branch -X PUT`), push, then wait for the CD platform to start a new deployment.
   - Otherwise, when the resolved host is Railway, trigger a Railway deploy from the branch: `railway up --detach` (if `railway` CLI is authenticated via `RAILWAY_TOKEN`) or `railway redeploy` / Railway API `POST https://backboard.railway.app/graphql/v2` with the service. Poll deployment status with `railway status` or via `scripts/verify-preview.sh <PR_NUMBER>` until healthy (max 5 minutes, 30s interval).
2. **Re-verify**: Run `scripts/verify-preview.sh <PR_NUMBER>` (and any new endpoints). If it now succeeds (HTTP 200 on `/healthcheck`), the blocker is resolved: remove `GLOBAL_BLOCKED` and `need manual PR deploy` labels from the issue and PR:
   ```bash
   gh issue edit <ISSUE_NUMBER> --remove-label "GLOBAL_BLOCKED" --remove-label "need manual PR deploy" 2>/dev/null || true
   gh pr edit <PR_NUMBER> --remove-label "GLOBAL_BLOCKED" --remove-label "need manual PR deploy" 2>/dev/null || true
   ```
   Then continue the normal flow from the point of failure (do not skip).
3. **If recovery fails** (no `railway` CLI auth, push rejected, deployment still unhealthy after bounded wait, or branch cannot be updated):
   ```bash
   gh pr edit <PR_NUMBER> --add-label "need manual PR deploy" 2>/dev/null || true
   gh issue edit <ISSUE_NUMBER> --add-label "need manual PR deploy" 2>/dev/null || true
   ```
   Send a WhatsApp notification with issue and PR links to `120363422033474991@g.us`:
   ```bash
   PR_URL="https://github.com/francovp/cabros-bot/pull/${PR_NUMBER}"
   ISSUE_URL="https://github.com/francovp/cabros-bot/issues/${ISSUE_NUMBER}"
   NOTIFY_MESSAGE="[need manual PR deploy] Railway deploy still stale/bounded-retry for ${PR_URL} (issue #${ISSUE_NUMBER}: ${ISSUE_URL}). Manual deploy required." \
     curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-bot-production.up.railway.app/api/webhook/message}" \
     --header 'Content-Type: application/json' \
     --header "x-api-key: ${NOTIFY_API_KEY}" \
     --data-raw '{"message": "'"${NOTIFY_MESSAGE}"'","channels": ["whatsapp"],"whatsappChatId": "120363422033474991@g.us"}'
   ```
   Append the issue number to `SKIPPED_ISSUES`, keep `GLOBAL_BLOCKED`, release `agent-working`, and advance to the next oldest issue.

Before applying the skip branches below, if this session still owns the issue's claim, handle `NEEDS_USER` first—whether set as this iteration's outcome or indicated by an issue/PR label. Its terminal handoff takes precedence over `LOCAL_DEADLOCK`, `IN_REVIEW` with no writes, and `GLOBAL_BLOCKED`. If another session owns the claim, follow the no-touch `CLAIMED` branch.

1. If `LOCAL_DEADLOCK`: Write a concise blocker summary on the issue or PR. Append the issue number to `SKIPPED_ISSUES`. Sync GitHub issue and PR state as needed.
2. **If the issue has a merged PR**: Clean up stale `agent-working` labels (issue + PR), ensure the GitHub issue is closed if the merged PR did not close it automatically, and end with outcome `SHIPPED` (same handling as Step 1).
3. **If `IN_REVIEW` with no agent writes**: The PR/issue state is already correct and must not be changed further — except that, if this session claimed the issue this run (Step 1/Step 2 returned `RESULT=CLAIMED` or `RESULT=TAKEOVER`), the one remaining cleanup is to release the freshly-acquired claim it added: remove the `agent-working` label so the issue is not held claimed until `CLAIM_TTL_MINUTES` (see the **Release a claim on a no-write terminal exit** rule). Do not make any other issue or PR state changes. Append the issue number to `SKIPPED_ISSUES`.
4. **If the issue is claimed by another agent session** (claim script exit `2` / `RESULT=SKIP`): Do not modify the issue or PR state. Append the issue number to `SKIPPED_ISSUES`.
5. **If the current outcome is `NEEDS_USER` or the issue/linked PR has a `NEEDS_USER` / `HUMAN NEEDED` / `need user` label**: Do not attempt implementation or advance to another issue. Send a WhatsApp notification to `120363422033474991@g.us` with the issue URL and a PR URL only if one exists. Release this session's claim using the **Release a claim on a no-write terminal exit** procedure, record `NEEDS_USER`, and stop the run. Do not append the issue to `SKIPPED_ISSUES`.
6. **If the issue or its linked PR is `GLOBAL_BLOCKED`** (the label is present or the iteration set the outcome):
   - **Docs-only N/A gate first**: if the linked PR is documentation-only and the only blocker is preview or code-check status, confirm this session still owns the claim, remove the stale `GLOBAL_BLOCKED` label from the issue and PR where present, and continue the review flow. Do not retry those gates, notify, or add the issue to `SKIPPED_ISSUES`. If any other blocker is present, use the applicable branch below.
   - **Write-producing check**: if this iteration already produced agent writes (code changes or PR creation/update) before any other blocker was hit, do NOT skip — record `GLOBAL_BLOCKED`, count it against the max-2 write budget (Hard Rule #4), then clean up before stopping: remove the `agent-working` label from the issue and PR (work on this item has ended — see Hard Rule 9) and send the WhatsApp global-deadlock notification with issue link and PR link (see Notification Webhook). Neither Step 7 nor the zero-work branch cleanup runs on this exit, so ownership release and the human notification must happen here. Then stop the run.
   - **Railway stale-deploy / bounded-retry first**: if the blocker is a Railway `429`/bounded-retry or the preview commit is not the PR head, run Step 6.5 recovery before the generic unblock. On success, remove the labels and continue; on failure, the `need manual PR deploy` label is already added and the WhatsApp notification sent — treat as a skip and advance.
   - **Attempt to unblock first** (other zero-work `GLOBAL_BLOCKED` only): re-run the failing action(s) once with a bounded retry budget (e.g., `gh` auth check, CI status, Railway preview verification). If an applicable retry succeeds, resolve the blocker — remove the `GLOBAL_BLOCKED` label from issue/PR if it was applied — and continue the normal flow from the point of failure.
   - **If the PR still cannot be unblocked**: compare a stable blocker fingerprint (issue/PR, blocker class, expected PR head, and observed preview commit or missing capability) with the latest blocker summary on the issue or PR. If it is unchanged, do not add another comment or send a duplicate notification; keep the `GLOBAL_BLOCKED` label, remove the `agent-working` label from the issue and PR (work on this item has ended — see Hard Rule 9), and append the issue number to `SKIPPED_ISSUES`. If it changed, write a concise summary stating the exact missing capability and smallest human action needed, keep the label, release the claim, and send one WhatsApp notification with issue URL and PR URL when available. Notify again only after the blocker clears and later reappears.
   - **Do not halt the run**: continue with the next oldest open issue until an unblockable PR is `SHIPPED` or `IN_REVIEW`, or no open issues remain — **except** when `GLOBAL_BLOCKED` is from a total tooling/access failure (see below).
   - **Total tooling/access failure**: advancing requires authenticated GitHub access. If the blocker is a total tooling/access failure (e.g., `gh` auth fails and no GitHub MCP path is available), stop the run with `GLOBAL_BLOCKED` instead — `get-oldest-issue.sh` cannot run without authenticated `gh` (see Error Handling).
7. Re-run `scripts/get-oldest-issue.sh "$SKIPPED_ISSUES"` (pass the accumulated comma-separated skip list) to fetch the next oldest open issue not yet processed in this run.
8. If no more open issues exist, stop execution.
9. Process this next issue from Steps 1–5 (treat it as the new primary).
10. If it again ends with a skip outcome (`CLAIMED`, `IN_REVIEW` no-writes, `LOCAL_DEADLOCK`, or `GLOBAL_BLOCKED` still blocked), repeat from step 1.
11. If it ends with any other outcome, proceed to Step 7 with that outcome.

Skip outcomes (`CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` no-writes, and `IN_REVIEW` no-writes) do not count toward the max-2 issues-that-require-writes limit (Hard Rule #4) and never count toward any session-level issue budget (e.g., 3 issues per session). `NEEDS_USER` is a terminal handoff and stops the run.

If the primary issue ends with any other (non-skip) outcome, including `IN_REVIEW` with agent writes, stop execution immediately.

### Step 7: Human Review Handoff & Sync
1. Use this path only when human review is needed and the PR should not be merged directly.
2. Verify the PR title describes the change and the PR body references the source GitHub issue; use `create-pr` to correct either if needed.
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
5. Record the final outcome as `IN_REVIEW` according to `references/outcomes-and-deadlocks.md`.
6. Send an `In review` notification to WhatsApp `120363422033474991@g.us` with issue and PR links:
   ```bash
   PR_URL="$(gh pr view --json url --jq .url 2>/dev/null || echo "N/A")"
   ISSUE_NUM="$(gh issue view --json number --jq .number 2>/dev/null || echo "N/A")"
   ISSUE_URL="https://github.com/francovp/cabros-bot/issues/${ISSUE_NUM}"
   NOTIFY_MESSAGE="[IN_REVIEW] PR ready for review — Issue #${ISSUE_NUM}: ${ISSUE_URL}. Review at: ${PR_URL}" \
     curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-bot-production.up.railway.app/api/webhook/message}" \
     --header 'Content-Type: application/json' \
     --header "x-api-key: ${NOTIFY_API_KEY}" \
     --data-raw '{
       "message": "'"${NOTIFY_MESSAGE}"'",
       "channels": ["whatsapp"],
       "whatsappChatId": "120363422033474991@g.us"
     }'
   ```
7. **Restore original GitHub user** after all `gh` commands are done:
   ```bash
   restore_gh_user
   ```

## Outcome Summary Contract

Always include a final summary of execution containing:
1. Primary issue processed and its outcome.
2. Outcome of the first non-skip issue, if any (issues with skip outcomes `CLAIMED`, `LOCAL_DEADLOCK`, `GLOBAL_BLOCKED` with no agent writes, or `IN_REVIEW` no-writes are counted as skipped and listed). Write-producing `GLOBAL_BLOCKED` issues are non-skip outcomes and are listed as such. A `NEEDS_USER` outcome is a terminal handoff, not a skip.
3. Tools utilized (`gh`, GitHub MCP, or scripts).
4. Details of any global blockers, including each `GLOBAL_BLOCKED` issue skipped, the unblock attempt made, and the next issue advanced to. Include stale-deploy recovery attempts (with the resolved preview host and whether it was Railway) and `need manual PR deploy` label actions.
5. Performed verification steps (CI, reviews, preview ping, and E2E). Note the URLs verified as resolved by `scripts/get-pr-deployment-url.sh` — the PR preview URL and, when applicable, the production URL (`https://cabros-bot-production.up.railway.app`). Never report a host you did not resolve; if the resolver warned that it fell back to the Railway pattern, say so.
   - Record both nested pre-PR reviews, the Codex review-request count/result, and screenshot evidence for UI changes.
6. GitHub issue and PR status after processing, including whether the issue was closed or handed off for review.
7. **`agent-working` lifecycle confirmation**: For each issue confirm: the claim was acquired at start via `scripts/claim-issue.sh` (label + claim comment with agent/session/timestamp), and released at end (merged or `In review`).
8. **Persona feedback handling**: For each issue/PR where `gigachad-senior-dev` or `virgin-trainee-dev` contributed, record whether their feedback was adopted and whether the mandatory confirmation reply was posted (and to which personas).

## Error Handling & Troubleshooting

Refer to this section when encountering execution issues:
- **CLI Authentication Failures**: If `gh` CLI calls fail due to auth:
  - First ensure the current user is `francovp` — run `gh auth switch --user francovp` and retry.
  - Verify the `francovp` account has valid credentials with `gh auth status`.
  - If the user switch itself fails, check if `GITHUB_TOKEN` env var is overriding the keyring-based auth.
  - If the CLI is unavailable, use GitHub MCP if available. If both access paths fail:
  - Send a WhatsApp global-deadlock notification to `120363422033474991@g.us` with the issue URL and a PR URL if one exists:
    ```bash
    ISSUE_URL="https://github.com/$repo/issues/$issue"
    NOTIFY_MESSAGE="[GLOBAL_BLOCKED] Issue automator halted: GitHub CLI and MCP access both failed for $repo/$issue. Human intervention required. Issue: $ISSUE_URL. PR: ${PR_URL:-none}" \
      curl --location "${NOTIFY_WEBHOOK_URL:-https://cabros-bot-production.up.railway.app/api/webhook/message}" \
      --header 'Content-Type: application/json' \
      --header "x-api-key: ${NOTIFY_API_KEY}" \
      --data-raw '{
        "message": "'"${NOTIFY_MESSAGE}"'",
        "channels": ["whatsapp"],
        "whatsappChatId": "120363422033474991@g.us"
      }'
    ```
  - Then end the run with outcome `GLOBAL_BLOCKED`. Do not attempt to advance: without authenticated `gh` or an available GitHub MCP path, there is no GitHub access to fetch the next issue — `get-oldest-issue.sh` fails its auth check. The Step 6 skip loop applies only to issue-specific `GLOBAL_BLOCKED` PRs where tooling remains functional.
- **Merge Conflicts**: If branch checkout or pushes fail due to conflicts, pull from `master` and resolve conflicts locally. Re-run tests for code changes; docs-only changes keep the Hard Rule 23 exemption. If resolving conflicts introduces ambiguity, end with `AMBIGUOUS`.
- **Preview deployment timeout / bounded retry**: If `scripts/verify-preview.sh` fails after 3 attempts, first re-resolve the host with `scripts/get-pr-deployment-url.sh <N>` — the failure may belong to a provider other than Railway.
  - Check if the PR preview commit matches the head: `gh pr view <N> --json headRefOid` vs. the SHA reported by `verify-preview.sh`'s `EXPECTED_SHA` comparison, or the deployed commit visible via `curl "$(scripts/get-pr-deployment-url.sh <N>)/healthcheck"`.
  - If the resolved host is Railway and the failure is a Railway `429` bounded retry or stale deployment (previous commit, not the HEAD), follow Step 6.5: update branch with `master` or trigger `railway up`/`railway redeploy` (requires `RAILWAY_TOKEN`), wait up to 5 minutes, re-run `scripts/verify-preview.sh`. On success, remove `GLOBAL_BLOCKED` / `need manual PR deploy` labels. On failure, add `need manual PR deploy`, notify WhatsApp `120363422033474991@g.us` with PR link, and skip to next issue.
  - If the resolved host is not Railway, do not run `railway up`/`railway redeploy` — that deploys a host the PR is not served from. Wait for the provider's deployment to settle, re-resolve, and re-run `scripts/verify-preview.sh`; escalate to `need manual PR deploy` only if the resolved host still does not serve the PR head.
  - If it is an application error/crash (5xx with current commit), treat it as a `LOCAL_DEADLOCK`.
- **Firebase Hosting preview `RESOURCE_EXHAUSTED`**: This is NOT a blocker. When `firebase hosting:channel:deploy` or PR checks report `RESOURCE_EXHAUSTED` / `channel quota reached`:
  ```bash
  node scripts/cleanup-preview-channels.js --apply
  # or: pnpm run cleanup:preview-channels -- --apply
  ```
  The script lists and deletes expired Firebase preview channels (default: older than 3 days) to free quota. Re-run the preview deploy after cleanup. Do not mark the PR `GLOBAL_BLOCKED` for this reason and do not add `need manual PR deploy`.
- **Claim script errors** (`RESULT=ERROR`, exit `1`): verify `gh` is authenticated as `francovp` and that you run the script from the repo root (it resolves the repo via `gh repo view`). Retry once; if it keeps failing, treat it as a tooling failure — stop the run with `GLOBAL_BLOCKED` (see CLI Authentication Failures).
- **Takeover Conflict**: Do not force-remove the `agent-working` label of an active run. A claim is active while its newest claim comment (or legacy labeled event) is younger than `CLAIM_TTL_MINUTES`. Wait for the claim to expire, or exit with `CLAIMED` (zero-work skip) / `NEEDS_USER` to allow coordination. Only stale claims may be taken over — `scripts/claim-issue.sh` handles this automatically.
