# Tasks: Scanner Preset Destinations

**Input**: `spec.md`, `plan.md`

## Phase 1: Routing contract

- [x] T001 Add failing tests for destination validation, mode defaults, legacy compatibility, and request-over-preset resolution.
- [x] T002 Run the focused routing tests and confirm RED before implementation.
- [x] T003 Implement destination normalization and shared preset routing resolution.
- [x] T004 Add failing request-routing tests for multi-recipient channel dispatch and no broadcast fallback in preset mode.
- [x] T005 Implement bounded per-recipient dispatch through `NotificationManager` and verify GREEN.

## Phase 2: Persistence and manual/scheduled runs

- [x] T006 Add failing service tests for preset mode/destinations through create, update, clone, and Firestore read.
- [x] T007 Add failing manual-run and scheduler tests for preset routing, inherit broadcast, request override, and invalid destination rejection.
- [x] T008 Implement preset persistence and use the shared routing resolver in manual and scheduled runs.
- [x] T009 Run focused scanner-preset service, validation, endpoint, and scheduler suites.

## Phase 3: Async jobs and status

- [x] T010 Add failing job tests for destination metadata retention and worker delivery routing.
- [x] T011 Add failing endpoint tests for `runAsyncJob: true` returning job metadata while synchronous defaults remain unchanged.
- [x] T012 Add failing status tests for non-sensitive preset destination capability/dependency fields.
- [x] T013 Implement async job propagation and additive status projection; verify GREEN.

## Phase 4: Contracts and operator docs

- [x] T014 Add OpenAPI/Postman assertions for preset destination create/update and async run request/response variants.
- [x] T015 Update OpenAPI, Postman, README, and environment/job documentation; confirm no new runtime env key was added.

## Phase 5: Verification and review

- [x] T016 Run affected unit/integration/contract suites and `git diff --check`.
- [x] T017 Run full Jest directly: 316 suites / 7,716 tests passed. `pnpm test` was blocked before test execution by the local dependency build-script policy.
- [x] T018 Complete the required defect-first and ponytail read-only reviews; fix verified findings and rerun affected checks.
- [ ] T019 Open/update the PR, verify exact-head checks/reviews/preview, then merge or hand off under the issue-automator rules.
- [ ] T020 After merge, run E2E against exact `origin/master`, clean up issue claim/session state, and archive the session.
