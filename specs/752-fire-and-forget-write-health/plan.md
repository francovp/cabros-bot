# Fire-and-Forget Firestore Write Health Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Make asynchronous Firestore write failures visible by domain without changing alert delivery or existing metrics behavior.

**Architecture:** Extend `FirestoreWriteMetricsService` with a separate bounded `persistentWriteHealth` snapshot and Sentry threshold state. A small `fireAndForget(name, fn)` helper records outcomes for four fixed persistence domains while existing background-task tracking remains in charge of shutdown. Expose the snapshot through the existing status/capabilities response and update the API contract examples.

**Tech Stack:** Node.js 24.18.0, CommonJS, Jest, Express, Firebase Admin SDK, existing Sentry wrapper.

**Spec:** [spec.md](spec.md)

## Global Constraints

- Preserve fail-open alert delivery and existing response values for failed persistence.
- Keep `dependencies.firestoreWriteMetrics` and `dependencies.firestoreReadMetrics` shapes unchanged.
- Keep all external errors sanitized; status and Sentry events expose no provider message, credentials, payload, or destination.
- Keep Firestore writes inside their existing `trackBackgroundTask` shutdown-drain paths.
- Add no dependencies, environment variables, Firebase Remote Config parameters, endpoint, or route changes.
- Update `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, README operator documentation, and the relevant AGENTS.md service map.

## Review Focus

- A supplied write function that throws synchronously and one that rejects asynchronously must take the same non-throwing metric path.
- A duplicate idempotent outcome record (`ALREADY_EXISTS`) remains a success and must not create a false degraded signal.
- Rolling windows stay capped at 100 entries per fixed domain; Sentry requires at least 50 attempts and deduplicates each domain/category incident.
- A domain without observed persistence attempts remains `unconfigured`; a failure in the last five minutes keeps it `degraded` even when the rolling rate is low.
- Fail-open handling must preserve process shutdown tracking and notification/alert responses.

---

## Summary

Reuse the existing Firestore metrics owner. Add bounded persistent-write health details as a second snapshot, instrument the four issue-listed persistence domains, and expose a safe read-only response block. The status failure threshold uses the latest 100 attempts or a failure in the last five minutes; Sentry paging requires at least 50 attempts and more than 20% failures in the latest 50.

## Technical Context

**Language/Version**: JavaScript, Node.js 24.18.0  
**Primary Dependencies**: Existing Firebase Admin SDK and `@sentry/node` wrapper; no additions  
**Storage**: Process-local telemetry only; Firestore records remain unchanged  
**Testing**: Jest unit and integration tests  
**Target Platform**: Node.js service on production/preview workers  
**Project Type**: Single Express application  
**Performance Goals**: Constant-time bounded metric updates; no more than 100 stored samples per domain  
**Constraints**: Metrics and Sentry failures are fail-open; no raw provider error text in public responses  
**Scale/Scope**: Four fixed write domains and one status response block

## Project Structure

```text
src/lib/fireAndForget.js
src/services/storage/FirestoreWriteMetricsService.js
src/services/storage/AlertStorageService.js
src/services/storage/SignalOutcomeService.js
src/services/notification/NotificationRedriveService.js
src/services/storage/NewsDedupStorageService.js
src/controllers/status.js
src/openapi/openapi.json
CabrosBot.postman_collection.json
README.md
AGENTS.md
tests/unit/fire-and-forget.test.js
tests/unit/firestore-write-metrics-service.test.js
tests/integration/status-endpoint.test.js
```

**Structure Decision**: Keep the existing storage metrics service as the state owner, with one small generic helper in `src/lib/`; instrument only the issue's alert-storage, outcome, dead-letter, and news-dedup persistence paths.

## Implementation Tasks

### Task 1: Pin the health and helper contracts with failing tests

**Files:**
- Modify: `tests/unit/firestore-write-metrics-service.test.js`
- Create: `tests/unit/fire-and-forget.test.js`

- [x] Add tests for the fixed initial `unconfigured` domains, cumulative counters, rolling rate, five-minute degradation, error-category mapping, 120-character redacted internal message, and state reset.
- [x] Add tests proving synchronous throws and rejected promises produce a resolved failure envelope, and successful promises preserve their value.
- [x] Add Sentry tests for the 50-attempt/20% boundary, domain/category deduplication, and re-arming after recovery.
- [x] Run the two focused files and verify each new assertion fails for the expected missing behavior.

### Task 2: Implement bounded metrics and the fail-open helper

**Files:**
- Modify: `src/services/storage/FirestoreWriteMetricsService.js`
- Create: `src/lib/fireAndForget.js`
- Modify: `tests/unit/firestore-write-metrics-service.test.js`
- Modify: `tests/unit/fire-and-forget.test.js`

- [x] Add fixed-domain rolling histories capped at 100 records without changing existing write/read snapshots.
- [x] Add `recordPersistentWriteSuccess`, `recordPersistentWriteFailure`, and `getPersistentWriteHealthSnapshot` with the spec's status thresholds and closed categories.
- [x] Use `redactString` before storing at most 120 characters of an error message; omit that message from the public snapshot.
- [x] Add fail-open Sentry capture with `feature=persistent-write-health`, a generic message, and a domain/category fingerprint; emit once per active incident.
- [x] Implement `fireAndForget(name, fn)` as a non-rejecting wrapper that preserves successful values and reports failures.
- [x] Re-run the focused unit files and confirm they pass.

### Task 3: Instrument the four persistence domains

**Files:**
- Modify: `src/services/storage/AlertStorageService.js`
- Modify: `src/services/storage/SignalOutcomeService.js`
- Modify: `src/services/notification/NotificationRedriveService.js`
- Modify: `src/services/storage/NewsDedupStorageService.js`
- Modify existing focused tests in `tests/unit/alert-storage-service.test.js`, `tests/unit/signal-outcome-service.test.js`, `tests/unit/notification-redrive-service.test.js`, and `tests/unit/news-monitor-persistent-dedup.test.js`

- [x] Wrap each issue-listed Firestore operation in the matching fixed domain and retain existing console diagnostics, return values, idempotency behavior, fail-open behavior, and background-task draining.
- [x] Add success/failure assertions for each domain, including `ALREADY_EXISTS` idempotent outcome recording and a Firestore rejection.
- [x] Run all four focused service test files and verify existing alert/dedup behavior is unchanged.

### Task 4: Expose and document the status contract

**Files:**
- Modify: `src/controllers/status.js`
- Modify: `src/openapi/openapi.json`
- Modify: `CabrosBot.postman_collection.json`
- Modify: `tests/integration/status-endpoint.test.js`
- Modify: `README.md`
- Modify: `AGENTS.md`

- [x] Add `dependencies.persistentWriteHealth` to `/api/status` and the existing `/api/capabilities` alias.
- [x] Add valid response examples for unconfigured and observed/degraded domains in Postman; preserve the existing authenticated status request and response contract.
- [x] Update the OpenAPI schema and concise operator docs; document process-local bounded state and omitted error messages.
- [x] Add integration assertions for both routes, the unconfigured state, and a degraded domain; verify no raw error message is present.
- [x] Parse the changed JSON and run focused status/contract tests plus `git diff --check`.

### Task 5: Complete verification and review

**Files:**
- All implementation files above

- [x] Run safe local server smoke checks for `/healthcheck` and protected `/api/status`/`/api/capabilities`.
- [x] Run the focused tests again, then the full `pnpm test` suite once (pnpm was blocked before test startup by ignored-build policy; equivalent Jest suite passed directly).
- [ ] Run the required defect-first and Ponytail reviews; address applicable findings and repeat after code changes.
- [ ] Create/update the PR through the `create-pr` skill, add the agent/model attribution label and `agent-working`, then verify the OpenClaw exact-head preview and review/discussion gates.

## Complexity Tracking

No new abstraction is introduced beyond the requested helper. The existing Firestore metrics service remains the source of process-local telemetry; its current snapshots are kept stable so older consumers do not need migration.
