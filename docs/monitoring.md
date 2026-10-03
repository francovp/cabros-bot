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

A scheduled GitHub Actions workflow (`.github/workflows/production-smoke-probe.yml`) probes the Railway deployment every 15 minutes and pages the Telegram admin chat on persistent failures. The probe runs `ops/production-smoke-probe.sh`, which:

- Hits `/healthcheck` (must return HTTP 200).
- Hits `/api/status` with the `x-api-key` header from the `WEBHOOK_API_KEY` GitHub secret.
- Asserts `service.commit` matches the latest `master` SHA (catches stale deploys).
- Optionally asserts each dependency in `PRODUCTION_REQUIRE_READY_DEPS` is `ready: true`.

Configure the probe via GitHub repository variables (no application-owned env vars required):

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRODUCTION_BASE_URL` | `https://cabros-bot-production.up.railway.app` | Probe target. |
| `PRODUCTION_REQUIRE_READY_DEPS` | empty | Comma-separated dependency names that must be ready (e.g. `tradingViewMcp,firestore`). |
| `PRODUCTION_PROBE_TIMEOUT` | `15` | Per-request curl timeout (seconds). |

Configure the probe via GitHub repository secrets:

| Secret | Purpose |
| --- | --- |
| `WEBHOOK_API_KEY` | Sent via the `x-api-key` header. Never appears in URLs, logs, or job summaries. |
| `TELEGRAM_BOT_TOKEN` | (Optional) Enables admin paging on persistent failures. |
| `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` | (Optional) Target chat id for admin paging. |

Exit codes:

- `0` — probe succeeded
- `2` — `AUTH_BLOCKED` (missing `WEBHOOK_API_KEY`) or `SECRET_LEAK` (credentials in URL)
- `3` — `/healthcheck` non-200
- `4` — `/api/status` request failed or returned non-JSON
- `5` — `service.commit` does not match the expected SHA (stale deploy)
- `6` — at least one required dependency is not ready

Run locally for debugging:

```bash
WEBHOOK_API_KEY=$YOUR_KEY \
PRODUCTION_BASE_URL=https://cabros-bot-production.up.railway.app \
PRODUCTION_EXPECTED_COMMIT=$(git rev-parse origin/master) \
ops/production-smoke-probe.sh
```

### Logs

The application logs to stdout:

- `INFO`: Bot initialization, webhook received, alerts sent
- `DEBUG`: Detailed processing steps
- `WARN`: Configuration warnings, retry attempts
- `ERROR`: Delivery failures, API errors

## Performance & Load Testing (opt-in)

The performance harness boots a local API-only server, exercises 10/50/200 RPS
profiles, and checks the p95 ceilings in `tests/performance/budgets.json`.

```bash
# Load profiles plus the dependency-outage drill (requires k6)
pnpm test:perf

# Additionally run the 30-minute low-RPS soak and collect /diag samples
pnpm test:perf -- --soak
```

Install k6 from the official distribution before running it locally. The soak
profile is schedule/manual-workflow tooling only; it is not part of the default
Jest suite. `/diag` is available only while the harness runs the app with
`NODE_ENV=test` and requires `x-api-key`.
