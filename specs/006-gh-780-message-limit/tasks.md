# Tasks: Configurable generic message limit

**Input**: Design documents from `specs/006-gh-780-message-limit/`
**Prerequisites**: `plan.md`, `spec.md`, `research.md`, `data-model.md`, `contracts/configuration.md`

## Format: `[ID] [P?] [Story] Description`

- `[P]` marks independent work that can proceed in parallel.
- `[US1]` maps a task to the single user story.
- Tests are required by the issue acceptance criteria and repository instructions; write them first and confirm they fail before implementation.

## Phase 1: Setup

**Purpose**: Confirm the clean issue branch and current compatibility baseline.

- [x] T001 [US1] Create the numbered feature branch and complete the GH-780 specification, plan, research, and quality checklist.

## Phase 2: User Story 1 - Configure the webhook message limit (Priority: P1)

**Goal**: Let operators tune the existing truncation cap while retaining the default, safe fallback, and shipped webhook response behavior.

**Independent Test**: Remote-config unit tests and generic-message webhook integration tests cover default, valid override, boundaries, invalid fallback, and response compatibility.

### Tests first

- [x] T002 [US1] Add `RemoteConfigService` tests for the 4000 default, inclusive 1..20000 bounds, invalid environment fallback, invalid remote override preservation of the environment value, and a fresh remote override in `tests/unit/remote-config-service.test.js`.
- [x] T003 [US1] Add failing generic-message webhook integration cases for environment and fresh remote values, exact-boundary behavior, clipping metadata, and unchanged under-limit responses in `tests/integration/generic-message-webhook.test.js`.

### Implementation

- [x] T004 [US1] Register the bounded `GENERIC_MESSAGE_MAX_LENGTH` parameter in `src/services/remoteConfig/RemoteConfigService.js` and `firebase-remote-config-template.json`.
- [x] T005 [US1] Resolve the effective setting through `getRuntimeConfig()` in `src/controllers/webhooks/handlers/message/message.js`, preserving current truncation, routing, response, and persistence behavior.
- [x] T006 [P] [US1] Document the setting and its default/range/fallback in `.env.example`, `docs/environment-configuration.md`, `docs/webhooks.md`, and `AGENTS.md`; align the OpenAPI and Postman descriptions without changing response fields.

## Phase 3: Verification and handoff

**Purpose**: Validate the change, complete reviews, and hand off one focused PR.

- [x] T007 [US1] Run focused tests, safe local smoke checks, and the full `pnpm test`; verify clean-tree test behavior.
- [x] T008 [US1] Complete separate defect-first and Ponytail reviews; fix applicable findings and rerun required checks.
- [ ] T009 [US1] Create or update the issue-linked PR with `codex/gpt-6` and `codex-automation` attribution, verify the current-head preview and checks, then hand off for review.

## Dependencies and Execution Order

- T001 precedes all work and is complete.
- T002 and T003 precede T004 and T005; verify their expected failures before implementation.
- T004 and T005 precede T006 and verification.
- T007 and T008 precede PR creation and handoff in T009.

## Implementation Strategy

Deliver the single story in one focused increment. Preserve the existing API response contract and default, validate the shared runtime-config path, then document the operator setting and review the complete PR head.
