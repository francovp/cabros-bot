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
- Last-Seen: 2026-10-03