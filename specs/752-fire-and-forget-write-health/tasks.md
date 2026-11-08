# Tasks: Fire-and-Forget Firestore Write Health

**Input**: Design documents from `specs/752-fire-and-forget-write-health/`  
**Prerequisites**: `plan.md`, `spec.md`, and `research.md`

## Phase 1: Health helper and bounded metrics

- [x] T001 [US1] Add failing unit tests for fixed domains, counters, rolling status, categories, redaction, and reset in `tests/unit/firestore-write-metrics-service.test.js`.
- [x] T002 [US1] Add failing helper tests for sync throw, rejected promise, success value, and non-rejecting outcome in `tests/unit/fire-and-forget.test.js`.
- [x] T003 [US1] Implement fixed-domain persistent-write histories and snapshot methods in `src/services/storage/FirestoreWriteMetricsService.js`.
- [x] T004 [US1] Implement bounded error sanitization and `fireAndForget(name, fn)` in `src/lib/fireAndForget.js`.
- [x] T005 [US3] Add Sentry threshold, per-domain/category dedupe, and recovery tests and implementation.

## Phase 2: Instrument persistence paths

- [x] T006 [US1] Instrument `AlertStorageService.saveAlert()` without changing its existing write metrics or null-on-failure behavior.
- [x] T007 [US1] Instrument `SignalOutcomeService.recordSignal()` and preserve `ALREADY_EXISTS` idempotency.
- [x] T008 [US1] Instrument notification dead-letter persistence in `NotificationRedriveService.recordDeliveryResults()` while retaining its 500 ms bound and in-memory fallback.
- [x] T009 [US1] Instrument all news dedup writes, including `setEntry()`, `updateEntry()`, claims, renewals, explicit deletion, and expired-entry cleanup, while retaining fail-open behavior and excluding no-op transactions from write-success counts.
- [x] T010 [US1] Add focused tests for success and failure in the four instrumented domains.

## Phase 3: Status contract and verification

- [x] T011 [US2] Add `dependencies.persistentWriteHealth` to the status handler and `/api/capabilities` alias.
- [x] T012 [US2] Update OpenAPI and Postman status examples and add authenticated integration coverage for unconfigured and degraded domains.
- [x] T013 [US2] Update README and `AGENTS.md` service documentation.
- [x] T014 [US1, US2, US3] Run focused tests, local smoke checks, `git diff --check`, and the full `pnpm test` suite (direct Jest completed because pnpm was blocked before startup by ignored-build policy).
- [ ] T015 [US1, US2, US3] Complete required read-only reviews, create/update the PR, and verify its preview/review gates.

## Dependency Order

T001–T002 precede T003–T005. T003–T005 precede T006–T010. T011–T013 depend on the snapshot contract. T014 follows all code and contract edits; T015 follows successful verification and review.
