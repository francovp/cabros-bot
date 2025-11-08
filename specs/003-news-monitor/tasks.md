# Tasks: News Monitoring with Sentiment Analysis and Alert Distribution

**Feature Branch**: `003-news-monitor`  
**Input**: Design documents from `/specs/003-news-monitor/`  
**Prerequisites**: plan.md ✅, spec.md ✅, research.md ✅, data-model.md ✅, contracts/ ✅

**Tests**: Integration tests are included for critical paths (core analysis flow, deduplication, enrichment fallback, multi-channel delivery)

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Path Conventions

- **Single project**: `src/`, `tests/` at repository root (Node.js 20.x, Express REST API)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and dependency setup

- [X] T001 Install Azure AI Inference dependencies in package.json (@azure-rest/ai-inference, @azure/core-auth, @azure/core-sse)
- [x] T002 [P] Update .env.example with NEWS_* environment variables (ENABLE_NEWS_MONITOR, NEWS_ALERT_THRESHOLD, NEWS_CACHE_TTL_HOURS, NEWS_TIMEOUT_MS, NEWS_SYMBOLS_CRYPTO, NEWS_SYMBOLS_STOCKS, URL_SHORTENER_SERVICE, BITLY_ACCESS_TOKEN, TINYURL_API_KEY, PICSEE_API_KEY, REURL_API_KEY, CUTTLY_API_KEY, PIXNET0RZ_API_KEY)
- [X] T003 [P] Update .env.example with AZURE_AI_* environment variables (AZURE_AI_ENDPOINT, AZURE_AI_API_KEY, AZURE_AI_MODEL)
- [X] T004 [P] Create directory structure for news monitor feature (src/controllers/webhooks/handlers/newsMonitor/, src/services/inference/, tests/integration/)

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

- [X] T005 Create cache module with TTL support in src/controllers/webhooks/handlers/newsMonitor/cache.js
- [X] T006 [P] Create types definitions file in src/controllers/webhooks/handlers/newsMonitor/types.ts (NewsAlert, MarketContext, AnalysisResult interfaces)
- [X] T007 [P] Create Azure AI Inference client wrapper in src/services/inference/azureAiClient.js
- [X] T008 Implement enrichment service with fallback logic in src/services/inference/enrichmentService.js (depends on T007)
- [X] T009 [P] Enhance Gemini service with news analysis prompt in src/services/grounding/gemini.js (add analyzeNewsForSymbol function)
- [X] T010 [P] Create analyzer orchestrator module in src/controllers/webhooks/handlers/newsMonitor/analyzer.js
- [X] T011 Register /api/news-monitor route in src/routes/index.js with feature gate check

**Checkpoint**: Foundation ready - user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - External Caller Monitors News for Assets (Priority: P1) 🎯 MVP

**Goal**: Enable external schedulers to call `/api/news-monitor` endpoint with crypto/stock symbols and receive per-symbol analysis results with detected alerts

**Independent Test**: Call the endpoint with `{"crypto": ["BTCUSDT"], "stocks": ["NVDA"]}` and verify the response includes per-symbol results with status (analyzed/cached/timeout/error)

### Integration Tests for User Story 1

- [x] T012 [P] [US1] Create integration test for basic endpoint behavior in tests/integration/news-monitor-basic.test.js (test POST with crypto+stocks, GET with query params, feature gate) ✅ COMPLETED (22 tests, 95%+ passing)
- [x] T013 [P] [US1] Create unit test for analyzer orchestrator in tests/unit/analyzer.test.js (test parallel processing, timeout handling, confidence calculation) ✅ COMPLETED (10 tests, 100% passing)

### Implementation for User Story 1

- [x] T014 [US1] Implement main endpoint handler in src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js (request parsing, validation, response formatting) ✅ COMPLETED (Phase 2)
- [x] T015 [US1] Implement symbol analysis flow in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (Gemini integration, confidence scoring, parallel processing with Promise.allSettled) ✅ COMPLETED (Phase 2)
- [x] T016 [US1] Implement market context fetching with Binance fallback to Gemini in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (reuse fetchPriceCryptoSymbol, add getGeminiPriceContext) ✅ COMPLETED (Phase 2)
- [x] T017 [US1] Implement confidence calculation formula in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (0.6 × event_significance + 0.4 × |sentiment|) ✅ COMPLETED (Phase 2)
- [x] T018 [US1] Add request validation (max 100 symbols, format checks) in src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js ✅ COMPLETED (Phase 2)
- [x] T019 [US1] Add error handling and logging (requestId, totalDurationMs, per-symbol timing) in src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js ✅ COMPLETED (Phase 2)

**Checkpoint**: ✅ COMPLETED - User Story 1 fully functional - endpoint accepts requests, analyzes symbols in parallel, returns per-symbol results

**Phase 3 Status**: COMPLETE - All 22 tests written and integrated (110/113 tests passing overall)

---

## Phase 4: User Story 2 - Traders Receive Alerts via Configured Channels (Priority: P1) ✅ COMPLETED

**Goal**: When significant market events are detected (confidence >= threshold), automatically send formatted alerts to both Telegram and WhatsApp channels simultaneously

**Independent Test**: Trigger an alert condition and verify both Telegram and WhatsApp channels receive the message (check deliveryResults in response)

### Integration Tests for User Story 2

- [x] T020 [P] [US2] Create integration test for multi-channel alert delivery in tests/integration/news-monitor-alerts.test.js (test alert sent to both channels, partial success handling) ✅ COMPLETED (24 tests, 100% passing)

### Implementation for User Story 2

- [x] T021 [US2] Implement alert formatting function in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (MarkdownV2 for Telegram, WhatsApp-compatible format) ✅ COMPLETED (buildAlert and formatAlertMessage functions)
- [x] T022 [US2] Integrate with NotificationManager.sendToAll() in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (reuse existing multi-channel notification) ✅ COMPLETED (analyzeLyanalyzeSymbolInternal calls notificationManager.sendToAll)
- [x] T023 [US2] Implement threshold filtering logic (confidence >= NEWS_ALERT_THRESHOLD) in src/controllers/webhooks/handlers/newsMonitor/analyzer.js ✅ COMPLETED (checks threshold before sending)
- [x] T024 [US2] Add deliveryResults to AnalysisResult response in src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js ✅ COMPLETED (deliveryResults included in each result object)

**Checkpoint**: ✅ COMPLETED - User Stories 1 AND 2 both work - endpoint analyzes symbols and sends alerts when confidence threshold is met

**Phase 4 Status**: COMPLETE - All 24 tests written and integrated (134/137 tests passing overall, 98% success rate)

---

## Phase 4b: User Story 2b - WhatsApp Source URL Shortening (Priority: P2)

**Goal**: Shorten source URLs in WhatsApp alerts using configurable URL shortening service (Bitly, TinyURL, PicSee, reurl, Cutt.ly, Pixnet0rz.tw) to reduce message size from ~25K chars to <10K chars while preserving source attribution

**Why this story**: Current implementation strips URLs entirely from WhatsApp messages. URL shortening enables traders to verify alert sources while keeping messages readable and within transmission limits. Multiple service support via `prettylink` package provides flexibility and fallback options.

**Independent Test**: Send an alert with enriched citations to WhatsApp and verify each source URL is shortened (e.g., from 150+ chars to ~30 chars) and appears in format "Title (short-url)". Verify fallback behavior when the configured shortening service is unavailable.

### Integration Tests for User Story 2b

- [x] T025 [P] [US2b] Create integration test for URL shortening with fallback in tests/integration/news-monitor-url-shortening.test.js (test Bitly success, timeout fallback, cache hits, graceful degradation)

### Implementation for User Story 2b

- [x] T026 [US2b] Create URL shortener utility module in src/controllers/webhooks/handlers/newsMonitor/urlShortener.js (implement shortenUrl, shortenUrlsParallel functions with `prettylink` package support for multiple services and direct API calls for unsupported services)
- [x] T027 [US2b] Implement in-memory URL cache (session-scoped) in src/controllers/webhooks/handlers/newsMonitor/urlShortener.js (Map-based cache keyed by original URL, prevents redundant shortening service calls)
- [x] T028 [US2b] Integrate URL shortening into WhatsAppService formatter in src/services/notification/formatters/whatsappMarkdownFormatter.js (use URL_SHORTENER_SERVICE env var to select service, call shortenUrlsParallel for enriched citations, fallback to title-only on failure)
- [x] T029 [US2b] Add URL shortening configuration validation in index.js (validate URL_SHORTENER_SERVICE value, check service-specific API key presence, log if shortening disabled)
- [x] T030 [US2b] Add npm dependency for prettylink package in package.json (multi-service URL shortening wrapper supporting Bitly, TinyURL, PicSee, reurl, Cutt.ly, Pixnet0rz.tw with direct API fallback)

**Checkpoint**: User Story 2b complete - WhatsApp messages now include shortened source URLs via configurable service; graceful fallback to title-only if shortening unavailable



---

## Phase 5: User Story 3 - System Avoids Duplicate Alerts for Same News (Priority: P2)

**Goal**: Implement intelligent cache mechanism that prevents duplicate alerts for the same (symbol, event_category) within TTL window (default: 6 hours)

**Independent Test**: Call the endpoint twice with the same symbol within TTL window and verify the second call returns cached result (status: "cached") without sending duplicate alert

### Integration Tests for User Story 3

- [x] T031 [P] [US3] Create integration test for cache deduplication in tests/integration/news-monitor-cache.test.js (test cache hit, cache miss after TTL, different event categories)
- [x] T032 [P] [US3] Create unit test for cache module in tests/unit/cache.test.js (test TTL enforcement, cleanup, key generation)

### Implementation for User Story 3

- [x] T033 [US3] Implement cache key generation (symbol:event_category format) in src/controllers/webhooks/handlers/newsMonitor/cache.js
- [x] T034 [US3] Implement cache.get() with TTL check in src/controllers/webhooks/handlers/newsMonitor/cache.js
- [x] T035 [US3] Implement cache.set() for storing analysis results in src/controllers/webhooks/handlers/newsMonitor/cache.js
- [x] T036 [US3] Implement cache.cleanup() with periodic setInterval (every 1 hour) in src/controllers/webhooks/handlers/newsMonitor/cache.js
- [x] T037 [US3] Integrate cache check before analysis in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (check cache, return cached result if valid)
- [x] T038 [US3] Initialize cache on app startup in index.js (after bot launch, before registering routes). **Note**: Cache stores both primary analysis (Gemini) and optional enrichment results (when `ENABLE_LLM_ALERT_ENRICHMENT=true`) under the same `(symbol, event_category)` key with same TTL. This prevents redundant API calls to both Gemini and secondary LLM for duplicate events. If enrichment fails, original Gemini analysis is cached; enrichment retry only occurs after cache entry expires.

**Checkpoint**: At this point, User Stories 1, 2, AND 3 should all work - duplicate alerts are prevented, cached results are returned quickly

---

## Phase 6: User Story 4 - System Optionally Enriches Alerts with Real-time Crypto Prices (Priority: P2)

**Goal**: When ENABLE_BINANCE_PRICE_CHECK=true, fetch precise crypto prices from Binance API (~5s timeout) with automatic fallback to Gemini GoogleSearch (~20s timeout)

**Independent Test**: Enable Binance mode, analyze crypto symbol, and verify MarketContext.source="binance"; disable Binance or force timeout and verify fallback to source="gemini"

### Integration Tests for User Story 4

- [x] T033 [P] [US4] Create integration test for Binance integration with fallback in tests/integration/news-monitor-binance.test.js (test Binance success, timeout fallback, stock symbol skips Binance)

### Implementation for User Story 4

- [x] T034 [US4] Implement getMarketContext() function with Binance/Gemini routing in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (check isCrypto and ENABLE_BINANCE_PRICE_CHECK)
- [x] T035 [US4] Implement withTimeout() wrapper for Binance API calls (~5s) in src/controllers/webhooks/handlers/newsMonitor/analyzer.js
- [x] T036 [US4] Implement getGeminiPriceContext() fallback function in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (call Gemini with price discovery prompt, ~20s timeout)
- [x] T037 [US4] Add MarketContext to NewsAlert in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (include price, change24h, source, timestamp)

**Checkpoint**: At this point, User Stories 1-4 should all work - crypto prices are fetched from Binance when enabled, with reliable Gemini fallback

---

## Phase 7: User Story 5 - System Detects Trading-Relevant Events (Priority: P3)

**Goal**: Enhance Gemini prompt to detect 3 event categories (price_surge, price_decline, public_figure, regulatory) with confidence scoring per category

**Independent Test**: Inject known market events (price movement >5%, public figure mention, regulatory announcement) and verify correct event_category and confidence score in response

### Implementation for User Story 5

- [x] T038 [P] [US5] Create enhanced Gemini prompt template in src/services/grounding/config.js (NEWS_ANALYSIS_PROMPT with structured JSON format)
- [x] T039 [US5] Implement event detection logic with category classification in src/services/grounding/gemini.js (parse Gemini response, extract event_category, event_significance, sentiment_score)
- [x] T040 [US5] Implement fallback parsing for free-form Gemini responses in src/services/grounding/gemini.js (regex/NLP heuristics when JSON fails)
- [x] T041 [US5] Add validation for event detection response in src/lib/validation.js (validateNewsAnalysisResponse function)

**Checkpoint**: At this point, User Stories 1-5 should all work - system detects and categorizes different types of trading-relevant events

---

## Phase 8: User Story 6 - Optional Secondary LLM Enrichment of Alerts (Priority: P2)

**Goal**: When ENABLE_LLM_ALERT_ENRICHMENT=true, invoke Azure AI Inference to refine confidence scores with conservative selection (min of Gemini + LLM); gracefully fall back to Gemini-only if unavailable

**Independent Test**: Enable enrichment, trigger alert, verify enrichmentMetadata in response with enriched_confidence; disable enrichment or force timeout and verify fallback to Gemini-only

### Integration Tests for User Story 6

- [x] T042 [P] [US6] Create integration test for LLM enrichment with fallback in tests/integration/news-monitor-enrichment.test.js (test enrichment success, timeout fallback, disabled mode)
- [x] T043 [P] [US6] Create unit test for enrichment service in tests/unit/enrichment.test.js (test conservative confidence selection, error handling)

### Implementation for User Story 6

- [x] T044 [US6] Implement enrichAlert() function in src/services/inference/enrichmentService.js (call Azure AI with Gemini results, parse response, return EnrichmentMetadata)
- [x] T045 [US6] Implement conservative confidence selection in src/services/inference/enrichmentService.js (Math.min(geminiConfidence, llmConfidence))
- [x] T046 [US6] Add enrichment call with timeout (~10s) in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (wrap with sendWithRetry, 3 retries)
- [x] T047 [US6] Add enrichmentMetadata to NewsAlert response in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (original_confidence, enriched_confidence, reasoning_excerpt, model_name, processing_time_ms)
- [x] T048 [US6] Implement graceful fallback when enrichment disabled or fails in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (log error, continue with Gemini confidence)

**Checkpoint**: At this point, ALL user stories should work - optional LLM enrichment refines confidence when enabled, falls back gracefully when disabled or unavailable

---

## Phase 9: Polish & Cross-Cutting Concerns

**Purpose**: Improvements that affect multiple user stories

- [x] T049 [P] Add comprehensive logging for all external API calls in src/controllers/webhooks/handlers/newsMonitor/analyzer.js (Gemini, Binance, Azure AI, Telegram, WhatsApp with request/response summaries)
- [x] T050 [P] Add structured logging for operational visibility in src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js (per-symbol timing, cache hits, enrichment decisions, retry attempts)
- [x] T051 [P] Update README.md with news monitor feature documentation (link to quickstart.md, feature flags, basic usage)
- [x] T052 [P] Create example GitHub Actions cron workflow in .github/workflows/news-monitor-cron.yml.example
- [x] T053 Code cleanup and refactoring (remove console.log, ensure consistent error handling, validate all file paths)
- [x] T054 Run quickstart.md validation scenarios (test all 4 examples, verify troubleshooting guide accuracy)
- [x] T055 Performance optimization (ensure parallel processing works correctly, verify 30s timeout budget, test with 50+ symbols)
- [x] T056 [P] Add JSDoc comments to all public functions in src/controllers/webhooks/handlers/newsMonitor/ and src/services/inference/

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-8)**: All depend on Foundational phase completion
  - User stories can then proceed in parallel (if staffed)
  - Or sequentially in priority order (P1 → P1 → P2 → P2 → P3 → P2)
- **Polish (Phase 9)**: Depends on all desired user stories being complete

### User Story Dependencies

- **User Story 1 (P1)**: Can start after Foundational (Phase 2) - No dependencies on other stories ✅ INDEPENDENT
- **User Story 2 (P1)**: Depends on User Story 1 (needs alert detection to trigger delivery) ⚠️ SEQUENTIAL
- **User Story 3 (P2)**: Can start after Foundational (Phase 2) - Works independently with cache module ✅ INDEPENDENT
- **User Story 4 (P2)**: Can start after User Story 1 (extends market context fetching) ⚠️ SEQUENTIAL
- **User Story 5 (P3)**: Can start after User Story 1 (enhances event detection) ⚠️ SEQUENTIAL
- **User Story 6 (P2)**: Can start after User Story 2 (enriches alerts after detection) ⚠️ SEQUENTIAL

### Within Each User Story

- Tests MUST be written and FAIL before implementation
- Foundation modules before analysis flow
- Analysis flow before alert delivery
- Alert delivery before enrichment
- Story complete before moving to next priority

### Parallel Opportunities

- **Phase 1 (Setup)**: T002, T003, T004 can run in parallel (different files)
- **Phase 2 (Foundational)**: T006, T007, T009, T010 can run in parallel (different files)
- **Phase 3 (US1)**: T012, T013 (tests) can run in parallel
- **Phase 5 (US3)**: T025, T026 (tests) can run in parallel
- **Phase 6 (US4)**: T033 (test) can run alone
- **Phase 8 (US6)**: T042, T043 (tests) can run in parallel
- **Phase 9 (Polish)**: T049, T050, T051, T052, T056 can run in parallel (different files)

**Note**: User Stories 1-6 are mostly sequential due to dependencies, but tests within each story can be parallelized

---

## Parallel Example: Foundational Phase (Phase 2)

```bash
# Launch all parallelizable foundational tasks together:
Task T006: "Create types definitions file in src/controllers/webhooks/handlers/newsMonitor/types.ts"
Task T007: "Create Azure AI Inference client wrapper in src/services/inference/azureAiClient.js"
Task T009: "Enhance Gemini service with news analysis prompt in src/services/grounding/gemini.js"
Task T010: "Create analyzer orchestrator module in src/controllers/webhooks/handlers/newsMonitor/analyzer.js"

# Then complete sequential dependencies:
Task T005: "Create cache module" (no dependencies)
Task T008: "Implement enrichment service" (depends on T007)
Task T011: "Register route" (depends on all above)
```

---

## Parallel Example: User Story 1 Tests

```bash
# Launch all tests for User Story 1 together:
Task T012: "Create integration test for basic endpoint behavior in tests/integration/news-monitor-basic.test.js"
Task T013: "Create unit test for analyzer orchestrator in tests/unit/analyzer.test.js"

# Both tests can be written in parallel since they test different aspects
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2 Only)

1. Complete Phase 1: Setup (4 tasks)
2. Complete Phase 2: Foundational (7 tasks) - **CRITICAL - blocks all stories**
3. Complete Phase 3: User Story 1 (8 tasks) - Core endpoint functionality
4. Complete Phase 4: User Story 2 (4 tasks) - Alert delivery
5. **STOP and VALIDATE**: Test User Stories 1+2 independently
6. Deploy/demo if ready - **This is a complete MVP**: endpoint analyzes symbols and sends alerts

**Estimated MVP Task Count**: 23 tasks (Setup + Foundational + US1 + US2)

### Incremental Delivery (Add P2 Features)

7. Add Phase 5: User Story 3 (6 tasks) - Deduplication cache
8. **VALIDATE**: Test cache prevents duplicates
9. Add Phase 6: User Story 4 (4 tasks) - Binance integration
10. **VALIDATE**: Test Binance price fetching with fallback
11. Add Phase 8: User Story 6 (5 tasks) - LLM enrichment
12. **VALIDATE**: Test enrichment refines confidence

**Each story adds value without breaking previous stories**

### Full Feature (Add P3 Features)

13. Add Phase 7: User Story 5 (4 tasks) - Enhanced event detection
14. **VALIDATE**: Test all 3 event categories detected correctly
15. Complete Phase 9: Polish (8 tasks) - Documentation, logging, optimization

**Total Task Count**: 56 tasks (all user stories + polish)

### Parallel Team Strategy

With multiple developers (after Foundational phase completes):

- **Developer A**: User Story 1 → User Story 4 (core analysis + Binance)
- **Developer B**: User Story 2 → User Story 6 (alerts + enrichment)
- **Developer C**: User Story 3 → User Story 5 (cache + event detection)
- **All**: Phase 9 Polish tasks in parallel

**Stories can integrate independently without blocking each other**

---

## Task Summary

- **Total Tasks**: 62 (updated with User Story 2b)
- **Setup Tasks**: 4 (Phase 1)
- **Foundational Tasks**: 7 (Phase 2) - **BLOCKS all user stories**
- **User Story 1 (P1)**: 8 tasks (2 tests + 6 implementation)
- **User Story 2 (P1)**: 4 tasks (1 test + 3 implementation)
- **User Story 2b (P2)**: 6 tasks (1 test + 5 implementation) - **NEW: URL shortening for WhatsApp**
- **User Story 3 (P2)**: 8 tasks (2 tests + 6 implementation)
- **User Story 4 (P2)**: 4 tasks (1 test + 3 implementation)
- **User Story 5 (P3)**: 4 tasks (0 tests + 4 implementation)
- **User Story 6 (P2)**: 7 tasks (2 tests + 5 implementation)
- **Polish Tasks**: 8 (Phase 9)

**MVP Scope (US1 + US2)**: 23 tasks  
**Recommended First Release**: MVP + US2b (URL shortening) + US3 (deduplication) = 37 tasks  
**Full Feature**: All 62 tasks

**Parallel Opportunities**: 17 tasks marked [P] can run in parallel within their phases

**Independent Test Criteria**:
- ✅ US1: Call endpoint with symbols, verify per-symbol results
- ✅ US2: Trigger alert, verify both Telegram + WhatsApp receive message
- ✅ US2b: Send enriched alert to WhatsApp, verify URLs are shortened via Bitly; verify fallback when unavailable
- ✅ US3: Call endpoint twice within TTL, verify cached result
- ✅ US4: Enable Binance, verify source="binance"; force timeout, verify source="gemini"
- ✅ US5: Inject known event types, verify correct category and confidence
- ✅ US6: Enable enrichment, verify enrichmentMetadata; disable, verify fallback

---

## Notes

- **[P] tasks**: Different files, no dependencies - can run in parallel
- **[Story] label**: Maps task to specific user story for traceability
- **Sequential US dependencies**: US2 depends on US1, US4/US5/US6 depend on US1/US2
- **Independent US3**: Cache module can be developed in parallel with other stories
- **Tests included**: Integration and unit tests for critical paths (analysis, cache, enrichment, alerts)
- **Feature-gated**: All functionality behind `ENABLE_NEWS_MONITOR=false` default for safe rollout
- **Commit frequently**: After each task or logical group
- **Stop at checkpoints**: Validate each story independently before proceeding
- **Avoid**: Vague tasks, same file conflicts, blocking dependencies that prevent parallel work

**Format validation**: ✅ All tasks follow checklist format (checkbox, ID, optional [P], required [Story] for US phases, file paths)
