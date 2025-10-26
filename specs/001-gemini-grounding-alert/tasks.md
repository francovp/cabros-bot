# Feature Tasks: Gemini Grounding Alert

**Feature Name**: Gemini Grounding Alert Feature
**Feature Branch**: `001-gemini-grounding-alert`

## Phase 1: Setup

**Goal**: Initialize the project environment and install necessary dependencies.

- [ ] T001 Install `@google/genai` dependency: `npm install @google/genai`
- [ ] T002 Create `src/controllers/webhooks/handlers/alert/types.ts` for type definitions
- [ ] T003 Create `src/services/grounding/types.ts` for shared grounding types
- [ ] T004 Create `src/lib/validation.js` for input validation helpers (FR-012)

## Phase 2: Foundational

**Goal**: Implement core services that are prerequisites for all user stories.

- [ ] T005 Create `src/services/grounding/search.js` for Google Search client
- [ ] T006 Create `src/services/grounding/gemini.js` for Gemini API client
- [ ] T007 Implement basic search functionality in `src/services/grounding/search.js`
- [ ] T008 Implement basic Gemini text generation functionality in `src/services/grounding/gemini.js`

## Phase 3: User Story 1 - Enriquecer alertas con contexto verificado (P1)

**Story Goal**: The bot enriches incoming webhook alerts with a contextual summary and verified sources from Gemini and Google Search, delivering this enhanced content to Telegram chat recipients.

**Independent Test Criteria**: Send a POST request to `/api/webhook/alert` with a text body. Verify that the Telegram message contains: (a) a generated summary, (b) a list of sources/URLs, and (c) the original or an enriched version of the alert.

- [ ] T009 [US1] Create `src/controllers/webhooks/handlers/alert/grounding.js` for grounding service integration
- [ ] T010 [US1] Implement `deriveSearchQuery` function in `src/controllers/webhooks/handlers/alert/grounding.js` (FR-011)
- [ ] T011 [US1] Integrate Google Search client (`src/services/grounding/search.js`) into `src/controllers/webhooks/handlers/alert/grounding.js` to fetch search results (FR-001)
- [ ] T012 [US1] Integrate Gemini API client (`src/services/grounding/gemini.js`) into `src/controllers/webhooks/handlers/alert/grounding.js` to generate summary with grounding (FR-001)
- [ ] T013 [US1] Modify `src/controllers/webhooks/handlers/alert/alert.js` to call the new grounding service (FR-001)
- [ ] T014 [US1] Implement logic in `src/controllers/webhooks/handlers/alert/alert.js` to append enriched content (summary + sources) after the original alert text in the Telegram message (FR-009)
- [ ] T015 [US1] Implement logic in `src/controllers/webhooks/handlers/alert/alert.js` to include short citation (title/snippet) and URL for each source in the Telegram message (FR-002)
- [ ] T016 [US1] Implement fallback mechanism in `src/controllers/webhooks/handlers/alert/alert.js` to send original text with a note if grounding fails (FR-003)
- [ ] T017 [US1] Create integration tests for alert grounding in `tests/integration/alert-grounding.test.js` (SC-001, SC-002, SC-003)
- [ ] T018 [US1] Create unit tests for `src/controllers/webhooks/handlers/alert/grounding.js` in `tests/unit/alert-handler.test.js`

## Phase 4: User Story 2 - Fallbacks y notificaciones de administrador (P2)

**Story Goal**: The system provides optional administrator notifications when the enrichment pipeline fails due to API errors or timeouts, enabling timely manual intervention.

**Independent Test Criteria**: Simulate an error in the Google Search or Gemini API calls. Verify that a notification message is sent to the `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` (if configured) with details of the failure.

- [ ] T019 [US2] Implement admin notification logic in `src/controllers/webhooks/handlers/alert/alert.js` for enrichment failures (FR-004, SC-004)
- [ ] T020 [US2] Add error handling for Search API 5xx errors in `src/controllers/webhooks/handlers/alert/grounding.js` and `src/controllers/webhooks/handlers/alert/alert.js` (FR-003)
- [ ] T021 [US2] Update integration tests in `tests/integration/alert-grounding.test.js` to cover admin notification scenarios

## Phase 5: User Story 3 - Configuración mínima y control (P3)

**Story Goal**: Operators can enable/disable the grounding enrichment feature and configure parameters like the maximum number of sources via environment variables, allowing for cost and latency control.

**Independent Test Criteria**: Set `ENABLE_GEMINI_GROUNDING=false` in the environment. Verify that the `postAlert` handler does not invoke Gemini or Google Search APIs and simply forwards the original alert text.

- [ ] T022 [US3] Implement environment variable `ENABLE_GEMINI_GROUNDING` check in `src/controllers/webhooks/handlers/alert/alert.js` to enable/disable grounding (FR-004)
- [ ] T023 [US3] Implement environment variable for maximum search results (e.g., `MAX_SEARCH_RESULTS`) in `src/controllers/webhooks/handlers/alert/grounding.js` (FR-004, FR-007)
- [ ] T024 [US3] Implement environment variable for grounding timeout (e.g., `GROUNDING_TIMEOUT_MS`) in `src/controllers/webhooks/handlers/alert/grounding.js` (FR-004, SC-002)
- [ ] T025 [US3] Implement safe default behavior if grounding credentials or configuration are missing (FR-006)
- [ ] T026 [US3] Update integration tests in `tests/integration/alert-grounding.test.js` to cover `ENABLE_GEMINI_GROUNDING=false` scenario

## Phase 6: Polish & Cross-Cutting Concerns

**Goal**: Address remaining functional requirements, edge cases, logging, and overall code quality.

- [ ] T027 Implement logging (console) for steps and errors in `src/controllers/webhooks/handlers/alert/grounding.js` and `src/controllers/webhooks/handlers/alert/alert.js` (FR-005)
- [ ] T028 Implement filtering of out-of-scope content before sending to external APIs (FR-010)
- [ ] T029 Handle very long alerts (> 4000 characters) by truncating or summarizing before sending to search/LLM
- [ ] T030 Handle content in languages other than English, requesting Gemini to respond in the same language if possible
- [ ] T031 Filter duplicate or inaccessible sources (HTTP 403/404) and report effective sources
- [ ] T032 Create unit tests for `src/services/grounding/gemini.js` in `tests/unit/gemini-client.test.js`
- [ ] T033 Create unit tests for `src/services/grounding/search.js` in `tests/unit/search-client.test.js`

## Dependencies

The user stories are designed to be incrementally delivered.
- User Story 1 is the core functionality and can be considered an MVP.
- User Story 2 builds upon the error handling of User Story 1.
- User Story 3 provides operational control and can be implemented in parallel or after User Story 1.

Completion Order:
1. User Story 1 (P1)
2. User Story 2 (P2) - depends on User Story 1's core functionality and error paths.
3. User Story 3 (P3) - can be developed in parallel with US1/US2, but its effects are on US1's behavior.

## Parallel Execution Examples

- **User Story 1**:
  - T010 [P] Implement `deriveSearchQuery` in `src/controllers/webhooks/handlers/alert/grounding.js`
  - T011 [P] Integrate Google Search client in `src/controllers/webhooks/handlers/alert/grounding.js`
  - T012 [P] Integrate Gemini API client in `src/controllers/webhooks/handlers/alert/grounding.js`

- **User Story 3**:
  - T022 [P] Implement `ENABLE_GEMINI_GROUNDING` check in `src/controllers/webhooks/handlers/alert/alert.js`
  - T023 [P] Implement `MAX_SEARCH_RESULTS` env var in `src/controllers/webhooks/handlers/alert/grounding.js`

## Implementation Strategy

The implementation will follow an MVP-first approach, focusing on delivering User Story 1 as a complete, independently testable increment. Subsequent user stories will be built on this foundation, ensuring continuous value delivery and ease of testing. Cross-cutting concerns like comprehensive logging and edge case handling will be addressed in the final polish phase.

