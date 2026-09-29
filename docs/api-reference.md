# API Reference & System Endpoints

[← Back to README](../README.md)

This document details the core system status, health, and authentication endpoints.
For specific domain APIs, see:
- [Webhook Alerts API](webhooks.md)
- [Asynchronous Analysis Jobs API](jobs.md)
- [Stored Alerts API](alerts.md)
- [Signal Outcomes API](signal-outcomes.md)
- [News Monitoring API](news-monitor.md)

## API Endpoints

The canonical API contract is served publicly at [`/openapi.json`](http://localhost:80/openapi.json), with interactive Swagger UI at [`/docs`](http://localhost:80/docs), and the operator console at [`/admin`](http://localhost:80/admin). Use those endpoints for request schemas, response shapes, examples, and the current route inventory. Protected `/api` operations still require `x-api-key`; documentation and admin console assets are exempt from the global rate limit budget and never expose configured credentials.

### GET /healthcheck

Liveness health check endpoint. The default behavior returns 200 with `uptime` only.

When called with `?deep=true`, the endpoint reuses the existing channel readiness logic from `/api/status` dependencies and returns 200 when every enabled channel is ready, or 503 when any enabled channel is degraded. Disabled channels are treated as healthy (not required). The endpoint is never API-key protected.

**Default response (200):**
```json
{"uptime":"..."}
```

**Deep response (200 — all enabled channels ready):**
```json
{
  "status": "healthy",
  "uptime": 42.5,
  "channels": {
    "telegram": { "enabled": true, "ready": true, "status": "ready" },
    "whatsapp": { "enabled": false, "ready": false, "status": "disabled" },
    "discord": { "enabled": false, "ready": false, "status": "disabled" }
  }
}
```

**Deep response (503 — enabled channel degraded):**
```json
{
  "status": "degraded",
  "uptime": 42.5,
  "degradedChannels": ["whatsapp"],
  "channels": {
    "telegram": { "enabled": true, "ready": true, "status": "ready" },
    "whatsapp": { "enabled": true, "ready": false, "status": "error", "error": "Missing WHATSAPP_API_KEY" },
    "discord": { "enabled": false, "ready": false, "status": "disabled" }
  }
}
```

### GET /ready

Public bootstrap-readiness endpoint for deployment traffic cutover. It returns `503` while startup is pending or failed, and `200` only after the required bootstrap components are ready. Telegram is `disabled` when the bot is disabled or the environment is a preview; the news monitor is `disabled` when it is not enabled. Readiness checks bootstrap completion only and does not continuously ping external providers, avoiding restart loops caused by transient dependency outages.

Configure the deployment platform health check to use `/ready` (`healthCheckPath` in `render.yaml`; Railway's service healthcheck path should use the same value). Keep `/healthcheck` for process liveness.

The protected `/api/status` response includes the same non-sensitive state under `readiness`.

**Ready response:**
```json
{
  "status": "ready",
  "ready": true,
  "components": {
    "telegramBot": { "status": "disabled" },
    "notificationServices": { "status": "ready" },
    "newsMonitor": { "status": "disabled" }
  }
}
```

Pending and failed bootstrap states use the same body shape with HTTP `503`; failed responses include a sanitized `error` message.

### GET /api/status

Machine-readable runtime status for operational tooling. This endpoint uses the same `WEBHOOK_API_KEY` protection as other `/api` endpoints when that environment variable is configured. Send the key with the `x-api-key` header.

The response intentionally exposes only non-sensitive booleans and metadata: service identity, version, commit, environment, feature-flag state, delivery channel readiness, and dependency readiness/configuration status. Secret values such as bot tokens, API keys, DSNs, chat IDs, and provider URLs are not returned.

For `ENABLE_NEWS_MONITOR=true`, the payload also reports the primary LLM dependency used by that flow as `dependencies.newsMonitorLlm`, including the resolved provider (`gemini`, `azure`, or `openrouter`) and whether that provider is actually configured for runtime use. When `FORCE_BRAVE_SEARCH=true`, the payload also exposes `dependencies.braveSearch` so the forced search path can be monitored independently of Gemini. When `ENABLE_GEMINI_GROUNDING=true` and `MODEL_PROVIDER=gemini`, `dependencies.gemini` requires both `GEMINI_API_KEY` and `GEMINI_MODEL_NAME`, matching the runtime path used for grounded alert generation. `dependencies.geminiQuota` reports whether a Gemini quota cooldown is active, bounded remaining cooldown duration, trigger counters, Brave search fallback events during cooldown, and grounding request telemetry counters (`totalRequests`, `successRequests`, `failureRequests`, `timeoutRequests`) without exposing prompts, error bodies, or provider credentials. `dependencies.groundingCoalescing` reports the bounded equity-alert search sharing window and hit/miss/failure counters. Firestore readiness treats `GOOGLE_APPLICATION_CREDENTIALS` as configured only when the referenced credential file exists and is readable.

When `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`, `featureFlags.tradingViewVolumeConfirmation` reports the gate value and `dependencies.tradingViewVolumeConfirmation` reports readiness only when the configured TradingView MCP endpoint and its parent MCP enrichment gate are active.

TradingView dependency readiness is runtime-derived and fail-open: `configured` reflects the effective endpoint, while `status` starts as `unknown` and changes to `ready` or `degraded` after an MCP operation. `lastErrorCategory` is sanitized to categories such as `timeout`, `http_5xx`, `http_4xx`, `invalid_response`, or `request_failed`; provider response bodies and URLs are never returned by `/api/status`.

When `ENABLE_FIRESTORE_JOB_STORAGE=true`, `featureFlags.firestoreJobStorage` reports the async-job persistence gate and `dependencies.firestoreJobStorage` reports readiness using the configured Firestore credentials. The legacy `ENABLE_FIRESTORE_ALERT_STORAGE=true` gate also reports job storage as enabled because it activates the same runtime persistence path.

`featureFlags.newsMonitorTestMode` reports `ENABLE_NEWS_MONITOR_TEST_MODE` without changing the news monitor's existing test-mode behavior.

`featureFlags.messageFooterMetadata` reports the `ENABLE_MESSAGE_FOOTER_METADATA` setting. It defaults to `true` and is disabled only when the environment variable is explicitly set to `false`.

When `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION=true`, `/api/webhook/alert` suppresses duplicate channel delivery for the same `(exchange, symbol, timeframe, side)` signal within a cooldown window of `ALERT_SIGNAL_COOLDOWN_BARS` bars (default `1`). Suppressed requests still return 200 with `suppressedRepeat: true`, empty `results`/`deliveredChannels`, and remain persisted with a suppression marker so replay and audit stay complete. Opposite-side flips always deliver; storage failures fail open to normal delivery. `featureFlags.alertSignalRepeatSuppression` reports the gate and `dependencies.alertSignalRepeatSuppression` exposes non-sensitive counters (`suppressedCount`, `lastSuppressedAt`, `activeTrackedSignals`).

`dependencies.firestoreWriteMetrics` exposes in-memory per-domain Firestore write counters for `AlertStorageService.saveAlert`/`saveReplayAttempt` and `JobRepository.save`. The section is omitted entirely until at least one write has been recorded and resets on process restart, mirroring the existing `deliveryMetrics` pattern. Counters report `writesAttempted`, `writesSucceeded`, `writesFailed`, overall `successRate`, and a per-domain `byDomain` breakdown with sanitized counts so silent persistence failures can be detected without exposing provider responses or credentials.

`featureFlags.cloudflareAig` reports `ENABLE_CLOUDFLARE_AIG`, while `dependencies.cloudflareAig` reports whether the Cloudflare AI Gateway credentials are configured and ready. Runtime provider selection is controlled separately by `MODEL_PROVIDER=cloudflare`; set both values when status/capability telemetry should match active Cloudflare routing.

`notificationChannelIntent` reports the operator-intent view of notification channel configuration (`telegram`, `whatsapp`, `discord`). It mirrors `NotificationChannel.isConfigured()`: a channel counts as `configured` when its enable flag is set **and** its required credentials/chat id/webhook are present — the same `ready` semantics `dependencyStatus` already uses. A channel with a webhook URL present but its enable flag off therefore reports as **not** configured, which is the same verdict the zero-channel admin page reaches because both call that one method. The view answers the question the zero-channel page exists to raise — a channel the operator never set up (`unconfigured`) versus one that is set up but currently failing. The page reports the same two sets, so an operator can reconcile an alert from the page and `/api/status` without inspecting credentials. Only channel names are exposed; never tokens, webhook URLs, or chat IDs.

When `ENABLE_EQUITY_MARKET_DATA=true`, `dependencies.equityMarketData` reports Twelve Data readiness and the supported `BATS`/`NASDAQ`/`NYSE`/`AMEX`/`NYSE ARCA`/`FX_IDC`/`SPCFD` exchanges without exposing the API key. Signal outcome tracking uses `/quote` for missing entry prices and `/time_series` for bounded historical bars; provider, timeout, malformed-data, and quota failures mark equity outcomes unavailable without blocking alert delivery. Extended-hours data is excluded by default. Confirm current Twelve Data plan limits and licensing before production use: [pricing](https://twelvedata.com/pricing), [US equities coverage](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data), and [commercial usage](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage).
`dependencies.signalOutcomeWorker` reports the scheduler role, shutdown state, cadence/budgets, active entry-price chains, and the last-sweep heartbeat counters (`lastRunAt`, scanned, pending, evaluated, and error counts). The `worker` role is intended for the dedicated Render service; set the web service role to `disabled` during cutover so only one scheduler is active. A disabled local scheduler reports `ready: false` and `status: "disabled"` because it is not the process evaluating outcomes.

The dedicated worker also persists the same non-sensitive heartbeat to `workerHeartbeats/signal-outcome` in Firestore. Heartbeat writes fail open and never block alert delivery.
`featureFlags.firebaseRemoteConfig` reports `ENABLE_FIREBASE_REMOTE_CONFIG`. This is server-side Remote Config: the Firebase Admin SDK loads the published template with `initServerTemplate()` from the `firebase-server` namespace, while no Firebase Web/Client SDK configuration is involved. `dependencies.firebaseRemoteConfig` exposes only `enabled`, `configured`, `ready` (true only after a successful, fresh template load), `templatePublished` (true only after at least one successful load; `enabled` + `configured` alone means the loader is wired up but serving no remote values), `status` (`ready`, `degraded`, `unknown`, `misconfigured`, or `disabled`), `source` (`remote`, `environment`, `default`, or `disabled`), `templateVersion`, `lastSuccessfulLoad`, `lastErrorCategory` (including `template_not_published` when the `firebase-server` namespace has no template yet, distinct from a transient `load_failed`), `consecutiveFailures`, and bounded loader settings; it never returns remote parameter values or credentials.

`GET /api/capabilities` is an alias for the same payload.

When configured, `featureFlags.binanceTrading` and `dependencies.binanceTrading` expose only the non-sensitive execution gate, selected `testnet`/`demo`/`live` environment, allow-listed symbols, and readiness state.

### GET /api/public/status

Public, unauthenticated, secrets-free status snapshot for external monitoring widgets, status pages, and trader self-checks. No API key is required and the endpoint is mounted before the global rate limiter so monitoring traffic never consumes the ordinary bucket. The endpoint returns:

```json
{
  "service": { "name": "cabros-bot", "version": "0.1.0" },
  "status": {
    "ok": true,
    "uptimeSeconds": 42319,
    "lastUpdated": "2026-08-27T19:30:00.000Z",
    "shuttingDown": false
  },
  "channels": { "enabled": ["telegram"] },
  "dependencies": {
    "gemini":      { "ready": true },
    "tradingview": { "ready": true },
    "firestore":   { "ready": true }
  }
}
```

The snapshot is cached for 30 seconds per process. The endpoint returns HTTP `503` with `code: "SERVICE_NOT_READY"` while the process is still bootstrapping or shutting down; otherwise it returns `200`. Build commit, environment, configuration values, per-channel counters, feature flags, admin chat IDs, the `WEBHOOK_API_KEY`, Sentry DSN, Firebase project ID, and per-feature cost data are intentionally omitted.

### Browser admin authentication

`/admin` is public shell content. With `ENABLE_FIREBASE_ADMIN_AUTH=false` (the default), it keeps the existing session-only `WEBHOOK_API_KEY` console flow. With the flag enabled, the shell shows Firebase email/password sign-in, keeps an API-key field only in memory for API-key-only webhook/news-monitor operations, and does not read or write that key to browser storage. `/admin/auth-config` returns only the public Firebase Web configuration needed by the client.

The server verifies Firebase ID tokens with revoked-token checks enabled. Custom claims may use `roles: ["admin.viewer"]`, `roles: ["admin.operator"]`, `adminRole`, `role`, or the equivalent `admin.viewer`/`admin.operator` boolean claims. Viewers can read status, alerts, analytics, exports, scanner presets, and job metadata; operators can perform the existing preset, replay, and job actions. The legacy API-key path remains available for machine clients. Protected webhook and news-monitor routes remain API-key-only.

When Firebase auth is enabled, configure `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for server-side Admin SDK token verification, plus the public browser settings listed above. Do not put service-account JSON or ID tokens in browser config, Postman variables, logs, or client error messages.

The public browser configuration may also include `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_MEASUREMENT_ID`; these values are not service-account credentials.

### Firebase Hosting for Admin Console

The `/admin` console is deployed as a static site on Firebase Hosting for the `cabros-bot` project (`https://cabros-bot.web.app/admin`):

- **Build & Artifacts**: `pnpm run build:hosting` synchronizes static console assets from `src/admin/` to `public/admin/` and generates the root redirect `public/index.html`. `firebase.json` defines the hosting root (`public`), ignore patterns, rewrite rules (`/admin/**` -> `/admin/index.html`), and `no-cache` cache-control headers.
- **Backend API Connectivity**: When hosted on Firebase Hosting (`*.web.app` / `*.firebaseapp.com`), the admin console resolves `https://cabros-bot-production.up.railway.app` by default. `?backend=` and `cabros_backend_origin` overrides are accepted only when their exact origin is the explicit HTTPS allowlist entry `https://cabros-bot-production.up.railway.app`; arbitrary origins, wildcards, HTTP URLs, and malformed values are ignored before any credential-bearing request.
- **CORS & CSP Policy**: Backend CORS permits requests from the explicit allowlist (`https://cabros-bot.web.app`, `https://cabros-bot.firebaseapp.com`, `https://cabros-bot-production.up.railway.app`, `http://localhost:*`, and optional `CORS_ALLOWED_ORIGINS`), and Helmet CSP allows `connect-src` to Google Auth, Firebase Hosting origins, and the backend origin.
- **CI/CD Deployment**: `.github/workflows/firebase-hosting.yml` automatically deploys pull requests to ephemeral Firebase preview channels and deploys the `live` channel on releases merged to `master`.
- **Local Testing**: Run `pnpm run build:hosting` then `firebase emulators:start --only hosting` to test the static hosting deployment locally on port 5000.
- **Rollback**: In the Firebase Console (Hosting > Release history) or via Firebase CLI: `firebase hosting:rollback` / `firebase hosting:clone cabros-bot:previous_version cabros-bot:live`.

.env.example is the canonical operator template. The documentation-alignment test checks static application-owned `process.env` reads against that template; platform-injected values, test-only controls, and deprecated compatibility aliases are explicitly classified instead of being copied into production configuration.

**Response:**
```json
{
  "service": {
    "name": "cabros-bot",
    "version": "0.1.0",
    "commit": "abcdef1234567890",
    "environment": "production"
  },
  "featureFlags": {
    "telegramBot": true,
    "whatsappAlerts": false,
    "geminiGrounding": true,
    "newsMonitor": true,
    "newsMonitorTestMode": false,
    "tradingViewMcpEnrichment": true,
    "tradingViewVolumeConfirmation": false,
    "firestoreAlertStorage": true,
    "firestoreJobStorage": false,
    "sentryMonitoring": true,
    "langfusePrompts": false,
    "marketScanner": true,
    "binancePriceCheck": false,
    "llmAlertEnrichment": false,
    "cloudflareAig": false,
    "messageFooterMetadata": true,
    "equityMarketData": false
  },
  "deliveryChannels": {
    "telegram": { "enabled": true, "status": "ready" },
    "whatsapp": { "enabled": false, "status": "disabled" }
  },
  "dependencies": {
    "telegram": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "whatsapp": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "gemini": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "tradingViewMcp": { "enabled": true, "configured": true, "ready": false, "status": "unknown", "lastCheckedAt": null, "lastSuccessAt": null, "lastFailureAt": null, "lastErrorCategory": null, "successCount": 0, "failureCount": 0, "enrichment": { "alertPath": { "windowMs": 86400000, "totalCount": 0, "appliedCount": 0, "failedCount": 0, "appliedRate24h": 0, "failureRate24h": 0 } }, "toolMetrics": {} },
    "tradingViewVolumeConfirmation": { "enabled": false, "configured": true, "ready": false, "status": "disabled", "lastCheckedAt": null, "lastSuccessAt": null, "lastFailureAt": null, "lastErrorCategory": null, "successCount": 0, "failureCount": 0 },
    "firestore": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "firestoreJobStorage": { "enabled": false, "configured": true, "ready": false, "status": "disabled" },
    "signalOutcomeWorker": {
      "enabled": false,
      "configured": true,
      "ready": false,
      "status": "disabled",
      "role": "web",
      "running": false,
      "shutdownRequested": false,
      "lastRunScannedCount": 0,
      "lastRunPendingCount": 0,
      "lastRunEvaluatedCount": 0,
      "lastRunErrorCount": 0
    },
    "sentry": { "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "langfuse": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "braveSearch": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "newsMonitorLlm": { "provider": "gemini", "enabled": true, "configured": true, "ready": true, "status": "ready" },
    "llmAlertEnrichment": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "cloudflareAig": { "enabled": false, "configured": false, "ready": false, "status": "disabled" },
    "equityMarketData": { "provider": null, "enabled": false, "configured": false, "ready": false, "status": "disabled", "supportedExchanges": ["BATS", "NASDAQ", "NYSE", "AMEX", "NYSE ARCA", "FX_IDC", "SPCFD"], "timeoutMs": 5000 }
  }
}
```

---

## Trading Endpoints

### POST /api/trading/binance/orders/preview

`POST /api/trading/binance/orders/preview` returns a pre-trade cost preview without ever calling `submitNewOrder`. It is exposed behind the existing `admin.viewer`/`admin.operator` flow (API-key or Firebase bearer) and fails closed if neither mechanism is configured, mirroring the live endpoint.

The response includes:
- LOT_SIZE-adjusted quantity and projected notional.
- Symbol constraints (`LOT_SIZE`, `MARKET_LOT_SIZE`, `PRICE_FILTER`, `NOTIONAL`, `MIN_NOTIONAL`) from cached exchange-info.
- Maker/taker fee estimate derived from `account.commission` (or 10 bps default) labeled `estimate — not a Binance fill guarantee`.
- Effective price source (`limitPrice` for LIMIT orders, `avgPrice` for MARKET orders, `quoteOrderQty` when only quote quantity is supplied).
- 5-second `expiresAt` token so the preview cannot be replayed against a stale book.
- MARKET BUY orders fetch `GET /api/v3/depth` with a 4-second `AbortController` deadline and expose slippage estimate in basis points; an optional `maxSlippageBps` request field causes `wouldExceedBudget: true` without rejecting the preview.
- `BINANCE_TRADING_MAX_NOTIONAL` is enforced (`403 MAX_NOTIONAL_EXCEEDED` on breach). The preview never mutates Binance and is a no-op when `ENABLE_BINANCE_TRADING=false`.
