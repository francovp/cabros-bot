# Implementation Plan: News Monitoring with Sentiment Analysis and Alert Distribution

**Branch**: `003-news-monitor` | **Date**: October 31, 2025 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/003-news-monitor/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

This feature implements an HTTP endpoint (`/api/news-monitor`) that analyzes news and market sentiment for crypto and stock symbols using Gemini GoogleSearch grounding service. The system detects significant market events (price movements, public figure mentions, regulatory announcements), assigns confidence scores, and sends filtered alerts simultaneously to Telegram and WhatsApp channels. Optional secondary LLM enrichment (using Azure AI Inference with Gemini models) can refine confidence scores when enabled. The system includes intelligent deduplication via in-memory cache (6hr TTL), optional Binance integration for precise crypto prices, and parallel symbol analysis with aggressive timeout handling.

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

**Storage**: In-memory cache for news deduplication (Map-based, TTL-aware, no persistence required)  
**Testing**: Jest ^30.2.0 with supertest ^7.1.4 for integration tests; minimal test coverage per constitution (critical paths + regressions)  
**Target Platform**: Linux server (Render.com cloud hosting, Docker container via devcontainer)  
**Project Type**: Single-project (existing Express REST API + Telegram bot)  
**Performance Goals**: 
- 30s total timeout per batch of symbols
- Parallel symbol analysis (10+ concurrent symbols)
- <5s response time for cached results
- Support 10 concurrent endpoint requests without degradation

**Constraints**: 
- Must not block existing bot functionality when `ENABLE_NEWS_MONITOR=false`
- Aggressive timeouts: Binance ~5s, Gemini ~20s, optional LLM enrichment ~10s per symbol
- Graceful degradation: notification channel failures do not block HTTP response
- Conservative confidence selection when enrichment is enabled (min of Gemini + LLM scores)

**Scale/Scope**: 
- 10-50 symbols per request typical (crypto + stocks combined)
- 6hr cache TTL per (symbol, event_category) pair
- 3 event categories: price_surge, price_decline, public_figure, regulatory
- 2 notification channels: Telegram, WhatsApp (via existing notification manager)

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

### I. Code Quality & Readability ✅
- **Status**: COMPLIANT
- **Rationale**: Feature uses existing patterns (notification manager, grounding service, retry helper). New code will follow clear naming, small focused functions, and modular service layer.

### II. Simplicity & Minimalism ✅
- **Status**: COMPLIANT
- **Rationale**: Implements simplest solution that meets requirements:
  - Reuses existing services (grounding, notification manager, retry helper)
  - In-memory cache (no external storage dependency)
  - Optional LLM enrichment disabled by default (backward compatible)
  - No premature abstraction (direct Gemini + optional Azure AI calls)

### III. Testing Policy (No TDD Mandate) ✅
- **Status**: COMPLIANT
- **Rationale**: Tests required for critical logic:
  - Core analysis flow (Gemini response parsing, confidence scoring)
  - Deduplication logic (cache key generation, TTL enforcement)
  - Optional enrichment (fallback when disabled/unavailable)
  - Integration tests for multi-channel delivery (existing pattern from 002-whatsapp-alerts)
  - No TDD mandate; tests can be written after implementation

### IV. Review & Quality Gates ✅
- **Status**: COMPLIANT
- **Rationale**: Feature follows existing PR workflow:
  - PR will reference this spec/plan
  - CI runs eslint, jest tests, and coverage checks
  - Integration tests cover endpoint behavior, notification delivery, and enrichment

### V. Incremental Delivery & Semantic Versioning ✅
- **Status**: COMPLIANT
- **Rationale**: Feature is feature-gated (`ENABLE_NEWS_MONITOR=false` by default):
  - Can be enabled incrementally in production
  - Optional enrichment is additional layer (`ENABLE_LLM_ALERT_ENRICHMENT=false` by default)
  - No breaking changes to existing bot or alert webhook
  - Follows semantic versioning for API contracts (v1 endpoint)

### Gate Decision: ✅ PROCEED TO PHASE 0
All constitution principles are met. No violations requiring justification.

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
│           └── cache.js                              # In-memory deduplication cache
├── services/
│   ├── grounding/                                    # Existing Gemini grounding service
│   │   ├── gemini.js                                 # Reuse for news sentiment analysis
│   │   ├── genaiClient.js                            # Existing Gemini client
│   │   └── config.js
│   ├── notification/                                 # Existing multi-channel notification
│   │   ├── NotificationManager.js                    # Reuse for alert delivery
│   │   ├── TelegramService.js
│   │   ├── WhatsAppService.js
│   │   └── formatters/
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
│   └── news-monitor-cache.test.js                    # NEW: Deduplication logic
└── unit/
    ├── analyzer.test.js                              # NEW: Symbol analysis unit tests
    ├── enrichment.test.js                            # NEW: Enrichment service unit tests
    └── cache.test.js                                 # NEW: Cache logic unit tests
```

**Structure Decision**: This feature extends the existing single-project Express application. It follows the established pattern of controllers/webhooks/handlers for HTTP endpoints, reuses existing services (grounding, notification, retry logic), and adds a new Azure AI Inference service layer for optional enrichment. Tests follow the existing integration/ and unit/ split. No architectural changes required.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

**No violations detected** - All constitution principles met. No complexity tracking required.

## Post-Design Constitution Re-Check

*Re-evaluated after Phase 1 design artifacts (research.md, data-model.md, contracts/, quickstart.md) are complete.*

### I. Code Quality & Readability ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - Data model uses clear entity names (NewsAlert, MarketContext, CacheEntry)
  - API contract follows REST conventions with explicit schemas
  - Service layer separated by concern (analyzer, enrichment, cache)
  - No violations introduced

### II. Simplicity & Minimalism ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - In-memory Map cache is simplest solution (no external dependencies)
  - Reuses existing services (grounding, notification manager, retry helper)
  - Optional enrichment disabled by default (backward compatible)
  - No premature abstraction (direct API calls, no unnecessary layers)
  - No violations introduced

### III. Testing Policy (No TDD Mandate) ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - Test strategy defined in quickstart.md (unit + integration)
  - Critical paths identified: confidence scoring, deduplication, enrichment fallback
  - Integration tests reuse existing pattern from 002-whatsapp-alerts
  - No TDD mandate imposed
  - No violations introduced

### IV. Review & Quality Gates ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - OpenAPI contract enables automated validation
  - PR will reference this plan and include test coverage
  - CI will run eslint + jest tests
  - No violations introduced

### V. Incremental Delivery & Semantic Versioning ✅
- **Status**: COMPLIANT
- **Design Review**: 
  - Feature-gated with `ENABLE_NEWS_MONITOR=false` default
  - Optional enrichment is additional layer (can be enabled independently)
  - API versioned as v1 (/api/news-monitor)
  - No breaking changes to existing endpoints
  - No violations introduced

### Final Gate Decision: ✅ APPROVED FOR IMPLEMENTATION
All constitution principles remain met after design phase. Architecture is simple, testable, and incrementally deliverable.

---

## Planning Phase Completion Summary

**Status**: ✅ COMPLETE  
**Date**: October 31, 2025  
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

### Phase 1: Design & Contracts ✅
- **data-model.md**: 6 core entities documented with validation rules
  - NewsAlert, MarketContext, CacheEntry, AnalysisResult, EnrichmentMetadata, NotificationDeliveryResult
  - Request/response schemas defined
  - State transitions documented
  - Environment configuration specified
- **contracts/news-monitor.openapi.yml**: OpenAPI 3.0.3 specification complete
  - POST /api/news-monitor endpoint
  - GET /api/news-monitor endpoint (query params)
  - Complete request/response schemas with examples
  - Error responses (400, 403, 500)
- **quickstart.md**: Implementation guide complete
  - Installation instructions
  - Environment configuration
  - 4 usage examples (basic, default symbols, GET, cached)
  - Advanced configuration (Binance, LLM enrichment, threshold tuning)
  - Troubleshooting guide
  - Scheduled monitoring examples (GitHub Actions, Render cron)
- **Agent context updated**: .github/copilot-instructions.md
  - Added Node.js 20.x
  - Added in-memory cache pattern
  - Added single-project structure context

### Artifacts Generated

```
specs/003-news-monitor/
 plan.md                         ✅ This file (planning output)
 research.md Phase 0 (7 research topics)                     
 data-model.md                   ✅ Phase 1 (6 entities + schemas)
 quickstart.md                   ✅ Phase 1 (implementation guide)
 spec.md                         ✅ Existing (input specification)
 contracts/
   └── news-monitor.openapi.yml   ✅ Phase 1 (API contract)
 checklists/
    └── requirements.md             ✅ Existing (quality checklist)
```

### Key Decisions

1. **Azure AI Integration**: `@azure-rest/ai-inference` + `@azure/core-auth` + `@azure/core-sse`
   - Lightweight REST client pattern
   - Flexible authentication (API key or Azure AD)
   - Streaming capable for future features

2. **Cache Strategy**: JavaScript Map with custom TTL
   - No external dependencies
   - Cache key: `(symbol, event_category)`
   - 6hr TTL default (configurable)

3. **Confidence Scoring**: `confidence = (0.6 × event_significance + 0.4 × |sentiment|)`
   - Conservative enrichment: `min(gemini, llm)`
   - Threshold filtering (default: 0.7)

4. **Architecture**: Reuse existing services
   - Grounding service (Gemini)
   - Notification manager (Telegram + WhatsApp)
   - Retry helper (exponential backoff)
   - No new external dependencies for core functionality

### Ready for Implementation (Phase 2)

**Next Command**: `/speckit.tasks` to generate tasks.md with implementation breakdown

**Implementation Highlights**:
- New controllers: `src/controllers/webhooks/handlers/newsMonitor/`
- New services: `src/services/inference/` (Azure AI client)
- New routes: Register `/api/news-monitor` in `src/routes/index.js`
- New tests: Integration tests for endpoint, enrichment, cache
- Update: `package.json` to add Azure dependencies

**Feature Flags**:
- `ENABLE_NEWS_MONITOR=false` (default, safe rollout)
- `ENABLE_BINANCE_PRICE_CHECK=false` (default, Gemini-only prices)
- `ENABLE_LLM_ALERT_ENRICHMENT=false` (default, backward compatible)

---

**Planning Command Completed Successfully** ✅  
All constitution gates passed. Architecture approved for implementation.
