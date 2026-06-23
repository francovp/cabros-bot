# Add Idempotency Keys to Webhook Deliveries (GitHub Issue #62)

Integrate idempotency key support on webhook alert-producing endpoints to prevent duplicate deliveries (Telegram/WhatsApp) when upstream systems retry requests due to network issues or timeouts.

## User Review Required

> [!NOTE]
> The idempotency keys will be checked across headers (`Idempotency-Key`), request body fields (`idempotencyKey`, `idempotency_key`), and query parameters (`idempotencyKey`, `idempotency_key`).
>
> To avoid caching transient internal errors (which should be retriable), responses with status code `>= 500` will **not** be cached.
>
> If a client attempts to reuse an existing idempotency key with a **different payload**, the system will return `409 Conflict` to prevent returning wrong cached results.

## Open Questions

No open questions. The specifications in GitHub issue #62 are complete and self-contained.

---

## Proposed Changes

### Idempotency Core Service & Middleware

#### [NEW] [IdempotencyService.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/src/services/storage/IdempotencyService.js)
Create an in-memory storage manager for idempotency keys.
- Store structure: `key -> { payloadHash, statusCode, responseBody, headers, createdAt, expiresAt }`
- Hash payload: SHA-256 of the serialized request body/payload.
- Conflict validation: If key exists but SHA-256 does not match the incoming request payload, throw a custom conflict error.
- Configuration: Default TTL of 5 minutes (300,000 ms), configurable via `WEBHOOK_IDEMPOTENCY_TTL_MS`.
- Automatic eviction of expired records via periodic `setInterval` check and lazy check on retrieval.

#### [NEW] [idempotency.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/src/lib/idempotency.js)
Implement the Express middleware for response interception:
- Extract key from `Idempotency-Key` header, request body, or query params.
- If key matches an active cached response:
  - Add header `Idempotency-Replay: true` to the response.
  - If response body is JSON, append/inject `idempotencyReplayed: true`.
  - Replay the response immediately and short-circuit.
  - If payload differs, return `409 Conflict` (JSON response).
- If key is new:
  - Intercept the original `res.send`/`res.json` methods.
  - Set `Idempotency-Replay: false` header.
  - Once the response is successfully generated (status code `< 500`), store the status, body, and headers in `IdempotencyService`.

---

### Routing Configuration

#### [MODIFY] [index.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/src/routes/index.js)
Apply the `idempotencyMiddleware` to the following endpoints:
- `POST /api/webhook/alert`
- `POST /api/webhook/expanded-analysis-alert`
- `POST /api/webhook/market-scanner-alert`

---

### Verification Plan

### Automated Tests
Create a new unit test suite [idempotency.test.js](file:///Users/fgvaleriop/.gemini/antigravity/worktrees/cabros-crypto-bot-telegram/automate-github-linear-workflow/tests/unit/idempotency.test.js) and run the following tests:
```bash
pnpm test -- tests/unit/idempotency.test.js
```
The test suite will verify:
1. Fresh request processing and caching behavior.
2. Replayed request returns cached status code, headers, and body with `Idempotency-Replay: true` and `idempotencyReplayed: true`.
3. Unique keys process independently.
4. Expired keys are evicted and processed as fresh requests.
5. Reused key with a mismatched payload returns `409 Conflict`.
6. Status codes `>= 500` are not cached.
7. Custom TTL config via `WEBHOOK_IDEMPOTENCY_TTL_MS`.

Run the full test suite to ensure no regressions:
```bash
pnpm test
```

### Manual Verification
1. Start the server locally:
   ```bash
   pnpm run start-dev
   ```
2. Send a `POST` request to `/api/webhook/alert` with an `Idempotency-Key` header and verify the response.
3. Send the same request again and verify that:
   - No duplicate delivery occurs (checked via server log/mock).
   - Response includes `Idempotency-Replay: true` header.
   - Response body contains `"idempotencyReplayed": true`.
4. Send the same key with a different body text and verify that a `409 Conflict` status is returned.
