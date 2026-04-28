# Feature Tasks: Gemini Grounding Alert

**Feature Name**: Gemini Grounding Alert Feature
**Feature Branch**: `001-gemini-grounding-alert`

> NOTE: Implementation MUST use the official `@google/genai` package's googleSearch groundingTool to collect search results and provide grounding context to Gemini. Do NOT implement a custom web search client or `searchapi` client as part of this feature.

## Phase 1: Setup

**Goal**: Initialize the project environment and install necessary dependencies.

- [ ] T001 Install `@google/genai` dependency: `npm install @google/genai`
- [ ] T002 Create `src/controllers/webhooks/handlers/alert/types.ts` for type definitions
- [ ] T003 Create `src/services/grounding/types.ts` for shared grounding types
- [ ] T004 Create `src/lib/validation.js` for input validation helpers (FR-012)

## Phase 2: Foundational

**Goal**: Implement core services that are prerequisites for all user stories.

- [ ] T005 Create `src/services/grounding/gemini.js` wrapper that calls `genai` to produce a concise summary given original text + grounded context and returns normalized `{ summary, citations }`. File: `src/services/grounding/gemini.js` (FR-001, FR-011)
  - Acceptance: Given Alert + GroundedContext, returns a `GeminiResponse` with `summary` (<=250 chars or <=3 sentences) and `citations` array of `SearchResult` (max `GROUNDING_MAX_SOURCES`). Unit tests must mock genai and assert shape.
- [ ] T006 Implement `src/services/grounding/genaiClient.js` to initialize and expose a small wrapper around `src/services/grounding/gemini.js` (googleSearch and Gemini calls). This wrapper will be the single integration point for `genai` usage (do NOT implement a separate custom web search client). File: `src/services/grounding/genaiClient.js` (FR-001, FR-004)
  - Acceptance: Expose `search(query, opts)` and `llmCall(prompt, context, opts)` functions. `search` normalizes `SearchResult[]`, enforces `GROUNDING_MAX_SOURCES`, and returns within `GROUNDING_TIMEOUT_MS` (or rejects). Unit tests must stub `@google/genai` and verify normalization and timeout handling.
- [ ] T007 Implement basic Gemini text generation functionality in `src/services/grounding/gemini.js` that accepts context and `GEMINI_SYSTEM_PROMPT` and returns {summary, citations}. File: `src/services/grounding/gemini.js` (FR-001)
  - Acceptance: Given a composed prompt and `GroundedContext`, returns `GeminiResponse.summary` (<=250 chars or <=3 sentences) and `citations` referencing provided `SearchResult` objects. Add unit tests to verify trimming and language-preservation behavior.
- [ ] T008 Create `src/services/grounding/grounding.js` orchestrator that combines Gemini calls and optional search (if another provider is added in the future) with timeout handling (respect `GROUNDING_TIMEOUT_MS`). File: `src/services/grounding/grounding.js` (FR-001, FR-003, FR-004)
  - Acceptance: Derives query (via configured prompt), calls `genaiClient.search`, calls `gemini`/`genaiClient.llmCall`, enforces `GROUNDING_TIMEOUT_MS` and returns normalized `GeminiResponse`. On timeout/error it returns a clear error that `alert.js` can use to fallback. Integration tests should simulate timeouts and errors.

## Phase 3: User Story 1 - Enriquecer alertas con contexto verificado (P1)

**Story Goal**: The bot enriches incoming webhook alerts with a contextual summary and verified sources from Gemini and Google Search, delivering this enhanced content to Telegram chat recipients.

**Independent Test Criteria**: Send a POST request to `/api/webhook/alert` with a text body. Verify that the Telegram message contains: (a) a generated summary, (b) a list of sources/URLs, and (c) the original or an enriched version of the alert.

- [ ] T009 [US1] Create `src/controllers/webhooks/handlers/alert/grounding.js` for grounding service integration
- [ ] T010 [US1] Implement `deriveSearchQuery` function in `src/controllers/webhooks/handlers/alert/grounding.js` (FR-011)
- [ ] T011 [US1] Integrate `src/services/grounding/gemini.js` into the grounding flow (`src/services/grounding/grounding.js` to fetch search results and return normalized `SearchResult[]` (FR-001)
- [ ] T012 [US1] Integrate Gemini API client (`src/services/grounding/gemini.js`) into `src/controllers/webhooks/handlers/alert/grounding.js` to generate summary with grounding (FR-001)
- [ ] T013 [US1] Modify `src/controllers/webhooks/handlers/alert/alert.js` to call the new grounding service (FR-001)
- [ ] T014 [US1] Implement logic in `src/controllers/webhooks/handlers/alert/alert.js` to append enriched content (summary + sources) after the original alert text in the Telegram message (FR-009)
- [ ] T015 [US1] Implement logic in `src/controllers/webhooks/handlers/alert/alert.js` to include short citation (title/snippet) and URL for each source in the Telegram message (FR-002)
- [ ] T016 [US1] Implement fallback mechanism in `src/controllers/webhooks/handlers/alert/alert.js` to send original text with a note if grounding fails (FR-003)
- [ ] T017 [US1] Create integration tests for alert grounding in `tests/integration/alert-grounding.test.js` (SC-001, SC-002, SC-003) (FR-001, FR-002, FR-003)
  - Acceptance: Tests exercise a full POST /api/webhook/alert flow with mocked `genai` responses: (1) successful enrichment with >=1 citation and message formatting asserts, (2) timeout/failure -> fallback original text, (3) respects `GROUNDING_MAX_SOURCES` and `GROUNDING_TIMEOUT_MS`.
- [ ] T018 [US1] Create unit tests for `src/controllers/webhooks/handlers/alert/grounding.js` in `tests/unit/alert-handler.test.js` (FR-011)
  - Acceptance: Unit tests validate `deriveSearchQuery` behavior, prompt usage, and edge cases (empty input, very long input, non-English), asserting returned query strings and error handling.

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
- [ ] T023 [US3] Implement environment variable `GROUNDING_MAX_SOURCES` for maximum search results and wire it into grounding flow (default: 3). File: `src/services/grounding/config.js` and `src/services/grounding/grounding.js` (FR-004, FR-007)
- [ ] T024 [US3] Implement environment variable `GROUNDING_TIMEOUT_MS` for grounding timeout and enforce it in the orchestrator (default: 8000 ms). File: `src/services/grounding/config.js` and `src/services/grounding/grounding.js` (FR-004, SC-002)
- [ ] T025 [US3] Implement safe default behavior if grounding credentials or configuration are missing (FR-006)
- [ ] T026 [US3] Update integration tests in `tests/integration/alert-grounding.test.js` to cover `ENABLE_GEMINI_GROUNDING=false` scenario (FR-004)
  - Acceptance: When `ENABLE_GEMINI_GROUNDING=false`, the handler forwards original text and does not call `genaiClient.search` or `llmCall` (mock assertions).

- [ ] T033 [US1] Implement prompt configuration and validation: ensure `GEMINI_SYSTEM_PROMPT` (or `SEARCH_QUERY_PROMPT`) is loadable from env/config and validated by `src/services/grounding/config.js`; add a small test verifying the prompt is used to derive queries. File: `src/services/grounding/config.js`, `tests/unit/prompt-config.test.js` (FR-011)

- [ ] T034 [P] Add simple instrumentation for grounding: record basic metrics (latency, success/failure counts) via console structured logs and a small metrics helper `src/services/grounding/metrics.js`; add tests to assert timeout metric emission. File: `src/services/grounding/metrics.js`, `tests/unit/metrics.test.js` (SC-002, SC-001)

## Phase 6: Polish & Cross-Cutting Concerns

**Goal**: Address remaining functional requirements, edge cases, logging, and overall code quality.

- [ ] T027 Implement logging (console) for steps and errors in `src/controllers/webhooks/handlers/alert/grounding.js` and `src/controllers/webhooks/handlers/alert/alert.js` (FR-005)
- [ ] T028 Implement filtering of out-of-scope content before sending to external APIs (FR-010)
- [ ] T029 Handle very long alerts (> 4000 characters) by truncating or summarizing before sending to search/LLM (FR-010, FR-001)
  - Acceptance: Input >4000 chars is truncated/summarized before external calls; unit tests assert truncation and that final Telegram message includes a notice when truncation occurred.
- [ ] T030 Handle content in languages other than English, requesting Gemini to respond in the same language if possible (FR-001)
  - Acceptance: When input language detection indicates non-English, the prompt instructs Gemini to respond in the same language; tests assert language preservation for a sample non-English input.
- [ ] T031 Filter duplicate or inaccessible sources (HTTP 403/404) and report effective sources (FR-002)
  - Acceptance: The orchestrator filters duplicates and inaccessible URLs; returned `citations` only contain valid, reachable URLs (or are excluded) and a metric/log is emitted indicating filtered counts.
- [ ] T032 Create unit tests for `src/services/grounding/gemini.js` in `tests/unit/gemini-client.test.js` (FR-001, FR-011)
  - Acceptance: Unit tests mock `genaiClient` and verify `gemini.js` composes prompts correctly, enforces summary length, preserves language, and maps citations into the canonical `SearchResult` shape.

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
  - T011 [P] Integrate `genaiClient` usage into the grounding flow (`src/services/grounding/grounding.js`) to fetch search results and evidence
  - T012 [P] Integrate Gemini wrapper (`src/services/grounding/gemini.js`) into the grounding flow to produce summaries using grounded context

- **User Story 3**:
  - T022 [P] Implement `ENABLE_GEMINI_GROUNDING` check in `src/controllers/webhooks/handlers/alert/alert.js`
  - T023 [P] Implement `MAX_SEARCH_RESULTS` env var in `src/controllers/webhooks/handlers/alert/grounding.js`

## Implementation Strategy

The implementation will follow an MVP-first approach, focusing on delivering User Story 1 as a complete, independently testable increment. Subsequent user stories will be built on this foundation, ensuring continuous value delivery and ease of testing. Cross-cutting concerns like comprehensive logging and edge case handling will be addressed in the final polish phase.

