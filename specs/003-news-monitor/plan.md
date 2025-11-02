# Implementation Plan: News Monitoring with Sentiment Analysis and Alert Distribution

**Branch**: `003-news-monitor` | **Date**: October 31, 2025 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-news-monitor/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

This feature implements an HTTP endpoint (`/api/news-monitor`) that analyzes news and market sentiment for crypto and stock symbols using Gemini GoogleSearch grounding service. The system detects significant market events (price movements, public figure mentions, regulatory announcements), assigns confidence scores, and sends filtered alerts simultaneously to Telegram and WhatsApp channels. Optional secondary LLM enrichment (using Azure AI Inference with Gemini models) can refine confidence scores when enabled. The system includes intelligent deduplication via in-memory cache (6hr TTL), optional Binance integration for precise crypto prices, WhatsApp URL shortening via Bitly for enriched citations, and parallel symbol analysis with aggressive timeout handling.

## Technical Context

**Language/Version**: Node.js 20.x (matches existing codebase)  
**Primary Dependencies**: 
- `@azure-rest/ai-inference` - Azure AI Inference REST client for optional secondary LLM enrichment
- `@azure/core-auth` - Authentication (AzureKeyCredential, TokenCredential)
- `@azure/core-sse` - Server-Sent Events streaming for LLM responses
- `@google/genai` ^1.27.0 - Gemini API client (existing, for primary grounding)
- `binance` ^2.10.2 - Binance API client (existing, for crypto price fetching)
- `express` ^4.17.1 - HTTP server (existing)
- `telegraf` ^4.3.0 - Telegram bot framework (existing)
- `prettylink` ^1.1.0 - Bitly URL shortening wrapper (NEW for User Story 2b, for WhatsApp citation links)

**Storage**: In-memory cache for news deduplication (Map-based, TTL-aware, no persistence required) + in-memory URL shortening cache (session-scoped)
**Testing**: Jest ^30.2.0 with supertest ^7.1.4 for integration tests; minimal test coverage per constitution (critical paths + regressions)  
**Target Platform**: Linux server (Render.com cloud hosting, Docker container via devcontainer)  
**Project Type**: Single-project (existing Express REST API + Telegram bot)  
**Performance Goals**: 
- 30s total timeout per batch of symbols (includes URL shortening latency <1s per citation)
- Parallel symbol analysis (10+ concurrent symbols)
- <5s response time for cached results
- Support 10 concurrent endpoint requests without degradation
- URL shortening succeeds in 90% of requests within 2 seconds (with 3 retries)

**Constraints**: 
- Must not block existing bot functionality when `ENABLE_NEWS_MONITOR=false`
- Aggressive timeouts: Binance ~5s, Gemini ~20s, optional LLM enrichment ~10s, Bitly shortening ~5s per symbol
- Graceful degradation: notification channel failures and URL shortening failures do not block HTTP response or alert delivery
- Conservative confidence selection when enrichment is enabled (min of Gemini + LLM scores)
- URL shortening is optional and disabled if `BITLY_API_KEY` is not configured

**Scale/Scope**: 
- Extensible: No hard limits on symbol count (30s timeout applies to entire batch)
- 1hr cache TTL per (symbol, event_category) pair
- 3 event categories: price_surge, price_decline, public_figure, regulatory
- 2 notification channels: Telegram, WhatsApp (via existing notification manager)
- URL shortening cache session-scoped: In-memory only, resets on bot restart (acceptable for MVP)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Code Quality & Readability ✅
- **Status**: COMPLIANT
- **Rationale**: Feature uses existing patterns (notification manager, grounding service, retry helper). New code will follow clear naming, small focused functions, and modular service layer. URL shortening integrated cleanly into WhatsAppService formatter without excessive complexity.

### II. Simplicity & Minimalism ✅
- **Status**: COMPLIANT
- **Rationale**: Implements simplest solution that meets requirements:
  - Reuses existing services (grounding, notification manager, retry helper)
  - In-memory cache for both news deduplication and URL shortening (no external storage dependency)
  - Optional LLM enrichment disabled by default (backward compatible)
  - URL shortening optional (disabled if `BITLY_API_KEY` not configured)
  - No premature abstraction (direct Gemini + + optional Azure AI calls, Bitly calls, graceful fallback)

### III. Testing Policy (No TDD Mandate) ✅
- **Status**: COMPLIANT
- **Rationale**: Tests required for critical logic:
  - Core analysis flow (Gemini response parsing, confidence scoring)
  - Deduplication logic (cache key generation, TTL enforcement)
  - Optional enrichment (fallback when disabled/unavailable)
  - URL shortening logic (Bitly integration, cache hits, fallback to title-only)
  - Integration tests for multi-channel delivery with URL shortening
  - No TDD mandate; tests can be written after implementation

### IV. Review & Quality Gates ✅
- **Status**: COMPLIANT
- **Rationale**: Feature follows existing PR workflow:
  - PR will reference this spec/plan
  - CI runs eslint, jest tests, and coverage checks
  - Integration tests cover endpoint behavior, notification delivery, enrichment, and URL shortening

### V. Incremental Delivery & Semantic Versioning ✅
- **Status**: COMPLIANT
- **Rationale**: Feature is feature-gated (`ENABLE_NEWS_MONITOR=false` by default):
  - Can be enabled incrementally in production
  - Optional enrichment is additional layer (`ENABLE_LLM_ALERT_ENRICHMENT=false` by default)
  - URL shortening is optional (`BITLY_API_KEY` must be configured)
  - No breaking changes to existing bot or alert webhook
  - Follows semantic versioning for API contracts (v1 endpoint)

### Gate Decision: ✅ PROCEED TO PHASE 0
All constitution principles are met. No violations requiring justification.

---

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── controllers/
│   ├── commands.js                                    # Existing Telegram command handlers
│   ├── commands/handlers/core/
│   │   └── fetchPriceCryptoSymbol.js                 # Existing Binance price fetcher (reuse)
│   └── webhooks/handlers/
│       ├── alert/
│       │   ├── alert.js                              # Existing webhook handler
│       │   └── grounding.js                          # Existing Gemini grounding
│       └── newsMonitor/                              # NEW: News monitoring handlers
│           ├── newsMonitor.js                        # Main endpoint handler
│           ├── analyzer.js                           # Symbol analysis orchestrator
│           ├── enrichment.js                         # Optional LLM enrichment service
│           ├── cache.js                              # In-memory deduplication cache
│           └── urlShortener.js                       # NEW: Bitly URL shortening utility (User Story 2b)
├── services/
│   ├── grounding/                                    # Existing Gemini grounding service
│   │   ├── gemini.js                                 # Reuse for news sentiment analysis
│   │   ├── genaiClient.js                            # Existing Gemini client
│   │   └── config.js
│   ├── notification/                                 # Existing multi-channel notification
│   │   ├── NotificationManager.js                    # Reuse for alert delivery
│   │   ├── TelegramService.js
│   │   ├── WhatsAppService.js                        # Update: integrate URL shortening for citations
│   │   └── formatters/
│   │       ├── markdownV2Formatter.js                # Existing Telegram formatter
│   │       └── whatsappMarkdownFormatter.js          # Update: support shortened URLs
│   └── inference/                                    # NEW: Azure AI Inference service
│       ├── azureAiClient.js                          # Azure REST client wrapper
│       └── enrichmentService.js                      # Confidence refinement logic
├── lib/
│   ├── retryHelper.js                                # Existing retry logic (reuse)
│   └── validation.js                                 # Existing validation helpers
└── routes/
    └── index.js                                      # Update to register /api/news-monitor

tests/
├── integration/
│   ├── alert-dual-channel.test.js                    # Existing multi-channel tests
│   ├── news-monitor-basic.test.js                    # NEW: Basic endpoint behavior
│   ├── news-monitor-enrichment.test.js               # NEW: Optional LLM enrichment
│   ├── news-monitor-cache.test.js                    # NEW: Deduplication logic
│   └── news-monitor-url-shortening.test.js           # NEW: URL shortening (User Story 2b)
└── unit/
    ├── analyzer.test.js                              # NEW: Symbol analysis unit tests
    ├── enrichment.test.js                            # NEW: Enrichment service unit tests
    ├── cache.test.js                                 # NEW: Cache logic unit tests
    └── url-shortener.test.js                         # NEW: URL shortening unit tests (User Story 2b)

index.js                                              # Update to register /api/news-monitor
```

**Structure Decision**: This feature extends the existing single-project Express application. It follows the established pattern of controllers/webhooks/handlers for HTTP endpoints, reuses existing services (grounding, notification, retry logic), and adds a new Azure AI Inference service layer for optional enrichment plus URL shortening utility for WhatsApp citations. Tests follow the existing integration/ and unit/ split. No architectural changes required. The URL shortening feature (User Story 2b) adds minimal surface area: a new urlShortener utility module and updates to WhatsAppService formatter and tests.

---

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

**No violations detected** - All constitution principles met. No complexity tracking required.

---

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 design artifacts (research.md, data-model.md, contracts/, quickstart.md) are complete, with User Story 2b additions.*

### I. Code Quality & Readability ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - Data model uses clear entity names (NewsAlert, MarketContext, CacheEntry, AnalysisResult, EnrichmentMetadata, NotificationDeliveryResult, URLShortenerCache)
  - API contract follows REST conventions with explicit schemas
  - Service layer separated by concern (analyzer, enrichment, cache, urlShortener)
  - URL shortening logic isolated in utility module for testability
  - No violations introduced

### II. Simplicity & Minimalism ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - In-memory Map caches (news dedup + URL shortening) are simplest solutions (no external dependencies)
  - Reuses existing services (grounding, notification manager, retry helper)
  - Optional enrichment disabled by default (backward compatible)
  - URL shortening optional and disabled if `BITLY_API_KEY` not configured (graceful degradation)
  - No premature abstraction (direct API calls, graceful fallback to title-only citations)
  - No violations introduced

### III. Testing Policy (No TDD Mandate) ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - Test strategy defined in quickstart.md (unit + integration)
  - Critical paths identified: confidence scoring, deduplication, enrichment fallback, URL shortening with cache hits and fallback
  - Integration tests reuse existing pattern from 002-whatsapp-alerts
  - URL shortening tests verify cache hits, Bitly failures, and fallback behavior
  - No TDD mandate imposed
  - No violations introduced

### IV. Review & Quality Gates ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - OpenAPI contract enables automated validation
  - PR will reference this plan and include test coverage
  - CI will run eslint + jest tests
  - New tests for URL shortening validate acceptance scenarios (SC-016 through SC-019)
  - No violations introduced

### V. Incremental Delivery & Semantic Versioning ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - Feature-gated with `ENABLE_NEWS_MONITOR=false` default
  - Optional enrichment is additional layer (can be enabled independently)
  - URL shortening is optional (disabled if `BITLY_API_KEY` not configured)
  - API versioned as v1 (/api/news-monitor)
  - No breaking changes to existing endpoints
  - No violations introduced

### Final Gate Decision: ✅ APPROVED FOR IMPLEMENTATION
All constitution principles remain met after design phase. Architecture is simple, testable, incrementally deliverable, and URL shortening feature integrates cleanly without complexity.

---

## Planning Phase Completion Summary

**Status**: ✅ COMPLETE (Updated November 1, 2025 for User Story 2b)
**Date**: October 31, 2025 (Updated November 1, 2025)
**Branch**: `003-news-monitor`

### Phase 0: Outline & Research ✅
- **research.md**: All NEEDS CLARIFICATION resolved
  - Azure AI Inference integration pattern documented
  - In-memory cache strategy defined
  - Gemini prompt strategy for event detection specified
  - Confidence scoring formula finalized
  - Parallel processing approach selected
  - Multi-channel notification strategy (reuse existing)
  - Binance integration approach (reuse with fallback)
  - Technology choices finalized (Gemini GoogleSearch, Azure AI Inference, Binance, Bitly/prettylink)
  - Open questions: None remaining

### Phase 1: Design & Contracts ✅
- **data-model.md**: 7 core entities documented with validation rules (including URLShortenerCache)
  - NewsAlert, MarketContext, CacheEntry, AnalysisResult, EnrichmentMetadata, NotificationDeliveryResult, URLShortenerCache
  - Request/response schemas defined
  - State transitions documented
  - Environment configuration specified (includes BITLY_API_KEY)
- **contracts/news-monitor.openapi.yml**: OpenAPI 3.0.3 specification complete
  - POST /api/news-monitor endpoint
  - GET /api/news-monitor endpoint (query params)
  - Complete request/response schemas with examples
  - Error responses (400, 403, 500)
  - Response includes URL shortening metadata (success flag)
- **quickstart.md**: Implementation guide complete
  - Installation instructions (includes prettylink)
  - Environment configuration (includes BITLY_API_KEY)
  - 4 usage examples (basic, default symbols, GET, cached)
  - Advanced configuration (Binance, LLM enrichment, threshold tuning, URL shortening)
  - Troubleshooting guide (including URL shortening fallback scenarios)
  - Scheduled monitoring examples (GitHub Actions, Render cron)
- **Agent context updated**: .github/copilot-instructions.md
  - Added Node.js 20.x
  - Added in-memory cache pattern
  - Added single-project structure context

### Artifacts Generated

```
specs/003-news-monitor/
 plan.md                         ✅ This file (planning output, updated Nov 1, 2025 for User Story 2b)
 research.md                     ✅ Phase 0 (7 research topics)                     
 data-model.md                   ✅ Phase 1 (7 entities + schemas including URLShortenerCache)
 quickstart.md                   ✅ Phase 1 (implementation guide with URL shortening config)
 spec.md                         ✅ Existing (input specification, updated Nov 1, 2025 with User Story 2b)
 contracts/
   └── news-monitor.openapi.yml  ✅ Phase 1 (API contract)
 checklists/
    └── requirements.md          ✅ Existing (quality checklist)
```

### Agent Context Updated
- **`.github/copilot-instructions.md`**: Updated to include User Story 2b guidance
  - URL shortening feature documented in 003-news-monitor section
  - Bitly integration patterns explained
  - URL shortening cache pattern described
  - Error handling for URL shortening failures explained
  - Where to look first for URL shortening debugging
  - Extension guide for adding new citation formatters

### Key Decisions

1. **Azure AI Integration**: `@azure-rest/ai-inference` + `@azure/core-auth` + `@azure/core-sse`
   - Lightweight REST client pattern
   - Flexible authentication (API key or Azure AD)
   - Streaming capable for future features

2. **Cache Strategy**: Simplest deduplication mechanism (JavaScript Map-based, TTL-aware)
   - No external dependencies or storage.
   - Cache key: `(symbol, event_category)`
   - 1hr TTL default (configurable) to deduplicate alerts

3. **Confidence Scoring**: Weighted formula + conservative enrichment
   - Confidence is computed as `confidence = (0.6 × event_significance + 0.4 × |sentiment|)` and, when optional LLM enrichment is enabled, the final confidence used for alerting is `min(gemini_confidence, llm_confidence)` to reduce false positives.
   - Conservative enrichment: `min(gemini, llm)` when enrichment enabled (favors precision) 
   - Threshold filtering (default: 0.7)

4. **Architecture**: Reuse existing services
   - Grounding service (Gemini)
   - Notification manager (Telegram + WhatsApp)
   - Retry helper (exponential backoff)
   - No new external dependencies for core functionality
  
5. **Single API call per webhook**: Reuse grounding results across channels (cost efficient, consistent context) 
   - Single Gemini GoogleSearch grounding call per incoming webhook
   - Results (summary, extracted sources, insight snippets) are attached to the alert object (e.g., `alert.enriched`) and reused for all notification channels (Telegram, WhatsApp) to keep cost and context consistent.

6. **Graceful degradation**: Enrichment failures and URL shortening failures do NOT block alert delivery (fail-open)
   - Any failure in Gemini grounding, optional LLM enrichment, external APIs (Binance/Bitly), or notification channels is logged and degrades gracefully
  -  Alerts still get delivered using best-effort data (original text or title-only citations), and errors are surfaced to admin channels when configured.

7. **Feature flags**: Three independent toggles (ENABLE_NEWS_MONITOR, ENABLE_BINANCE_PRICE_CHECK, ENABLE_LLM_ALERT_ENRICHMENT)
   - Feature gating remains: `ENABLE_NEWS_MONITOR`, `ENABLE_BINANCE_PRICE_CHECK`, `ENABLE_LLM_ALERT_ENRICHMENT` control the major flows
   - URL shortening is optional and enabled only when a valid `BITLY_API_KEY` (or equivalent Bitly credential used by `prettylink`) is present.

8. **Timeout strategy**: Aggressive budgets (Binance ~5s, Gemini ~30s, LLM ~20s, Bitly ~5s, batch total 60s)
   - Overall per-symbol/batch analysis budget is 60s. 
   - External calls use retry with exponential backoff (default 3 attempts) but must still respect the overall timeout budget.

7. **URL Shortening** (NEW for User Story 2b): 
  - Optional feature controlled by presence of `BITLY_API_KEY`
  - Uses `prettylink` npm package to wrap Bitly API
  - Session-scoped in-memory cache prevents redundant API calls for duplicate sources (originalUrl → shortUrl map; in-memory only, resets on process restart)
  - Graceful fallback to title-only citations if Bitly unavailable, rate-limited, or shortening fails (shortening failures logged at INFO; alert delivery proceeds)
  - Reduces WhatsApp message size for enriched alerts (typical enriched payloads drop from ~25K chars to under ~10K chars when citations are shortened)
  - Per-symbol 30s timeout budget accounts for shortening latency (shortening typically <1s per citation; Bitly calls use a ~5s timeout and 3 retries with backoff)
  - Implementation notes (for engineers): validate `prettylink` responses, de-duplicate source URLs before calling Bitly, and include shortening metadata (success flag, shortUrl) in alert response payload for observability

### Ready for Implementation (Phase 2)

**Next Command**: `/speckit.tasks` to generate tasks.md with implementation breakdown

**Implementation Highlights**:
- New controllers: `src/controllers/webhooks/handlers/newsMonitor/` (including urlShortener.js)
- New services: `src/services/inference/` (Azure AI client) + URL shortening utility
- Update services: `src/services/notification/WhatsAppService.js` (URL shortening integration)
- New routes: Register `/api/news-monitor` in `src/routes/index.js`
- New tests: Integration tests for endpoint, enrichment, cache, URL shortening
- Update: `package.json` to add Azure dependencies + prettylink

**Feature Flags**:
- `ENABLE_NEWS_MONITOR=false` (default, safe rollout)
- `ENABLE_BINANCE_PRICE_CHECK=false` (default, Gemini-only prices)
- `ENABLE_LLM_ALERT_ENRICHMENT=false` (default, backward compatible)
- `BITLY_API_KEY` (optional, if provided enables URL shortening for WhatsApp)

---

**Planning Command Completed Successfully** ✅  
All constitution gates passed. Architecture approved for implementation (including User Story 2b URL shortening).

---

**End of plan.md (Updated November 1, 2025 for User Story 2b)**
