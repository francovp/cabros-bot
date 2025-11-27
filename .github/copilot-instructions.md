## Quick orientation for AI coding agents

This project is a small Express + Telegraf (Telegram) bot service that exposes an HTTP webhook and a Telegram command interface.

Key files / entry points
- `index.js` — app entry. Starts Express server and conditionally launches the Telegraf bot. Important logic for enabling the bot lives here.
- `app.js` — Express app configuration (body parsing, CORS, helmet, healthcheck route).
- `src/routes/index.js` — registers routes (mounted under `/api` when the bot is enabled).
- `src/controllers/commands.js` — Telegram command handlers wired in `index.js` (`/precio`, `/cryptobot`).
- `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` — calls Binance `MainClient.getAvgPrice` to fetch prices.
- `src/controllers/webhooks/handlers/alert/alert.js` — webhook handler that forwards alert text to a Telegram chat.
- `src/controllers/helpers.js` — small numeric helper (`round10`) used by price formatting.

Environment and runtime behavior (discoverable)
- NODE version: `20.x` (see `package.json` engines).
- Required env vars: `BOT_TOKEN` (throws if missing). Optional but relevant: `ENABLE_TELEGRAM_BOT`, `PORT`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`, `RENDER`, `IS_PULL_REQUEST`, `RENDER_GIT_COMMIT`, `RENDER_GIT_REPO_SLUG`.
- Bot startup is gated: bot is launched only when `ENABLE_TELEGRAM_BOT === 'true'` and not a preview environment (`RENDER==='true' && IS_PULL_REQUEST==='true'` disables it).
- Routes under `/api` (e.g. `/api/webhook/alert`) are only mounted after the bot is launched.

Dev / run commands
- `npm install` — install deps.
- `npm start` — run production entry (`node index.js`).
- `npm run start-dev` — runs `nodemon index.js` for development.
- Healthcheck endpoint: `GET /healthcheck` (provided by `app.js`).

Patterns and conventions to follow
- Telegram command handlers receive `context` (Telegraf). Commands parse the full text with `context.message.text.split(' ')` and expect parameters at index 1. Example: `/precio BTCUSDT` where symbol = `messageSplited[1]`.
- When interacting with external APIs, handlers return Promises (resolve on success, reject on error). `fetchSymbolPrice` is async and returns `{ price, symbol }` when successful.
- Webhook `/api/webhook/alert` accepts either plain text (text/plain body) or JSON body with a `text` property. The handler sends messages with `parse_mode: 'MarkdownV2'` to `process.env.TELEGRAM_CHAT_ID`.
- Simple, explicit logging is used (`console.log`, `console.debug`, `console.error`) rather than a structured logger.

External integrations
- Binance: uses `binance` package `MainClient` and `getAvgPrice({ symbol })` (see `fetchPriceCryptoSymbol.js`). Responses are configured with `beautifyResponses: true`.
- Telegram: `telegraf` package; commands wired in `index.js` and direct `bot.telegram.sendMessage` used for alerts and admin notifications.

Common failure modes to check (based on code)
- Missing `BOT_TOKEN` throws on startup (explicit check in `index.js`).
- If `ENABLE_TELEGRAM_BOT` is not `'true'`, the bot and `/api` routes will not be available.
- Webhook failures will attempt to read `error.response` when building error responses; some external errors may not match that shape.

Small, concrete examples
- Get price via Telegram: send message `/precio BTCUSDT` -> handler calls `client.getAvgPrice({ symbol: 'BTCUSDT' })` and replies with `Precio de BTCUSDT es <price>`.
- Send a webhook alert (when bot enabled): POST to `/api/webhook/alert` with body `{ "text": "Alert body" }` or `text/plain` body `Alert body`.

What an AI code change should preserve
- Do not change how env gating works in `index.js` without adjusting tests/deploys — deployments rely on `RENDER` and `IS_PULL_REQUEST` checks.
- Keep the `parse_mode: 'MarkdownV2'` when composing Telegram messages unless escaping/formatting is implemented project-wide.

## Development Workflow for AI Agents

### When implementing a feature:

1. **Read the spec** (`specs/*/spec.md`) for requirements and user stories
2. **Check patterns** in this file for similar implementations
3. **Understand failure modes** (see Common Failure Modes sections)
4. **Follow existing code style**: Simple functions, explicit logging, env-driven config
5. **Add tests** for critical paths after implementation
6. **Run focused tests during development** (see Test Execution Strategy below)
7. **Update environment variables** section if adding new config
8. **Update .github/copilot-instructions.md** with new patterns/context
9. **Final full test run** before completion to ensure no regressions

**Linting and Commits During Implementation**:
- **Ignore linter issues during implementation**: Focus on feature functionality first; linter errors will be fixed in a dedicated final pass
- **Make commits with `--no-verify`**: Use `git commit --no-verify -m "message"` to bypass pre-commit hooks during development (prevents blocking on linter/test failures mid-implementation)
- **Final cleanup phase**: After all user stories are complete DO NOT run linting and formatting, it will be done manually
- **Rationale**: This approach maximizes development velocity during active feature work and prevents context-switching between implementation and linting

**Test Execution Strategy**:
- **During development**: Run focused/specific tests only, NOT the full test suite. Examples:
  - `npm test -- tests/unit/price-parsing.test.js` — test single unit file
  - `npm test -- tests/integration/news-monitor-basic.test.js` — test single integration file
  - `npm test -- tests/unit/ --testTimeout=5000` — test entire unit directory
  - `npm test -- --testNamePattern="should parse price"` — test by test name pattern
- **After completing all changes**: Run the full test suite `npm test` once per implementation to ensure no regressions
- **Rationale**: Full test runs take 2-5 minutes and consume significant token budget. Focused tests give rapid feedback (10-30s) during development. Only run full suite as final validation after full implementation phase.
- **Performance tip**: Use `--testTimeout=5000` with unit tests to speed up execution; integration tests need higher timeouts (~10000ms)

### When extending a feature:

1. **Locate entry points** (see "Where to look first" sections)
2. **Trace data flow** through service layer
3. **Identify dependencies** (other services, external APIs, env vars)
4. **Add feature flag** if feature is optional
5. **Implement graceful fallback** (don't break alert delivery)
6. **Update documentation** (README for users, copilot-instructions for developers)

### When debugging:

1. **Check logs**: stdout for startup/shutdown, debug for processing steps, error for failures
2. **Verify env vars**: Feature might be disabled or misconfigured
3. **Test external APIs**: Check Gemini, Binance, Telegram, WhatsApp directly
4. **Review test cases**: Existing tests reveal expected behavior
5. **Check retry logic**: Some failures are transient and auto-recover

## Alert Enrichment with Gemini Grounding (001-gemini-grounding-alert)

The system provides optional enrichment of webhook alerts using Google Gemini API with GoogleSearch grounding to fetch verified sources and context.

**Core Components** (`src/services/grounding/` and `src/controllers/webhooks/handlers/alert/`):
- `grounding.js` — Orchestrates Gemini GoogleSearch grounding to fetch context and sources
- `genaiClient.js` — Wrapper around Google Generative AI client
- `gemini.js` — Gemini API configuration and prompt management
- `alert.js` — Webhook handler that optionally calls grounding service

**Grounding Service Pattern**:
- Enabled via `ENABLE_GEMINI_GROUNDING=true` (default: false)
- Makes single Gemini API call with GoogleSearch grounding enabled
- Returns structured response with summary and sources (URLs with titles)
- Graceful degradation: if grounding fails (API error, timeout), sends original alert text and logs warning (does NOT block alert delivery)

**Alert Enrichment Flow**:
1. Webhook receives alert text (plain or JSON body with `text` property)
2. If `ENABLE_GEMINI_GROUNDING=true`, call grounding service to fetch context
3. Grounding service queries Gemini with alert text + system prompt + GoogleSearch results
4. Gemini returns summary, extracted sources (URLs + titles), and key insights
5. Enriched alert stored as `alert.enriched` object with structure: `{ summary, sources, insights, original_text }`
6. Original `alert.text` preserved for fallback
7. Enhanced alert sent to all enabled notification channels
8. Webhook response includes `enriched: true/false` flag to indicate if enrichment was applied

**Configuration**:
- `ENABLE_GEMINI_GROUNDING` — Feature flag (default: false)
- `GEMINI_API_KEY` — Google API key with Generative AI enabled
- Implicit: `ENABLE_TELEGRAM_BOT` must be true for grounding to be initialized

**Enrichment Strategy**:
- Single grounding call per alert (results reused across all notification channels)
- Reuses same alert object for both Telegram and WhatsApp delivery
- Each channel formats the enriched alert appropriately (see 002-whatsapp-alerts for formatting)
- Graceful fallback: enrichment errors do NOT prevent alert delivery

**Timeout & Retry**:
- Grounding API calls use `retryHelper.sendWithRetry()` with 3 retries and exponential backoff
- Timeout: ~8 seconds per call (configurable in grounding service)
- If timeout exceeded, returns original alert text with warning

**Common Failure Modes**:
- Missing `GEMINI_API_KEY` when `ENABLE_GEMINI_GROUNDING=true` → error logged at startup
- Gemini API unavailable or rate-limited → fallback to original text + warning log
- Alert text too long (>4000 chars) → may be truncated by Gemini to avoid cost overruns
- Non-English alert text → Gemini respects language; returns summary in same language if possible

**Where to look first when extending or debugging**:
- `index.js` for lifecycle (calls initializeGroundingService if ENABLE_GEMINI_GROUNDING=true)
- `src/services/grounding/grounding.js` for orchestration logic and timeout handling
- `src/controllers/webhooks/handlers/alert/alert.js` for webhook flow and grounding integration
- `src/services/grounding/gemini.js` for prompt templates and response parsing
- Tests in `tests/integration/alert-grounding.test.js` for end-to-end behavior
- Tests in `tests/unit/grounding.test.js` and `tests/unit/gemini-client.test.js` for core logic

## Multi-Channel Notification Architecture (002-whatsapp-alerts)

The alert delivery system now supports parallel delivery to multiple channels (Telegram, WhatsApp) without blocking. Key patterns:

**Service Layer** (`src/services/notification/`):
- `NotificationChannel.js` — Abstract base class defining send(alert), validate(), isEnabled() contract
- `TelegramService.js` — Wraps Telegraf bot.telegram.sendMessage() with MarkdownV2 parsing
- `WhatsAppService.js` — GreenAPI integration with message truncation (20K chars), 10s timeout, retry logic
- `NotificationManager.js` — Orchestrates: validateAll() at startup, sendToAll() in parallel via Promise.allSettled()

**Formatting** (`src/services/notification/formatters/`):
- `MarkdownV2Formatter.js` — Escapes special chars (_ * [ ] ( ) ~ ` > # + - = | { } . !) for Telegram; preserves link URLs
- `WhatsAppMarkdownFormatter.js` — Strips unsupported syntax (links → plain text, underline removed); logs conversions

**Retry Logic** (`src/lib/retryHelper.js`):
- sendWithRetry(sendFn, maxRetries=3, logger) with exponential backoff (1s, 2s, 4s) + ±10% jitter
- Per-channel retry (one channel failure doesn't block others)
- Returns SendResult { success, channel, messageId?, error?, attemptCount, durationMs }

**Alert Flow**:
1. Webhook receives text (plain or JSON)
2. Optional Gemini enrichment (stored in alert.enriched) — single call, reused across channels
3. notificationManager.sendToAll(alert) fires in parallel
4. Returns 200 OK with per-channel results (fail-open pattern)

**Configuration**:
- WhatsApp disabled by default (ENABLE_WHATSAPP_ALERTS=false for backward compat)
- Requires: WHATSAPP_API_URL, WHATSAPP_API_KEY, WHATSAPP_CHAT_ID (format: 120363xxxxx@g.us)
- Telegram requires existing: BOT_TOKEN, TELEGRAM_CHAT_ID

**Extending**:
- Add new channel: Create class extending NotificationChannel, implement send(), validate(), isEnabled()
- Register in NotificationManager constructor
- Create tests in tests/unit/ and tests/integration/

Where to look first when extending or debugging
- `index.js` for lifecycle and bot wiring (calls initializeNotificationServices after bot.launch)
- `src/controllers/webhooks/handlers/alert/alert.js` for webhook flow and notificationManager.sendToAll()
- `src/services/notification/NotificationManager.js` for parallel send orchestration
- `src/services/notification/WhatsAppService.js` for retry logic, GreenAPI integration, truncation
- `src/lib/retryHelper.js` for exponential backoff timing
- Tests in `tests/integration/` for multi-channel scenarios (dual-channel, config validation, graceful degradation)

If anything in this file is unclear or you want more examples (tests, extra command patterns, or a CI/dev workflow), tell me which area to expand and I'll iterate.

## News Monitoring with Sentiment Analysis (003-news-monitor)

The system provides an HTTP endpoint (`/api/news-monitor`) that analyzes financial news and market sentiment for crypto and stock symbols, detects significant trading events, and delivers alerts via configured channels.

**Core Components** (`src/controllers/webhooks/handlers/newsMonitor/`):
- `newsMonitor.js` — Main HTTP endpoint handler (POST/GET at `/api/news-monitor`)
- `analyzer.js` — Symbol analysis orchestrator; handles parallel processing and timeouts
- `enrichment.js` — Optional secondary LLM enrichment service (via Azure AI Inference)
- `cache.js` — In-memory deduplication cache with TTL (default: 6 hours per symbol/event-category pair)
- `urlShortener.js` — URL shortening utility for WhatsApp citations (uses prettylink for supported services, direct API calls for unsupported)

**Grounding Service Integration** (`src/services/grounding/`):
- Reuses existing Gemini GoogleSearch grounding for **both** market sentiment analysis (`analyzeNewsForSymbol`) and price fetching (`fetchGeminiPrice`)
- **News Analysis** (`analyzeNewsForSymbol`): Fetches `"${symbol} news market sentiment events today"` → returns structured `{ event_category, event_significance, sentiment_score, sources }` (preferred) or unstructured text with fallback parsing
- **Price Fetching** (`fetchGeminiPrice`): Fetches `"current price of ${symbol} today"` → extracts numeric price and 24h change % from grounded search snippets using regex patterns; parses price (pattern: `$123.45` or `123.45 USD`), change (pattern: `+5.2% 24h`), and gracefully returns null/empty context if parsing fails
- Supports event categories: `price_surge` (bullish), `price_decline` (bearish), `public_figure` (mentions), `regulatory` (official statements)
- Graceful degradation: If Gemini search fails or timeout exceeded, system returns analysis/price without market context (alerts still sent based on news sentiment alone)

**Optional Binance Integration**:
- When `ENABLE_BINANCE_PRICE_CHECK=true`, fetches precise crypto prices from Binance API (~5s timeout)
- Falls back to Gemini GoogleSearch for price context if Binance unavailable or symbol is not crypto
- Does not validate symbol classification; requester responsible for correct crypto/stocks separation

**Alert Flow**:
1. Endpoint receives request with crypto and stock symbol arrays (or defaults from `NEWS_SYMBOLS_CRYPTO`/`NEWS_SYMBOLS_STOCKS` env vars)
2. Symbols analyzed in parallel; each symbol has 30s timeout budget
3. Gemini extracts market context and sentiment; confidence score calculated: `confidence = (0.6 × event_significance + 0.4 × |sentiment|)`
4. Optional LLM enrichment (if `ENABLE_LLM_ALERT_ENRICHMENT=true`) refines confidence using conservative strategy: `min(gemini_confidence, llm_confidence)`
5. Alerts filtered by `NEWS_ALERT_THRESHOLD` (default: 0.7)
6. Deduplicated: cache key is `(symbol, event_category)`. Same category within TTL prevents duplicate alerts; different categories generate separate alerts
7. **URL shortening applied to WhatsApp citations** (if `URL_SHORTENER_SERVICE` configured): Uses prettylink for supported services, direct API calls for unsupported; falls back to title-only if shortening fails
8. Filtered alerts sent to all enabled channels (Telegram, WhatsApp) via existing NotificationManager in parallel
9. Returns 200 OK with per-symbol results: status (analyzed/cached/timeout/error), detected alerts, delivery results, metadata (totalDurationMs, cached, requestId)

**Configuration**:
- `ENABLE_NEWS_MONITOR` — Feature flag (default: false for safe rollout)
- `NEWS_SYMBOLS_CRYPTO` — Default crypto symbols if not provided in request (comma-separated, e.g., "BTCUSDT,ETHUSD")
- `NEWS_SYMBOLS_STOCKS` — Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` — Confidence score threshold (default: 0.7, range 0.0-1.0)
- `NEWS_CACHE_TTL_HOURS` — Cache time-to-live (default: 6 hours)
- `NEWS_TIMEOUT_MS` — Per-symbol analysis timeout (default: 30000 ms)
- `ENABLE_BINANCE_PRICE_CHECK` — Enable Binance crypto price fetching (default: false)
- `ENABLE_LLM_ALERT_ENRICHMENT` — Enable optional secondary LLM enrichment (default: false)
- `URL_SHORTENER_SERVICE` — URL shortening service for WhatsApp citations (default: 'bitly', options: 'bitly', 'tinyurl', 'picsee', 'reurl', 'cuttly', 'pixnet0rz.tw')
- Service-specific tokens: `BITLY_ACCESS_TOKEN`, `TINYURL_API_KEY`, etc. (some services don't require tokens)
- Azure AI Inference (if enrichment enabled): `AZURE_LLM_ENDPOINT`, `AZURE_LLM_KEY`, `AZURE_LLM_MODEL`

**Timeout Strategy**:
- Binance fetch: ~5s timeout (aggressive)
- Gemini/GoogleSearch: ~20s timeout (generous fallback)
- Optional LLM enrichment: ~10s timeout per symbol
- URL shortening: ~5s timeout per call (with 3 retries)
- Per-symbol total: 30s (accounts for worst-case retry scenarios with exponential backoff)
- Batch response: waits up to 30s total; returns partial results if some symbols timeout

**Retry Logic** (reuses `src/lib/retryHelper.js`):
- Binance: 3 retries with exponential backoff (1s, 2s, 4s) + ±10% jitter
- Gemini: 3 retries with exponential backoff
- Optional LLM enrichment: 3 retries (independent from analysis; failure doesn't block alert)
- URL shortening: 3 retries with exponential backoff (independent; failure falls back to title-only)
- Telegram/WhatsApp: 3 retries (reuse existing notification retry logic)

**Cache Deduplication**:
- In-memory Map cache; key is JSON stringified `(symbol, event_category)` tuple
- Value: `{ alert, timestamp, enrichment_data (if applicable) }`
- TTL enforced on read; expired entries evicted automatically
- Different event categories for same symbol bypass cache (separate alerts per category)

**Extending**:
- Add new event category: Update Gemini prompt in `analyzer.js` to detect and tag new category
- Add new LLM model for enrichment: Create new service in `src/services/inference/` extending pattern from `enrichmentService.js`
- Add new URL shortening service: Extend `urlShortener.js` to support new service via prettylink or direct API calls
- Add new notification channel: Extend NotificationChannel in `src/services/notification/` and register in NotificationManager (existing pattern)

**Where to look first when extending or debugging**:
- `index.js` for lifecycle (calls initializeNewsMonitor after bot.launch if `ENABLE_NEWS_MONITOR=true`)
- `src/routes/index.js` for `/api/news-monitor` route registration
- `src/controllers/webhooks/handlers/newsMonitor/analyzer.js` for Gemini prompts, confidence formula, and timeout orchestration
- `src/controllers/webhooks/handlers/newsMonitor/cache.js` for deduplication logic and TTL management
- `src/controllers/webhooks/handlers/newsMonitor/urlShortener.js` for URL shortening logic and cache
- `src/services/inference/enrichmentService.js` for secondary LLM enrichment and conservative confidence selection
- Tests in `tests/integration/news-monitor-*.test.js` for endpoint behavior, caching, enrichment fallback
- Tests in `tests/unit/analyzer.test.js`, `tests/unit/cache.test.js`, `tests/unit/url-shortener.test.js` for core logic

## Active Technologies
- Node.js 20.x (from package.json engines) + Express 4.17+, telegraf 4.3+; NO new HTTP client (use native fetch)
- GreenAPI for WhatsApp (REST API integration via native fetch with AbortController timeout)
- Google Gemini for optional alert enrichment (existing integration in grounding service) and news sentiment analysis (003-news-monitor)
- Azure AI Inference REST client for optional secondary LLM enrichment (003-news-monitor, disabled by default)
- prettylink npm package for URL shortening in WhatsApp citations (003-news-monitor, with fallback to direct API calls)
- In-memory Map cache for news deduplication with TTL (003-news-monitor, no external storage)
- Binance API client for precise crypto prices (003-news-monitor, optional fallback to Gemini GoogleSearch)
- Sentry SDK for Node (`@sentry/node` v8) for backend runtime error monitoring (005-sentry-runtime-errors; error events only, no tracing by default)

## Terminology Guide: Grounding vs Enrichment

The system uses two complementary terms with specific meanings:

### **Grounding** (Technical Term)
- Refers to **Google's Grounding Tools API** and GoogleSearch integration
- Used in internal service architecture: `/src/services/grounding/`
- Implementation detail: how we fetch verified sources and context
- Example: `ENABLE_GEMINI_GROUNDING` env var, `groundingService.enrich()` method

### **Enrichment** (User-Facing Term)
- Refers to the **user value delivered**: alerts enhanced with context and sources
- Used in alerts, documentation, and user messaging
- Business concept: traders receive enriched data for better decisions
- Example: `alert.enriched` data structure, "enriched alerts" in README

### Key Mapping

| Feature | Technical Service | User Benefit | Env Var |
|---------|-------------------|--------------|---------|
| 001 | Grounding (Gemini) | Enriched alerts with sources | ENABLE_GEMINI_GROUNDING |
| 002 | NotificationManager | Enriched alerts on WhatsApp | ENABLE_WHATSAPP_ALERTS |
| 003 | News analysis + Grounding | Enriched news alerts | ENABLE_NEWS_MONITOR |
| 004 (future) | LLM refinement | Enriched confidence scoring | ENABLE_LLM_ALERT_ENRICHMENT |

### Usage Guidelines

**When documenting or adding features:**
- Use **"grounding"** when describing technical implementation details
- Use **"enrichment"** when describing user-facing features or data structures
- Keep `ENABLE_GEMINI_GROUNDING` as-is (Gemini-specific flag name)
- Use `alert.enriched` for all enrichment data (agnostic to method)

**For new services (e.g., Feature 004):**
- Don't create new grounding service unless using Google's Grounding Tools API
- All enrichment methods contribute to the same `alert.enriched` data
- This approach allows switching enrichment providers without breaking alerts

See `/specs/TERMINOLOGY_GUIDE.md` for extended discussion and examples.


## Recent Changes
- 001-gemini-grounding-alert: Added Gemini GoogleSearch grounding integration for alert enrichment; retrieves verified sources and context; graceful degradation on API failure; reuses single grounding call across notification channels
- 002-whatsapp-alerts: Added multi-channel notification system with TelegramService, WhatsAppService, NotificationManager; exponential backoff retry logic; MarkdownV2 and WhatsApp markdown formatters; comprehensive integration tests for parallel delivery, config validation, graceful degradation
- 003-news-monitor: Added `/api/news-monitor` endpoint for financial news analysis and sentiment-based alerts; Gemini GoogleSearch integration for market context; optional secondary LLM enrichment via Azure AI Inference; in-memory deduplication cache; optional Binance price integration; parallel symbol analysis with timeout management; configurable event detection (price_surge, price_decline, public_figure, regulatory); URL shortening for WhatsApp citations using prettylink package for supported services and direct API calls for unsupported services

## Architectural Patterns & Extension Guide

### Multi-Channel Notification Pattern (002)

**Core Pattern**: Abstract channel + concrete implementations + manager orchestrator

```
NotificationChannel (abstract)
├── TelegramService (concrete)
├── WhatsAppService (concrete)
└── [Future channels]

NotificationManager
├── validateAll() at startup
└── sendToAll() in parallel
```

**To add a new channel**:
1. Create class extending `NotificationChannel` in `src/services/notification/`
2. Implement: `send(alert)`, `validate()`, `isEnabled()`
3. Create formatter in `src/services/notification/formatters/` if needed
4. Register in `NotificationManager` constructor
5. Add env vars for configuration
6. Add unit tests in `tests/unit/`
7. Add integration tests in `tests/integration/`

**Example: SMS Channel**:
```javascript
class SMSService extends NotificationChannel {
  send(alert) { /* Use AWS SNS or Twilio */ }
  validate() { /* Check credentials */ }
  isEnabled() { return process.env.ENABLE_SMS_ALERTS === 'true'; }
}
```

### Grounding Service Pattern (001, 003)

**Core Pattern**: Reusable Gemini + GoogleSearch orchestrator with graceful degradation

**Usage locations**:
- Alert enrichment (001): Single call per webhook
- News sentiment analysis (003): Single call per symbol

**To extend**:
1. **New prompt strategy**: Update `src/services/grounding/gemini.js` system prompt
2. **New response format**: Modify parser in `src/services/grounding/grounding.js`
3. **New use case**: Reuse `grounding.js` via existing `genaiClient.js` wrapper

**Key design principles**:
- Single API call (cost-efficient, results reused across channels)
- Graceful fallback to original text (never blocks delivery)
- Structured response parsing with unstructured fallback
- Timeout budgets strictly enforced (~8s for alerts, ~20s for news)

### Event Detection Pattern (003)

**Core Pattern**: Gemini prompt → confidence scoring → threshold filtering → caching → delivery

**Event categories**: `price_surge`, `price_decline`, `public_figure`, `regulatory`

**To add new category**:
1. Update Gemini prompt in `src/controllers/webhooks/handlers/newsMonitor/analyzer.js`
2. Extend event detection logic to tag new category
3. Update confidence scoring if different weight needed: `confidence = (0.6 × significance + 0.4 × |sentiment|)`
4. Update cache key generation (includes event_category)
5. Add tests for new category detection

**Confidence Formula**:
```
confidence = (0.6 × event_significance + 0.4 × |sentiment|)
```
- Conservative: favors precision (lower threshold for delivery)
- Adjustable: Modify weights or thresholds via `NEWS_ALERT_THRESHOLD` env var

### In-Memory Cache Pattern (003)

**Core Pattern**: Map-based cache with TTL enforcement and key deduplication

**Cache key strategy**: `(symbol, event_category)` tuple
- Same category = deduplicated
- Different categories = separate entries
- Efficient: O(1) lookup, manual TTL cleanup

**To extend**:
1. Add new cache dimensions: Modify key generation in `src/controllers/webhooks/handlers/newsMonitor/cache.js`
2. Persistent cache (Phase 2): Replace Map with Redis/MongoDB while keeping same interface
3. Cache metrics: Add tracking for hit/miss rates (debug only)

### Retry Logic Pattern (All features)

**Core Pattern**: Exponential backoff with jitter via `src/lib/retryHelper.js`

```javascript
retryHelper.sendWithRetry(
  async () => { /* API call */ },
  maxRetries = 3,
  logger = console
)
```

**Returns**: `{ success, channel, messageId?, error?, attemptCount, durationMs }`

**To extend**:
1. **New retry strategy**: Update `retryHelper.js` backoff calculation
2. **Adaptive timeout**: Modify per-call timeout based on external API health
3. **Metrics integration**: Add duration tracking (already included in response)

**Current backoff**: 1s → 2s → 4s ± 10% jitter

### Parallel Processing Pattern (003)

**Core Pattern**: Promise.allSettled() for independent symbol analysis

**Key design**:
- Each symbol has independent timeout (30s default)
- Partial failure is acceptable (return both completed and timeout results)
- No cascading: One symbol timeout doesn't affect others

**To extend**:
1. **Concurrency limits**: Add semaphore pattern if needed (currently unbounded)
2. **Priority queue**: Prioritize high-confidence symbols first
3. **Streaming responses**: Return results as they complete (requires WebSocket/SSE)

### Feature Flag Pattern (All features)

**Core Pattern**: Environment-driven feature gating

```
ENABLE_GEMINI_GROUNDING (001)
ENABLE_WHATSAPP_ALERTS (002)
ENABLE_NEWS_MONITOR (003)
ENABLE_BINANCE_PRICE_CHECK (003)
ENABLE_LLM_ALERT_ENRICHMENT (003)
ENABLE_SENTRY (005)
```

**To add new feature**:
1. Create `ENABLE_FEATURE_NAME=false` env var
2. Validate at startup in `index.js` initialization
3. Gate feature behind conditional: `if (process.env.ENABLE_FEATURE_NAME === 'true')`
4. Update `.github/copilot-instructions.md` with new flag

### Error Handling Pattern (All features)

**Patterns**:
- Graceful degradation: Enrichment failure ≠ alert failure
- Partial success: Return mixed results (some channels fail, others succeed)
- Logging: Explicit console.log/debug/warn/error (not structured logging)
- Admin notifications: Optional `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` for failures

**To extend**:
1. **Discord integration**: Add in `src/services/notification/DiscordService.js`
2. **Error aggregation**: Track error rates in memory for metrics
3. **Sentry reporting (005-sentry-runtime-errors)**: Use a thin monitoring service (planned `src/services/monitoring/SentryService.js`) that wraps `@sentry/node` for runtime errors only. Gated by `ENABLE_SENTRY` and `SENTRY_DSN`; MUST NOT change HTTP responses or notification fallbacks and SHOULD be stubbed/mocked in tests (no real Sentry traffic by default).
4. **Telegram admin alerts**: Send critical errors to admin chat if configured

## Runtime Error Monitoring with Sentry (005-sentry-runtime-errors)

This feature introduces backend runtime error monitoring using Sentry's Node SDK (`@sentry/node`) with a strong focus on **non-intrusive, error-only** instrumentation.

**Scope and goals**
- Capture unexpected runtime errors in core flows:
  - HTTP webhooks: `/api/webhook/alert`, `/api/news-monitor`.
  - Notification channels: Telegram and WhatsApp when internal retries are exhausted.
  - Process-level failures: `uncaughtException` and `unhandledRejection` via the SDK's built-in integrations.
- Do **not** change public API contracts or user-visible behavior; monitoring is a side-effect only.

**Planned core components**
- `src/services/monitoring/SentryService.js` (new):
  - Initializes `@sentry/node` once at startup (called from `index.js`).
  - Resolves configuration from env (see below) and exposes helpers like `captureError({ channel, error, context })`.
  - Applies tags (`channel`, `feature`, `environment`) and structured contexts (`http`, `external`, `alert`, `news`) as defined in `specs/005-sentry-runtime-errors/data-model.md`.
- Existing handlers/services will call `SentryService` instead of importing `@sentry/node` directly:
  - `src/controllers/webhooks/handlers/alert/alert.js`
  - `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`
  - `src/services/notification/NotificationManager.js` and channel services when retries are exhausted.

**Configuration (env vars)**
- `ENABLE_SENTRY` (`'true'` to enable monitoring; otherwise no-op)
- `SENTRY_DSN` (server-side DSN from Sentry project; required when `ENABLE_SENTRY==='true'` in environments where we want events)
- Optional overrides (otherwise derived from existing deployment vars):
  - `SENTRY_ENVIRONMENT` (e.g., `production`, `preview`, `development`)
  - `SENTRY_RELEASE` (e.g., `cabros-bot@1.2.3+<git-sha>`)
- Derivation rules (conceptual, see spec for details):
  - If `SENTRY_ENVIRONMENT` is set, use it.
  - Else if `RENDER==='true' && IS_PULL_REQUEST==='true'` → `environment='preview'`.
  - Else if `NODE_ENV==='production'` or `RENDER==='true'` → `environment='production'`.
  - Else → `environment='development'`.

**Instrumentation rules for AI agents**
- Use **only** the monitoring service (`SentryService`) for new Sentry instrumentation; do **not** scatter direct `@sentry/node.captureException` calls across handlers.
- Treat monitoring as a best-effort side-effect:
  - Sentry failures (bad DSN, network issues) MUST NOT introduce new 5xx responses or break existing fallbacks.
  - Purely expected flows (feature flags disabling behavior, validation 4xx responses) MUST NOT be reported as errors.
- When extending handlers:
  - Capture **unexpected** runtime failures (5xx paths, exhausted retries) with appropriate `channel`/`feature` tags.
  - Avoid instrumenting predictable, controlled logic errors (e.g., user input validation that returns 400/403 as per spec).

**Testing guidance**
- Unit tests for the monitoring service SHOULD mock `@sentry/node` so no network calls are made.
- Integration tests MAY assert that monitoring helpers are called in error paths but MUST keep HTTP responses and notification behavior identical with Sentry enabled vs disabled.
- Default for Jest and local dev is to run with Sentry disabled (`ENABLE_SENTRY=false` or no `SENTRY_DSN`), unless a test explicitly enables it with a fake DSN.

### Testing Patterns

**Test locations**:
- `tests/unit/`: Core logic (parsers, formatters, helpers, cache)
- `tests/integration/`: End-to-end flows (webhook → delivery, news → alerts)
- No TDD mandate: Write tests after implementation (tests for critical paths + regressions)

**Test structure**:
```javascript
// Unit: Test single function/class
describe('analyzer', () => {
  it('calculates confidence correctly', () => { ... })
})

// Integration: Test feature end-to-end
describe('news-monitor', () => {
  it('sends alert when confidence exceeds threshold', () => { ... })
})
```

## Common Implementation Tasks

### Add new Telegram command (extend existing pattern):
- Edit `src/controllers/commands.js` to add handler
- Wire in `index.js` with `bot.command()`
- Example: `/precio BTCUSDT` → calls Binance → replies

### Add new news event category (extend 003):
- Update Gemini prompt in `analyzer.js`
- Add to event detection logic
- Update tests to verify detection
- Example: `security_breach` category for exchange hacks

### Add new notification channel (extend 002):
- Create class extending `NotificationChannel`
- Implement send(), validate(), isEnabled()
- Register in NotificationManager
- Add tests and env vars

### Add new API endpoint (create new feature):
- Create controller in `src/controllers/webhooks/handlers/`
- Register route in `src/routes/index.js`
- Add env vars and validation
- Create integration tests
- Document in README

### Add new external API client (extend services):
- Create service in `src/services/`
- Use native fetch (no new HTTP client dependencies)
- Implement retry with retryHelper
- Add timeout handling
- Example: `src/services/inference/azureAiClient.js`
