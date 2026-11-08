feat: add circuit breaker for external API providers (#610)

## Summary

Adds a reusable `CircuitBreaker` utility (`src/lib/circuitBreaker.js`) and integrates circuit breaker protection across external API providers (Gemini, TradingView MCP, and Twelve Data). When external services experience consecutive outages or rate-limit saturation, the breaker trips to `open` state, fast-failing outbound calls to prevent resource exhaustion, thread blockage, and cascading failures. The service status endpoint (`/api/status` and `/api/capabilities`) reports granular circuit breaker health and marks dependencies as `degraded` when tripped, automatically recovering once probe requests succeed after the configured cooldown.

## Key Changes

- **`src/lib/circuitBreaker.js`**:
  - Implemented reusable `CircuitBreaker` state machine supporting `closed`, `open`, and `half-open` states.
  - Exported `CircuitBreaker` and `CircuitBreakerError` with configurable `failureThreshold` (default 5) and `cooldownMs` (default 60s).
  - Dynamic threshold and cooldown resolvers hook into Remote Config and environment variables.
  - Supports automatic state transition from `open` to `half-open` on cooldown expiry, reset to `closed` on probe success, and immediate return to `open` on probe failure.
- **`src/services/storage/EquityMarketDataService.js`**:
  - Integrated `twelveDataCircuitBreaker` for Twelve Data stock quote and historical bar requests.
  - Added `REASONS.CIRCUIT_BREAKER_OPEN: 'twelve_data_circuit_breaker_open'` (classified as transient for outcome retries).
  - Fast-fails calls with HTTP 503 when breaker is open without issuing outbound fetch requests.
  - Records success on 200 responses; records failure on network timeouts, HTTP 429, and 5xx errors (skipping normal `NO_DATA` responses).
  - Reports `circuitBreaker` status and marks readiness `degraded` in `getStatus()`.
- **`src/services/grounding/grounding.js`**:
  - Integrated `geminiCircuitBreaker` for Google Gemini grounding and search queries.
  - In `deriveSearchQuery`: fast-fails to raw alert text without calling Gemini LLM when breaker is open.
  - In `groundAlert`: fast-fails with 503 and category `circuit_breaker_open` when breaker is open.
  - Records success on completed enrichments; records failure on timeouts, quota errors, and API failures.
- **`src/services/tradingview/TradingViewMcpService.js`**:
  - Updated fallback threshold and cooldown resolution to respect `CIRCUIT_BREAKER_THRESHOLD` and `CIRCUIT_BREAKER_COOLDOWN_MS` as global defaults alongside existing TradingView-specific overrides.
- **`src/controllers/status.js` & `src/openapi/openapi.json`**:
  - Updated `/api/status` to report `circuitBreaker` status for `dependencies.gemini` and `dependencies.equityMarketData` (matching `tradingViewMcp`).
  - Degrades dependency status to `degraded` and readiness to `false` when circuit breaker is `open`.
  - Updated OpenAPI specification Status schema and examples.
- **Configuration & Remote Config Parity**:
  - Added `CIRCUIT_BREAKER_THRESHOLD` and `CIRCUIT_BREAKER_COOLDOWN_MS` to `RemoteConfigService.js` `PARAMETER_SCHEMA`, `firebase-remote-config-template.json`, and `.env.example`.
- **Testing**:
  - `tests/unit/circuit-breaker.test.js`: 13 unit tests covering state transitions, half-open probing, cooldowns, and error throwing.
  - `tests/unit/equity-market-data-service.test.js`: Verified Twelve Data circuit breaker integration and 503 fast-fail.
  - `tests/unit/grounding.test.js`: Verified Gemini circuit breaker integration and query derivation fallback.
  - `tests/integration/circuit-breaker-providers.test.js`: End-to-end integration tests simulating outages across Twelve Data, Gemini, and TradingView MCP, testing fast-fails, `/api/status` degradation, and probe recovery.
  - Updated `tests/integration/status-endpoint.test.js`.

## References

- Closes #610
