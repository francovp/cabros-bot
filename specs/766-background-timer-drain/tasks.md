# Tasks: Managed shutdown draining for webhook alert timers

**Input**: Design documents from specs/766-background-timer-drain/  
**Prerequisites**: plan.md and spec.md

## Phase 1: Shared timer lifecycle

- [x] T001 Audit every recurring interval in src/services and map it to its owning service.
- [x] T002 Verify registry behavior for idempotent stop, callback drain, callback rejection, and timeout in tests/unit/background-timer-registry.test.js.
- [x] T003 Verify process shutdown ordering and fail-open behavior in tests/unit/process-lifecycle.test.js.

## Phase 2: Service integration

- [x] T004 Route each service-owned recurring interval through createManagedInterval while preserving interval duration and ref/unref behavior.
- [x] T005 Verify each service's local stop method clears its managed timer and leaves no active registry entry.
- [x] T006 Audit that src/services contains no raw setInterval calls outside src/lib/backgroundTimerRegistry.js.

## Phase 3: Status contract and verification

- [x] T007 Expose only registered, drained, and failed counts in GET /api/status.
- [x] T008 Update OpenAPI and CabrosBot.postman_collection.json examples for the additive status field.
- [x] T009 Run focused timer, lifecycle, alert-delivery, status, and Postman contract tests.
- [ ] T010 Run the full suite, compare any unrelated failures with current master, and record exact evidence.
- [ ] T011 Verify exact-head CI, active OpenClaw preview, and relevant webhook alert E2E before merge.

## Verification notes

- Focused run on the final tree: 20 suites passed, 969 tests passed.
- Full run before the final timer-budget follow-up: 286 suites passed and 15 failed (7,216 passed, 36 failed). The news-monitor cache and public-status `400` failures were reproduced in a separate current-master run; the isolated JobService suite passed. Other full-suite failures still need baseline or CI confirmation.

