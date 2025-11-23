---

description: "Task list for feature 004-enrich-alert-output (Enrich Alert Output)"

---

# Tasks: Enrich Alert Output

**Input**: Design documents from `specs/004-enrich-alert-output/`
**Prerequisites**: `plan.md` (required), `spec.md` (required for user stories), `research.md`, `data-model.md`, `contracts/`

**Tests**: This feature explicitly requires unit tests for the new prompt and formatters, plus integration coverage for the webhook.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently once foundational work is complete.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no direct ordering dependency)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Every task description includes at least one concrete file path

## Path Conventions

- Backend source: `src/`
- Tests: `tests/`
- Feature design docs: `specs/004-enrich-alert-output/`

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm that existing Express, Gemini Grounding, and multi-channel notification infrastructure from features 001–003 is sufficient for this feature.

This repository is already initialized and wired for `/api/webhook/alert`, Gemini Grounding, Telegram, and WhatsApp. No additional setup tasks are required beyond the existing project configuration.

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Establish a shared, typed `EnrichedAlert` data model and keep contracts/docs aligned before implementing user stories.

- [ ] T001 [P] Update `EnrichedAlert` and `Source` interfaces in `src/controllers/webhooks/handlers/alert/types.ts` to match `specs/004-enrich-alert-output/data-model.md` (fields for `original_text`, `sentiment`, `insights`, `technical_levels`, and `sources`).
- [ ] T002 [P] Add matching `EnrichedAlert` and `Source` interfaces to `src/services/grounding/types.ts` so Gemini grounding and notification services share the same structured enriched alert data model.
- [ ] T003 Align the internal data contract example in `specs/004-enrich-alert-output/contracts/api.md` with the updated `EnrichedAlert` interfaces and reference it from JSDoc comments in `src/controllers/webhooks/handlers/alert/grounding.js`.

**Checkpoint**: The enriched alert data model is stable and shared between controllers, services, and documentation.

---

## Phase 3: User Story 1 - Receive Enriched Alert with Structured Insights (Priority: P1) 🎯 MVP

**Goal**: As a trader, receive alerts that include sentiment, key insights, technical levels, and verified sources so decisions can be made directly from the chat.

**Independent Test**: Send a sample alert like `"BTC broke 83k"` to `/api/webhook/alert` and verify the delivered Telegram/WhatsApp message contains clearly separated sections for Sentiment, Key Insights, Technical Levels, and Sources.

### Tests for User Story 1

> Write these tests before or alongside implementation; they should initially fail against the current code.

- [ ] T004 [P] [US1] Add unit tests for JSON-based enriched alert generation in `tests/unit/gemini-client.test.js` covering valid `EnrichedAlert` output, missing fields, and non-English alert text for `generateEnrichedAlert()` / `parseEnrichedAlertResponse()` in `src/services/grounding/gemini.js`.
- [ ] T005 [P] [US1] Add unit tests in `tests/unit/news-alert-formatting.test.js` asserting that `MarkdownV2Formatter.formatEnriched()` in `src/services/notification/formatters/markdownV2Formatter.js` renders sections for Sentiment, Key Insights, Technical Levels, and Sources from an `EnrichedAlert`.
- [ ] T006 [P] [US1] Extend WhatsApp enrichment tests in `tests/unit/whatsapp-formatter.test.js` for `WhatsAppMarkdownFormatter.formatEnriched()` in `src/services/notification/formatters/whatsappMarkdownFormatter.js` to verify Sentiment, Key Insights, Technical Levels, and Sources are rendered correctly with URL shortening.
- [ ] T007 [P] [US1] Extend integration coverage in `tests/integration/alert-grounding.test.js` so `POST /api/webhook/alert` returns `enriched: true` and mock Telegram messages (via `src/services/notification/TelegramService.js`) include all structured sections for a sample alert.

### Implementation for User Story 1

- [ ] T008 [US1] Implement `generateEnrichedAlert({ text, searchResults, searchResultText, options })` and a JSON-only `parseEnrichedAlertResponse()` helper in `src/services/grounding/gemini.js` using the `EnrichedAlert` schema from `specs/004-enrich-alert-output/data-model.md` (no Telegram/WhatsApp formatting inside the data object).
- [ ] T009 [US1] Update the grounding pipeline in `src/services/grounding/grounding.js` to call `generateEnrichedAlert()` after `genaiClient.search()` and return an `EnrichedAlert` object plus truncation flag while preserving existing timeout and metrics behaviour in `src/services/grounding/metrics.js`.
- [ ] T010 [US1] Refactor `enrichAlert()` in `src/controllers/webhooks/handlers/alert/grounding.js` to consume the new `groundAlert` `EnrichedAlert` result and map it into the `EnrichedAlert` interface from `src/controllers/webhooks/handlers/alert/types.ts` before attaching `alert.enriched`.
- [ ] T011 [US1] Update `MarkdownV2Formatter.formatEnriched()` in `src/services/notification/formatters/markdownV2Formatter.js` to format enriched alerts with sections for Sentiment (emoji + label), Key Insights (bullet list), Technical Levels (supports/resistances), and Sources (markdown links), starting from `EnrichedAlert.original_text`.
- [ ] T012 [US1] Update `WhatsAppMarkdownFormatter.formatEnriched()` in `src/services/notification/formatters/whatsappMarkdownFormatter.js` to render the same enriched sections for WhatsApp text, converting from MarkdownV2 escapes and reusing URL shortener integration.
- [ ] T013 [US1] Verify and, if needed, adjust alert sending paths in `src/services/notification/TelegramService.js` and `src/services/notification/WhatsAppService.js` so they continue to call `formatter.formatEnriched(alert.enriched)` for structured alerts and `formatter.format(alert.text)` for plain alerts without breaking existing behaviour.

**Checkpoint**: User Story 1 is complete when `/api/webhook/alert` produces an `alert.enriched` object with sentiment, insights, technical levels, and sources, and both Telegram and WhatsApp messages render these sections correctly.

---

## Phase 4: User Story 2 - Graceful Fallback for Analysis Failure (Priority: P2)

**Goal**: As a system administrator, ensure the system delivers a standard alert even when the structured AI analysis fails, so no alerts are lost due to parsing or timeout errors.

**Independent Test**: Mock the Gemini API to return malformed JSON or trigger a timeout and verify that `/api/webhook/alert` still responds with `success: true`, `enriched: false`, and that Telegram/WhatsApp receive a basic alert message.

### Tests for User Story 2

- [ ] T014 [P] [US2] Extend `generateEnrichedAlert()` error-path tests in `tests/unit/gemini-client.test.js` to cover malformed JSON, missing required fields, and overly long responses, asserting that `parseEnrichedAlertResponse()` in `src/services/grounding/gemini.js` signals errors suitable for fallback.
- [ ] T015 [P] [US2] Add unit tests in `tests/unit/alert-handler.test.js` for `enrichAlert()` in `src/controllers/webhooks/handlers/alert/grounding.js` and `postAlert()` in `src/controllers/webhooks/handlers/alert/alert.js` to verify `enriched: false` and successful delivery when enrichment throws.
- [ ] T016 [P] [US2] Extend failure-path scenarios in `tests/integration/alert-grounding.test.js` (search failure, timeout) to also simulate invalid Gemini JSON and confirm that `POST /api/webhook/alert` still returns `{ success: true, enriched: false }` and delivers alerts to Telegram.
- [ ] T017 [P] [US2] Add edge case tests in `tests/unit/news-alert-formatting.test.js` and `tests/unit/whatsapp-formatter.test.js` to ensure `formatEnriched()` in both formatters handles `EnrichedAlert` objects with empty `insights`, missing `technical_levels`, or no `sources` without throwing.

### Implementation for User Story 2

- [ ] T018 [US2] Harden `parseEnrichedAlertResponse()` in `src/services/grounding/gemini.js` to detect invalid or incomplete `EnrichedAlert` JSON and throw descriptive errors or return safe defaults (e.g., `NEUTRAL` sentiment, empty `insights`) per `specs/004-enrich-alert-output/spec.md` Edge Cases.
- [ ] T019 [US2] Update `enrichAlert()` in `src/controllers/webhooks/handlers/alert/grounding.js` to catch Gemini parsing/generation errors and either propagate a generic `"Alert enrichment failed"` error or downgrade to a minimal `EnrichedAlert` while logging the root cause.
- [ ] T020 [US2] Ensure `postAlert()` in `src/controllers/webhooks/handlers/alert/alert.js` preserves fail-open behaviour by keeping `enriched = false` and still calling `notificationManager.sendToAll(alert)` whenever `enrichAlert()` fails (validation errors, timeouts, JSON parsing issues).
- [ ] T021 [US2] Document fallback behaviour for malformed JSON, timeouts, very short alerts, and non-English alerts in `specs/004-enrich-alert-output/spec.md` and `specs/004-enrich-alert-output/quickstart.md`, aligning with User Story 2 acceptance scenarios.

**Checkpoint**: User Story 2 is complete when all enrichment failures (model error, malformed JSON, timeout, invalid input) still result in alerts being delivered with `enriched: false` and no user-visible errors.

---

## Phase 5: Polish & Cross-Cutting Concerns

**Purpose**: Finalize performance monitoring, documentation, and repository-wide regression checks.

- [ ] T022 [P] Add or update enrichment performance logging in `src/services/grounding/metrics.js` and `src/services/grounding/grounding.js` to record per-alert enrichment duration and failures so SC-004 (no more than ~2s additional latency) can be monitored.
- [ ] T023 [P] Run focused Jest suites for enrichment code paths using scripts in `package.json` against `tests/unit/gemini-client.test.js`, `tests/unit/alert-handler.test.js`, `tests/unit/news-alert-formatting.test.js`, `tests/unit/whatsapp-formatter.test.js`, and `tests/integration/alert-grounding.test.js`, fixing any regressions surfaced.
- [ ] T024 [P] Update enriched alert examples in `specs/004-enrich-alert-output/quickstart.md` to match the final Telegram and WhatsApp message structure produced by `MarkdownV2Formatter` and `WhatsAppMarkdownFormatter`.
- [ ] T025 [P] Update the root `README.md` features section to describe the `EnrichedAlert` fields and how `/api/webhook/alert` uses Gemini Grounding to produce Sentiment, Key Insights, Technical Levels, and Sources.
- [ ] T026 Execute the full test suite (`npm test` via `package.json`) to confirm `001-gemini-grounding-alert`, `002-whatsapp-alerts`, `003-news-monitor`, and `004-enrich-alert-output` features all pass unit and integration tests after enrichment changes.

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No new work; existing project infrastructure is reused.
- **Foundational (Phase 2)**: Must be completed before User Story 1 and User Story 2 (shared `EnrichedAlert` data model and contract alignment).
- **User Story 1 (Phase 3, P1)**: Can start after Phase 2 is complete; delivers the MVP enriched alert experience.
- **User Story 2 (Phase 4, P2)**: Depends on Phase 2 and the core enrichment flow from User Story 1; adds robustness and fallback handling.
- **Polish (Phase 5)**: Runs after the desired user stories (at least US1 + US2) are implemented.

### User Story Dependencies

- **US1 (P1)**: Depends on the shared `EnrichedAlert` types and contracts from Phase 2; otherwise independent.
- **US2 (P2)**: Builds on US1’s enrichment pipeline to add error handling and fallbacks; should follow US1.

### Within Each User Story

- Tests (T004–T007 for US1, T014–T017 for US2) should be written before or together with implementation tasks so they initially fail against the current code.
- For US1, prefer order: `types & contracts (T001–T003) → Gemini generation (T008–T010) → formatters (T011–T012) → services wiring (T013) → integration tests (T007)`.
- For US2, prefer order: `Gemini error handling (T018) → enrichAlert/postAlert fail-open logic (T019–T020) → docs (T021) → integration failure-path tests (T016)`.

### Parallel Opportunities

- **Foundational**: T001 and T002 can run in parallel (different TypeScript type files), followed by T003 for docs.
- **User Story 1**:
  - Test tasks T004–T007 can be developed in parallel across different test files (`tests/unit/gemini-client.test.js`, `tests/unit/news-alert-formatting.test.js`, `tests/unit/whatsapp-formatter.test.js`, `tests/integration/alert-grounding.test.js`).
  - Implementation tasks T011 and T012 can proceed in parallel once `EnrichedAlert` generation (T008–T010) is in place, since they touch separate formatter files.
- **User Story 2**:
  - Test tasks T014–T017 can be split by file (Gemini tests vs alert handler vs formatter edge cases).
- **Polish**:
  - T022–T025 are largely independent and can be executed in parallel by different contributors.

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 2 (Foundational) to stabilize the `EnrichedAlert` data model and contracts.
2. Implement and validate User Story 1 (T004–T013): end-to-end enriched alerts with Sentiment, Key Insights, Technical Levels, and Sources on Telegram and WhatsApp.
3. Stop and validate: run focused tests from T023 and verify the example in `specs/004-enrich-alert-output/quickstart.md` matches actual output.
4. Optionally deploy/demo the enriched alerts as an MVP.

### Incremental Delivery

1. **Iteration 1**: Phases 2 + 3 (US1) → traders receive enriched alerts with structured insights.
2. **Iteration 2**: Phase 4 (US2) → system becomes robust to Gemini failures while keeping enriched behaviour from US1.
3. **Iteration 3**: Phase 5 (Polish) → performance monitoring, documentation, and full regression test run.

### Parallel Team Strategy

- Developer A: Focus on Gemini generation and parsing (`src/services/grounding/gemini.js`, `src/services/grounding/grounding.js`, tests in `tests/unit/gemini-client.test.js`).
- Developer B: Implement and test Telegram/WhatsApp formatting (`src/services/notification/formatters/*.js`, `tests/unit/news-alert-formatting.test.js`, `tests/unit/whatsapp-formatter.test.js`).
- Developer C: Own end-to-end integration and fail-open behaviour (`src/controllers/webhooks/handlers/alert/*.js`, `tests/unit/alert-handler.test.js`, `tests/integration/alert-grounding.test.js`).

Each user story remains independently testable: US1 delivers structured enriched alerts; US2 ensures alerts are still delivered when enrichment fails, and the Polish phase closes the loop with performance and documentation.
