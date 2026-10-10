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

### Dependency readiness probes (`?depth=readiness` / `?depth=dependencies`)

Bootstrap completion only proves the process started. It says nothing about whether Firestore, Gemini, TradingView MCP, Binance, and the Telegram bot are reachable right now — so a running process with a dead Firestore connection or an expired Gemini key still passes both `/healthcheck` and `/ready` and keeps receiving traffic it cannot serve.

Two opt-in `depth` values add bounded external dependency probes:

| Surface | Question | Degraded result |
| :--- | :--- | :--- |
| `GET /healthcheck` | Is the process alive? | never |
| `GET /healthcheck?deep=true` | Are the enabled **notification channels** ready? | `503` |
| `GET /ready` | Did **startup bootstrap** complete? | `503` |
| `GET /healthcheck?depth=readiness` | Are external **dependencies** healthy (advisory)? | `200` with `ready: false` |
| `GET /ready?depth=dependencies` | Bootstrap **and** dependencies, traffic-gating? | `503` |

Both probes run the same five checks **in parallel**, each with a bounded 1–5 second timeout (default 3s, clamped). Disabled features are reported as `skipped: true` and excluded from the verdict, so the payload works unchanged in preview, development, and production. No new environment variable is required. A probe is only scheduled when its feature flag is enabled, so a deployment that does not use Gemini never pays for a Gemini probe and never fails one.

`/ready?depth=dependencies` **layers** on the bootstrap gate rather than replacing it: the verdict is `bootstrap.ready AND dependencies.ready`, and the response echoes `status`, `components`, and `bootstrapReady`. A replica that has not finished bootstrapping therefore never reports 200 to a load balancer, no matter how healthy its providers are.

Results are memoized for 5 seconds and concurrent requests are single-flighted, so a load balancer polling every few seconds cannot fan out to Gemini, Binance, and TradingView on every hit from every replica. A degraded dependency that is switched on but not configured (`firestore_not_configured`, an expired service account) counts as a failure rather than a skip, because the feature is supposed to be working.

All surfaced `error` strings pass through the shared log redaction layer, and the Gemini key is sent in the `x-goog-api-key` header rather than the query string, so a provider error can never disclose a credential on this unauthenticated surface.

**Why the advisory surface never returns 503.** A readiness probe wired into a load balancer restarts or evicts replicas that fail it. If a transient Gemini timeout or a Binance `451` flipped the HTTP status, one flaky third party would pull every healthy replica out of rotation and turn a partial degradation into a full outage — precisely the failure mode the probe exists to detect. The default surface is therefore **observability only**: it always returns `200` and reports degradation in the body's `ready` field, for alerting and dashboards. Operators who *want* dependency health to gate traffic opt into `/ready?depth=dependencies`, which fails closed. Default to alerting on `ready: false`; reserve the 503 variant for deployments that can tolerate losing all capacity when a provider is down.

**Advisory response (`?depth=readiness`, always HTTP 200):**
```json
{
  "ready": true,
  "failClosed": false,
  "checkedAt": "2026-08-31T02:30:00.000Z",
  "latencyMs": 412,
  "dependencies": {
    "firestore": { "ready": true, "backend": "firestore", "latencyMs": 53 },
    "gemini": { "ready": true, "backend": "gemini", "latencyMs": 124 },
    "tradingViewMcp": { "ready": true, "backend": "tradingview_mcp", "latencyMs": 18 },
    "binance": { "ready": true, "backend": "binance", "latencyMs": 36 },
    "telegram": { "ready": true, "backend": "telegram", "latencyMs": 22 }
  }
}
```

A degraded dependency reported alongside a disabled feature — still HTTP `200`:
```json
{
  "ready": false,
  "failClosed": false,
  "latencyMs": 3011,
  "dependencies": {
    "gemini": { "ready": false, "latencyMs": 3001, "error": "timeout_after_3000ms" },
    "telegram": { "ready": false, "enabled": false, "skipped": true, "reason": "telegram_disabled" }
  }
}
```

The fail-closed variant (`/ready?depth=dependencies`) returns the same body with `failClosed: true` and HTTP `503` when any considered dependency is unhealthy.

Probes never throw and never block: a transient provider failure surfaces a per-dependency `error` string and a `ready: false` verdict without affecting webhook ingest, notification dispatch, or any other production path. Bare `/healthcheck` and bare `/ready` keep their existing contracts and never run provider probes.

### GET /api/status

Machine-readable runtime status for operational tooling. This endpoint uses the same `WEBHOOK_API_KEY` protection as other `/api` endpoints when that environment variable is configured. Send the key with the `x-api-key` header.

The response intentionally exposes only non-sensitive booleans and metadata: service identity, version, commit, environment, feature-flag state, delivery channel readiness, and dependency readiness/configuration status. Secret values such as bot tokens, API keys, DSNs, chat IDs, and provider URLs are not returned.

For `ENABLE_NEWS_MONITOR=true`, the payload also reports the primary LLM dependency used by that flow as `dependencies.newsMonitorLlm`, including the resolved provider (`gemini`, `azure`, or `openrouter`) and whether that provider is actually configured for runtime use. When `FORCE_BRAVE_SEARCH=true`, the payload also exposes `dependencies.braveSearch` so the forced search path can be monitored independently of Gemini. When `ENABLE_GEMINI_GROUNDING=true` and `MODEL_PROVIDER=gemini`, `dependencies.gemini` requires both `GEMINI_API_KEY` and `GEMINI_MODEL_NAME`, matching the runtime path used for grounded alert generation. `dependencies.geminiQuota` reports whether a Gemini quota cooldown is active, bounded remaining cooldown duration, trigger counters, Brave search fallback events during cooldown, and grounding request telemetry counters (`totalRequests`, `successRequests`, `failureRequests`, `timeoutRequests`) without exposing prompts, error bodies, or provider credentials. `dependencies.groundingCoalescing` reports the bounded equity-alert search sharing window and hit/miss/failure counters. Firestore readiness treats `GOOGLE_APPLICATION_CREDENTIALS` as configured only when the referenced credential file exists and is readable.

When `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION=true`, `featureFlags.tradingViewVolumeConfirmation` reports the gate value and `dependencies.tradingViewVolumeConfirmation` reports readiness only when the configured TradingView MCP endpoint and its parent MCP enrichment gate are active.

TradingView dependency readiness is runtime-derived and fail-open: `configured` reflects the effective endpoint, while `status` starts as `unknown` and changes to `ready` or `degraded` after an MCP operation. `lastErrorCategory` is sanitized to categories such as `timeout`, `http_5xx`, `http_4xx`, `invalid_response`, `provider_unavailable`, or `request_failed`; terminal provider outages do not consume the retry chain, and `lastHttpStatusCode` exposes the last observed HTTP status without returning provider response bodies or URLs from `/api/status`.

When `ENABLE_FIRESTORE_JOB_STORAGE=true`, `featureFlags.firestoreJobStorage` reports the async-job persistence gate and `dependencies.firestoreJobStorage` reports readiness using the configured Firestore credentials. The legacy `ENABLE_FIRESTORE_ALERT_STORAGE=true` gate also reports job storage as enabled because it activates the same runtime persistence path.

`featureFlags.newsMonitorTestMode` reports `ENABLE_NEWS_MONITOR_TEST_MODE` without changing the news monitor's existing test-mode behavior.

`featureFlags.messageFooterMetadata` reports the `ENABLE_MESSAGE_FOOTER_METADATA` setting. It defaults to `true` and is disabled only when the environment variable is explicitly set to `false`.

When `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION=true`, `/api/webhook/alert` suppresses duplicate channel delivery for the same `(exchange, symbol, timeframe, side)` signal within a cooldown window of `ALERT_SIGNAL_COOLDOWN_BARS` bars (default `1`). Suppressed requests still return 200 with `suppressedRepeat: true`, empty `results`/`deliveredChannels`, and remain persisted with a suppression marker so replay and audit stay complete. Opposite-side flips always deliver; storage failures fail open to normal delivery. `featureFlags.alertSignalRepeatSuppression` reports the gate and `dependencies.alertSignalRepeatSuppression` exposes non-sensitive counters (`suppressedCount`, `lastSuppressedAt`, `activeTrackedSignals`).

When `ENABLE_ALERT_SYNTH_BURST_AGGREGATION=true`, `/api/webhook/alert` buffers a parsed TradingView signal for `ALERT_BURST_WINDOW_MS` and collapses alerts that share the same direction **and** identical notification routing into a single "⚡ Regime shift" message per channel. Alerts are grouped by direction only — a market-wide burst spanning crypto and equities is one event, and each symbol's exchange and timeframe are listed in the message. Requests that reach `ALERT_BURST_MIN_SIGNALS` inside the window return `200` with `aggregated: true`, the shared `burstAggregateId`, `burstSignalCount`, and the single aggregate set of `results`/`deliveredChannels`; every constituent alert is still persisted individually with the same `burstAggregateId`, so outcome analytics keep per-symbol granularity. A window that closes below the minimum, a direction that never matches, a `symbolRoutes` request, and unparsed text all take the normal individual path (only the window latency is added). Any store, dispatch or shutdown failure releases held alerts to individual delivery — aggregation can lose noise reduction, never an alert. `featureFlags.alertBurstAggregation` reports the gate and `dependencies.alertBurstAggregation` exposes non-sensitive counters (`openWindows`, `windowMs`, `minSignals`, `aggregatedBurstCount`, `aggregatedSignalCount`, `aggregatedFailoverCount`, `releasedSignalCount`, `lastAggregatedAt`, `lastWindowClosedAt`), which are process-local and reset on restart.

`dependencies.signalClassClassification` exposes in-memory counters for signal classification on the `POST /api/webhook/alert` ingest path. `featureFlags.signalClassMarker` only states that the badge marker is *allowed* to render; this block states whether alerts are *actually* being classified, so a silent regression back to 100% `unknown` is detectable instead of looking healthy. The section is omitted entirely until at least one alert has been classified and resets on process restart, mirroring the `firestoreWriteMetrics` pattern. Counters report `totalAlerts`, `classifiedAlerts`, `unknownAlerts`, `populationRate` (`classifiedAlerts / totalAlerts`, so a sustained `0` means nothing is being classified), and a per-class `byClass` breakdown. Only enum class names and counts are exposed — never alert text, symbols, or chat IDs. Historical records are **not** backfilled; the counters describe the current process window only.

`dependencies.firestoreWriteMetrics` exposes in-memory per-domain Firestore write counters for `AlertStorageService.saveAlert`/`saveReplayAttempt` and `JobRepository.save`. The section is omitted entirely until at least one write has been recorded and resets on process restart, mirroring the existing `deliveryMetrics` pattern. Counters report `writesAttempted`, `writesSucceeded`, `writesFailed`, overall `successRate`, and a per-domain `byDomain` breakdown with sanitized counts so silent persistence failures can be detected without exposing provider responses or credentials.

### Firestore read health (issue #1285)

Write counters alone could not detect a total read-path outage: every alert write could succeed while every ordered stored-alert read was rejected, and `dependencies.firestore.ready` still returned `true` because `configured` only validates credential *shape*.

`dependencies.firestoreReadMetrics` is the independent read-side counter set, omitted until at least one read has been recorded and reset on process restart. It reports `readsAttempted`, `readsSucceeded`, `readsFailed`, overall `successRate`, a per-domain `byDomain` breakdown, `consecutiveReadFailures`, `lastReadAt`, `lastReadFailureAt`, and a sanitized `lastErrorCategory`.

`readHealth` is the field that drives readiness:

| Value | Meaning | `dependencies.firestore.ready` |
| :--- | :--- | :--- |
| `unknown` | No read observed yet — no evidence, not a failure | unchanged (`enabled && configured`) |
| `healthy` | Last read succeeded | unchanged |
| `degraded` | Consecutive-failure streak is non-empty | **`false`**, `status: "degraded"` |

While degraded, `dependencies.firestore` additionally carries `readsFailed`, `consecutiveReadFailures`, `lastReadErrorCategory`, and `lastReadFailureAt`. Read health recovers on the first successful read without a process restart.

`lastErrorCategory` is drawn from a closed, sanitized enum — `uninitialized`, `failed_precondition`, `permission_denied`, `unauthenticated`, `unavailable`, `deadline_exceeded`, `not_found`, `resource_exhausted`, `invalid_argument`, `aborted`, `internal`, `unknown_error`. The provider message is **never** returned: Firestore embeds the fully-qualified project/database path and the index definition in it, so both go to the log only.

### Stored-alert `503 STORAGE_UNAVAILABLE`

Stored-alert read endpoints answer `503` with a machine-readable `category` so a rejected query is distinguishable from a credential failure without a Cloud Logging session:

| `category` | Meaning | Fix |
| :--- | :--- | :--- |
| `uninitialized` | The Firestore client never built | Check `FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS` and the project id |
| `failed_precondition` + `missingIndex: true` | Client was fine; the **query** was rejected for a missing composite index | Deploy the indexes declared in `firestore.indexes.json` |
| `failed_precondition` | Query rejected for another precondition | Inspect the logged provider message |
| `permission_denied` | IAM or Firestore security rules rejected the call | Check service-account roles and `firestore.rules` |
| `unavailable` / `deadline_exceeded` | Backend unreachable or over deadline | Usually transient; retry |
| `resource_exhausted` | Quota or rate limit | Back off and check quotas |

`category` and `missingIndex` are omitted when the failure could not be classified, so consumers must treat them as optional.

`GET /ready?depth=dependencies` runs the same indexed `alerts` read (bounded to one document) in its Firestore probe, so a missing index fails the gate closed instead of only surfacing on the admin console. The probe replaced `listCollections()`, which is a metadata call that never executes a collection query and therefore could not observe this class of fault. See [Observability & Monitoring](monitoring.md) and [Troubleshooting](troubleshooting.md).

`featureFlags.cloudflareAig` reports `ENABLE_CLOUDFLARE_AIG`, while `dependencies.cloudflareAig` reports Cloudflare AI Gateway readiness **including whether the gateway is actually in the runtime request path**. `dependencies.cloudflareAig.provider` is the selected `MODEL_PROVIDER` and `dependencies.cloudflareAig.routed` reports whether that provider is `cloudflare`.

`ENABLE_CLOUDFLARE_AIG` is a telemetry-visibility flag only; it does not route LLM traffic — `MODEL_PROVIDER` does. Setting the flag plus credentials while another provider is selected leaves every request on that provider, so the block reports `ready: false` with `status: "inactive"` rather than claiming readiness. `status` is `ready` only when the gateway is enabled, credentialed, and routed; `misconfigured` when it is routed but credentials are missing; `disabled` when the flag is off.

`notificationChannelIntent` reports the operator-intent view of notification channel configuration (`telegram`, `whatsapp`, `discord`). It mirrors `NotificationChannel.isConfigured()`: a channel counts as `configured` when its enable flag is set **and** its required credentials/chat id/webhook are present — the same `ready` semantics `dependencyStatus` already uses. A channel with a webhook URL present but its enable flag off therefore reports as **not** configured, which is the same verdict the zero-channel admin page reaches because both call that one method. The view answers the question the zero-channel page exists to raise — a channel the operator never set up (`unconfigured`) versus one that is set up but currently failing. The page reports the same two sets, so an operator can reconcile an alert from the page and `/api/status` without inspecting credentials. Only channel names are exposed; never tokens, webhook URLs, or chat IDs.

`adminPaging` reports whether operator pages are actually landing, which channel readiness cannot: a readiness block says `ready` from configuration alone, so it reports `ready` for a channel that is failing 100% of live sends. Operator pages (delivery-failure and zero-channel) are sent over the non-recursive admin path — the Telegram admin chat first, then the other operator-configured channels — and when the primary destination fails the fallback prefers whichever candidate's observed delivery health is best (`healthy` → `unknown` → `degraded` → `failing`, with a deterministic `discord`-then-`whatsapp` tie-break). A channel the operator never configured is never used, so no phantom page is produced. The block is omitted until a `NotificationManager` exists and exposes `status` (`unknown` before the first attempt, `ready` once a page landed, `degraded` when every page failed on every operator channel), `attempts`/`successes`/`failures`, `consecutiveFailures`, `lastSuccessAt`/`lastFailureAt`, `lastSuccessChannel`, `lastErrorCategory`, a truncated sanitized `lastError`, `fallbackEnabled`, and `fallbackChannels`. `consecutiveFailures` is the signal external uptime monitoring can page on. Admin paging never re-enters the broadcast dispatch path, so it cannot inflate `deliveryMetrics` or the dead-letter queue, and no destination value is ever exposed.

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

Both credential controls are native `<form>` elements with a submit handler, so Enter signs in or saves the key and the browser performs constraint validation before the Firebase SDK or session storage is reached. The email field is `type="email"` and `required`, the key field is `required` (an all-whitespace key is refused too, which native `required` alone accepts), and every field carries a stable `name` plus an explicit `label`/`for` pairing. A rejected credential pair is reported once through `#auth-credentials-error`, which both credential inputs reference with `aria-describedby`, with `aria-invalid` cleared on the next edit.

Neither form has an `action`, so a submit the client did not handle would perform a native `GET` and place the credentials in the URL. Both submit listeners are therefore attached before either card is revealed and always cancel the submission; readiness (`initializeApp` plus `setPersistence` having resolved) gates only the authentication call, and the credential card is not shown at all when Firebase auth is unconfigured. Error text is always a fixed string: submitted credentials are never echoed into a message, a log, or a URL. The legacy key remains session-only and is still sent as the `x-api-key` request header.

The server verifies Firebase ID tokens with revoked-token checks enabled. Custom claims may use `roles: ["admin.viewer"]`, `roles: ["admin.operator"]`, `adminRole`, `role`, or the equivalent `admin.viewer`/`admin.operator` boolean claims. Viewers can read status, alerts, analytics, exports, scanner presets, and job metadata; operators can perform the existing preset, replay, and job actions. The legacy API-key path remains available for machine clients. Protected webhook and news-monitor routes remain API-key-only.

When Firebase auth is enabled, configure `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for server-side Admin SDK token verification, plus the public browser settings listed above. `GOOGLE_APPLICATION_CREDENTIALS` accepts either a service-account key or an Application Default Credentials document (`authorized_user` from `gcloud application-default login`, or `external_account` workload identity); the latter types carry no project id, so `FIREBASE_PROJECT_ID` is required on that path. `FIREBASE_SERVICE_ACCOUNT_JSON` accepts service accounts only. Do not put service-account JSON or ID tokens in browser config, Postman variables, logs, or client error messages.

The public browser configuration may also include `FIREBASE_STORAGE_BUCKET`, `FIREBASE_MESSAGING_SENDER_ID`, and `FIREBASE_MEASUREMENT_ID`; these values are not service-account credentials.

### Firebase Hosting for Admin Console

The console uses self-hosted Vue 3 components for contract-driven forms and readable response cards and tables. Query filters, nested request options, lists, and job variants are editable without JSON. Existing Firebase roles, API-key transport, confirmations, and request deadlines still apply. The responsive theme includes keyboard focus states and a skip link.

`src/admin/admin-components.js` contains the visual editors and result components. It uses Vue render functions with the self-hosted runtime, so no browser template compiler, CDN, or CSP relaxation is required. `pnpm run build:hosting` refreshes the runtime from the locked dependency and copies the admin assets to `public/admin/`; do not edit generated runtime or hosting copies directly.

The `/admin` console is deployed as a static site on Firebase Hosting for the `cabros-bot` project (`https://cabros-bot.web.app/admin`):

- **Build & Artifacts**: `pnpm run build:hosting` synchronizes static console assets from `src/admin/` to `public/admin/` and generates the root redirect `public/index.html`. `firebase.json` defines the hosting root (`public`), ignore patterns, rewrite rules (`/admin/**` -> `/admin/index.html`), and `no-cache` cache-control headers.
- **Backend API Connectivity**: When hosted on Firebase Hosting (`*.web.app` / `*.firebaseapp.com`), the admin console resolves `https://openclaw.tail5e4271.ts.net` by default. The `cabros_backend_origin` localStorage override takes precedence over `?backend=`; both accept only the exact HTTPS origins `https://openclaw.tail5e4271.ts.net` and `https://cabros-bot-production.up.railway.app`; arbitrary origins, wildcards, HTTP URLs, and malformed values are ignored before any credential-bearing request. `?backend=` is preserved across view navigation and filter state.
- **Shareable URLs**: the active view and report filters live in the query string. `?view=<name>` selects one of `overview`, `status`, `alerts`, `outcomes`, `presets`, `jobs`, `orders`, `analysis`, or `playground`; filter fields are namespaced per form as `<scope>.<field>` (for example `?view=alerts&alerts.summary.from=2026-08-01T00:00&alerts.summary.limit=500`). Scope prefixes keep the Alerts summary and export filter sets independent because they are separate forms with separate defaults. Browser Back/Forward move between views without a page reload, a refresh preserves the view and its filters, and an unrecognized `view` value falls back to `overview` and rewrites the URL rather than rendering a blank workspace. A shared link still respects authentication: an unauthenticated deep link shows the sign-in card and issues no API request until sign-in.
- **CORS & CSP Policy**: Backend CORS permits requests from the explicit allowlist (`https://cabros-bot.web.app`, `https://cabros-bot.firebaseapp.com`, `https://cabros-bot-production.up.railway.app`, `http://localhost:*`, and optional `CORS_ALLOWED_ORIGINS`), and Helmet CSP allows `connect-src` to Google Auth, Firebase Hosting origins, and the backend origin.
- **CI/CD Deployment**: `.github/workflows/firebase-hosting.yml` automatically deploys pull requests to ephemeral Firebase preview channels and deploys the `live` channel on releases merged to `master`.
- **Browser verification**: With the local console open in Playwright CLI, run `playwright-cli run-code --filename=scripts/check-admin-browser.js`. The check visits contract operations, edits and restores fields, submits to intercepted API responses, and checks mobile overflow. Screenshots are saved under `output/playwright/`.
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
  "notificationChannelIntent": {
    "configured": ["telegram"],
    "unconfigured": ["whatsapp", "discord"]
  },
  "adminPaging": {
    "enabled": true,
    "status": "degraded",
    "telegramAdminChatConfigured": true,
    "fallbackEnabled": false,
    "fallbackChannels": [],
    "attempts": 3,
    "successes": 0,
    "failures": 3,
    "consecutiveFailures": 3,
    "lastSuccessAt": null,
    "lastFailureAt": "2026-09-28T04:00:00.000Z",
    "lastSuccessChannel": null,
    "lastAttemptChannel": "telegram",
    "lastErrorCategory": "PROVIDER_ERROR",
    "lastError": "Bad Request: chat not found",
    "byChannel": [
      { "pageType": "delivery-failure", "channel": "telegram", "success": 0, "failure": 3 }
    ]
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
