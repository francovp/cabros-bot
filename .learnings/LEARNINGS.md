## [LRN-20261004-011] correction

**Logged**: 2026-10-04T08:27:00Z
**Priority**: high
**Status**: pending
**Area**: api

### Summary
PR #1273 (auto-trade bridge) review: verified safety-critical points against code rather than assuming; found one real bug and one auth gap.

### Details
@francovp reviewed PR #1273 and verified each safety-critical point against the code rather than assuming. Found one real bug and one auth gap worth documenting.

### Suggested Action
When reviewing safety-critical code (money-moving paths), always verify each claim against the actual implementation rather than assuming correctness from the PR description. Document findings explicitly.

### Metadata
- Source: user_feedback
- Related Files: PR #1273, src/services/trading/AlertSignalRouter.js
- Tags: trading, safety-review, code-verification, auto-trade
- Pattern-Key: harden.verify_safety_claims_against_code
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-010] correction

**Logged**: 2026-10-04T08:27:00Z
**Priority**: high
**Status**: pending
**Area**: api

### Summary
PR #1299 (collapse cross-timeframe duplicates): QA failed twice before passing on round 3 after fixes were verified by reverting source files.

### Details
@francovp QA'd PR #1299: Round 1 FAIL (all six AC pass but contract parity work had issues), Round 2 FAIL (PR head still identical single commit), Round 3 PASS (both blockers genuinely fixed, proved by reverting two source files to pre-fix code). The fix was validated by demonstrating the failure returns when the fix is removed.

### Suggested Action
When QA fails, require the author to demonstrate the fix by showing the test fails without it (revert-to-prove). Round numbers must correspond to actual code changes, not just re-assertions.

### Metadata
- Source: user_feedback
- Related Files: PR #1299, tests/unit/alert-handler.test.js
- Tags: qa-process, revert-to-prove, cross-timeframe-duplicates
- Pattern-Key: harden.qa_revert_to_prove
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-009] correction

**Logged**: 2026-10-04T08:27:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
PR #1300 (Production Smoke Probe checkout): QA failed round 1, fixed in commit 90307937, passed round 2. Blocker was false-outage class the PR exists to eliminate.

### Details
@francovp QA'd PR #1300: Round 1 FAIL (root-cause fix correct: SHA-pinned actions/checkout present, live workflow_dispatch works). Round 2 PASS after fix in `90307937`. The blocker was exactly the false-outage class this PR exists to eliminate. Root cause: `validateApiKey` returns 403 when the preview deployments share the production WEBHOOK_API_KEY but have different deployment URLs.

### Suggested Action
When a PR aims to fix a class of false outages, verify the fix actually eliminates that class by testing against the real failure mode, not just the happy path.

### Metadata
- Source: user_feedback
- Related Files: PR #1300, .github/workflows/production-smoke-probe.yml
- Tags: ci, smoke-probe, false-outage, qa-verification
- Pattern-Key: harden.qa_test_real_failure_mode
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-008] correction

**Logged**: 2026-10-04T08:27:00Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
PR #1310 (Firestore composite index deploy): QA failed with two blockers — fetchLiveIndexes doesn't paginate, and PR closes #1285 while criterion 1 (GET /api/alerts 200 in production) is unmet.

### Details
@francovp QA'd PR #1310 (Marple, Round 1): Two blockers: (1) `fetchLiveIndexes` ignores `nextPageToken`, so on projects with >1 page of indexes the tool can never return exit 0 and will falsely report READY indexes as missing during a P0. (2) PR carries `Closes #1285` but acceptance criterion 1 (GET /api/alerts returning 200 in production) is explicitly not met — production still 503s, so merging would auto-close the P0 while outage persists.

### Suggested Action
1. Always implement pagination for list APIs — single-page assumptions break at scale.
2. Never use `Closes` keyword on a tracking issue until ALL acceptance criteria are demonstrably met in production. Use `Refs` or `Part of` until the deploy runs and passes.

### Metadata
- Source: user_feedback
- Related Files: PR #1310, scripts/deploy-firestore-indexes.js, Issue #1285
- Tags: firestore, pagination, issue-tracking, production-verification
- Pattern-Key: harden.pagination_required, harden.no_premature_closes
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-007] correction

**Logged**: 2026-10-04T08:27:00Z
**Priority**: high
**Status**: pending
**Area**: api

### Summary
PR #1315 (jobs broker readiness): QA failed round 1, passed round 2 after fix extracted `_markBrokerReady` and proved it end-to-end against real RESP broker.

### Details
@francovp QA'd PR #1315 (Marple, Round 1 FAIL): Core fix works but broker readiness proof was incomplete. Round 2 PASS (Sherlock): Round-1 blocker genuinely fixed, not just re-asserted. Fix extracts `_markBrokerReady` and verifies end-to-end against a real RESP broker on healthy broker with 3s timeout.

### Suggested Action
When a PR claims to "prove" readiness or connectivity, the proof must be executable against the real dependency, not just a unit test mock. Require end-to-end verification in QA.

### Metadata
- Source: user_feedback
- Related Files: PR #1315, src/services/jobs/jobWorker.js
- Tags: jobs, broker-readiness, e2e-verification, qa
- Pattern-Key: harden.e2e_proof_required
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-006] correction

**Logged**: 2026-10-04T08:27:00Z
**Priority**: high
**Status**: pending
**Area**: api

### Summary
PR #1323 (enable Firestore scanner preset persistence): live verification corrected own description — checked claim against real deployments instead of assuming.

### Details
@francovp on PR #1323: "I checked the issue's claim against the real deployments instead of assuming it. Two things came back that change what this PR should say." Self-correction by verifying against deployed infrastructure rather than trusting the issue description.

### Suggested Action
Always verify issue claims against the actual deployed infrastructure before acting. Assumptions about what is deployed often diverge from reality.

### Metadata
- Source: user_feedback
- Related Files: PR #1323, Issue #1114
- Tags: deployment-verification, assumption-checking, scanner-presets
- Pattern-Key: harden.verify_claims_against_deployed
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-005] correction

**Logged**: 2026-10-04T02:23:31Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Issue #1285: Evidence update — 29 writes SUCCEEDED, so client was non-null at write time; read failure is on caught-error path, not null-client guard.

### Details
Two `/api/status` reads separated by real wall-clock time returned identical write counters: `writesAttempted=29, writesSucceeded=29, writesFailed=0` (window 142.9h). This establishes the client was functional for 29 alert writes. The read failure is more consistent with the caught-error path (`query.get()` rejecting at line 1478) than the null-client guard (line 1437). However, counters carry no timestamps — all 29 writes may have completed early before read failure began. Next alert arrival or Cloud Logging access needed to settle.

### Suggested Action
When counters lack timestamps, treat "worked at some point" as distinct from "works now." Design observability to include timestamps on cumulative counters so temporal correlation is possible.

### Metadata
- Source: user_feedback
- Related Files: Issue #1285, src/services/storage/AlertStorageService.js
- Tags: firestore, observability, counters, temporal-correlation
- Pattern-Key: harden.timestamp_cumulative_counters
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-004] correction

**Logged**: 2026-10-04T02:17:33Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Issue #1285: `scannerPresetStorage` is the only status entry that materialises the real Firestore client — it reports the client as unusable while entries that never touch it report `ready: true`.

### Details
`ScannerPresetService.getStorageStatus()` calls `alertStorageService.getFirestore()` — the same client failing alert reads. `scannerPresetStorage` reports `configured: false, ready: false, status: "misconfigured"` while `firestore` and `firestoreJobStorage` (both derived from `isFirestoreConfigured()` env check) report `ready: true`. Exactly two causes: (1) `getFirestore()` returns `null` (null-client guard at line 1437), or (2) `firestoreUnavailable` latched `true` from earlier scanner-preset write failure (local to that service). Falsifiable prediction: if client is null now, next alert increments `writesFailed`; if stays 0, client is fine and scanner-preset flag is unrelated noise.

### Suggested Action
Status endpoints that report `ready: true` based only on env/config checks (not live probes) create false confidence. Every status dependency should reflect an actual probe of the subsystem it represents.

### Metadata
- Source: user_feedback
- Related Files: Issue #1285, src/services/scannerPresetService.js, src/controllers/status.js
- Tags: firestore, status-endpoint, false-readiness, probe-vs-config
- Pattern-Key: harden.status_must_probe_not_config
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-003] correction

**Logged**: 2026-10-04T02:12:35Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Issue #1285: Correction 2 — `/api/jobs` control was invalid because `JobRepository.list()` catches Firestore read errors and falls back to in-memory jobs, so 200 response proves nothing about Firestore read health.

### Details
`JobRepository.list()` (line 698-700) catches Firestore read errors, logs a warning, and merges memory jobs. `GET /api/jobs` → 200 with `jobs: []` is returned whether or not the Firestore read succeeded. This invalidates the earlier evidence that "shared client reaches Firestore fine."

### Suggested Action
Never use an endpoint that swallows errors as a health control for the subsystem it wraps. Health checks must fail when the underlying dependency fails, not silently succeed.

### Metadata
- Source: user_feedback
- Related Files: Issue #1285, src/services/jobs/JobRepository.js
- Tags: firestore, health-checks, error-swallowing, invalid-control
- Pattern-Key: harden.health_checks_must_fail_on_dep_failure
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-002] correction

**Logged**: 2026-10-04T02:09:40Z
**Priority**: high
**Status**: pending
**Area**: infra

### Summary
Issue #1285: Missing composite index RULED OUT — bogus document ID returns 503 (not 404), proving failure happens before Firestore query planner; no composite index required for single-field ordered queries.

### Details
Discriminating test: `GET /api/alerts/zzz-not-real` (doc read) returns 503, not 404. A bogus doc ID returning 503 means failure happens before any document lookup — read never reaches query planner, so index selection not involved. `firestore.indexes.json` has 10 composite indexes, none for `alerts` collection; `listAlerts()` issues plain `.orderBy('receivedAt','desc').orderBy(__name__,'desc')` which Firestore auto-satisfies with single-field indexes. Revised hypothesis: write/read split is time-dependent — writes succeeded early in 142.9h window, reads degraded later, no writes since.

### Suggested Action
Use discriminating probes (doc read vs query read) to isolate failure layer. Don't assume index issues without proving the query planner is reached. Track timestamps on write/read metrics to correlate temporally.

### Metadata
- Source: user_feedback
- Related Files: Issue #1285, src/services/storage/AlertStorageService.js, firestore.indexes.json
- Tags: firestore, composite-index, discriminating-probes, troubleshooting
- Pattern-Key: harden.discriminating_probes_for_layer_isolation
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

## [LRN-20261004-001] correction

**Logged**: 2026-10-04T02:40:04Z
**Priority**: medium
**Status**: pending
**Area**: api

### Summary
Issue #1301: OpenAPI contract already documents 503 for news-monitor routes — proposed "add 503 to OpenAPI" change was factually wrong.

### Details
@francovp corrected own issue #1301 body: claimed fix should "declare 503 alongside existing 200/403" but parsing the spec showed both news-monitor routes (`/api/news-monitor/summary` and `/api/news-monitor/analyses`) **already declare 503** referencing shared `#/components/responses/Error`. The defect is a contract violation (implementation returns 500, spec promises 503), not a documentation gap. No OpenAPI change needed; drop proposed change and acceptance criterion. Postman has no items for these endpoints — coverage drift, but separate gap.

### Suggested Action
Always parse the actual OpenAPI spec to verify what it declares before proposing contract changes. `grep` the source of truth (spec file), not memory or assumptions.

### Metadata
- Source: user_feedback
- Related Files: Issue #1301, src/openapi/openapi.json, src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js
- Tags: openapi, contract-verification, spec-parsing, self-correction
- Pattern-Key: harden.parse_spec_before_proposing_changes
- Recurrence-Count: 1
- First-Seen: 2026-10-04
- Last-Seen: 2026-10-04

---

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