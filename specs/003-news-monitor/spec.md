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

When the news analysis detects a significant market event or sentiment shift, the system automatically sends alerts to the trader via both Telegram and WhatsApp simultaneously.

**Why this priority**: Alert delivery is critical - the analysis is only valuable if traders receive notifications. This ensures traders act on opportunities in real time.

**Independent Test**: Can be fully tested by triggering an alert condition and verifying that both notification channels receive the message independently.

**Acceptance Scenarios**:

1. **Given** a significant market event is detected (e.g., BTCUSDT +8% with bullish news), **When** the analysis completes, **Then** alerts are sent to both Telegram and WhatsApp simultaneously
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

### Edge Cases

- What happens when an external caller provides an invalid symbol format?
- How does the system handle API timeouts (Binance, Gemini, Telegram, WhatsApp) gracefully?
- What occurs if a symbol exists in both the default list and the request (no duplication)?
- How does the system behave when NEWS_ALERT_THRESHOLD is set to very high values (e.g., 0.99) and no events meet the threshold?
- What happens if the cache TTL is set to 0 (should allow constant re-analysis)?
- How does the system handle malformed JSON or missing required fields in the request body?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST provide an HTTP endpoint at `/api/news-monitor` that accepts POST and GET requests
- **FR-002**: System MUST accept financial symbols via JSON body with separate arrays: `{ "crypto": ["BTCUSDT", "BNBUSDT"], "stocks": ["NVDA", "MSFT"] }`. If arrays are omitted, system defaults to `NEWS_SYMBOLS_CRYPTO` and `NEWS_SYMBOLS_STOCKS` environment variables. Requester is responsible for correct classification; system does not re-validate symbols.
- **FR-003**: System MUST analyze news and market sentiment for each provided symbol using Gemini GoogleSearch (grounding service) to extract market context and sentiment indicators
- **FR-004**: System MUST detect significant market events across three categories: (1) price movements exceeding the configured threshold (default: 5%) with bullish/bearish sentiment, (2) mentions of public figures (e.g., Trump, Elon Musk) making statements about the asset, (3) regulatory or official announcements. Each event receives a category tag and confidence score via Gemini analysis.
- **FR-005**: System MUST assign a confidence score (0.0-1.0) to each alert based on significance and relevance
- **FR-006**: System MUST filter alerts by comparing confidence score against `NEWS_ALERT_THRESHOLD` (default: 0.7) and only send alerts meeting the threshold
- **FR-007**: System MUST execute symbol analysis in parallel to minimize total response time
- **FR-008**: System MUST send filtered alerts to all enabled notification channels (Telegram and WhatsApp) simultaneously without blocking on individual channel failures
- **FR-009**: System MUST implement deduplication using an in-memory cache with configurable TTL (default: 6 hours via `NEWS_CACHE_TTL_HOURS`). Cache key is (symbol, event_category). Same event category for same symbol within TTL prevents duplicate alerts. Different event categories for same symbol generate separate alerts if each meets confidence threshold.
- **FR-010**: System MUST optionally integrate with Binance API for crypto symbols when `ENABLE_BINANCE_PRICE_CHECK=true`. System does NOT validate symbol classification; requester ensures crypto symbols are placed in crypto array. Binance API returns errors for invalid/non-crypto symbols, which system handles gracefully.
- **FR-011**: System MUST execute Binance and Gemini price fetches in parallel and use result of whichever completes first, BUT wait for Gemini to complete (with configurable timeout ~15s) before returning final response. If Binance times out but Gemini completes, use Gemini data with status "gemini_fallback". If Gemini times out but Binance completed, return Binance data with status "partial".
- **FR-012**: System MUST apply a timeout of configurable duration (default: 30 seconds via `NEWS_TIMEOUT_MS`) to the entire analysis flow per symbol
- **FR-013**: System MUST return a JSON response containing per-symbol results with status (analyzed/cached/timeout/error), detected alerts, and notification delivery results. If some symbols timeout and others complete, response includes both completed results (status: "analyzed") and timeout results (status: "timeout") with HTTP 200 OK and "partial_success" flag.
- **FR-014**: System MUST be feature-gated behind the `ENABLE_NEWS_MONITOR` environment variable (default: false) for safe rollout
- **FR-015**: System MUST use the existing grounding service to contextualize alerts with extracted news sources, summaries, and citations
- **FR-016**: System MUST format alerts for each notification channel using existing formatters: MarkdownV2 for Telegram, WhatsApp-compatible format for WhatsApp
- **FR-017**: System MUST handle and gracefully log errors from external API calls (Gemini, Binance, Telegram, WhatsApp) without stopping the entire monitoring flow

### Key Entities

- **NewsAlert**: Represents a detected market event with symbol, headline, sentiment score, confidence, sources, and formatted message
- **MarketContext**: Encapsulates price data (current, 24h change, volume) sourced from Binance or Gemini
- **CacheEntry**: In-memory record of analyzed news with timestamp and TTL for deduplication
- **AnalysisResult**: Container for per-symbol analysis output including alert, status, and delivery results

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Endpoint responds to external calls within 30 seconds total (per batch of symbols), regardless of number of symbols analyzed
- **SC-002**: Alerts are delivered to all enabled notification channels within 5 seconds of analysis completion
- **SC-003**: Duplicate alerts are eliminated: identical event categories for same symbol detected within cache TTL do not trigger redundant notifications; different event categories generate separate alerts
- **SC-004**: System handles 10 concurrent requests to the endpoint without degradation or errors
- **SC-005**: 95% of all external API calls (Gemini, Binance, Telegram, WhatsApp) succeed on first attempt; failed calls trigger fallback mechanisms and do not block alert delivery
- **SC-006**: Traders receive alerts via both Telegram and WhatsApp with consistent formatting and content fidelity (same symbol, price, sentiment, sources, event category)
- **SC-007**: Configuration is fully externalized: all feature flags and thresholds can be adjusted via environment variables without code changes
- **SC-008**: Binance price fetching (when enabled) provides 99% accurate crypto prices compared to live market data. If Binance times out (>10s), automatic Gemini fallback provides reasonably current context within remaining timeout budget (default 15s).
- **SC-009**: No alert is sent if confidence score is below the configured threshold (alerts only sent when actionable)
- **SC-010**: System can be enabled/disabled via `ENABLE_NEWS_MONITOR` with zero impact on existing bot functionality
- **SC-011**: All three event detection categories (price_surge, public_figure, regulatory) are correctly identified, scored, and included in alerts when Gemini analysis detects them

## Clarifications

### Session 2025-10-30

- **Q1: Symbol Classification (Crypto vs Stock)** → A: Requester is responsible for separating symbols into two separate request objects: one for `crypto` and one for `stocks`. System trusts the classification. Binance will return errors for invalid/non-crypto symbols in crypto object; this is requester's responsibility.
- **Q2: Event Detection Types (FR-004)** → A: Detect ALL event types with scoring by category: (1) price movements >5% with bullish/bearish sentiment, (2) mentions of public figures (Trump, Elon, etc.), (3) regulatory/official announcements. Implement via Gemini with sophisticated prompts that categorize and score each event type.
- **Q3: Multi-Symbol Response Contract** → A: Return partial results on timeout. Endpoint waits up to 30s total. If 8/15 symbols complete and 7 timeout, return all 8 with status "analyzed" and 7 with status "timeout". No streaming or per-symbol early returns.
- **Q4: Duplicate Detection Strategy** → A: Deduplicate by (symbol, event_category). System allows multiple alerts per symbol if they are different event categories (e.g., "price_surge" at 10:00 + "regulatory" at 11:00 for same symbol). Within cache TTL, same category for same symbol is deduplicated.
- **Q5: Timeout Budget (Binance vs Gemini)** → A: Execute Binance and Gemini in parallel. Use result of whichever completes first. System waits for Gemini to complete (with configurable timeout; default ~15s) before returning, even if Binance completed earlier. If Binance completes but Gemini times out, return Binance data + "partial" status.

## Assumptions

- External schedulers are responsible for calling the endpoint at appropriate intervals (e.g., every 30 minutes); the system does not self-schedule
- Gemini API is available and functional (as it's already integrated in the project for grounding)
- Binance API (when enabled) is accessible and returns data within 10 seconds; fallback to Gemini is acceptable
- Traders accept WhatsApp and Telegram as primary notification channels (both already integrated)
- Default news symbols list is manageable (10-50 symbols typical); very large lists (100+) may require pagination or batching
- Cache TTL of 6 hours is appropriate for most trading scenarios; traders can adjust via environment variable
- Confidence scoring is based on sentiment analysis and event magnitude; exact algorithms are implementation details
- **Requester is responsible for correct symbol classification** (crypto symbols in crypto array, stocks in stocks array); system does not re-validate
- **Gemini prompts are sophisticated enough to detect all three event categories** (price, public figures, regulatory); implementation will define exact prompts and scoring weights
