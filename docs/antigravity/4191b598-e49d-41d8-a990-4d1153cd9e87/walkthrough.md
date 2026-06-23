# Walkthrough: Add Idempotency Keys to Webhook Deliveries (CB-16)

This walkthrough documents the design, implementation, and successful testing of the idempotency key support on alert-producing webhook endpoints.

## Changes Made

### 1. Core Service
- **[IdempotencyService.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/src/services/storage/IdempotencyService.js)**: Stores cached responses in-memory using an Express-safe cache mapping. Features payload SHA-256 validation to reject key reuse with modified payloads (`409 Conflict`), default and custom TTL configured via `WEBHOOK_IDEMPOTENCY_TTL_MS`, and key eviction for memory protection.

### 2. Middleware
- **[idempotency.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/src/lib/idempotency.js)**: Express middleware that checks headers (`Idempotency-Key`), bodies (`idempotencyKey` / `idempotency_key`), or query parameters for idempotency keys. Intercepts `res.send` and `res.json` to cache successful responses (status `< 500`) and replays them on subsequent matches with `Idempotency-Replay: true` and `"idempotencyReplayed": true`.

### 3. Route Registration
- **[index.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/src/routes/index.js)**: Applies `idempotencyMiddleware` right after `validateApiKey` for:
  - `POST /api/webhook/alert`
  - `POST /api/webhook/expanded-analysis-alert`
  - `POST /api/webhook/market-scanner-alert`

---

## Verification Results

### 1. Automated Tests
A comprehensive suite is created in **[idempotency.test.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/tests/unit/idempotency.test.js)**, covering:
- Response caching & retrieval.
- Payload hashing mismatch detection (`409 Conflict`).
- Expiration & eviction policies.
- Middleware integration with mock HTTP requests.
- Bypassing `>= 500` server errors.

All unit tests and the full project test suite passed successfully:
```bash
Test Suites: 51 passed, 51 total
Tests:       589 passed, 589 total
Snapshots:   0 total
```

### 2. E2E Verification
Conducted E2E tests against the deployed Render preview environment (`https://cabros-crypto-bot-telegram-pr-80.onrender.com`):
- **First request**: Returned `200 OK` and response header `idempotency-replay: false`.
- **Replay request**: Returned `200 OK` and response header `idempotency-replay: true` and injected `"idempotencyReplayed": true` into the JSON response body.
- **Mismatched request**: Returned `409 Conflict` with `"code": "IDEMPOTENCY_CONFLICT"` when trying to reuse the key with a different body.
