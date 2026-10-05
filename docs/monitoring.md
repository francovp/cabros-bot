# Observability & Monitoring Guide

[← Back to README](../README.md)

## Runtime Error Monitoring (005-sentry-runtime-errors)

**📖 [Quickstart Guide](../specs/005-sentry-runtime-errors/quickstart.md)** — Complete setup and verification instructions.

The runtime error monitoring feature captures unexpected errors across all application flows and reports them to Sentry for centralized visibility and debugging.
When enabled, it also forwards configured console levels to Sentry Logs using the JavaScript SDK console logging integration.

### Monitored Flows

- **Alert Webhook** (`/api/webhook/alert`): HTTP errors during alert processing
- **News Monitor** (`/api/news-monitor`): Analysis errors and service failures
- **Telegram Commands** (`/precio`, `/cryptobot`): Bot command handler errors
- **WhatsApp Delivery**: Notification delivery failures after retry exhaustion
- **Process Level**: Uncaught exceptions and unhandled promise rejections

### Features

- **Non-Intrusive**: Monitoring failures never affect HTTP responses or message delivery
- **Environment Gating**: Auto-derives environment from Render.com, Vercel, and Railway system variables (`production`, `preview`, `development`)
- **Privacy Controls**: Optional exclusion of alert content from error events
- **Structured Console Logs**: All `console.*` output is emitted as one-line JSON with `timestamp`, `level`, `message`, `service`, `environment`, and optional `attributes`, `parameters`, and `error`
- **Console Log Capture**: Configured console levels are captured as searchable Sentry Logs
- **Optional Tracing/Spans**: Enable transaction traces plus custom spans for alert processing, news analysis, and multi-channel delivery
- **Graceful Degradation**: Works without affecting existing fallback mechanisms

### Configuration

```bash
# Enable Sentry (required)
ENABLE_SENTRY=true
SENTRY_DSN=https://key@o123.ingest.sentry.io/456

# Optional: Explicit environment (auto-derived if not set)
SENTRY_ENVIRONMENT=production

# Optional: Explicit release (derived from RENDER_GIT_COMMIT or VERCEL_GIT_COMMIT_SHA if not set)
SENTRY_RELEASE=v1.2.3

# Optional: Privacy control (default: true = include alert text)
SENTRY_SEND_ALERT_CONTENT=false

# Optional: Error sampling (default: 1.0 = 100%)
SENTRY_SAMPLE_RATE_ERRORS=1.0

# Optional: Trace sampling (leave unset to disable tracing)
SENTRY_TRACES_SAMPLE_RATE=0.1

# Optional: Console log levels captured as Sentry Logs (default: warn,error)
SENTRY_CONSOLE_LOG_LEVELS=warn,error
```

### Environment Auto-Detection

| Condition | Environment |
|-----------|-------------|
| `SENTRY_ENVIRONMENT` set | Uses explicit value |
| `RENDER=true` + `IS_PULL_REQUEST=true`, `VERCEL_ENV=preview`, or Railway PR metadata/name | `preview` |
| `RENDER=true`, `VERCEL_ENV=production`, or any Railway deployment (no preview) | `production` |
| `NODE_ENV=production` | `production` |
| Default | `development` |

### Troubleshooting

**Errors not appearing in Sentry**:
1. Verify `ENABLE_SENTRY=true` and `SENTRY_DSN` is set
2. Check application logs for `[SentryService] Monitoring disabled` message
3. Verify DSN format: `https://<key>@<org>.ingest.sentry.io/<project>`

**Console warnings/errors not appearing in Sentry Logs**:
1. Verify the installed `@sentry/node` version is `10.53.1` or newer
2. Confirm Sentry initialized with `enableLogs: true`
3. Confirm `SENTRY_CONSOLE_LOG_LEVELS` includes the level you are testing
4. Check the Sentry Logs view, not only the Issues view

**Manual Sentry error validation**:
1. Keep `ENABLE_SENTRY_DEBUG_ROUTE` unset in production and preview environments
2. For local-only validation, start the app with `ENABLE_SENTRY_DEBUG_ROUTE=true`
3. Request `GET /debug-sentry` locally to trigger the intentional test error
4. Remove the flag again after validation so the route falls back to `404`

**Expected behaviors not reporting** (by design):
- Validation errors (400 responses) are not reported
- Feature-disabled responses (403) are not reported
- These are expected behaviors, not runtime errors


---

## Monitoring

### Health Check

```bash
curl http://localhost/healthcheck
```

### Production Smoke Probe

A scheduled GitHub Actions workflow (`.github/workflows/production-smoke-probe.yml`) probes the Render production deployment every 15 minutes. **A failing probe fails the scheduled job, and GitHub's own notification for a failed scheduled workflow is the alert channel — this workflow has no paging step.** (The separate external uptime monitor below *does* page, on a DOWN transition only.) The probe runs `ops/production-smoke-probe.sh`, which:

- Hits `/healthcheck` (must return HTTP 200).
- Hits `/api/status` with the `x-api-key` header from the `WEBHOOK_API_KEY` GitHub secret.
- Asserts `service.commit` matches the latest `master` SHA (catches stale deploys).
- Optionally asserts each dependency in `PRODUCTION_REQUIRE_READY_DEPS` is `ready: true`.
- Optionally asserts each feature flag in `PRODUCTION_REQUIRE_ENABLED_FLAGS` is `true` (catches an enablement that never landed).

The default target must match the live platform. It previously defaulted to `https://cabros-bot-production.up.railway.app`, which answers 404 since Railway was retired. Because no `PRODUCTION_BASE_URL` repository variable is configured, the in-repo fallback is what actually executes — so the scheduled job probed a host that no longer exists and failed on every run, and a genuinely stale deploy was indistinguishable from a misconfigured target. The default is now the Render web service `cabros-crypto-bot-telegram-iac`.

Every failure message therefore ends with `(probed <base_url>)`. A 404 from a decommissioned host and a 404 from a broken service are indistinguishable in a log unless the message names what was probed, so a wrong target is always obvious at a glance and never confused with a real outage.

Configure the probe via GitHub repository variables (no application-owned env vars required):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRODUCTION_BASE_URL` | `https://cabros-crypto-bot-telegram.onrender.com` | Probe target. |
| `PRODUCTION_REQUIRE_READY_DEPS` | empty | Comma-separated dependency names that must be ready (e.g. `tradingViewMcp,firestore`). |
| `PRODUCTION_REQUIRE_ENABLED_FLAGS` | empty | Comma-separated `featureFlags` that must be `true` in production. |
| `PRODUCTION_PROBE_TIMEOUT` | `15` | Per-request curl timeout (seconds). |

Configure the probe via GitHub repository secrets:

| Secret | Purpose |
| --- | --- |
| `WEBHOOK_API_KEY` | Sent via the `x-api-key` header. Never appears in URLs, logs, or job summaries. |

There are no Telegram secrets for this workflow. An earlier revision documented `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` and `PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES` as optional paging controls, but no step read any of them, so all three were removed rather than left wired up to imply a page that never fires.

Exit codes:

- `0` — probe succeeded
- `2` — `AUTH_BLOCKED` (missing `WEBHOOK_API_KEY`) or `SECRET_LEAK` (credentials in URL)
- `3` — `/healthcheck` non-200
- `4` — `/api/status` request failed or returned non-JSON
- `5` — `service.commit` does not match the expected SHA (stale deploy)
- `6` — at least one required dependency is not ready
- `7` — `FLAG_DISABLED`: at least one required feature flag is not `true`

#### Asserting a production enablement actually landed

A `render.yaml` Blueprint entry with `value: true` is a *declaration of intent*. Production reality is a separate fact, and until now nothing in the repository connected the two — which is how `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT` could be declared `true` in the Blueprint while production reported `false` (issue #1109).

Set the `PRODUCTION_REQUIRE_ENABLED_FLAGS` repository variable to a comma-separated flag list to make the declaration checkable on a schedule. It defaults to empty, so it adds no failure mode until deliberately enabled.

```bash
ops/production-smoke-probe.sh \
  --require-enabled-flags tradingViewConfluenceEnrichment,langfusePrompts
```

**A flag absent from the deployed build counts as disabled.** The comparison demands the literal string `true`, so an absent key — which yields an empty value, not `true` — can never satisfy the assertion, and a stale build that predates the flag cannot pass. Treating absence as success would let an old deployment look compliant: the same shape-is-not-readiness trap this repository has hit repeatedly. Note that the jq default (`// false`) is *not* what enforces this; it only labels the diagnostic as `value=false` instead of blank. `tests/unit/production-smoke-probe.test.js` pins both halves — that an absent flag exits `7`, and that it is reported as `value=false`.

Verified live verdicts against production when this check was added:

```text
FLAG_DISABLED: tradingViewConfluenceEnrichment(value=false) (probed https://cabros-crypto-bot-telegram.onrender.com)
```

Run locally for debugging:

```bash
WEBHOOK_API_KEY=$YOUR_KEY \
  PRODUCTION_EXPECTED_COMMIT=$(git rev-parse origin/master) \
  ops/production-smoke-probe.sh
```

### External Uptime Monitoring

Every check described above lives *inside* the deployment, which is exactly the blind spot that cost six days of alert flow: on 2026-08-31 the hosting platform removed the production deployment platform-side (trial expiry) and `https://cabros-bot-production.up.railway.app` started answering `404 {"status":"error","code":404,"message":"Application not found"}`. Nothing outside the platform noticed, because there was no longer anything running to notice — including the in-repo smoke probe, which had been failing for an unrelated reason (issue #971) and whose failure looked identical to a routine misconfiguration.

The external monitor closes that gap. It runs from GitHub Actions, so it survives the deployment being removed, and it is **secretless**: `/healthcheck` is mounted in `app.js` before `validateApiKey` and before the rate limiter, so no API key is needed and the monitor cannot degrade into a silent no-op when a secret was never provisioned.

| Layer | Where it runs | Credentials | Detects |
| --- | --- | --- | --- |
| External uptime monitor (`external-uptime-monitor.yml`) | GitHub Actions, every 5 min | none | Platform-side removal, DNS/TLS failure, process death, ingress that answers 200 without the app |
| Uptime watchdog (`external-uptime-watchdog.yml`) | GitHub Actions, every 15 min offset | `GITHUB_TOKEN` | The monitor itself stopped running (no failed run ⇒ no GitHub notification) |
| Production smoke probe (`production-smoke-probe.yml`) | GitHub Actions, every 15 min | `WEBHOOK_API_KEY` | Stale deploy, authenticated routes, dependency readiness |
| Optional third-party SaaS monitor | Provider's own infrastructure | provider account | Hosting provider *and* GitHub Actions both unavailable |

The probe script is `ops/external-uptime-monitor.js`. Run it locally with `pnpm run uptime:monitor` or `node ops/external-uptime-monitor.js --no-page`; it prints one line of JSON and exits non-zero when the target is down.

Repository variables (all optional — each has a working default, so an unset variable degrades to the default rather than to a broken monitor):

| Variable | Default | Purpose |
| --- | --- | --- |
| `UPTIME_MONITOR_BASE_URL` | `https://cabros-crypto-bot-telegram.onrender.com` | Production origin to probe. Update this on any platform or host change. |
| `UPTIME_MONITOR_CHECK_DOCS` | `true` | Also probe the public `/docs` contract. |
| `UPTIME_MONITOR_TIMEOUT_MS` | `10000` | Per-request deadline in milliseconds. |
| `UPTIME_WATCHDOG_MAX_AGE_MINUTES` | `30` | How stale the last monitor run may be before the watchdog fails. |

Repository secrets (both optional; paging is disabled until both are set):

| Secret | Purpose |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Admin-notifications bot token used for the transition page. |
| `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` | Admin chat that receives the page. |

Exit codes:

| Code | Reason | Meaning |
| --- | --- | --- |
| `0` | `UP` | Healthcheck answered 200 with the application payload. |
| `3` | `HEALTHCHECK_UNREACHABLE` | DNS/connection failure, timeout, or non-200. This is the platform-removal case. |
| `4` | `HEALTHCHECK_BODY_UNEXPECTED` | HTTP 200 that is not this application — a proxy placeholder or CDN interstitial never reads as up. |
| `5` | `DOCS_UNREACHABLE` | `/healthcheck` is fine but the public `/docs` contract is not, which catches a half-migrated ingress. |
| `6` | `BASE_URL_INVALID` | Missing, non-HTTP(S), or credential-bearing target. |
| `7` | `MONITOR_INTERNAL_ERROR` | The monitor itself broke. Reported as DOWN — a broken monitor must never report UP. |

Alert routing:

1. **Primary, zero configuration.** A non-zero exit fails the scheduled job, and GitHub notifies repository admins of failed workflows. This works with no secrets at all.
2. **Optional Telegram page.** The script pages the admin chat once when the verdict transitions into DOWN, and once when it recovers. It deliberately does *not* re-page on every interval of a continuing outage — GitHub already reports each failing run, and a page every five minutes for six days is how an alert channel gets ignored. The previous run's conclusion is read from the Actions API and passed as `--previous-conclusion`; a manual `workflow_dispatch` run does not page unless `force_page` is set, so an operator test run cannot page the real chat.
3. Paging is fail-open: a Telegram failure is recorded as `paging_failed` and never changes the probe verdict or exit code.

**Verifying detection.** With the monitor merged, a failing probe is observable immediately:

```bash
node ops/external-uptime-monitor.js --base-url=https://<deliberately-wrong-host> --no-page; echo "exit=$?"
# {"status":"down","reason":"HEALTHCHECK_UNREACHABLE","exitCode":3,...}
# exit=3
```

To confirm the paging path end to end, run the workflow manually against a known-bad host with `force_page: true`, then confirm the page arrived and that the next scheduled run (previous conclusion now `failure`) does **not** page again.

#### Registering a third-party uptime service

The in-repo monitor covers a GitHub Actions outage; a hosted uptime service additionally covers a GitHub outage, and is the only layer that does not depend on this repository. Register the following with any provider that offers an HTTP uptime check (Better Stack, UptimeRobot, StatusCake, or equivalent — check the provider's current interval and quota before choosing):

| Field | Value |
| --- | --- |
| Monitor URL | `https://<production-host>/healthcheck` |
| Method | `GET` |
| Interval | 5 minutes (or the shortest the plan allows) |
| Expect | status `200` |
| Optional second monitor | `https://<production-host>/docs`, expect `200` |
| Alert contacts | Operator email, plus a Telegram alert via the provider's Telegram integration or an outbound webhook to a private relay |
| Paused on deploy? | **No.** A deploy pause must not silence the check; confirm the new deployment on the in-repo monitor instead. |

Never give a third-party monitor the production `WEBHOOK_API_KEY`. The liveness probe needs no credential, and a provider holding that key would turn a monitoring account compromise into full alert-injection capability.

#### Platform migration re-activation checklist

A migration is exactly how the last monitor was lost: the new host was never registered, and the old monitor's target was deleted with the old deployment. Run this list every time the hosting platform, the production host, or the plan changes:

- [ ] Set `UPTIME_MONITOR_BASE_URL` to the new production origin (repository variable).
- [ ] Confirm `node ops/external-uptime-monitor.js --base-url=<new origin> --no-page` exits `0`.
- [ ] Update the third-party provider's monitor URL (if one is registered), and re-confirm it reports UP.
- [ ] Update `PRODUCTION_BASE_URL`, the smoke probe's dependency list, `docs/environment-configuration.md`, `README.md`, and `AGENTS.md` to the new origin.
- [ ] Trigger `workflow_dispatch` on `external-uptime-monitor.yml` and confirm the run is green.
- [ ] Watch one `external-uptime-watchdog.yml` run pass, so the monitor is known to be scheduled.
- [ ] Confirm the previous platform's domain is intentionally released, not merely abandoned.

### Logs

The application logs to stdout:

- `INFO`: Bot initialization, webhook received, alerts sent
- `DEBUG`: Detailed processing steps
- `WARN`: Configuration warnings, retry attempts
- `ERROR`: Delivery failures, API errors

## Structured Request Logging (GH-665)

Every completed HTTP request emits exactly one structured JSON line, in addition
to the free-form application logs above. Each line records:

| Field | Meaning |
|---|---|
| `method` | HTTP method |
| `path` | Request path with the query string and trailing slash stripped (case preserved; `chatId` redacted) |
| `statusCode` | Final response status (`0` when the response never started) |
| `durationMs` | Time from middleware entry to response end (excludes connection setup and TLS) |
| `requestId` | Correlation id, shared with the `X-Request-Id` response header. Some handlers also echo it as `requestId` in the response body |
| `clientIp` | Client address, truncated (`203.0.113.x`) or redacted for IPv6 |
| `aborted` | `true` when the client disconnected before the response was fully flushed |
| `outcome` | `completed` or `aborted` |

Example line:

```json
{"timestamp":"2026-10-02T08:12:44.913Z","level":"warn","message":"Request completed","service":"cabros-bot","attributes":{"method":"POST","path":"/api/webhook/alert","statusCode":408,"durationMs":30012,"requestId":"3f1c...","clientIp":"203.0.113.x","aborted":false,"outcome":"completed"}}
```

**Log level** follows the status code: `info` for 2xx/3xx, `warn` for 4xx and
client aborts, `error` for 5xx.

**Correlating a request.** Use `requestId` to follow one request end to end. It
is the same value the request-deadline middleware puts in its `408` payload and
in the `X-Request-Id` response header, so a timeout in the logs lines up with the
client's error body:

```bash
grep '"requestId":"3f1c' logs.json | jq -c '{path:.attributes.path,status:.attributes.statusCode}'
```

The `X-Request-Id` **response header** is the reliable surface, and it is set on
every non-exempt route. Body echo is handler-dependent: many handlers include
`requestId`, but middleware-generated failures do not — a `401` from
`validateApiKey` carries only `{"error":"Unauthorized: Missing API key"}`. Search
logs by the header value rather than assuming a body field exists.

**What is not logged.** Probe paths (`/healthcheck`, `/ready`, `/openapi.json`,
`/docs` and its static asset subtree — the same list the request deadline
exempts) are silent, and query strings are stripped so request parameters never
reach the log. Request and response bodies are never logged.

Path **case is preserved** in `path`, so an id can be searched exactly as it
appeared in the request — Firestore document ids are mixed case. Probe-path
exemption is matched case-insensitively, so `/HEALTHCHECK` is silent too.

Chat identifiers are redacted: `/api/preferences/telegram/123456789` is logged as
`/api/preferences/telegram/:redacted`, because a chat id is a personal
destination. Other path parameters (`alertId`, `jobId`, scanner preset ids) are
kept so those paths stay searchable during triage.

**Tuning.** The middleware has no configuration of its own. Raise or lower
verbosity with `LOG_LEVEL`, and exempt additional probe paths with
`REQUEST_DEADLINE_EXEMPT_PATHS` — the logging skip list follows it.
