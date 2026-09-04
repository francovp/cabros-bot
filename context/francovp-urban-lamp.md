feat: add structured HTTP request logger middleware

## Summary

Fixes #665

Adds a structured logging middleware that emits one JSON line per completed HTTP request, capturing method, path, status code, duration, sanitized client IP, and per-request correlation id. Reuses the existing `src/lib/logging.js` JSON pipeline so output format stays consistent with current operator logs.

## Key Changes

- New `src/lib/requestLogger.js` middleware installed between the rate limiter and the OpenAPI docs router in `app.js`.
- Captures `method`, `path`, `statusCode`, `durationMs`, `requestId` (from incoming `x-request-id` header or generated UUID), and `clientIp` (IPv4 last-octet masked, IPv6/loopback replaced with stable token).
- Skips high-frequency, low-signal routes: `/healthcheck`, `/openapi.json`, and `/docs` (Swagger UI).
- Emits at `info` for 2xx/3xx, `warn` for 4xx, `error` for 5xx.
- No new dependency, no new environment variable, no new Remote Config key.

## Technical Implementation

- Module exports the middleware as the default export (parity with `src/lib/rateLimiter.js`) plus named helpers (`createRequestLogger`, `normalizeRequestPath`, `resolveRequestId`, `sanitizeClientIp`, `resolveLogLevel`, `resetRequestLoggerForTests`) for unit tests.
- Mount order: rate limiter → request logger → OpenAPI docs → routes. Logger sits after the rate limiter so blocked 429 responses still surface a request log.
- Listens to both `finish` and `close` events so closed-without-finish sockets do not silently drop.
- `clientIp` sanitizer masks the last IPv4 octet (`203.0.113.7` → `203.0.113.x`), collapses IPv6 to `ipv6-redacted`, and maps loopback to `loopback`.
- `requestId` resolver accepts the same header pattern already used by `resolveRequestId` in `src/controllers/webhooks/handlers/alert/alert.js` (printable ASCII, length-bounded).

## Testing

- `pnpm test -- tests/unit/requestLogger.test.js --testTimeout=5000` — 8 focused unit tests for the middleware (info/warn/error level mapping, requestId generation, IPv4 sanitization, duration span, skip list, no-log when listener never fires).
- `pnpm test -- tests/integration/request-logger.test.js --testTimeout=10000` — 4 integration tests verifying `app.js` wires the middleware (logs `/api/alerts`, skips `/healthcheck` and `/openapi.json`, honors `x-request-id` header).
- `pnpm test -- tests/unit/logging.test.js tests/unit/rateLimiter.test.js --testTimeout=5000` — existing logging + rate-limiter tests remain green.
- `pnpm test -- tests/unit/ --testTimeout=5000` — 108 suites / 2147 unit tests pass.

## References

- Issue: https://github.com/francovp/cabros-bot/issues/665
- Related: #608 (overlapping — closed by this issue)