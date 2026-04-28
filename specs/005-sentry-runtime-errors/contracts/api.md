# API Contracts: Runtime Error Monitoring with Sentry

**Feature**: `005-sentry-runtime-errors` | **Date**: 2025-11-26

---

## Public HTTP APIs

This feature does **not** introduce new public HTTP endpoints and does **not** change the request/response contracts of existing endpoints.

### `/api/webhook/alert`

- Request and response shapes remain as defined by:
  - `specs/002-whatsapp-alerts/contracts/alert-webhook.openapi.yml`
  - `specs/001-gemini-grounding-alert/contracts/api.md`
  - `specs/004-enrich-alert-output/contracts/api.md`
- Sentry integration only adds **side-effectful error monitoring**; it MUST NOT:
  - Change HTTP status codes or response bodies in success or error cases.
  - Introduce additional headers visible to clients.

### `/api/news-monitor`

- Request and response schemas remain as defined by:
  - `specs/003-news-monitor/contracts/news-monitor.openapi.yml`
- Sentry integration only observes failures and unexpected exceptions; it MUST keep:
  - Status codes (`200`, `400`, `403`, `500`) unchanged for equivalent scenarios.
  - Response body structure unchanged.

---

## Internal Monitoring Contracts

The Sentry integration introduces an internal monitoring contract that describes **when** and **how** errors are reported. This contract is invisible to external HTTP clients but is critical for tests and operations.

### MonitoringCaptureRequest (Internal)

```typescript
interface MonitoringCaptureRequest {
  event: ErrorEvent;            // Normalized error event (see data-model.md)
}
```

- `ErrorEvent` is defined in `specs/005-sentry-runtime-errors/data-model.md` and includes:
  - `type` (`runtime_error` | `process_error` | `external_failure`)
  - `channel` (`http-alert`, `news-monitor`, `telegram`, `whatsapp`, `grounding`, `news-enrichment`, `process`)
  - `environment`, `release`
  - Context blocks (`http`, `external`, `alert`, `news`)

### MonitoringCaptureResult (Internal)

```typescript
interface MonitoringCaptureResult {
  captured: boolean;            // True when Sentry accepted the event call
  skippedReason?: string;       // Reason when capture was skipped (disabled, missing DSN, etc.)
  eventId?: string;             // Sentry event ID when available
}
```

- `captured=false` MUST NOT affect control flow in HTTP handlers or notification services.
- `skippedReason` SHOULD be logged at debug/info level for diagnostics.

---

## When Events MUST Be Captured

The monitoring layer MUST attempt to capture an `ErrorEvent` in the following situations:

1. **HTTP Webhook Alert Failures**
   - Unhandled exceptions in `/api/webhook/alert` handler.
   - Explicit 5xx responses from the alert handler that result from internal errors.

2. **News Monitor Failures**
   - Unhandled exceptions in `/api/news-monitor` handler.
   - Errors that result in a `500` response for the whole request (not per-symbol timeouts handled as part of normal flow).

3. **External Provider Failures (after retries)**
   - WhatsApp (GreenAPI) sends that exhaust all retries without success.
   - Telegram sends that throw errors or return persistent failures.
   - Optional: persistent failures in Gemini, Azure LLM, Binance, or URL shorteners **after** internal retry mechanisms are exhausted.

4. **Process-Level Failures**
   - `uncaughtException` and `unhandledRejection` events surfaced by the Node SDK integrations.

---

## When Events MUST NOT Be Captured

To avoid noise and respect FR-006 and FR-003, the monitoring layer MUST NOT capture events for:

- Features disabled by configuration behaving as expected, for example:
  - `ENABLE_WHATSAPP_ALERTS=false` → WhatsApp not sending is **not** an error.
  - `ENABLE_NEWS_MONITOR=false` → `/api/news-monitor` returning `403 FEATURE_DISABLED` is **not** an error.
- Validation errors that result in 4xx responses where behavior is explicitly defined by the spec, for example:
  - Invalid request bodies for `/api/webhook/alert` (malformed JSON, empty text).
  - Too many symbols or invalid symbol formats in `/api/news-monitor` requests.

---

## Tagging & Context (Sentry Event Contract)

Although not visible to HTTP clients, the following tags and contexts MUST be present on Sentry events to satisfy FR-001, FR-005, and FR-009:

### Required Tags

- `environment`: `production` | `preview` | `development` (or value from `SENTRY_ENVIRONMENT`).
- `channel`: `http-alert` | `news-monitor` | `telegram` | `whatsapp` | `grounding` | `news-enrichment` | `process`.
- `feature`: High-level feature name such as:
  - `alerts`
  - `gemini-grounding`
  - `whatsapp-alerts`
  - `news-monitor`

### Optional Context Blocks

- `http`: When `channel` is `http-alert` or `news-monitor`.
- `external`: When `type === 'external_failure'`.
- `alert`: For `/api/webhook/alert`-related errors.
- `news`: For `/api/news-monitor`-related errors.

Exact shapes of these blocks are defined in `data-model.md`.

---

## Environment & Privacy Contract

- Sentry MUST only be considered **enabled** when:
  - `ENABLE_SENTRY === 'true'`, and
  - `SENTRY_DSN` is present and non-empty.
- When enabled, events MAY include full alert/news text in Sentry event payloads, consistent with FR-007 and internal privacy policies.
- If future privacy policies require anonymization, the `sendAlertContent` flag in `MonitoringConfiguration` can be toggled to restrict event content without changing public HTTP APIs.

---

## Backward Compatibility

- No existing public APIs change as part of this feature.
- Clients interacting with `/api/webhook/alert` and `/api/news-monitor` MUST observe identical behavior before and after Sentry is enabled or disabled, except for indirect operational improvements (better monitoring, faster incident response).

This contract provides the basis for unit and integration tests that verify Sentry is called (or not) in the correct scenarios without altering API-level behavior.
