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

A scheduled GitHub Actions workflow (`.github/workflows/production-smoke-probe.yml`) probes the Railway deployment every 15 minutes and pages the Telegram admin chat when production is unreachable. It checks out the repository first, so `ops/production-smoke-probe.sh` is present on the runner. The probe:

- Hits `/healthcheck` (must return HTTP 200).
- Hits `/api/status` with the `x-api-key` header from the `WEBHOOK_API_KEY` GitHub secret.
- Asserts `service.commit` matches the expected SHA (catches stale deploys). By default that is the latest `master` SHA; the `workflow_dispatch` `expected_commit` input overrides it.
- Optionally asserts each dependency in `PRODUCTION_REQUIRE_READY_DEPS` is `ready: true`.

Every run resolves to exactly one **outcome**, so a broken CI setup is never reported as a production outage:

| Outcome | Meaning | Pages the admin chat? |
| --- | --- | --- |
| `ok` | Service reachable, healthy, on the expected commit | No |
| `down` | `/healthcheck` non-200, or `/api/status` unreachable | **Yes** |
| `stale` | `service.commit` differs from the expected commit (deploy in flight) | No |
| `degraded` | Reachable, but a required dependency is not ready | No |
| `unconfigured` | `WEBHOOK_API_KEY` is not set, so the probe never ran | No |
| `script_missing` | The probe script was absent from the workspace | No |
| `invalid_args` | The probe rejected its arguments | No |
| `unknown` | Unclassified non-zero exit | No |

Only `down` pages. Paging a stale deploy or a missing secret would train operators to ignore the one signal that means alerts are not being delivered. Every non-`ok` outcome still fails the job and emits a `::error::` or `::warning::` annotation naming the specific failure.

Configure the probe via GitHub repository variables (no application-owned env vars required):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRODUCTION_BASE_URL` | `https://cabros-bot-production.up.railway.app` | Probe target. The `workflow_dispatch` `base_url` input overrides it. |
| `PRODUCTION_REQUIRE_READY_DEPS` | empty | Comma-separated dependency names that must be ready (e.g. `tradingViewMcp,firestore`). |
| `PRODUCTION_PROBE_TIMEOUT` | `15` | Per-request curl timeout (seconds). |
| `PRODUCTION_PROBE_FAILURE_COOLDOWN_MINUTES` | `60` | Minimum gap between repeat operator pages during a sustained outage. `0` pages on every run. A malformed value falls back to `60` with a warning. |

Configure the probe via GitHub repository secrets:

| Secret | Purpose |
| --- | --- |
| `WEBHOOK_API_KEY` | **Required.** Sent via the `x-api-key` header. Never appears in URLs, logs, or job summaries. |
| `TELEGRAM_BOT_TOKEN` | (Optional) Enables admin paging when production is down. |
| `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` | (Optional) Target chat id for admin paging. Both Telegram secrets must be set or neither is used. |

The cooldown latch is stored in `.smoke-probe-state/` and carried between runs through the GitHub Actions cache. It latches **only after a confirmed delivery**, so a page that could not be delivered is retried on the next scheduled run, and a successful (`ok`) run clears it so the next outage pages immediately.

Run locally for debugging:

```bash
WEBHOOK_API_KEY=$YOUR_KEY \
PRODUCTION_BASE_URL=https://cabros-bot-production.up.railway.app \
PRODUCTION_EXPECTED_COMMIT=$(git rev-parse origin/master) \
ops/production-smoke-probe.sh

# Exercise the paging decision without sending anything.
PROBE_OUTCOME=down \
PROBE_DETAIL='HEALTHCHECK_FAILED: /healthcheck returned HTTP 503.' \
ops/production-smoke-probe-notify.sh
```

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
