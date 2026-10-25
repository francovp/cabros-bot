# Tasks: Request-level Trader Intent Outcomes

**Input**: Design documents in `specs/791-trader-intent-outcomes/`
**Prerequisites**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/trader-intent.yaml`

## Phase 1: Boundary contract

- [x] T001 [US1/US2] Add focused failing validation tests in `tests/unit/trader-intent.test.js` for omission, valid partial/complete plans, unknown keys, missing required fields, invalid enums/numbers/notes, and BUY/SELL ordering.
- [x] T002 [US1/US2] Run `pnpm test -- tests/unit/trader-intent.test.js` and confirm RED because `src/lib/traderIntent.js` does not exist.
- [x] T003 [US1/US2] Implement `validateTraderIntent(raw)` and `isCompleteTraderIntent(intent)` in `src/lib/traderIntent.js` using the existing `INVALID_REQUEST` error shape.
- [x] T004 [US1/US2] Re-run the focused unit test and confirm GREEN.

## Phase 2: Request and persistence flow

- [x] T005 [US1/US2] Add failing integration tests in `tests/integration/alert-trader-intent.test.js` proving validation occurs before delivery/provider work and valid plans reach alert/outcome storage while omission stays inert.
- [x] T006 [US1/US2] Add failing symbol-analysis tests proving validation occurs before MCP work and the sanitized plan is echoed/persisted.
- [x] T007 [US1] Add failing alert/symbol storage unit tests for allow-listed persistence and undefined-field stripping.
- [x] T008 [US1/US2] Implement minimal handler and storage plumbing; run the three focused suites until GREEN.
- [x] T009 [US1] Add replay/export RED tests for JSONL round-trip and explicit CSV trader-intent columns; implement preservation without field cherry-picking.

## Phase 3: Outcome evaluation and analytics

- [x] T010 [US3] Add failing `SignalOutcomeService` tests proving intent persistence, matching-horizon-only evaluation, conservative BUY/SELL barrier precedence, partial-plan exclusion, and no mutation of bot-default fields.
- [x] T011 [US3] Implement nested trader-plan evaluation inside the existing bounded market-data loop; run the focused service suite until GREEN.
- [x] T012 [US3] Add failing summary/controller tests for `{ hitRatePercent, samples, averageRMultiple }`, then aggregate evaluated complete plans from the existing query result and verify GREEN.

## Phase 4: Contract synchronization

- [x] T013 [US1/US2] Add OpenAPI and Postman RED assertions for valid, omitted, partial, inverted BUY, and inverted SELL variants.
- [x] T014 [US1/US2] Update `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, README/operator docs, and examples; parse JSON and run contract tests.
- [x] T015 [US1/US2/US3] Record that no environment variable or Remote Config change exists and verify environment-documentation parity tests remain green.

## Phase 5: Verification and review

- [x] T016 Run all affected unit/integration/contract suites and `git diff --check`.
- [x] T017 Start the app with safe local configuration and verify `/healthcheck`, invalid intent rejection, and valid dry-run behavior.
- [x] T018 Run `pnpm test` once and record the full result.
- [x] T019 Run the required defect-first and ponytail reviews, fix verified findings, and repeat affected checks.
- [x] T020 Create/update the PR through `create-pr`, run Codex/discussion gates, verify preview at exact head when available, then merge or hand off per `issue-automator`.

## Dependencies

- Phase 1 blocks every later phase.
- Phase 2 blocks Phase 3 because evaluation consumes the stored sanitized contract.
- Phase 4 follows stable runtime behavior so checked-in consumers describe the real contract.
- No task may write production code before its corresponding RED test is observed.

## Deferred work

- `/intentar`, chat-scoped storage, per-destination outcome fan-out, Telegram UI, `ENABLE_TRADER_INTENT`, Remote Config, and status dependency reporting.
