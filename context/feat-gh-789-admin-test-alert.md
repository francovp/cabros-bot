# feat(admin): test-alert endpoint for verification probe (GH-789)

## Summary

Add a dedicated, protected administrative endpoint `POST /api/admin/test-alert` designed for operator verification probing of alert notification pipelines. It enables manual or automated smoke verification across enabled delivery channels (`telegram`, `whatsapp`, `discord`) with optional enrichment, safe dry-run previewing, in-memory 60s caller rate limiting with daily limit caps, telemetry integration, and explicit `source: 'test-alert'` Firestore persistence.

## Key Changes

### 🛡️ Administrative Test-Alert Controller & Endpoint
- Created `src/controllers/admin/testAlert.js` implementing `postTestAlert`, `getTestAlertTelemetry`, and `resetTestAlertRateLimitsForTesting`.
- Mounted on `POST /api/admin/test-alert` in `src/routes/index.js` protected by `adminWrite` (`[validateAdminAccess, requireAdminRole(ADMIN_OPERATOR)]`).
- Core capabilities:
  1. **Rate Limiting & Safety**: In-memory rate limiting enforcing a minimum 60-second cooldown between test alert requests per caller (IP/subject) and daily limit capped by `TEST_ALERT_DAILY_LIMIT` (default: 30/day), returning structured 429 errors with `Retry-After` headers.
  2. **Channel Routing**: Supports custom channel subsets via `validateChannelRouting` (`telegram`, `whatsapp`, `discord`) while safely defaulting to all configured channels.
  3. **Dry-Run Mode**: When `dryRun: true`, formats channel previews without dispatching notifications or polluting Firestore storage (`persisted: false`).
  4. **Enrichment**: Optional LLM enrichment via `processEnrichment` from alert webhook handler, tracking token usage and operating fail-open.
  5. **Persistence**: Saves probe alerts to Firestore with `source: 'test-alert'` when `ENABLE_FIRESTORE_ALERT_STORAGE=true`.
  6. **Telemetry & Status**: Telemetry recorded on `/api/status` and `/api/capabilities` under `dependencies.testAlert` (`enabled`, `lastRunAt`, `lastRunStatus`, `rateLimitState`) and `featureFlags.testAlert`.

### ⚙️ Runtime & Feature Flags Parity
- Documented `ENABLE_TEST_ALERT=true` and `TEST_ALERT_DAILY_LIMIT=30` in `.env.example` with valid values and operator guidance.
- Added `ENABLE_TEST_ALERT` (boolean) and `TEST_ALERT_DAILY_LIMIT` (number, integer, min 1, max 1000) to `RemoteConfigService` parameter schema and `firebase-remote-config-template.json`.
- Exposed `featureFlags.testAlert` and `dependencies.testAlert` in `/api/status` and `/api/capabilities`.

### 📜 Contract & Postman Specifications
- Updated OpenAPI 3.1 specification (`src/openapi/openapi.json`):
  - Added `Admin` tag and `POST /api/admin/test-alert` path with `x-admin-role: admin.operator` and `FirebaseBearerAuth` security.
  - Added request body `TestAlert`, response `TestAlertResult`, schemas `TestAlertRequest` and `TestAlertResult`.
  - Added `test-alert` to `StoredAlert` source enum and `Source` query parameter.
- Updated Postman collection (`CabrosBot.postman_collection.json`):
  - Added 4 request variants under `Stored Alerts`: Minimal / Default Probe, Dry Run, Multi-channel & Enrichment, and Rate Limited 429 response.

## Testing Infrastructure

### Test Suites
- **10 Unit Tests** in `tests/unit/admin-test-alert.test.js`: controller execution, rate limiting 60s cooldown, daily limit enforcement, disabled gating, dry-run previews, multi-channel routing, fail-open enrichment, and Firestore persistence.
- **7 Integration Tests** in `tests/integration/admin-test-alert.test.js`: Supertest HTTP end-to-end testing verifying API key auth, Firebase token auth, viewer role rejection (403), disabled gating (404), dry run, live probe delivery, and rate limiting (429).
- **Docs Alignment**: passes `tests/unit/docs-alignment.test.js` (9/9).
- **Remote Config**: passes `tests/unit/remote-config-service.test.js` (25/25).
- **OpenAPI Contract**: passes `tests/unit/openapi-contract.test.js` (19/19) and `tests/integration/openapi-docs.test.js` (9/9).
- **Postman Collection**: passes `tests/unit/postman-collection.test.js` (18/18).
- **Status Endpoint**: passes `tests/integration/status-endpoint.test.js` (80/80).
- **Full Test Suite**: all 167 suites and 3,197 tests pass with zero regressions.

## References
- Closes #789
