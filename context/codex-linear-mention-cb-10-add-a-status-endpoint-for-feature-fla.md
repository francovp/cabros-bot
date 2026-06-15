## feat: add status and capabilities endpoints

## Summary

Added a machine-readable service status surface for operational checks through `GET /api/status` and `GET /api/capabilities`, including feature flags, delivery-channel readiness, and dependency readiness for alert processing.

## Key Changes

### :satellite: Status and capabilities endpoints

- Added `src/controllers/status.js` to build a non-sensitive status payload with:
- `service` metadata (`name`, `version`, `commit`, `environment`)
- `featureFlags` for runtime-gated features
- `deliveryChannels` readiness (`telegram`, `whatsapp`)
- `dependencies` readiness (`telegram`, `whatsapp`, `gemini`, `tradingViewMcp`, `firestore`, `sentry`, `langfuse`)
- Registered `GET /api/status` and `GET /api/capabilities` in `src/routes/index.js`.

### :shield: Readiness accuracy improvements

- Treated TradingView MCP as configured when enrichment is enabled and the documented default MCP URL path is available.
- Treated Firestore as configured for supported ADC-based Google-managed runtimes (for example Cloud Run/App Engine/Functions) in addition to explicit credential env vars.

### :test_tube: Integration coverage

- Added integration tests for `/api/status` and `/api/capabilities`.
- Validated API-key protection, payload shape, feature/dependency states, preview gating behavior, and secret redaction.
- Added explicit coverage for Firestore ADC readiness detection and stabilized test setup by clearing `SENTRY_ENVIRONMENT` in test bootstrap for deterministic environment assertions.

## Technical Implementation

### status controller

- [src/controllers/status.js](/Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/controllers/status.js)
- Added shared readiness helpers and Google-managed runtime detection for ADC-compatible Firestore checks.

### route wiring

- [src/routes/index.js](/Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/src/routes/index.js)
- Mounted new status endpoints under `/api`.

### tests

- [tests/integration/status-endpoint.test.js](/Users/fgvaleriop/repositorios/cabros-crypto-bot-telegram/tests/integration/status-endpoint.test.js)
- End-to-end endpoint and readiness assertions.

## Testing

### Pre-merge Verification

- [x] `npm test -- tests/integration/status-endpoint.test.js`

## References

- CB-10
- PR #57
