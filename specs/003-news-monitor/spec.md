# Feature Specification: News Monitoring with Sentiment Analysis and Alert Distribution

**Feature Branch**: `003-news-monitor`  
**Created**: October 30, 2025  
**Status**: Draft  
**Input**: Endpoint HTTP para monitoreo de noticias y análisis de sentimiento de stocks y crypto con alertas configurables vía Telegram y WhatsApp, usando Gemini para contexto y Binance opcional para precios de crypto

## User Scenarios & Testing *(mandatory)*

### User Story 1 - External Caller Monitors News for Assets (Priority: P1)

An external scheduler (GitHub Actions, Render cron, third-party service) calls the `/api/news-monitor` endpoint with separate request objects for crypto and stock symbols to analyze news and market sentiment.

**Why this priority**: This is the core feature - without it, the system cannot deliver any alerts. It's the entry point for all monitoring workflows.

**Independent Test**: Can be fully tested by calling the endpoint with separate crypto and stock symbol lists and verifying that the service analyzes each correctly and returns per-symbol results.

**Acceptance Scenarios**:

1. **Given** the endpoint is called with `{ "crypto": ["BTCUSDT", "BNBUSDT"], "stocks": ["NVDA", "MSFT"] }`, **When** the request completes, **Then** the system analyzes all 4 symbols and returns per-symbol results
2. **Given** an external caller provides only crypto symbols, **When** the endpoint is called with `{ "crypto": ["ETHUSD"] }`, **Then** the system analyzes only the crypto symbols (omitting stocks array is acceptable)
3. **Given** an analysis detects a newsworthy event (significant price movement, market sentiment shift, public figure mention), **When** the analysis completes, **Then** the result includes the detected alert with a confidence score and event category
4. **Given** the endpoint is called, **When** processing completes, **Then** the response includes per-symbol results with status (analyzed, cached, error, timeout) and any alerts detected

---

### User Story 2 - Traders Receive Alerts via Configured Channels (Priority: P1)

When the news analysis detects a significant market event or sentiment shift, the system automatically sends alerts to the configured Telegram and WhatsApp chat IDs simultaneously. All alerts are sent to the same unified recipients (`TELEGRAM_CHAT_ID` and `WHATSAPP_CHAT_ID` environment variables); no per-trader or per-event-type routing in MVP.

**Why this priority**: Alert delivery is critical - the analysis is only valuable if traders receive notifications. This ensures traders act on opportunities in real time.

**Independent Test**: Can be fully tested by triggering an alert condition and verifying that both notification channels receive the message independently.

**Acceptance Scenarios**:

1. **Given** a significant market event is detected (e.g., BTCUSDT +8% with bullish news), **When** the analysis completes, **Then** alerts are sent to both `TELEGRAM_CHAT_ID` and `WHATSAPP_CHAT_ID` simultaneously
2. **Given** one notification channel fails (e.g., WhatsApp API temporarily unavailable), **When** sending occurs, **Then** the other channel (Telegram) still receives the alert and the response indicates partial success
3. **Given** an alert is formatted for delivery, **When** it's sent to Telegram, **Then** it includes formatted context with symbol, price, sentiment score, and news sources
4. **Given** an alert is formatted for delivery, **When** it's sent to WhatsApp, **Then** it includes the same information in WhatsApp-compatible format

---

### User Story 3 - System Avoids Duplicate Alerts for Same News (Priority: P2)

If the external scheduler calls the endpoint multiple times within a short period and the same news event has already been analyzed, the system should skip sending duplicate alerts using an intelligent cache mechanism.

**Why this priority**: Prevents alert fatigue and unnecessary noise. Allows external schedulers to call frequently without flooding traders with duplicates. High importance for user experience.

**Independent Test**: Can be tested by calling the endpoint twice with the same symbol within the TTL window and verifying that the second call returns cached results.

**Acceptance Scenarios**:

1. **Given** a news event for BTCUSDT has been analyzed and an alert was sent, **When** the endpoint is called again within the cache TTL (e.g., 6 hours), **Then** the same symbol returns a cached result and no duplicate alert is sent
2. **Given** cache TTL has expired, **When** the endpoint is called again for the same symbol, **Then** the system re-analyzes news and can send new alerts if warranted
3. **Given** multiple news events occur for the same symbol, **When** each unique event is detected, **Then** each unique alert is sent and cached independently

---

### User Story 4 - System Optionally Enriches Alerts with Real-time Crypto Prices (Priority: P2)

If `ENABLE_BINANCE_PRICE_CHECK` is enabled, the system can fetch precise crypto asset prices directly from Binance API for enhanced context in alerts. If Binance fetch fails, it automatically falls back to Gemini-based price discovery.

**Why this priority**: Enhances accuracy for crypto monitoring. Optional to maintain simplicity. Fallback ensures reliability.

**Independent Test**: Can be tested by enabling Binance mode and verifying that crypto prices are fetched accurately, with fallback validation when Binance is unavailable.

**Acceptance Scenarios**:

1. **Given** ENABLE_BINANCE_PRICE_CHECK is true and a crypto symbol (BTCUSDT) is analyzed, **When** fetching market context, **Then** the system calls Binance API for precise price and 24h change data
2. **Given** a non-crypto symbol (NVDA) is analyzed with ENABLE_BINANCE_PRICE_CHECK enabled, **When** fetching market context, **Then** the system skips Binance and uses Gemini GoogleSearch instead
3. **Given** Binance API call fails or times out, **When** fetching market context, **Then** the system automatically falls back to Gemini and continues processing without blocking
4. **Given** either mode is used, **When** alerts are generated, **Then** they include current market context (price, 24h change) sourced from the available data provider

---

### User Story 5 - System Detects Trading-Relevant Events (Priority: P3)

The system analyzes news and market data to identify significant trading signals across three event categories: major price movements (>X%, configurable), statements from public figures (Trump, Elon Musk, etc.), and regulatory/official announcements. Each event type receives a confidence score and category tag.

**Why this priority**: Provides the intelligence layer that makes alerts actionable. Depends on core delivery working first.

**Independent Test**: Can be tested by injecting known market events of different categories and verifying correct detection, categorization, and scoring.

**Acceptance Scenarios**:

1. **Given** a cryptocurrency has increased >5% in 24h and positive market news is detected, **When** analysis occurs, **Then** the system generates a "price_surge" alert with bullish sentiment and confidence score
2. **Given** a stock has declined >5% and negative news is detected, **When** analysis occurs, **Then** the system generates a "price_decline" alert with bearish sentiment and confidence score
3. **Given** a news event mentions a public figure (e.g., "Trump says..."), **When** analysis occurs, **Then** the system tags it as "public_figure" event and includes in alerts with high-relevance score
4. **Given** a regulatory announcement or official statement is detected, **When** analysis occurs, **Then** the system tags it as "regulatory" event and includes in alerts
5. **Given** no significant events or news are detected, **When** analysis completes, **Then** no alert is sent (only neutral data is returned)

---

### User Story 6 - Optional Secondary LLM Enrichment of Alerts (Priority: P2)

When `ENABLE_LLM_ALERT_ENRICHMENT=true`, the system can invoke an optional secondary LLM model to re-analyze Gemini grounding results and refine confidence scores and alert reasoning. This feature is disabled by default and gracefully falls back to Gemini-only analysis if unavailable.

**Why this priority**: Enables higher-quality alert signals by adding a second opinion from a different model. Optional to preserve core system reliability. Implemented as feature 004-llm-alert-enrichment.

**Independent Test**: Can be tested by enabling enrichment, triggering an alert, and verifying secondary LLM is called and refined confidence is returned; also test fallback when enrichment is disabled or unavailable.

**Acceptance Scenarios**:

1. **Given** `ENABLE_LLM_ALERT_ENRICHMENT=true` and a market event is detected via Gemini, **When** the system processes the alert, **Then** the secondary LLM receives grounding data and returns enriched analysis with updated confidence and reasoning
2. **Given** the secondary LLM enrichment succeeds, **When** the alert is generated, **Then** conservative confidence selection is applied: use minimum of (Gemini confidence, LLM confidence) to prevent false positives
3. **Given** the secondary LLM is unavailable or times out, **When** enrichment is attempted, **Then** system falls back to Gemini-only analysis and continues processing without blocking alert delivery
4. **Given** enrichment is enabled, **When** the response is returned, **Then** the response includes enrichment metadata (original_confidence, enriched_confidence, reasoning_excerpt) for trader context
5. **Given** `ENABLE_LLM_ALERT_ENRICHMENT=false` or is unset, **When** alerts are processed, **Then** system uses Gemini analysis only (backward compatible)

---

### Edge Cases

- **Invalid symbol format**: System validates that symbols are non-empty strings (max 20 chars). Invalid symbols are passed to external APIs (Binance/Gemini) and returned as per-symbol status "error"; entire request is never rejected at HTTP level.
- **API timeouts (Binance, Gemini, Telegram, WhatsApp)**: Handled by `retryHelper.sendWithRetry()` with 3 retries and exponential backoff. If all retries fail, per-symbol result includes status "error" with timeout message. Notification channel failures do not block response (partial_success flag indicates mixed outcomes).
- **Symbol duplication across request**: If same symbol appears in multiple arrays or multiple times, Gemini/Binance will return errors for misclassified symbols; no special deduplication needed.
- **NEWS_ALERT_THRESHOLD set to extreme values** (e.g., 0.99): System correctly filters; alerts with confidence <0.99 are not sent. Response still includes analyzed results with their confidence scores so requester can audit filtering.
- **NEWS_CACHE_TTL_HOURS set to 0**: System allows constant re-analysis (treated as no cache). Each call will trigger fresh Gemini analysis.
- **Malformed JSON or missing required fields**: System validates JSON parsing and assumes valid arrays if present; omitted arrays default to env symbols. Per-field validation errors are logged but do not reject request.
- **Rate limiting from external APIs**: Handled by retry logic with exponential backoff. If rate-limited after 3 retries, per-symbol result includes status "error" with rate-limit message.
- **Both Binance and Gemini fail for same symbol**: System returns analysis result without market price context (status "analyzed"). Alert is still sent if confidence threshold is met, based on news sentiment alone.
- **No significant news detected for a symbol**: System returns analyzed result with empty alerts array and status "analyzed" (no error).
- **Secondary LLM enrichment returns invalid confidence**: System logs error and falls back to Gemini-only result for that alert without blocking other symbols.
- **Secondary LLM enrichment timeout (per symbol)**: If enrichment exceeds timeout budget (default: 10s per LLM call), system logs timeout and uses Gemini score without enrichment for that alert.
- **Secondary LLM enrichment partially fails**: If enrichment succeeds for some symbols and fails for others, batch processing continues; affected alerts use Gemini scores; response indicates partial enrichment success.
- **Enrichment cache hit on second call**: If same symbol with same event_category is re-analyzed within cache TTL, both primary analysis and enrichment results are returned from cache without redundant API calls.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an HTTP endpoint at `/api/news-monitor` that accepts POST and GET requests
- **FR-002**: System MUST accept financial symbols via JSON body with separate arrays: `{ "crypto": ["BTCUSDT", "BNBUSDT"], "stocks": ["NVDA", "MSFT"] }`. If arrays are omitted, system defaults to `NEWS_SYMBOLS_CRYPTO` and `NEWS_SYMBOLS_STOCKS` environment variables. Requester is responsible for correct classification; system does not re-validate symbols.
- **FR-003**: System MUST analyze news and market sentiment for each provided symbol using Gemini GoogleSearch (grounding service) to extract market context and sentiment indicators. Gemini SHOULD return structured JSON with explicit fields: `{ event_category, event_significance, sentiment_score, sources }` for reproducibility and testability. System validates field types and value ranges ([0.0-1.0] for numeric fields) before applying confidence formula. If Gemini returns free-form text (fallback), system parses unstructured response using regex/NLP heuristics to extract event_category, significance, and sentiment.
- **FR-004**: System MUST detect significant market events across three categories: (1) price movements exceeding the configured threshold (default: 5%) with bullish/bearish sentiment, (2) mentions of public figures (e.g., Trump, Elon Musk) making statements about the asset, (3) regulatory or official announcements. Each event receives a category tag and confidence score via Gemini analysis (structured JSON preferred, free-form fallback supported).
- **FR-005**: System MUST assign a confidence score (0.0-1.0) to each alert using the formula: `confidence = (0.6 × event_significance + 0.4 × |sentiment|)` where event_significance is 0.0–1.0 based on price movement magnitude, source credibility, and mention frequency; sentiment is extracted from news articles as -1.0 (bearish) to +1.0 (bullish) scale.
- **FR-006**: System MUST filter alerts by comparing confidence score against `NEWS_ALERT_THRESHOLD` (default: 0.7) and only send alerts meeting the threshold
- **FR-007**: System MUST execute symbol analysis in parallel to minimize total response time
- **FR-008**: System MUST send filtered alerts to all enabled notification channels (Telegram and WhatsApp) simultaneously without blocking on individual channel failures
- **FR-009**: System MUST implement deduplication using an in-memory cache with configurable TTL (default: 6 hours via `NEWS_CACHE_TTL_HOURS`). Cache key is (symbol, event_category). Same event category for same symbol within TTL prevents duplicate alerts. Different event categories for same symbol generate separate alerts if each meets confidence threshold.
- **FR-010**: System MUST optionally integrate with Binance API for crypto symbols when `ENABLE_BINANCE_PRICE_CHECK=true`. System does NOT validate symbol classification; requester ensures crypto symbols are placed in crypto array. Binance API returns errors for invalid/non-crypto symbols, which system handles gracefully.
- **FR-011**: System MUST execute Binance and Gemini price fetches with aggressive and generous timeouts: Binance ~5 seconds, Gemini ~20 seconds. If both calls fail or timeout, system returns analysis result without market price context (alert is still sent based on news sentiment). If one completes, use that result. Per-symbol timeout budget remains 30 seconds total.
- **FR-012**: System MUST apply a timeout of configurable duration (default: 30 seconds via `NEWS_TIMEOUT_MS`) to the entire analysis flow per symbol
- **FR-013**: System MUST return a JSON response containing per-symbol results with status (analyzed/cached/timeout/error), detected alerts, notification delivery results, and metadata (totalDurationMs, cached, requestId). If some symbols timeout and others complete, response includes both completed results (status: "analyzed") and timeout results (status: "timeout") with HTTP 200 OK and "partial_success" flag.
- **FR-014**: System MUST be feature-gated behind the `ENABLE_NEWS_MONITOR` environment variable (default: false) for safe rollout
- **FR-015**: System MUST use the existing grounding service to contextualize alerts with extracted news sources, summaries, and citations
- **FR-016**: System MUST format alerts for each notification channel using existing formatters: MarkdownV2 for Telegram, WhatsApp-compatible format for WhatsApp
- **FR-017**: System MUST handle and gracefully log errors from external API calls (Gemini, Binance, Telegram, WhatsApp, optional secondary LLM) without stopping the entire monitoring flow. All external API calls MUST use `retryHelper.sendWithRetry()` with 3 retries and exponential backoff (see FR-018).
- **FR-018**: System MUST retry transient API failures using exponential backoff: Binance (3 retries, ~5s timeout), Gemini (3 retries, ~20s timeout), optional secondary LLM enrichment (3 retries, ~10s timeout), Telegram/WhatsApp (3 retries, ~10s timeout). Per-symbol 30s budget accounts for worst-case retry scenarios. Secondary LLM enrichment is independent and does not block alert delivery if it fails.
- **FR-019**: System MUST support optional secondary LLM enrichment via `ENABLE_LLM_ALERT_ENRICHMENT` environment variable (default: false). When enabled, secondary LLM receives grounding results and returns refined confidence, reasoning, and recommended action. Implementation details deferred to feature 004-llm-alert-enrichment.
- **FR-020**: System MUST apply conservative confidence selection when enrichment is applied: use minimum of (Gemini confidence, Secondary LLM confidence) to prevent false positives from LLM hallucination. Gemini-only analysis is used if enrichment is disabled or unavailable.
- **FR-021**: System MUST implement verbose structured logging for operational visibility: log each external API call (Gemini, Binance, Telegram, WhatsApp) with request/response summaries at DEBUG/INFO level. Include per-symbol analysis timing, cache hits, enrichment decisions, and retry attempts. Log format should support easy parsing for Phase 2 Datadog integration. All errors, retries, and timeouts MUST be logged at WARN/ERROR level with correlation IDs (requestId) for audit trails.

### Key Entities

- **NewsAlert**: Represents a detected market event with symbol, headline, sentiment score, confidence, sources, and formatted message. Includes event_category (price_surge, price_decline, public_figure, regulatory). When enrichment is applied, includes original_confidence, enriched_confidence, reasoning_excerpt, and recommended_action.
- **MarketContext**: Encapsulates price data (current, 24h change, volume) sourced from Binance or Gemini.
- **CacheEntry**: In-memory record of analyzed news with timestamp and TTL for deduplication. Key is (symbol, event_category). When enrichment is enabled, also caches enrichment results to prevent redundant secondary LLM calls.
- **AnalysisResult**: Container for per-symbol analysis output including alert, status, delivery results, totalDurationMs, cached flag, requestId, and optional enrichment metadata (when enrichment is enabled).
- **ErrorResult**: Per-symbol error container with status "error", error code, and error message (returned for invalid symbols or API failures, not as HTTP-level rejection).
- **EnrichmentMetadata**: Optional alert metadata wrapper (when `ENABLE_LLM_ALERT_ENRICHMENT=true`) including original_confidence, enriched_confidence, enrichment_applied, reasoning_excerpt, model_name, and processing_time_ms. Omitted when enrichment is disabled (backward compatible).

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Endpoint responds to external calls within 30 seconds total (per batch of symbols), regardless of number of symbols analyzed
- **SC-002**: Alerts are delivered to all enabled notification channels within 5 seconds of analysis completion
- **SC-003**: Duplicate alerts are eliminated: identical event categories for same symbol detected within cache TTL do not trigger redundant notifications; different event categories generate separate alerts
- **SC-004**: System handles 10 concurrent requests to the endpoint without degradation or errors
- **SC-005**: 95% of all external API calls (Gemini, Binance, Telegram, WhatsApp) succeed on first attempt; failed calls trigger fallback mechanisms and do not block alert delivery
- **SC-006**: Traders receive alerts via both Telegram and WhatsApp with consistent formatting and content fidelity (same symbol, price, sentiment, sources, event category)
- **SC-007**: Configuration is fully externalized: all feature flags and thresholds can be adjusted via environment variables without code changes
- **SC-008**: Binance price fetching (when enabled) provides 99% accurate crypto prices compared to live market data. With aggressive timeout (~5s), Binance succeeds in 90% of requests. Gemini fallback (~20s) succeeds in 95% of requests. If both fail, system still delivers alerts based on news sentiment analysis alone (without price context).
- **SC-009**: No alert is sent if confidence score is below the configured threshold (alerts only sent when actionable)
- **SC-010**: System can be enabled/disabled via `ENABLE_NEWS_MONITOR` with zero impact on existing bot functionality
- **SC-011**: All three event detection categories (price_surge, price_decline, public_figure, regulatory) are correctly identified, scored, and included in alerts when Gemini analysis detects them
- **SC-012**: When secondary LLM enrichment is enabled (`ENABLE_LLM_ALERT_ENRICHMENT=true`), enriched alerts have confidence scores that are conservative (≤ original Gemini confidence) to prevent false positives. Enrichment succeeds in 95% of cases; failures gracefully fall back to Gemini-only analysis.
- **SC-013**: When secondary LLM enrichment is disabled or unavailable, alert generation latency and quality are identical to Gemini-only analysis (backward compatible)
- **SC-014**: Verbose logging is enabled: 100% of external API calls (Gemini, Binance, Telegram, WhatsApp) are logged with request/response summaries. Per-symbol timing, cache hits, enrichment decisions, and retry attempts are captured in structured logs. All errors and timeouts include correlation IDs (requestId) for traceability.
- **SC-015**: Gemini prompt strategy supports graceful degradation: Preferred structured JSON responses are validated and parsed correctly in 95%+ of calls. Free-form fallback parsing succeeds in 90%+ of degraded cases (when Gemini returns unstructured text). System continues processing without blocking either way.

## Clarifications

### Session 2025-10-30 (Speckit Clarification - Interactive)

- **Q1: Alert Recipient & Multi-Channel Routing Strategy** → A: Single unified recipient per channel; all alerts go to same `TELEGRAM_CHAT_ID` and `WHATSAPP_CHAT_ID`. No per-trader or per-event-type routing in MVP. Aligns with existing bot architecture.
- **Q2: Gemini Prompt Strategy for Event Detection** → A: Hybrid two-stage approach. Preferred: Gemini returns structured JSON with `{ event_category, event_significance, sentiment_score, sources }`. System validates types/ranges before applying confidence formula. Fallback: If free-form text received, system parses using regex/NLP heuristics. Enrichment: Secondary LLM uses structured JSON for refined confidence (when `ENABLE_LLM_ALERT_ENRICHMENT=true`); if disabled, use Gemini confidence directly.
- **Q3: Observability & Logging Strategy** → A: Verbose logging for MVP. Log each API call (Gemini, Binance, Telegram, WhatsApp) with request/response summaries. Include symbol-level timing, cache hits, enrichment decisions in structured logs. Foundation for Phase 2 Datadog integration. Enables operational debugging and audit trails during MVP.

### Session 2025-10-30 (Initial)

- **Q1: Symbol Classification (Crypto vs Stock)** → A: Requester is responsible for separating symbols into two separate request objects: one for `crypto` and one for `stocks`. System trusts the classification. Binance will return errors for invalid/non-crypto symbols in crypto object; this is requester's responsibility.
- **Q2: Event Detection Types (FR-004)** → A: Detect ALL event types with scoring by category: (1) price movements >5% with bullish/bearish sentiment, (2) mentions of public figures (Trump, Elon, etc.), (3) regulatory/official announcements. Implement via Gemini with sophisticated prompts that categorize and score each event type.
- **Q3: Multi-Symbol Response Contract** → A: Return partial results on timeout. Endpoint waits up to 30s total. If 8/15 symbols complete and 7 timeout, return all 8 with status "analyzed" and 7 with status "timeout". No streaming or per-symbol early returns.
- **Q4: Duplicate Detection Strategy** → A: Deduplicate by (symbol, event_category). System allows multiple alerts per symbol if they are different event categories (e.g., "price_surge" at 10:00 + "regulatory" at 11:00 for same symbol). Within cache TTL, same category for same symbol is deduplicated.
- **Q5: Timeout Budget (Binance vs Gemini)** → A (Option D): Aggressive on Binance (~5s timeout), generous with Gemini fallback (~20s). If both fail, return analysis without market price context (system still sends alert based on news sentiment alone). Prioritizes fallback reliability over Binance speed.

### Session 2025-10-30 (Clarification)

- **Q1: Gemini Confidence & Sentiment Scoring** → A: Gemini extracts sentiment from news articles (positive/negative/neutral as -1.0 to +1.0 scale) and event significance (0.0–1.0 based on price movement magnitude, source credibility, mention frequency). Final confidence score uses weighted formula: `confidence = (0.6 × event_significance + 0.4 × |sentiment|)` clamped to [0, 1]. This formula is reproducible and debuggable.
- **Q2: Observability & Metrics Instrumentation** → Deferred to planning phase. Will address in Phase 2 with Datadog integration strategy.
- **Q3: Input Validation & Error Response** → A: Validate format but return per-symbol errors only; never reject entire request at HTTP level. Invalid symbols (e.g., non-existent crypto symbols) are caught by Binance/Gemini APIs and returned as per-symbol status "error", not HTTP 400.
- **Q4: Response Transparency & Debugging** → A: Include full metadata in response: `totalDurationMs` per symbol (transparency), `cached` flag (debugging deduplication), and `requestId` (operational tracing). This aids external callers and operations in correlating logs and understanding delays.
- **Q5: External API Retry & Rate Limit Handling** → A: Reuse existing `retryHelper.sendWithRetry()` with 3 retries and exponential backoff for all external APIs (Binance ~5s timeout, Gemini ~20s timeout, optional LLM enrichment ~10s timeout, Telegram/WhatsApp ~10s timeout). Per-symbol 30s budget accounts for worst-case retry scenarios.
- **Q6: Optional Secondary LLM Enrichment Integration** → A: Secondary LLM enrichment (feature 004-llm-alert-enrichment) is an optional overlay on top of Gemini analysis. When enabled via `ENABLE_LLM_ALERT_ENRICHMENT=true`, secondary LLM refines confidence and reasoning but does not replace Gemini. Conservative confidence (minimum of both scores) prevents false positives. If secondary LLM is unavailable, system falls back to Gemini-only analysis. Enrichment cache uses same TTL as primary news cache (6 hours default) to keep implementation simple.

### Session 2025-10-31 (Grounding Usage Clarification)

- **Q: Grounding for `fetchGeminiPrice()` - Extract Prices from Search Snippets?** → A (Option A): Yes, extract numeric price data from Gemini's grounded search snippets using regex parsing of financial data. This provides market context fallback when Binance is unavailable or for non-crypto symbols. System uses regex patterns to parse price, 24h change %, and volume from search result snippets. If parsing fails, gracefully returns null/empty context without blocking alert delivery.

## Assumptions

- External schedulers are responsible for calling the endpoint at appropriate intervals (e.g., every 30 minutes); the system does not self-schedule
- Gemini API is available and functional (as it's already integrated in the project for grounding)
- Binance API (when enabled) is accessible and returns data within 10 seconds; fallback to Gemini is acceptable
- Traders accept WhatsApp and Telegram as primary notification channels (both already integrated)
- Default news symbols list is manageable (10-50 symbols typical); very large lists (100+) may require pagination or batching
- Cache TTL of 6 hours is appropriate for most trading scenarios; traders can adjust via environment variable
- **Confidence scoring uses weighted formula**: `confidence = (0.6 × event_significance + 0.4 × |sentiment|)` where event_significance reflects price movement magnitude, source credibility, mention frequency; sentiment ranges -1.0 to +1.0
- **Requester is responsible for correct symbol classification** (crypto symbols in crypto array, stocks in stocks array); system does not re-validate or cross-check classifications
- **Gemini prompts are sophisticated enough to detect all three event categories** (price movements, public figures, regulatory); implementation will refine exact prompts and scoring weights
- **Retry logic reuses existing `retryHelper.sendWithRetry()`**: 3 retries with exponential backoff for Binance (~5s), Gemini (~20s), optional LLM enrichment (~10s), Telegram/WhatsApp (~10s). Per-symbol 30s budget is sufficient for worst-case scenarios
- **Response metadata includes**: totalDurationMs (per symbol), cached flag (deduplication indicator), requestId (operational tracing). External callers can use these for debugging and transparency
- **Format validation is lenient**: Invalid symbols are detected by external APIs, not rejected upfront; entire request is never rejected at HTTP level (format errors return per-symbol status "error")
- **Optional secondary LLM enrichment**: Controlled via `ENABLE_LLM_ALERT_ENRICHMENT` environment variable (default: false). When enabled, secondary LLM refines Gemini results but system remains functional if enrichment is unavailable. Conservative confidence selection (minimum of Gemini + LLM scores) prevents false positives from LLM hallucination.
- **Backward compatibility**: When enrichment is disabled or unavailable, system behaves identically to Gemini-only analysis. Response format supports optional enrichment metadata for forward compatibility.

