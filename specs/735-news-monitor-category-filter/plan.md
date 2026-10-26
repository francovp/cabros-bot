# Implementation Plan: Event Category Filtering for News Monitor (Issue #735)

## Phase 1: Constants & Request Parsing/Validation
- Export `ALLOWED_EVENT_CATEGORIES` in `src/controllers/webhooks/handlers/newsMonitor/constants.js`.
- Update `parsePostRequest` and `parseGetRequest` in `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js` to extract `categories`.
- Add `validateCategories(categories)` in `newsMonitor.js` ensuring:
  - If omitted/undefined -> valid.
  - If provided -> must be an array of non-empty strings, length > 0, matching `ALLOWED_EVENT_CATEGORIES` (case-insensitive).
  - Invalid values return HTTP 400 with a descriptive error message and code `INVALID_REQUEST`.

## Phase 2: Analyzer Delivery Filtering & Cache Preservation
- Pass `categories` into `options` when `handleRequest` calls `analyzer.analyzeSymbols`.
- In `src/controllers/webhooks/handlers/newsMonitor/analyzer.js`:
  - In `analyzeSymbolInternal`:
    - Cache lookup: if `options.categories` is specified and a cached alert belongs to a category not in `options.categories`, return `{ status: AnalysisStatus.CACHED, alert: null, deliveryResults: [], cached: true, ... }` without calling Gemini.
    - Post-analysis: after Gemini returns and `alert` is built:
      - If `options.categories` does not include `alert.eventCategory`, cache the detected event under its true category, but return `{ status: AnalysisStatus.ANALYZED, alert: null, deliveryResults: [], cached: false, analysisRecord: { ..., alertSent: false } }`.
      - Suppress `_pendingDelivery` so `applyVolumeThrottling` does not deliver notifications.

## Phase 3: Tests (TDD)
- Unit tests:
  - `tests/unit/news-monitor-categories.test.js`:
    - Valid and invalid category parsing/validation in `NewsMonitorHandler`.
    - 400 responses for unknown category, empty array, non-array, and `'none'`.
    - Analyzer post-filtering: alert suppressed when category does not match.
    - Cache hit filtering: cached alert suppressed when category does not match.
- Integration tests:
  - `tests/integration/news-monitor-categories.test.js`:
    - End-to-end `POST /api/news-monitor` with `categories: ['regulatory']` when Gemini returns `price_surge` -> 200, `alert: null`, 0 alerts sent.
    - End-to-end `POST /api/news-monitor` with `categories: ['price_surge']` when Gemini returns `price_surge` -> 200, alert delivered.
    - End-to-end `GET /api/news-monitor?categories=regulatory` filtering.
    - Invalid categories return 400.

## Phase 4: OpenAPI & Postman Contracts
- Update `src/openapi/openapi.json` for `GET` and `POST /api/news-monitor`.
- Update `CabrosBot.postman_collection.json` with category-filtered requests and validation variants.
- Verify `pnpm test -- tests/unit/postman-collection.test.js`.
- Run full test suite: `pnpm test`.
