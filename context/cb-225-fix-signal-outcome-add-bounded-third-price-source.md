# Context: Add a bounded third price source when MCP enrichment fails and Binance is region-blocked (CB-225)

- **Issue**: [#507](https://github.com/francovp/cabros-bot/issues/507)
- **Linear**: [CB-225](https://linear.app/knil/issue/CB-225/fixsignal-outcome-add-bounded-third-price-source-for-region-blocked)
- **Branch**: `fix/signal-outcome-tertiary-price-source-507`

## Summary of Changes
1. **Gemini Grounded Price Service (`src/services/grounding/geminiPriceService.js`)**:
   - Extracted reusable, bounded Gemini price lookup module (`fetchGeminiPrice`, `extractPriceJson`, `isGeminiQuotaError`, `isGeminiGroundingEnabled`).
   - Integrated with `PromptKeys.MARKET_PRICE_FETCH` prompt and `genaiClient.search`.
   - Unified `AbortController` and deadline covering both prompt resolution and search operation with clean event listener cleanup.
   - Enforced runtime feature gate `ENABLE_GEMINI_GROUNDING` with test mode support.
2. **News Monitor Analyzer Refactor (`src/controllers/webhooks/handlers/newsMonitor/analyzer.js`)**:
   - Replaced internal `fetchGeminiPrice` implementation with shared `geminiPriceService.fetchGeminiPrice`.
3. **Signal Outcome Service (`src/services/storage/SignalOutcomeService.js`)**:
   - In `recordSignalInternal`: Bounded Binance `client.getAvgPrice` with a 5000ms `AbortController` timeout race.
   - When Binance fails transiently (e.g. 451 HTTP region-block) and Gemini grounding is enabled, falls back to tertiary Gemini grounding lookup via `geminiPriceService.fetchGeminiPrice` (5000ms timeout). On success, stores `entryPrice`, sets `entryPriceSource = 'gemini-grounding'`, `entryPriceReason = null`, and `eligibilityState = 'supported_provider'`.
   - Preserves historical integrity by ensuring real-time quotes are not used during delayed worker sweeps.
4. **Unit Tests**:
   - `tests/unit/gemini-price-service.test.js`: Comprehensive tests for JSON extraction, grounded price parsing, feature gating, test mode, timeout handling, and quota error propagation.
   - `tests/unit/signal-outcome-service.test.js`: Added unit tests verifying tertiary Gemini price resolution on Binance region-block during ingestion and structural error bypass.
