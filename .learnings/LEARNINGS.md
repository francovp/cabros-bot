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

### Details
In PR #1188 (feat(outcomes): add confidence calibration feedback loop (GH-704)), query validation for `GET /api/outcomes/calibration` originally used `Number.parseInt(req.query.limit, 10)` directly. @chatgpt-codex-connector[bot] identified that `Number.parseInt` accepts leading digits from malformed strings like `'10junk'` or fractional representations like `'1.9'`, silently coercing them into valid integers (`10` and `1`). In financial and telemetry APIs, accepting malformed numeric inputs masks caller bugs and circumvents range validation.

Root cause: Relying on JavaScript's permissive `Number.parseInt` coercion instead of validating that the parameter string is composed strictly of digits before parsing into an integer.

### Suggested Action
1. Validate integer query and route parameters against `/^\d+$/` before calling `Number.parseInt` or `Math.trunc`.
2. Return a structured 400 `INVALID_REQUEST` error envelope if the parameter contains any non-digit characters (including decimal points, exponents, or alphanumeric tails).
3. Apply boundary checks (`min` and `max`) only after verifying the strict numeric format.

### Metadata
- Source: pr_review
- Related Files: src/controllers/outcomes/outcomes.js, src/lib/validation.js
- Tags: api-contract, input-validation, regex, parseInt, query-parameters
- See Also: none
- Pattern-Key: harden.strict_integer_validation
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-003] correction

**Logged**: 2026-09-27T01:05:00Z
**Priority**: high
**Status**: pending
**Area**: contracts

### Summary
Closed enum parameters in API payloads must reject explicit `null` with a 400 `INVALID_REQUEST`; only `undefined` may trigger fallback defaulting.

### Details
In PR #1193 (feat(webhooks): classify alerts with signalClass enum (GH-858)), incoming alert webhook payloads containing `"signalClass": null` were silently coalesced to the default fallback (`"unknown"`). @chatgpt-codex-connector[bot] corrected this behavior, noting that for closed enum specifications, explicitly passing `null` represents an invalid type assignment under OpenAPI/JSON Schema contracts, not an omission.

Root cause: Conflating `null` (explicit invalid type) with `undefined` (omitted property) during defensive parameter extraction and defaulting logic (`payload.signalClass || 'unknown'`).

### Suggested Action
1. Distinguish between omitted properties (`undefined`) and explicit null values (`null`) in request validation schemas.
2. For closed string enums, reject `null` values with HTTP 400 `INVALID_REQUEST` indicating that the value must be one of the permitted enum literals.
3. Allow default assignment only when the property key is entirely omitted from the input object.

### Metadata
- Source: pr_review
- Related Files: src/lib/validation.js, src/openapi/openapi.json
- Tags: api-contract, enums, schema-validation, null-safety, defensive-deserialization
- See Also: LRN-20260927-002
- Pattern-Key: harden.closed_enum_null_rejection
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-004] correction

**Logged**: 2026-09-27T01:10:00Z
**Priority**: medium
**Status**: pending
**Area**: docs

### Summary
Introducing or altering Remote-Config-eligible, non-secret configuration toggles requires atomic 4-way documentation parity across environment templates, schema definitions, operator guides, and agent guidelines.

### Details
Across PR #1189 (feat(cost): aggregate token spend tracking and budget alerting), PR #1190 (feat(ops): maintenance mode toggle for incident response), and PR #1193 (feat(webhooks): classify alerts with signalClass enum), newly introduced configuration toggles (`ENABLE_TOKEN_COST_BUDGET`, `ENABLE_SIGNAL_CLASS_MARKER`, maintenance toggles) were added to code and Firebase Remote Config templates, but omitted from `README.md` allow-lists or `AGENTS.md`. Additionally, in PR #1190, editing the configuration documentation inadvertently deleted existing documented settings (`ZERO_CHANNEL_ALERT_COOLDOWN_MS`).

Root cause: Fragmented configuration management workflows where code, schemas, and markdown documentation are maintained across disparate files without an atomic synchronization checklist.

### Suggested Action
1. Whenever a new Remote-Config-eligible, non-secret dynamic toggle or configuration key is added, update all 4 target files atomically in the same commit: `.env.example`, `RemoteConfigService.js` / Firebase template, `README.md`, and `AGENTS.md`. Secrets, authentication controls, delivery destinations, and startup-only gates must remain environment-only and never be added to Remote Config.
2. Verify that existing documentation tables and adjacent configuration keys are preserved without accidental line omissions during diff updates.
3. Include the new flags in status and capability response schemas (`/api/status`, `/api/capabilities`) and verify corresponding Postman test assertions.

### Metadata
- Source: senior_review
- Related Files: README.md, AGENTS.md, .env.example, src/services/remoteConfig/RemoteConfigService.js
- Tags: remote-config, documentation-parity, configuration-management, operational-safety
- See Also: none
- Pattern-Key: harden.remote_config_documentation_parity
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-005] correction

**Logged**: 2026-09-27T01:15:00Z
**Priority**: high
**Status**: pending
**Area**: backend

### Summary
Alert and signal replay handlers must start from the complete stored raw input payload and overlay replay/routing metadata, rather than cherry-picking fields from an explicit known-field list.

### Details
In PR #1193 (feat(webhooks): classify alerts with signalClass enum (GH-858)), the single alert replay endpoint (`/api/alerts/:id/replay`) and batch redrive routines re-dispatched stored alerts to notification channels (Telegram, WhatsApp, Discord) without copying `storedAlert.signalClass` into the delivery payload. This caused replayed messages to lose their visual signal class markers, resulting in visual degradation and inconsistency between live and replayed notifications.

Root cause: Replay handlers reconstructed delivery payloads by cherry-picking partial field subsets or explicitly whitelisting a subset of known fields instead of cloning the full raw input payload and overlaying routing metadata. Any newly introduced or unrecognized top-level attributes are silently dropped when reconstructing payloads from an explicit known-field list.

### Suggested Action
1. When implementing replay, redrive, or retry routines, start from the complete stored raw input payload (`{ ...storedAlert.payload }`) and overlay replay/routing metadata, rather than reconstructing payloads from a known-field list.
2. Ensure all top-level domain classification and metadata attributes (such as `signalClass`, `source`, `receivedAt`, `symbols`) and any unrecognized top-level properties are preserved verbatim.
3. Write integration tests for replay endpoints verifying that replayed payloads preserve all incoming fields and that outbound notifications are semantically identical to original dispatches.
4. Avoid field cherry-picking, whitelisting, or relying on optional nested fields for channel-critical formatting.

### Metadata
- Source: pr_review
- Related Files: src/services/notification/TelegramService.js, src/controllers/admin/alerts.js, src/services/NotificationManager.js
- Tags: replay, redrive, alert-ingestion, telegram, signal-classification, payload-preservation
- See Also: LRN-20260914-001
- Pattern-Key: harden.replay_payload_preservation
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-006] correction

**Logged**: 2026-09-27T01:20:00Z
**Priority**: medium
**Status**: pending
**Area**: contracts

### Summary
Postman collections must provide distinct executable request variants asserting structured 400 error envelopes for all documented failure boundaries.

### Details
In PR #1188 and PR #1194 (feat(postman): add invalid outcomes summary request variants (GH-716)), the Postman collection claimed validation coverage for `/api/outcomes/summary` but contained only a single negative request (`limit=200`). Review by @chatgpt-codex-connector[bot] and subsequent PR #1194 required creating 6 discrete, runnable test variants covering invalid status, invalid window, non-numeric timestamps, and reversed time ranges (`from > to`), each asserting a structured 400 `INVALID_REQUEST` response.

Root cause: Treating API collection documentation as illustrative rather than an executable, comprehensive negative contract test suite.

### Suggested Action
1. Include separate, runnable requests in `CabrosBot.postman_collection.json` for each invalid input variant (out-of-bounds numbers, invalid enum members, malformed timestamps, inverted ranges).
2. Attach Postman test scripts asserting HTTP 400 status codes and structured payload schemas containing machine-readable `code: 'INVALID_REQUEST'` alongside specific human-readable `error` messages.
3. Back collection contracts with automated regression suites in `tests/unit/postman-collection.test.js`.

### Metadata
- Source: pr_review
- Related Files: CabrosBot.postman_collection.json, tests/unit/postman-collection.test.js
- Tags: postman, negative-testing, contract-testing, error-envelopes, api-validation
- See Also: LRN-20260927-002, LRN-20260927-003
- Pattern-Key: harden.postman_negative_variant_coverage
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---

## [LRN-20260927-007] correction

**Logged**: 2026-09-27T01:25:00Z
**Priority**: critical
**Status**: pending
**Area**: backend

### Summary
Authentication middleware must precede maintenance mode and dynamic feature gates to prevent unauthenticated information disclosure and probing.

### Details
In PR #1190 (feat(ops): maintenance mode toggle for incident response), the maintenance mode middleware was initially placed before `validateApiKey` in Express route handlers. Unauthenticated external clients sending requests to maintenance-gated endpoints received a 503 `MAINTENANCE_MODE` status instead of 401 `UNAUTHORIZED`. @chatgpt-codex-connector[bot] flagged this as a P1 security vulnerability: unauthenticated attackers could probe whether the service was in maintenance without valid credentials.

Root cause: Applying operational availability gates globally before verifying client authenticity in the Express middleware chain.

### Suggested Action
1. Keep rate limiting as an outer defense ahead of authentication to protect against unauthenticated volumetric floods or credential brute-forcing, while ensuring `validateApiKey` (and any required bearer authentication) executes before maintenance mode or dynamic feature flag gates.
2. For bot command integrations (e.g. Telegram), filter updates so maintenance mode applies only to user commands (`isTelegramCommand`) and evaluate per-chat maintenance reply cooldowns without consuming expensive user rate quotas.
3. Ensure all gated operations return structured 503 envelopes (`{ error: 'MAINTENANCE_MODE', message: '...' }`) only to authenticated callers.

### Metadata
- Source: pr_review
- Related Files: src/routes/index.js, src/lib/maintenanceMode.js, index.js
- Tags: security, middleware-order, authentication, maintenance-mode, api-gateway
- See Also: none
- Pattern-Key: harden.auth_precedes_maintenance_gate
- Recurrence-Count: 1
- First-Seen: 2026-09-27
- Last-Seen: 2026-09-27

---
## [LRN-20260929-001] correction

**Logged**: 2026-09-29T00:13:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Cleanup preview channels script default `--max-age-days 3` deletes 0 channels; only `--max-age-days 1` frees quota.

### Details
In Issue #1269 (firebase-hosting preview channel quota exhausted), @francovp corrected their own earlier remediation suggestion. The recommended `node scripts/cleanup-preview-channels.js --apply --max-age-days 3` would delete **0 of 51 channels**. Measured thresholds:
- `--max-age-days 1`: deletes 16 channels (created in ~19-min burst on 2026-09-27)
- `--max-age-days 2, 3, 7`: delete 0 channels
- `--max-age-days 0`: rejected as invalid

The 35 remaining channels are all under 24 hours old, created by current PR burst. The workflow mints a channel per branch, so every push to a renamed/force-pushed branch consumes a new slot, outpacing the 7-day TTL decay. Default of 3 days is misleading — useful value today is 1.

### Suggested Action
1. When documenting cleanup commands, verify the actual deletion count with dry-run against current state before recommending.
2. Address recurrence: reuse single channel per PR number (not per branch name) to prevent rebase/rename from consuming new slots.
3. Consider shortening 7-day TTL and making preview deploy non-blocking so channel exhaustion cannot block merges.

### Metadata
- Source: user_feedback
- Related Files: scripts/cleanup-preview-channels.js, .github/workflows/firebase-hosting-preview.yml
- Tags: firebase-hosting, preview-channels, quota, cleanup-script, documentation-accuracy
- See Also: LRN-20260927-004
- Pattern-Key: harden.verify_cleanup_dryrun_before_recommending
- Recurrence-Count: 1
- First-Seen: 2026-09-29
- Last-Seen: 2026-09-29

---

## [LRN-20260929-002] correction

**Logged**: 2026-09-29T00:13:00Z
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Documented git recovery command became invalid after master advanced.

### Details
In Issue #1228 (master force-pushed backwards, un-merging PR #924), @francovp corrected the original recovery command `git push origin cefc13ee:master` as **now wrong and should not be run**. Master had advanced 8 commits since the force-push, so it was no longer a fast-forward. The correction emphasizes that recovery commands documented in issues have a short shelf life and must be re-verified before execution.

### Suggested Action
1. Never treat documented git recovery commands as evergreen — always re-verify against current master HEAD before executing.
2. Prefer documenting the *procedure* (fetch, reset, force-push) over specific commit SHAs that stale quickly.
3. Add a warning note in incident runbooks that SHA-based recovery commands expire.

### Metadata
- Source: user_feedback
- Related Files: Issue #1228
- Tags: git, force-push, recovery, incident-response, documentation-accuracy
- See Also: LRN-20260929-001
- Pattern-Key: harden.git_recovery_commands_expire
- Recurrence-Count: 1
- First-Seen: 2026-09-29
- Last-Seen: 2026-09-29

---

## [LRN-20260929-003] correction

**Logged**: 2026-09-29T00:13:00Z
**Priority**: critical
**Status**: pending
**Area**: backend

### Summary
Green CI on conflicting PRs is not evidence of safety — pre-existing defects survive merge conflict resolution.

### Details
In Issue #1258 (and confirmed second instance in #1079), @francovp demonstrated that merging `origin/master` into a conflicting PR branch and resolving conflicts **does not fix pre-existing defects in the branch head**. PR #1083 had green CI but would 500 on every live replay due to a defect in `src/controllers/alerts/alerts.js` that existed before the merge. The conflict resolution work itself was correct; the problem was a pre-existing bug that CI did not catch because the test environment differed from production.

### Suggested Action
1. Never assume green CI on a rebased/merged PR branch means the code is production-safe.
2. When resolving conflicts on old branches, run the full test suite *and* manually verify critical paths against production-like conditions.
3. For replay/redrive endpoints specifically: test against real stored payloads, not just synthetic test fixtures.

### Metadata
- Source: user_feedback
- Related Files: src/controllers/alerts/alerts.js, PR #1083, PR #1079
- Tags: ci, merge-conflicts, false-green, replay, alert-replay, production-parity
- See Also: LRN-20260927-005, LRN-20260929-004
- Pattern-Key: harden.ci_green_not_production_safe
- Recurrence-Count: 2
- First-Seen: 2026-09-28
- Last-Seen: 2026-09-29

---

## [LRN-20260929-004] correction

**Logged**: 2026-09-29T00:13:00Z
**Priority**: critical
**Status**: pending
**Area**: backend

### Summary
PR #1083 green CI is misleading — branch would 500 every live replay due to pre-existing defect.

### Details
@francovp blocked PR #1083 (feat(alerts): add optional re-enrichment to alert replay endpoint) despite green CI: "This branch would 500 every live replay, and its green CI is misleading." The defect in `src/controllers/alerts/alerts.js` reproduces without the merge conflicts. The branch head `280bd297` has a pre-existing bug that the test suite does not catch because test environment differs from production (e.g., Firestore emulator vs real Firestore, missing stored alert payloads with signalClass).

### Suggested Action
1. Add integration tests for alert replay that use real stored alert payloads including `signalClass` and all top-level metadata.
2. Ensure test fixtures cover the full payload preservation contract (LRN-20260927-005).
3. Consider adding a "production parity" test stage that runs against a staging Firestore instance.

### Metadata
- Source: user_feedback
- Related Files: src/controllers/alerts/alerts.js, PR #1083
- Tags: ci, alert-replay, signalClass, payload-preservation, test-gaps, production-parity
- See Also: LRN-20260927-005, LRN-20260929-003
- Pattern-Key: harden.test_production_parity_for_replay
- Recurrence-Count: 1
- First-Seen: 2026-09-29
- Last-Seen: 2026-09-29

---
## [LRN-20261001-001] correction

**Logged**: 2026-10-01T10:40:00Z
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
Cleanup preview channels script default `--max-age-days 3` deletes 0 channels; only `--max-age-days 1` frees quota.

### Details
In comment on issue #1269, @francovp corrected his earlier remediation suggestion for firebase-hosting preview channel quota exhaustion. The recommended `node scripts/cleanup-preview-channels.js --apply --max-age-days 3` would delete **0 of 51 channels**. Measured thresholds:
- `--max-age-days 1`: deletes 16 channels (created in ~19-min burst on 2026-09-27)
- `--max-age-days 2, 3, 7`: delete 0 channels
- `--max-age-days 0`: rejected as invalid

The 35 remaining channels are all under 24 hours old, created by current PR burst. The workflow mints a channel per branch, so every push to a renamed/force-pushed branch consumes a new slot, outpacing the 7-day TTL decay. Default of 3 days is misleading — useful value today is 1.

### Suggested Action
1. When documenting cleanup commands, verify the actual deletion count with dry-run against current state before recommending.
2. Address recurrence: reuse single channel per PR number (not per branch name) to prevent rebase/rename from consuming new slots.
3. Consider shortening 7-day TTL and making preview deploy non-blocking so channel exhaustion cannot block merges.
4. For immediate backlog, run `node scripts/cleanup-preview-channels.js --apply --max-age-days 1` and verify with dry run.
5. Wire the script into `package.json` (#1268) but note the default of 3 days is misleading; update documentation accordingly.

### Metadata
- Source: user_feedback
- Related Files: scripts/cleanup-preview-channels.js, .github/workflows/firebase-hosting-preview.yml, Issue #1269
- Tags: firebase-hosting, preview-channels, quota, cleanup-script, documentation-accuracy
- See Also: LRN-20260929-001
- Pattern-Key: harden.verify_cleanup_dryrun_before_recommending
- Recurrence-Count: 1
- First-Seen: 2026-10-01
- Last-Seen: 2026-10-01

---