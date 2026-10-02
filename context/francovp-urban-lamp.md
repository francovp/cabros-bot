feat(observability): structured HTTP request logging middleware

## Summary

Fixes #665

Every completed HTTP request emits exactly one structured JSON log line carrying `method`, `path`, `statusCode`, `durationMs`, `requestId`, `clientIp`, `aborted`, and `outcome`. The middleware is mounted as the **outermost** layer in `app.js`, so a single line covers every terminal outcome — CORS rejections, body-parser `413`s, request-deadline `408`s, rate-limit `429`s, and route handlers — rather than only the routes a handler chose to log.

Output flows through the existing `console.*` → `src/lib/logging.js` pipeline, so secret redaction and `LOG_LEVEL` filtering apply without a parallel format.

This revision supersedes the original #967 head: the branch was 192 commits behind `master` and `CONFLICTING`. It has been merged up to `master` and the feature re-integrated against current `master`, which already ships `src/lib/requestDeadline.js`.

## Key Changes

### New middleware — `src/lib/requestLogger.js`
- Emits one line per request through the existing structured JSON pipeline.
- Level follows the outcome: `info` for 2xx/3xx, `warn` for 4xx and client aborts, `error` for 5xx.
- Mounted first in `app.js`; it only attaches `finish`/`close` listeners and calls `next()`, so it **cannot** change any status code, header, or response body.

### Integration with the request deadline (not a fork of it)
`master` already ships `src/lib/requestDeadline.js`, which owns the request-id vocabulary and the probe-path exemption list. The original PR re-implemented both, which would have let the two middlewares drift:

| Concern | Resolution |
|---|---|
| Correlation id | `requestDeadline.resolveRequestId(req)` — the log line, the `X-Request-Id` header, and the `408` payload all carry the same id |
| Probe skip list | `requestDeadline.resolveExemptPaths()`, read per request, so `REQUEST_DEADLINE_EXEMPT_PATHS` silences both middlewares at once (new `resolveExemptPaths` export added to `requestDeadline`) |
| Path matching | exemption matching is case-insensitive (mirroring `requestDeadline.normalizePath`) because Express routing is case-insensitive and `/HEALTHCHECK` otherwise reached the healthcheck handler while still being logged |

### Correctness bugs found and fixed during review
1. **Truncated downloads logged as clean completions.** Abort detection read `res.writableEnded`, which flips the instant the handler calls `res.end()` — before bytes reach the socket. A client disconnecting in that window produced `outcome: "completed", aborted: false` with a tiny `durationMs`. Now reads `res.writableFinished`.
2. **`/HEALTHCHECK` bypassed the probe skip list.** The deadline exempted it while the logger logged it; one character of variation per request was enough to flood logs from a health probe.
3. **A throwing log sink could crash the process.** `emit()` ran unguarded from a Node event emitter, outside Express's `try/catch`. `console.*` is globally replaceable (the logging wrapper, Sentry, test doubles), so an observability path could take down the server. Now wrapped in `try/catch`.
4. **Abort reported a phantom `statusCode: 200`.** Node initializes `res.statusCode` to 200 even when nothing was written, so an early disconnect was logged as a success. Now reports `0` when no response began.
5. **Masking ran before exemption matching.** An operator who configured `/api/preferences/telegram/123` as exempt would still see it logged, because the path was rewritten to `:redacted` first. Exemption is now decided on the unmasked path.
6. **Lower-casing the logged path broke `/api/alerts/:alertId` searchability.** Firestore document ids are mixed case and case-sensitive, so a lower-cased path would not match the id an operator saw in a 404 body. Matching and display are now separate concerns: the exemption set matches case-insensitively, the emitted path keeps its original case.
7. **`/docs/*` asset subtree was logged.** `/docs` is documented as a probe route, but exact set membership exempted none of `swagger-ui.css`, `swagger-ui-bundle.js`, `swagger-ui-standalone-preset.js`, or `swagger-initializer.js`.

### Privacy
- Query strings are stripped, so request parameters and secrets never reach the log.
- `/api/preferences/:channel/:chatId` is masked to `:redacted` — a personal destination, and the one parameterized route segment the centralized logger cannot catch (the attribute is named `path`, and bare numeric or `@g.us` values match no secret rule).
- `clientIp` is masked to `a.b.c.x` for IPv4 and reported as `ipv6-redacted` for IPv6.
- No request or response bodies are logged, and no headers.

### Documentation
- `docs/monitoring.md` — "Structured Request Logging" section: field table, level mapping, `requestId` correlation recipe, and what is deliberately not logged.
- `docs/environment-configuration.md` — `REQUEST_DEADLINE_EXEMPT_PATHS` now notes it also silences request logging.
- `AGENTS.md` — documents the invariants (shared id, single exemption vocabulary, `writableFinished`, exempt-before-mask, fail-open emit).
- `.env.example` — notes that `REQUEST_DEADLINE_EXEMPT_PATHS` also silences request logging; no new variable.

## Technical Implementation

```mermaid
graph LR
  A[Incoming request] --> L[RequestLogger<br/>outermost]
  L --> B[CORS]
  B --> C[RequestDeadline<br/>stamps requestId]
  C --> D[Body parsers<br/>413 on overflow]
  D --> E[Rate limiter<br/>429]
  E --> F[Routes<br/>200/404/...]
  F --> G([Structured log line])
  B -.-> G
  C -. 408 .-> G
  D -.-> G
  E -.-> G
```

The logger attaches listeners at position 0 and finalizes on whichever of `finish`/`close` arrives first, guarded by a `finalized` flag so a clean response never logs twice. On `close`, `finalize(!res.writableFinished)` distinguishes a client abort from a completed response.

## Testing

- `pnpm test -- tests/unit/ --testTimeout=10000` — **158 suites, 3,637 tests passed**
- `pnpm test -- tests/integration/ --testTimeout=25000` — **62 suites, 856 tests passed**
- `tests/unit/requestLogger.test.js` — level mapping, single-emission guard, abort vs completion, IPv4/IPv6 masking, path normalization, case preservation, sensitive-segment masking, exempt-path matching, fail-open emit.
- `tests/integration/request-logger.test.js` — supertest coverage for parser rejections, `x-request-id` header reuse, `408` payload/log id agreement, and probe-path silence.
- `tests/unit/handlers-request-id.test.js` and `tests/unit/alert-webhook-request-id.test.js` — handlers reuse the middleware-resolved id.
- Each of the seven bug fixes is covered by a regression test verified to fail when the fix is reverted.
- Live preview verified: `https://openclaw.tail5e4271.ts.net/cabros-bot-pr-967/healthcheck` and `/openapi.json` return `200`; a custom `x-request-id` header is echoed on both the response header and the error payload.

## Known limitation

The issue's "< 1ms overhead" criterion is not asserted by an automated test. The middleware performs one `Date.now()` pair, two `String.replace` calls, one `Set` lookup, and one `console.info` per request — no per-request allocation beyond the listener closures, and no synchronous I/O — but no benchmark pins that claim.

## References

- Issue: https://github.com/francovp/cabros-bot/issues/665
- Related: #608 (overlapping — closed by this issue), #581, #592