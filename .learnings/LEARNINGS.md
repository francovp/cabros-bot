## [LRN-20261003-005] correction

**Logged**: 2026-10-03T16:22:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Firebase Hosting preview channel cleanup default threshold (3 days) deletes zero channels — only 1-day threshold frees quota.

### Details
In Issue #1269, @francovp corrected his own earlier remediation suggestion. The cleanup script `scripts/cleanup-preview-channels.js` with default `--max-age-days 3` deletes **0 of 51** channels. Only `--max-age-days 1` deletes 16 channels (all from a ~19-minute burst on 2026-09-27). The other 35 channels are under 24 hours old. The default 3-day threshold is misleading and would have deleted nothing. Root cause is the workflow creating a channel per branch (not per PR), so rebases/force-pushes consume new slots faster than the 7-day TTL decays.

### Suggested Action
1. Always verify cleanup/dry-run commands against real data before recommending them.
2. The useful threshold today is `--max-age-days 1`, not the default 3.
3. Fix the recurrence: reuse single channel per PR number instead of per branch name, and/or shorten the 7-day TTL.
4. Consider making preview deploy non-blocking so channel exhaustion cannot block merges.

### Metadata
- Source: user_feedback
- Related Files: Issue #1269, scripts/cleanup-preview-channels.js
- Tags: firebase-hosting, preview-channels, quota-management, dry-run-verification
- See Also: LRN-20260927-001, Issue #1268
- Pattern-Key: harden.verify_cleanup_thresholds
- Recurrence-Count: 1
- First-Seen: 2026-10-03
- Last-Seen: 2026-10-03

---

## [LRN-20260914-001] correction

**Logged**: 2026-09-14T10:55:00Z
**Priority**: low
**Status**: pending
**Area**: backend

### Summary
Avoid adding granular telemetry to worker status schemas if a centralized analytics system already exists.

### Details
In PR #992, suggested adding per-channel delivery rates to the `lastSweepResult` of the `NotificationRedriveService`. @francovp corrected this, stating that such data is already centralized in the alert delivery SLA and analytics subsystem (`/api/alerts/summary`). Adding it to the worker status would cause redundant schema bloat.

### Suggested Action
When proposing observability enhancements for background workers, first check if the required metrics are already captured by a broader analytics or SLA subsystem. Prioritize keeping worker status objects lean.

### Metadata
- Source: user_feedback
- Related Files: src/services/NotificationRedriveService.ts
- Tags: observability, schema-design, redrive-worker
- See Also: none
- Pattern-Key: harden.lean_status_schemas
- Recurrence-Count: 1
- First-Seen: 2026-09-14
- Last-Seen: 2026-09-14

---

## [LRN-20260917-001] correction

**Logged**: 2026-09-17T04:51:00Z
**Priority**: low
**Status**: pending
**Area**: backend

### Summary
SSE architecture uses in-process EventEmitter bridge (not Redis/NATS) with fallback polling for multi-worker sync.

### Details
In PR #1149 (feat(admin): add SSE real-time updates), @virgin-trainee-dev asked about worker-to-web event relay and bounded multi-connection pool. @francovp corrected the architectural understanding:
1. **Multi-process relay**: The web deployment is the single ingest/API coordinator where operators connect. Uses in-process EventEmitter bridge to avoid heavy infrastructure (Redis, NATS, Firestore listeners). Background workers update Firestore on completion; frontend fallback polling synchronizes across workers.
2. **Keepalive heartbeat**: The 30s `:keepalive` comment prevents edge proxy (Render, Cloudflare, Nginx) idle timeout termination (55-100s) and allows server to detect ghost sockets.

### Suggested Action
When reviewing SSE/real-time architectures, understand the coordinator pattern: single web ingress + in-process bridge + durable store + fallback polling. Don't assume message buses are required. Keepalive intervals should account for common proxy timeouts.

### Metadata
- Source: user_feedback
- Related Files: src/services/sse/AdminSseService.js, src/controllers/admin/sseEvents.js
- Tags: sse, realtime, architecture, eventemitter, fallback-polling
- See Also: LRN-20260914-001
- Pattern-Key: harden.sse_coordinator_pattern
- Recurrence-Count: 1
- First-Seen: 2026-09-17
- Last-Seen: 2026-09-17

---

## [LRN-20260927-001] correction

**Logged**: 2026-09-27T04:15:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Test suite execution silently reverts source-built divergence in `public/admin/admin.js` — test imports build script and mutates working tree.

### Details
@francovp corrected on issue #1201: The test `tests/unit/firebase-hosting-config.test.js` imports `scripts/build-hosting.js` and calls `buildHosting()`, which blindly copies `src/admin/*` → `public/admin/*`. Any `pnpm test` run executes this copy, silently overwriting fixes in `public/admin/admin.js` that don't exist in source. The revert manifests as `MM` status (staged ≠ unstaged). Two divergent copies exist: `public` has `handshakeTimeoutMs`/`handshakeTimer` SSE guard (7 occurrences), `src` lacks it entirely. Regenerating from source deletes the fix.

### Suggested Action
1. Make test **not** mutate working tree — assert against temp output dir or restore files after asserting.
2. Add post-copy verification in `build:hosting` to fail loudly when `src` and `public` diverge on content it didn't write.
3. Consider making `public/admin/*` generated-and-gitignored; serve artifact built in CI.
4. Same risk applies to `CabrosBot.postman_collection.json` and its test — stale branch produced result differing from both sides.
5. Codify the Clean Worktree Test Invariant in `AGENTS.md` and review rubrics so all tests are mandated to leave `git status --porcelain` completely clean.

### Metadata
- Source: user_feedback
- Related Files: tests/unit/firebase-hosting-config.test.js, scripts/build-hosting.js, public/admin/admin.js, src/admin/admin.js
- Tags: test-hygiene, build-reproducibility, silent-revert, firebase-hosting
- See Also: LRN-20260920-002
- Pattern-Key: harden.test_no_worktree_mutation
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-002] correction

**Logged**: 2026-09-27T01:00:00Z
**Priority**: high
**Status**: pending
**Area**: api

### Summary
Strict integer query parameter validation must enforce regex matching (`/^\d+$/`) before parsing to prevent `Number.parseInt` prefix truncation.


## [LRN-20261003-001] correction

**Logged**: 2026-10-03T04:22:00Z
**Priority**: medium
**Area**: api

### Summary
The `formatAlertMessage()` function has no production call site and should not be relied upon for message formatting logic.

### Details
In PR #1259, @francovp corrected that `formatAlertMessage()` has no production call site. He confirmed with `grep -rn "formatAlertMessage(" src/` that the only definition is the method itself. Production delivery goes through `sendWithNotificationRouting(notificationMgr, alert, ...)` → Telegram/WhatsApp services → `formatter.formatEnriched(alert.enriched, ...)`, and `MarkdownV2Formatter` renders `extraText` (lines 262-263). The audit line added to `formatAlertMessage()` was invisible to every trader.

### Suggested Action
When adding formatting logic intended for delivery to users, ensure it's placed in the actual message formatting path used by production services (e.g., `extraText` field or the formatter classes), not in helper functions that may only be used in tests.

### Metadata
- Source: user_feedback
- Related Files: PR #1259, src/controllers/webhooks/handlers/alert/alert.js
- Tags: api, messaging, production-code, grep-verification
- See Also: none
- Pattern-Key: harden.production_code_path
- Recurrence-Count: 1
- First-Seen: 2026-10-03
- Last-Seen: 2026-10-03

---

## [LRN-20261003-002] correction

**Logged**: 2026-10-03T04:22:00Z
**Priority**: medium
**Area**: api

### Summary
Example values in code should reflect actual pipeline behavior, not hypothetical scenarios that cannot occur in production.

### Details
In PR #1259, @francovp corrected an example value of 0.646 that was described as a "delivered" low-tier alert. He demonstrated that a `low`-resolved tier cannot reach the 0.7 threshold due to weakest-tier-wins plus the 0.85 multiplier, making the example impossible in the actual pipeline. Rather than invent a plausible value, he updated the example to document what actually happens: the alert is suppressed due to confidence below NEWS_ALERT_THRESHOLD.

### Suggested Action
When providing example values or scenarios, verify they can actually occur in the production pipeline by tracing the data flow through all validation and transformation steps. Examples should illustrate real behavior, including edge cases like suppression or filtering.

### Metadata
- Source: user_feedback
- Related Files: PR #1259, src/services/monitoring/SentryService.js
- Tags: api, examples, data-validation, pipeline-verification
- See Also: none
- Pattern-Key: harden.realistic_examples
- Recurrence-Count: 1
- First-Seen: 2026-10-03
- Last-Seen: 2026-10-03

---

## [LRN-20261003-003] correction

**Logged**: 2026-10-03T08:22:00Z
**Priority**: high
**Area**: trading

### Summary
Self-review fallback process uncovered critical bugs when Codex rate-limited: heuristic fallbacks displacing real provider levels, mislabeled provenance tags, undocumented contract enums, over-engineering, and incorrect R:R documentation.

### Details
In PR #1260 (feat(tradingview): wire fallbackTradePlan as secondary risk-metadata source), @francovp performed a defect-first + over-engineering review after Codex returned rate limits. Five issues found and fixed:

1. **High - Heuristic levels silently displaced real Gemini levels**: `selectRiskMetadata` gave MCP unconditional precedence when numerically complete. The fallback plan is always complete, so it always won over Gemini's real support/resistance levels. Fixed by weighing blocks on provenance order: ATR/MCP → Gemini → heuristic MCP as last resort. Covered by new tests in `tests/unit/alert-handler.test.js`.

2. **Medium - `levelsSource` mislabelled the winning block**: The tag derived from `technical_levels`, but risk block is selected independently. When Gemini won, output carried Gemini's levels tagged `fallback-trade-plan`. Fixed: `selectRiskMetadata` now reports `riskLevelsSource` for the chosen block; tag derives from that.

3. **Contract drift - `derived-quote` was undocumented**: Emitted in 9 places and branched on in `alert.js`, but absent from OpenAPI and `types.ts` `levelsSource` enums. Added to both; description corrected.

4. **Over-engineering**: Two-boolean ternary replaced with ordered-candidates list naming precedence directly.

5. **Documentation corrected**: `risk_reward_ratio` is recomputed from rounded levels that ship, so it's only ~2.0 (drift up to ~0.01 on non-round prices). The "all R:R 2.0" claim was wrong; `AGENTS.md` updated.

### Suggested Action
When Codex or automated review is unavailable, run structured fallback reviews (defect-first + over-engineering) as documented. Always trace provenance of computed values through the actual selection logic, not just the emitted tags. Verify contract enums match all emitted values. Document recomputed/approximate values accurately.

### Metadata
- Source: user_feedback
- Related Files: PR #1260, src/services/tradingview/expandedAnalysisAlertReport.js, tests/unit/alert-handler.test.js, AGENTS.md
- Tags: trading, risk-metadata, fallback, contract-design, code-review
- See Also: LRN-20260927-001
- Pattern-Key: harden.fallback_review_provenance
- Recurrence-Count: 1
- First-Seen: 2026-10-03
- Last-Seen: 2026-10-03

---

## [LRN-20261003-006] correction

**Logged**: 2026-10-03T22:22:00Z
**Priority**: critical
**Status**: pending
**Area**: trading / api / infra

### Summary
PR #1273 (auto-trade alert-to-order bridge) has a 20,000-line Postman reformat that reverts #967, is 15 commits behind master, and lacks safety review for money-moving code.

### Details
@francovp reviewed PR #1273 and found:

1. **Postman reformat regression**: The `CabrosBot.postman_collection.json` diff is +10183/-10020 lines — almost entirely a reformat at a different indent level. The file round-trips byte-identically at `indent=2` on `master`; this branch reserializes differently. This reformat also **reverts #967** (merged today at 7045c49d): `master` has 194 items, this branch has 181. Missing 14 items are exactly the request-ID items from #967. Only 1 new item added: `/Webhooks/POST Send Alert (autoTrade)`.

2. **Branch is 15 commits behind master** and marked `CONFLICTING`.

3. **No review decision** — the PR was opened today and has no human approval.

4. **Safety-critical questions unanswered** (highest-risk surface in service — bug here places real orders):
   - **Gating**: Does the bridge respect all existing kill switches (`ENABLE_BINANCE_TRADING`, `BINANCE_TRADING_ENV`, `ALLOWED_SYMBOLS`, `MAX_NOTIONAL`)? Can it bypass allowlist or testnet/live distinction?
   - **Idempotency**: Can same alert produce two orders on webhook retry? Needs per-key claims with durable reservation, not in-process dedup.
   - **Env/testnet affinity**: Is order construction pinned to `BINANCE_TRADING_ENV` so misconfigured deploy cannot target live from staging flag?
   - **Failure containment**: What happens when order submission is ambiguous (timeout after exchange may have accepted)? Must not silently retry into duplicate.
   - **Audit trail**: Is originating `alertId`/`requestId` persisted onto the order so a fill traces back to the signal?

### Suggested Action
1. **Rebase onto current `master`** (resolve 15-commit divergence).
2. **Revert `CabrosBot.postman_collection.json` to `master`**, then add only the one new `POST Send Alert (autoTrade)` item at `indent=2`. This turns 20,000-line diff into ~100 lines and eliminates the #967 revert.
3. **Answer all five safety questions explicitly** before merge consideration.
4. **Require deliberate transaction-safety review** against current `master` — this moves real money.
5. **Never commit whole-file reformats of generated/serialized files** (Postman, OpenAPI, lockfiles) — they hide regressions and create massive noise.

### Metadata
- Source: user_feedback
- Related Files: PR #1273, CabrosBot.postman_collection.json, src/services/trading/AlertSignalRouter.js, src/controllers/webhooks/handlers/alert/alert.js
- Tags: trading, postman, reformat-regression, safety-review, idempotency, audit-trail, kill-switch
- See Also: LRN-20260927-001, LRN-20260927-002, Issue #967
- Pattern-Key: harden.no_wholesale_reformat_generated_files
- Recurrence-Count: 1
- First-Seen: 2026-10-03
- Last-Seen: 2026-10-03

---

## [LRN-20261003-004] correction

**Logged**: 2026-10-03T10:22:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Firebase Hosting preview channel cleanup default threshold (3 days) deletes zero channels — only 1-day threshold frees quota.

### Details
In Issue #1269, @francovp corrected his own earlier remediation suggestion. The cleanup script `scripts/cleanup-preview-channels.js` with default `--max-age-days 3` deletes **0 of 51** channels. Only `--max-age-days 1` deletes 16 channels (all from a ~19-minute burst on 2026-09-27). The other 35 channels are under 24 hours old. The default 3-day threshold is misleading and would have deleted nothing. Root cause is the workflow creating a channel per branch (not per PR), so rebases/force-pushes consume new slots faster than the 7-day TTL decays.

### Suggested Action
1. Always verify cleanup/dry-run commands against real data before recommending them.  
2. The useful threshold today is `--max-age-days 1`, not the default 3.  
3. Fix the recurrence: reuse single channel per PR number instead of per branch name, and/or shorten the 7-day TTL.  
4. Consider making preview deploy non-blocking so channel exhaustion cannot block merges.

### Metadata
- Source: user_feedback
- Related Files: Issue #1269, scripts/cleanup-preview-channels.js
- Tags: firebase-hosting, preview-channels, quota-management, dry-run-verification
- See Also: LRN-20260927-001, Issue #1268
- Pattern-Key: harden.verify_cleanup_thresholds
- Recurrence-Count: 1
- First-Seen: 2026-10-03
- Last-Seen: 2026-10-03- [2026-10-04T00:25:03+00:00] @francovp on issue #1284 (Production smoke probe has never run: workflow omits actions/checkout (exit 127, 0/200 runs)): ## Correction: the outage is already tracked — see #970 and #1107  While verifying this issue I initially treated the Railway production outage as a new finding. It is not. It is already root-caused and tracked:  - **#970** (P0, opened 2026-08-31, still open) — Railway production has no active deployment;   every endpoint returns 404 `Application not found`; zero alerts flowing. - **#1107** (opened 2026-09-06, still open) — **root cause is Railway trial subscription expiry.**   Railway removed the production deployment entirely, and the outage went undetected for ~6 days.  Both carry `automation/skip`, so this issue should **not** duplicate them. Railway service state re-verified today (2026-10-03) is unchanged and still consistent with #970/#1107:  - `cabros-bot-production.up.railway.app` is correctly bound to the production service (port 8080) —   it is the authoritative production target, not Render. - Service status `Offline`; `latestDeployment: null`; newest deployment 2026-08-30, state `REMOVED`. - Endpoint response is a Railway **edge** 404, not an application error envelope.  ## Scope of this issue  Narrowed to the single defect that is genuinely new and not already tracked elsewhere:  > `production-smoke-probe.yml` omits `actions/checkout`, so the probe has **never executed**.  This is the mechanical reason the outage went unnoticed for the ~5 weeks #1107 describes, and it is the same root cause #1107 suspected (`script never checked out`) but did not file as its own issue. Restoring it is a prerequisite for any future outage being caught by CI.  Re-verified details supporting the fix:  - `ops/production-smoke-probe.sh` is tracked with mode **100755** (executable) and has a   `#!/usr/bin/env bash` shebang, so once the repo is checked out the direct invocation at   workflow line 87 will work — no `chmod` step needed. - Script added in `cdd26bcd9`; first run 2026-09-02; **0 successes in 200 runs**.  ## Note on ordering  Because the probe pages `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`, restoring checkout will make it start alerting. Given the outage is already known and already tracked, that paging is expected rather than new information, but the Railway subscription itself must be re-activated (a billing/account action owned by the maintainer, not a code change) before a probe can pass.
- [2026-10-04T00:25:03+00:00] @francovp on pull_request #1087 (feat(webhook): surface generic-message truncation metadata on /api/webhook/message (GH-780)): ## Closing as superseded — and flagging a contract regression this would introduce  The truncation-metadata half of this PR landed on `master` today via #946 (`c4938503`, GH-602), which is a superset of what this branch delivers for the reporting itself. But this branch is not a clean duplicate, so to be explicit about the two parts:  **Already covered by #946 on `master`:** surfacing `truncated` / `originalLength` / `deliveredLength` on `POST /api/webhook/message`, the numeric-only `console.warn` on clip, and the dedicated test coverage.  **Genuinely unique to this branch, and not on `master`:** the `GENERIC_MESSAGE_MAX_LENGTH` knob (`RemoteConfigService` 0 matches, `.env.example` 0 matches — verified on `df0f7b4d`). Making the 4,000-character threshold configurable is a real, separate improvement and I would be glad to see it land.  ### Why it cannot merge as-is  Merging this branch on top of #946 would not be additive — it would **regress** the contract that just went live:  1. **It renames the response field.** `master` emits `deliveredLength` (4 occurrences); this branch emits `messageLength` (4 occurrences) and has **zero** `deliveredLength`. That is a breaking rename of a field that is now documented in `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, `README.md`, `docs/webhooks.md`, and `AGENTS.md` — all updated as part of #946. 2. **It makes the metadata unconditional.** #946 deliberately emits these fields *only* when clipping actually occurs:    ```js    if (routing.truncated) {        responseBody.truncated = true;        responseBody.originalLength = routing.originalLength;        responseBody.deliveredLength = routing.deliveredLength;    }    ```    so a message that fits returns `{ success: true, results }` byte-identically and existing integrations are unaffected. This branch returns `truncated` / `messageLength` / `originalLength` / `maxMessageLength` on **every** response. That breaks the backwards-compatibility property #946 was built around, and it changes the shape of the overwhelmingly common non-truncating case. 3. **It also drops the `requestId` and chunk-estimation metadata** that #1067 (`083d8b7a`) added to this same handler — `estimatedChunks`, `channelDetails`, `delivered` — and the fire-and-forget `alertStorageService.saveAlert` from #654. This branch predates all three.  ### Suggested follow-up  The configurability is worth keeping, just not on this base. A small, focused PR against current `master` that only:  - adds `GENERIC_MESSAGE_MAX_LENGTH` to `PARAMETER_SCHEMA` (you already have the right shape: `type: 'number'`, `defaultValue: 4000`, `integer: true`, `min: 1`, `max: 20000`) plus the `.env.example` and `firebase-remote-config-template.json` entries, - threads `maxLength` through `validateMessageRequest` as you already do, keeping the resolved value in the routing object, - **preserves** the existing `if (routing.truncated)` conditional and the `deliveredLength` field name, optionally adding `maxMessageLength` alongside them only when truncation occurs, - keeps `requestId`, `estimatedChunks` / `channelDetails` / `delivered`, and the `saveAlert` persistence, - and carries over your `tests/unit/generic-message-truncation.test.js`, which is a better fit than what ended up in the integration suite.  One implementation note if you take this on: `resolveMaxMessageLength()` reads `process.env` directly. Every other runtime-tunable value in this codebase goes through `getRuntimeConfig()` / `RemoteConfigService`, which is what makes the Remote Config override actually take effect — a direct `process.env` read will not respond to a Remote Config change.  Happy to review that follow-up, or to pick it up myself if you would rather hand it over. If you think the field rename to `messageLength` is the more correct long-term name, that is a reasonable call — but it should be its own deliberate breaking-change PR against `master`, not a side effect of adding a config knob.
- [2026-10-04T00:25:03+00:00] @francovp on pull_request #1075 (feat(canary): add synthetic canary endpoint for full alert-pipeline validation (#619)): ## Heads-up: a second canary implementation exists, and one design question here  Found in the conflicting-PR sweep. This is not a supersession — the two are independently written, at different paths, with different gates — so it needs a decision rather than a close.  | | this PR | the other canary | |---|---|---| | path | `POST /api/ops/test-alert` | `POST /api/webhook/canary-alert` | | gate | `ENABLE_CANARY_ENDPOINT` | `ENABLE_CANARY_ALERT` | | `source` tag | `canary` | `canary-alert` | | reads | — | also `ENABLE_GEMINI_GROUNDING`, `ENABLE_TRADINGVIEW_MCP_ENRICHMENT` | | scope | pure delivery probe (explicitly no Gemini, no MCP, no Langfuse) | full alert-pipeline validation |  Two things worth settling.  **1. Two canaries means two gates and two `source` tags.** `canary` and `canary-alert` both have to be excluded from signal-outcome metrics and downstream aggregates, and every filter that does that has to know about both spellings. Only one of the two paths needs to exist; the other is duplicate operational surface. Note these are genuinely different scopes — the full-pipeline one exercises grounding/MCP, the pure one does not — so the right answer is probably "keep the fuller one, name it consistently, and delete the other", but that is a maintainer call.  **2. Enrolling a synthetic canary in the finite webhook-ingest bucket.** This adds `/api/webhook/canary-alert` to `WEBHOOK_INGEST_PATHS` in `src/lib/rateLimiter.js`. That bucket is the deliberately finite 1,000-request-per-window allowance from the ingest separation work (CB-239 / #532), and its whole purpose is to keep normal TradingView alert bursts from consuming the ordinary `RATE_LIMIT_MAX` budget.  A deploy pipeline that polls a canary endpoint on a schedule would spend that same finite budget, and every canary probe would eat headroom that exists to protect genuine alert delivery. Because the canary is synthetic and operator-initiated rather than market-driven, giving it its own allowance — or routing it through the ordinary per-IP bucket — keeps the ingest budget sized for the traffic it was designed around. Worth deciding deliberately rather than inheriting.  Also note both branches are 43+ commits behind and both add a bare `process.env` gate; if the gate is meant to be operator-tunable at runtime it should go through `getRuntimeConfig()` / `RemoteConfigService` (with the `.env.example` and `firebase-remote-config-template.json` parity entries) rather than reading the environment directly, so the override actually takes effect.  No objection to either implementation on its own merits — this is about the duplication and the bucket.
