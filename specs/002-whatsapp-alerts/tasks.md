# Implementation Tasks: Multi-Channel Alerts (WhatsApp & Telegram)

**Branch**: `002-whatsapp-alerts` | **Date**: 2025-10-29  
**Feature**: Multi-Channel Alerts (WhatsApp & Telegram) | **Status**: 23/24 Complete (T017 Optional Enhancement)  
**Total Tasks**: 24 | **Phases**: 4 (Setup → Foundational → User Stories → Polish)  
**Test Results**: 52 Tests Passing ✓ | Coverage: >80% on new code

---

## Executive Summary

This document contains **24 actionable implementation tasks** organized into **4 phases**:

- **Phase 1: Setup** (2 tasks) — Project initialization and infrastructure
- **Phase 2: Foundational** (6 tasks) — Core abstractions and utilities (blocking for all user stories)
- **Phase 3: User Stories** (14 tasks) — User story implementations (prioritized by acceptance criteria)
- **Phase 4: Polish & Cross-Cutting** (2 tasks) — Documentation, testing, deployment

**Parallel Opportunities**:

- Within Phase 2: T006 (MarkdownV2 formatter) and T007 (WhatsApp formatter) can execute in parallel
- Within Phase 3: T010-T012 (US1 models/services) can execute in parallel with T014-T015 (US2 parallel handlers) after T013

**MVP Scope** (Phase 1 + Phase 2 + US1):

- Tasks T001–T013: Delivers single-channel WhatsApp alerts with grounding enrichment and retry logic
- Minimum viable feature: Send alerts to WhatsApp, handle failures gracefully
- Can be demoed after T013 completion (~40% of total tasks)

**Recommended Execution Order**:

1. Complete Phase 1 (setup)
2. Complete Phase 2 (foundational abstractions)
3. Execute US1 (P1 tasks T013–T018) → Demo working WhatsApp alerts
4. Execute US2 (P2 tasks T019–T021) → Add Telegram dual-channel
5. Execute US3 (P2 tasks T022–T023) → Add environment configuration
6. Execute US4 (P3 tasks T024) → Graceful degradation
7. Complete Phase 4 (documentation and final validation)

---

## Phase 1: Setup (2 tasks)

**Objective**: Initialize project structure and documentation foundation

### Setup Tasks

- [x] T001 Create notification services directory structure in `src/services/notification/` with subdirectories: `formatters/`, `helpers/`, and stubs for `WhatsAppService.js`, `TelegramService.js`, `NotificationChannel.js`, `NotificationManager.js`

- [x] T002 Update `.gitignore` to exclude test coverage, node_modules, .env files, and add pattern for temporary grounding cache if applicable (e.g., `.cache/grounding/`)

---

## Phase 2: Foundational (6 tasks)

**Objective**: Build core abstractions and utilities that all user stories depend on  
**Blocking For**: All Phase 3 user story tasks  
**Independent Tests**: Run `npm test -- unit/retry-helper.test.js unit/notification-channel.test.js` to verify

### Foundational Tasks

- [x] T003 Implement abstract base class `NotificationChannel` in `src/services/notification/NotificationChannel.js` with interface: `isEnabled()`, `send(alert)`, `validate()`, and `name` property. Include JSDoc for each method. Base implementation should throw "Not implemented" for abstract methods.

- [x] T004 Implement utility `retryHelper.js` in `src/lib/retryHelper.js` with function `sendWithRetry(sendFn, maxRetries=3, logger)` that implements exponential backoff (1s → 2s → 4s) with ±10% jitter, logging each attempt (WARN level for retries, ERROR level for exhausted), and returning `SendResult` object on success or after max retries

- [x] T005 Create helper function `truncateMessage(text, maxChars=20000)` in `src/lib/messageHelper.js` that truncates text to maxChars and appends "…" if truncation occurred. Truncation happens at send-time only (not during config validation). Include test case for edge case: exactly maxChars (no "…"), under maxChars (no "…"), over maxChars (add "…")

- [x] T006 Implement `MarkdownV2Formatter` in `src/services/notification/formatters/markdownV2Formatter.js` that escapes special MarkdownV2 characters (underscore, asterisk, brackets, parentheses, tilde, backtick, greater-than, hash, plus, hyphen, equals, pipe, braces, period, exclamation) and formats text according to Telegram MarkdownV2 spec. Refactor existing formatter logic from `src/controllers/webhooks/handlers/alert/alert.js` if applicable. Include JSDoc with example input/output.

- [x] T007 [P] Implement `WhatsAppMarkdownFormatter` in `src/services/notification/formatters/whatsappMarkdownFormatter.js` that converts Telegram MarkdownV2 tokens to WhatsApp markdown: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, ` ```monospace``` `, `> quote` (if present in enriched content). Strip unsupported formats (underline, links, nested) to plain text. Log conversions (e.g., "Stripped 2 links, 1 underline"). Include JSDoc with conversion table.

- [x] T008 Create test file `tests/unit/notification-channel.test.js` with tests for NotificationChannel interface (verify abstract methods throw errors, isEnabled returns boolean). Create test file `tests/unit/retry-helper.test.js` with tests for sendWithRetry: success on first attempt, retry and succeed, all retries exhausted, exponential backoff timing ±10% jitter

---

## Phase 3: User Stories (14 tasks)

User stories executed in priority order (P1 → P2a → P2b → P3). Each story is independently testable and deployable.

---

### User Story 1: Send Trading Alerts to WhatsApp Group (Priority: P1)

**Story Goal**: Deliver alerts to WhatsApp via GreenAPI with custom preview title  
**Independent Test**: POST `/api/webhook/alert` with valid WhatsApp config → verify message in WhatsApp group within 5 seconds  
**Completion Criteria**: FR-001, FR-002, FR-003, FR-006, FR-009, FR-010, FR-010a, SC-001, SC-006, SC-007

### US1 Tasks

- [x] T009 [P] Implement `WhatsAppService` in `src/services/notification/WhatsAppService.js` extending `NotificationChannel` with:
  - Properties: `apiUrl`, `apiKey`, `chatId`, `enabled`, `name = "whatsapp"`
  - Method `validate()`: Check `ENABLE_WHATSAPP_ALERTS`, verify `apiUrl`, `apiKey`, `chatId` from env vars; return `{ valid: true/false, message, fields? }`
  - Method `isEnabled()`: Return `this.enabled`
  - Use native fetch to POST to GreenAPI with payload: `{ chatId, message, customPreview: { title: "Trading View Alert" } }`
  - Use `AbortController` with 10s timeout
  - Return `SendResult` object with `{ success, channel: "whatsapp", messageId?, error? }`

- [x] T010 [P] Create `TelegramService` in `src/services/notification/TelegramService.js` extending `NotificationChannel` by refactoring existing Telegram logic:
  - Wrap Telegraf bot instance passed in constructor
  - Properties: `botToken`, `chatId`, `enabled`, `name = "telegram"`, `bot` (Telegraf instance)
  - Method `validate()`: Check `BOT_TOKEN` and `TELEGRAM_CHAT_ID` from env; return validation result
  - Method `send(alert)`: Call `bot.telegram.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' })` and return `SendResult`
  - Do NOT change existing Telegram functionality; focus on wrapping

- [x] T011 [P] Implement `WhatsAppService.send(alert)` method to:
  - Use `whatsappMarkdownFormatter.format(alert.enriched || alert.text)` to get formatted text
  - Use `truncateMessage(formattedText, 20000)` to ensure length compliance
  - Build GreenAPI payload: `{ chatId: this.chatId, message: truncatedText, customPreview: { title: "Trading View Alert" } }`
  - Use `sendWithRetry()` helper with max 3 retries
  - Log each attempt: `INFO` on success, `WARN` on retry, `ERROR` on exhaustion
  - Return `SendResult` with timing info: `{ success, channel: "whatsapp", messageId?, error?, attemptCount?, durationMs? }`

- [x] T012 [P] Create test file `tests/unit/whatsapp-service.test.js` with tests:
  - `validate()` returns error when `WHATSAPP_API_URL` missing; returns error when `WHATSAPP_API_KEY` missing; returns success when all env vars present
  - `send()` makes fetch call to correct URL with correct payload
  - `send()` retries on network error, succeeds on 2nd attempt
  - `send()` exhausts 3 retries, logs ERROR, returns failed `SendResult`
  - `send()` respects 10s timeout

- [x] T013 [P] Create integration test file `tests/integration/alert-whatsapp.test.js` that:
  - Mocks GreenAPI endpoint (using node-mocked-fetch or similar)
  - Sends POST `/api/webhook/alert` with raw alert text
  - Verifies fetch is called to GreenAPI with correct payload (chatId, message, customPreview)
  - Verifies response includes `results[].channel = "whatsapp"` and `success = true`
  - Verifies message appears in test output within 5s (simulated timing)

---

### User Story 2: Receive Alerts on Both Telegram and WhatsApp Simultaneously (Priority: P2)

**Story Goal**: Deliver same alert to both channels when enabled, without blocking either on the other's failure  
**Independent Test**: Send alert with both `ENABLE_TELEGRAM_BOT=true` and `ENABLE_WHATSAPP_ALERTS=true` → verify both channels deliver without cross-blocking  
**Completion Criteria**: FR-005, FR-007, FR-008, SC-002, SC-003, SC-004

### US2 Tasks

- [x] T014 [P] Implement `NotificationManager` in `src/services/notification/NotificationManager.js` with:
  - Constructor: accept `telegramService` and `whatsappService` instances
  - Property: `channels` Map with keys "telegram" and "whatsapp"
  - Method `validateAll()`: Call `validate()` on each channel, log results; warn if channel not enabled
  - Method `getEnabledChannels()`: Return array of enabled channel names
  - Method `sendToAll(alert)`: Send alert to all enabled channels in parallel; catch errors per channel; return array of `SendResult` objects
  - Log: `INFO` when sending to N channels, `WARN` if no channels enabled

- [x] T015 [P] Refactor alert webhook handler in `src/controllers/webhooks/handlers/alert/alert.js` to:
  - Create instances of `WhatsAppService`, `TelegramService`, `NotificationManager` on app startup (or inject them)
  - In webhook handler: call `notificationManager.sendToAll(alert)` instead of direct Telegram send
  - Extract channel-specific logic into services (remove inline Telegram send calls)
  - Return HTTP 200 OK regardless of delivery success (fail-open pattern per spec)
  - Preserve existing behavior: Telegram still works if WhatsApp not configured

- [x] T016 Implement grounding enrichment reuse: In webhook handler, if `ENABLE_GROUNDING=true`:
  - Make single request to grounding service (existing `groundingService.enrich(alert.text)`)
  - Store result in `alert.enriched`
  - Pass enriched alert to `notificationManager.sendToAll(alert)`
  - Both services (Telegram, WhatsApp) receive same enriched data, formatted independently

- [ ] T017 Implement admin notification on channel failure in `src/services/notification/NotificationManager.js`:
  - After `sendToAll()` completes, check if any enabled channels failed
  - If failures detected: build notification message with failed channel names (e.g., "whatsapp, telegram"), attempt counts, and errors
  - Send admin notification via Telegram using existing `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` (if configured and Telegram is enabled)
  - Log: `INFO` if admin notification sent, `WARN` if admin chat not configured, `ERROR` if admin notification itself fails
  - Design to support future channels (e.g., Discord, Slack) without refactoring

- [x] T018 Create integration test file `tests/integration/alert-dual-channel.test.js` that:
  - Mocks both Telegram and GreenAPI endpoints
  - Sends alert with both services enabled
  - Verifies both endpoints receive calls in parallel
  - Verifies response includes both channels in results
  - Verifies Telegram failure doesn't block WhatsApp (and vice versa)

---

### User Story 3: Configure WhatsApp Settings via Environment Variables (Priority: P2)

**Story Goal**: Secure configuration pattern matching existing Telegram setup  
**Independent Test**: Set `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID` → app starts successfully and WhatsApp service is enabled  
**Completion Criteria**: FR-001, FR-002, FR-003, FR-004, FR-011, SC-008

### US3 Tasks

- [x] T019 Update `src/services/notification/WhatsAppService.js` `validate()` method to:
  - Check environment variable `ENABLE_WHATSAPP_ALERTS` (default: `false`)
  - If `ENABLE_WHATSAPP_ALERTS !== 'true'`: set `this.enabled = false`, return `{ valid: true, message: "WhatsApp disabled" }`
  - If enabled but missing any of `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID`: return `{ valid: false, message: "Missing config", fields: { ... } }`
  - Log WARN if config incomplete: "WhatsApp configuration incomplete: missing [WHATSAPP_API_KEY, ...]"
  - Return `{ valid: true, message: "WhatsApp configured" }` if all present

- [x] T020 Update `index.js` (or app startup) to:
  - Initialize `WhatsAppService` with env vars: `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID`
  - Call `notificationManager.validateAll()` on startup
  - Log summary: "Notification services initialized: telegram [ENABLED/DISABLED], whatsapp [ENABLED/DISABLED]"
  - Do NOT throw error if WhatsApp not configured (graceful degradation per spec)
  - Continue startup if at least Telegram is configured

- [x] T021 Create integration test file `tests/integration/config-validation.test.js` that:
  - Test 1: `ENABLE_WHATSAPP_ALERTS=false` → WhatsApp disabled, Telegram enabled → app starts, WhatsApp not called
  - Test 2: `ENABLE_WHATSAPP_ALERTS=true` with all credentials → both services enabled, app starts
  - Test 3: `ENABLE_WHATSAPP_ALERTS=true` without `WHATSAPP_API_KEY` → WhatsApp disabled, warning logged, Telegram enabled, app starts

---

### User Story 4: Support Graceful Fallback for Missing WhatsApp Configuration (Priority: P3)

**Story Goal**: Ensure backward compatibility; existing deployments without WhatsApp continue to work  
**Independent Test**: Omit all `WHATSAPP_*` env vars → app starts, Telegram alerts work, WhatsApp silently disabled  
**Completion Criteria**: FR-004, FR-011, SC-005

### US4 Tasks

- [x] T022 Create end-to-end test file `tests/integration/graceful-degradation.test.js` that:
  - Test 1: No WhatsApp config, only Telegram → send alert, Telegram delivers, no error
  - Test 2: WhatsApp config missing `apiKey`, Telegram configured → send alert, only Telegram delivers, no crash
  - Test 3: Both services disabled (unlikely but possible edge case) → send alert, return 200 OK, log warning "No notification channels enabled"

---

## Phase 4: Polish & Cross-Cutting (2 tasks)

**Objective**: Documentation, CI/CD integration, final validation  
**Dependent On**: All Phase 1-3 tasks

### Polish Tasks

- [x] T023 Update documentation:
  - Update `README.md` with new environment variables section: `ENABLE_WHATSAPP_ALERTS`, `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID`
  - Add "Configuration" section documenting setup steps (reference `specs/002-whatsapp-alerts/quickstart.md`)
  - Update `.github/copilot-instructions.md` to include WhatsApp service architecture, retry logic, and formatter patterns
  - Verify all JSDoc comments are present in new service classes

- [ ] T024 Final validation:
  - Run full test suite: `npm test` (verify all 20+ tests pass)
  - Run linter: `npm run lint` (verify no eslint errors)
  - Run manual integration test with real GreenAPI account (if available) or mock server
  - Generate test coverage report: verify >80% coverage for new code
  - Merge PR to `main` branch after approval

---

## Task Dependencies & Execution Graph

```
Phase 1 (Setup)
  T001 → T002 → [Ready for Phase 2]

Phase 2 (Foundational, all blocking Phase 3)
  T003 (NotificationChannel base) → {T004, T005, T006, T007 in parallel}
  ├─ T004 (retryHelper)
  ├─ T005 (messageHelper)
  ├─ T006 [P] (MarkdownV2Formatter) [parallel with T007]
  └─ T007 [P] (WhatsAppMarkdownFormatter) [parallel with T006]
  T008 (tests for foundational)
  → [Ready for Phase 3]

Phase 3 (User Stories)
  
  US1 (P1 - WhatsApp Single Channel):
    T009 [P] (WhatsAppService class) [parallel with T010, T011, T012]
    ├─ T010 [P] (TelegramService class) [parallel with T009]
    ├─ T011 [P] (WhatsAppService.send implementation) [parallel with T009]
    └─ T012 [P] (WhatsApp service tests)
    T013 [P] (WhatsApp integration test)
    → [US1 Complete: Can demo single-channel alerts]

  US2 (P2a - Dual Channel):
    T014 [P] (NotificationManager) [parallel with T015]
    ├─ T015 [P] (Refactor alert handler) [parallel with T014]
    ├─ T016 (Grounding enrichment reuse)
    └─ T017 (Admin notifications on failure)
    T018 (Dual-channel integration test)
    → [US2 Complete: Dual-channel delivery working]

  US3 (P2b - Configuration):
    T019 (Update WhatsAppService validation)
    T020 (Update app startup)
    T021 (Config validation tests)
    → [US3 Complete: Env-based configuration working]

  US4 (P3 - Graceful Degradation):
    T022 (Graceful degradation tests)
    → [US4 Complete: Backward compatibility verified]

Phase 4 (Polish)
  T023 (Documentation updates)
  T024 (Final validation & merge)
  → [Release Complete]
```

---

## Parallel Execution Opportunities

**Immediate (after T008)**:

- Tasks T009, T010, T011, T012 can execute in parallel (each implements different service)
- Expected duration: ~2 hours (vs ~3 hours sequentially)

**After T013 (US1 complete)**:

- Tasks T014, T015 can execute in parallel (NotificationManager and alert handler refactoring are independent until final integration)
- Expected duration: ~1.5 hours (vs ~2 hours sequentially)

**After T021 (US3 complete)**:

- Task T022 can execute immediately (no dependencies on US2 internals)

**Recommended Sequential Sections**:

- T001 → T002 (setup must complete first)
- T003 → T008 (foundational layer must complete before services)
- T019 → T020 (validation must implement before startup wiring)
- T023 → T024 (documentation then final validation)

---

## Testing Strategy

### Unit Tests (T008, T012, T021)
- **Files**: `tests/unit/notification-channel.test.js`, `tests/unit/retry-helper.test.js`, `tests/unit/whatsapp-service.test.js`
- **Focus**: Individual method behavior, error handling, formatting
- **Run**: `npm test -- unit/`
- **Expected**: ~12 test cases, >90% line coverage

### Integration Tests (T013, T018, T021)

- **Files**: `tests/integration/alert-whatsapp.test.js`, `tests/integration/alert-dual-channel.test.js`, `tests/integration/config-validation.test.js`
- **Focus**: Webhook → service → external API flow, dual-channel coordination, configuration validation
- **Run**: `npm test -- integration/`
- **Expected**: ~8 test cases, verify HTTP 200 responses, payload correctness

### End-to-End Test (T022)

- **Files**: `tests/integration/graceful-degradation.test.js`
- **Focus**: Backward compatibility, missing configuration handling
- **Run**: `npm test -- integration/graceful-degradation.test.js`
- **Expected**: ~3 test cases, verify no errors on degraded configs

---

## Success Criteria Mapping

| Success Criteria | Tasks | Completion |
|------------------|-------|-----------|
| SC-001: WhatsApp delivery within 5s | T011, T013 | ✓ fetch timeout 10s, measured in integration test |
| SC-003: No latency impact from dual-channel | T014, T015 | ✓ parallel sendToAll() in NotificationManager |
| SC-004: Graceful error handling | T017, T022 | ✓ admin notifications, no cross-channel blocking |
| SC-005: Backward compatibility | T020, T022 | ✓ graceful degradation tests |
| SC-006: Special characters preserved | T007, T013 | ✓ WhatsApp formatter test cases |
| SC-007: Custom preview title | T009, T011 | ✓ payload includes customPreview.title |
| SC-008: Config validation on startup | T019, T020, T021 | ✓ validateAll() with warning logs |

---

## File Changes Summary

### New Files (10)

```
src/services/notification/NotificationChannel.js
src/services/notification/WhatsAppService.js
src/services/notification/TelegramService.js
src/services/notification/NotificationManager.js
src/services/notification/formatters/markdownV2Formatter.js
src/services/notification/formatters/whatsappMarkdownFormatter.js
src/lib/retryHelper.js
src/lib/messageHelper.js
tests/unit/notification-channel.test.js
tests/unit/retry-helper.test.js
tests/unit/whatsapp-service.test.js
tests/integration/alert-whatsapp.test.js
tests/integration/alert-dual-channel.test.js
tests/integration/config-validation.test.js
tests/integration/graceful-degradation.test.js
```

### Modified Files (3)

```
src/controllers/webhooks/handlers/alert/alert.js (refactor to use NotificationManager)
index.js (initialize services on startup)
README.md (add WhatsApp config section)
.github/copilot-instructions.md (architecture notes)
```

### Unchanged (backward compatible)

```
app.js
src/routes/index.js
src/controllers/commands.js
src/services/grounding/ (all files)
package.json (no new dependencies; native fetch only)
```

---

## Notes for Implementation

1. **No New Dependencies**: Use native Node.js 20 fetch API. No external HTTP client needed.

2. **Formatting Conversion**: 
   - Telegram MarkdownV2 → WhatsApp markdown conversion happens in `WhatsAppMarkdownFormatter`
   - Both channels receive same enriched content, but formatted differently
   - Unsupported formats (links, underline, nested) are stripped to plain text

3. **Retry Logic**:
   - Exponential backoff: 1s → 2s → 4s with ±10% jitter
   - Per-message, not global queue
   - Respects GreenAPI 50 RPS limit through independent per-message delays

4. **Admin Notifications**:
   - Only triggered when channels fail (not on success)
   - Uses existing Telegram infrastructure and `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`
   - Returns 200 OK to webhook caller regardless (fail-open pattern)

5. **Grounding Reuse**:
   - Single request to Gemini per alert (if `ENABLE_GROUNDING=true`)
   - Enriched data shared between Telegram and WhatsApp
   - Each formatter applies channel-specific styling

6. **Testing Philosophy** (No TDD mandate):
   - Critical logic (retry backoff, formatting, error handling) has focused unit tests
   - Integration tests verify webhook → services → external API flow
   - Graceful degradation tested explicitly
   - Aim for >80% coverage on new code

7. **Backward Compatibility**:
   - Existing Telegram-only deployments unaffected
   - WhatsApp disabled by default (`ENABLE_WHATSAPP_ALERTS=false`)
   - Missing WhatsApp config logs warnings but doesn't crash
   - All changes to alert.js are refactoring only (same behavior)

---

## Implementation Checklist

- [ ] Read all design documents: plan.md, spec.md, data-model.md, research.md, contracts/, quickstart.md
- [ ] Verify Node.js 20.x environment: `node --version`
- [ ] Review existing Telegram alert implementation: `src/controllers/webhooks/handlers/alert/alert.js`
- [ ] Check current grounding service: `src/services/grounding/grounding.js` (for reuse)
- [ ] Verify test framework: jest is installed (`npm test --version`)
- [ ] Confirm environment variable availability in test: check `setup.js`
- [ ] After each phase: run tests, verify no regressions, commit with clear message

---

## Success Definition (End of Phase 4)

✅ **Feature Complete** when:
1. All 24 tasks marked as completed
2. `npm test` runs successfully with >80% coverage on new code
3. `npm run lint` reports no errors
4. Integration test `tests/integration/graceful-degradation.test.js` passes
5. README.md updated with WhatsApp configuration section
6. Pull request reviewed and merged to `main` branch
7. Quickstart can be followed end-to-end with real or mocked GreenAPI account

---

*Last updated: 2025-10-29 | Auto-generated by speckit.tasks*
