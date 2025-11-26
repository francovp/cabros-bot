# Quickstart: Runtime Error Monitoring with Sentry (@sentry/node)

**Feature**: `005-sentry-runtime-errors` | **Date**: 2025-11-26  
**Objective**: Enable Sentry-based runtime error monitoring without changing public API behavior.

---

## 1. Overview

This feature integrates Sentry (via `@sentry/node`) into the existing Express + Telegraf service so that:

- Unhandled errors in `/api/webhook/alert` and `/api/news-monitor` are captured with context.
- Persistent failures in external providers (Telegram, WhatsApp, Gemini, Azure, Binance, URL shorteners) are reported once retries are exhausted.
- Process-level failures (`uncaughtException`, `unhandledRejection`) are recorded before the process terminates or recovers.

The integration is **opt-in** and controlled entirely via environment variables. When disabled or misconfigured, all monitoring calls degrade to cheap no-ops and HTTP behavior remains unchanged.

---

## 2. Prerequisites

- Node.js **20.x** (same as existing project).
- A Sentry account and project (SaaS or self-host) with a **server-side DSN**.
- Existing configuration from previous features:
  - Telegram bot configured (`BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
  - Optional WhatsApp integration (`ENABLE_WHATSAPP_ALERTS`, `WHATSAPP_*`).
  - Optional news monitor (`ENABLE_NEWS_MONITOR`).

---

## 3. Environment Configuration

Add the following Sentry-related variables to your `.env` or deployment settings.

```bash
# Enable/disable monitoring
ENABLE_SENTRY=true                        # Set to 'true' in environments where you want Sentry events

# Sentry DSN (copied from Sentry project settings)
SENTRY_DSN=https://<publicKey>@sentry.io/<projectId>

# Optional overrides (otherwise derived from existing env vars)
SENTRY_ENVIRONMENT=production             # Optional, overrides derived values
SENTRY_RELEASE=cabros-bot@1.0.0+local     # Optional, overrides derived release

# Existing envs reused for derivation (no change required)
NODE_ENV=production
RENDER=true                               # In Render deployments
IS_PULL_REQUEST=false                     # true in preview/PR deployments
RENDER_GIT_COMMIT=<git-sha>               # Provided by Render
RENDER_GIT_REPO_SLUG=francovp/cabros-bot  # Provided by Render
```

**Environment derivation (default behavior):**

- If `SENTRY_ENVIRONMENT` is set → use it.
- Else if `RENDER==='true' && IS_PULL_REQUEST==='true'` → `environment = 'preview'`.
- Else if `NODE_ENV==='production'` or `RENDER==='true'` → `environment = 'production'`.
- Else → `environment = 'development'`.

**Release derivation (default behavior):**

- If `SENTRY_RELEASE` is set → use it.
- Else if `RENDER_GIT_COMMIT` is set → use a short commit hash.
- Else → leave unset and let Sentry auto-detect when possible.

To disable monitoring in a given environment, either:

- Set `ENABLE_SENTRY=false`, or
- Omit `SENTRY_DSN`.

In both cases the monitoring service will log a single info-level message at startup and then act as a no-op.

---

## 4. Local Development Workflow

### 4.1 Enable Sentry Locally

1. Create or update `.env.local` (or similar) with:

```bash
ENABLE_SENTRY=true
SENTRY_DSN=https://<your-local-dsn>
SENTRY_ENVIRONMENT=development
SENTRY_RELEASE=cabros-bot@dev
```

1. Start the server:

```bash
npm install
npm run start-dev
```

1. Confirm in logs that monitoring initialized successfully (e.g., `Sentry monitoring enabled (environment=development, release=cabros-bot@dev)`).

### 4.2 Trigger a Controlled HTTP Error

Trigger an **internal** server error in `/api/webhook/alert` (not just a validation 4xx), so that the Sentry integration is exercised on a real runtime failure:

1. In a local-only branch, temporarily add a `throw` near the top of the alert handler (for example, in `src/controllers/webhooks/handlers/alert/alert.js`) and restart the server:

   ```js
   // TEMPORARY for local testing only
   throw new Error('Sentry test error');
   ```

2. Call the endpoint:

   ```bash
   curl -X POST http://localhost:3000/api/webhook/alert \
     -H "Content-Type: text/plain" \
     -d 'Test alert: Sentry runtime error verification'
   ```

- Check the HTTP response: it should follow the existing error behavior for unexpected exceptions (typically a 5xx).
- In Sentry, you should see a new event tagged with:
  - `channel = http-alert`
  - `environment = development`
  - `feature = alerts`

> Note: pure validation errors that result in expected 4xx responses (e.g., malformed payloads) are **not** reported to Sentry according to the internal monitoring contract.

### 4.3 Trigger an External Provider Failure

To verify FR-005 (external failures after retries):

1. Set an invalid WhatsApp API key in `.env`:

```bash
ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_KEY=invalid-key
ENABLE_SENTRY=true
SENTRY_DSN=https://<your-local-dsn>
```

1. Restart the server.

2. Send an alert:

```bash
curl -X POST http://localhost:3000/api/webhook/alert \
  -H "Content-Type: text/plain" \
  -d 'Test alert: Sentry external failure verification'
```

1. Expected behavior:

- HTTP response: `200 OK` (fail-open pattern preserved).
- Telegram still sends (if configured); WhatsApp fails after 3 retries.
- Sentry receives an event with:
  - `channel = whatsapp`
  - `type = external_failure`
  - `external.provider = 'whatsapp-greenapi'`
  - `external.attemptCount = 3`

---

## 5. Preview vs Production

A typical deployment strategy:

### Preview (Pull Request) Environments

```bash
ENABLE_SENTRY=true
SENTRY_DSN=https://<shared-project-dsn>
SENTRY_ENVIRONMENT=preview
```

- Preview envs send events to the same Sentry project as production but with `environment=preview`.
- Use Sentry filters to hide preview events when focusing on production.

### Production Environments

```bash
ENABLE_SENTRY=true
SENTRY_DSN=https://<shared-project-dsn>
SENTRY_ENVIRONMENT=production
SENTRY_RELEASE=cabros-bot@1.2.3+<git-sha>
```

- Production envs use `environment=production` and a concrete `release` value derived from CI/CD.
- This enables Sentry features like release health and regression tracking without affecting API behavior.

### Local / Test Environments

```bash
ENABLE_SENTRY=false    # or omit SENTRY_DSN entirely
```

- Tests and local sandboxes run with monitoring disabled by default.
- Integration tests can enable Sentry with a **fake DSN** or SDK stub to assert calls without sending real events.

---

## 6. Verifying Non-Intrusive Behavior

To confirm that Sentry does not change user-visible behavior (User Story 2, FR-003):

1. **Baseline run (Sentry disabled)**
   - Set `ENABLE_SENTRY=false` and restart.
   - Run existing Jest suites (unit + integration):

   ```bash
   npm test
   ```

   - Exercise manual scenarios for `/api/webhook/alert`, `/api/news-monitor`, Telegram, and WhatsApp.

2. **Instrumented run (Sentry enabled)**
   - Set `ENABLE_SENTRY=true` and configure a valid `SENTRY_DSN`.
   - Re-run the same tests and manual flows.

3. **Compare**
   - HTTP status codes and response bodies MUST match between the two runs.
   - Telegram/WhatsApp delivery behavior MUST be identical for the same configuration.
   - The only visible difference should be new events in Sentry.

---

## 7. Troubleshooting

### Sentry Not Receiving Events

- Check that:
  - `ENABLE_SENTRY === 'true'`.
  - `SENTRY_DSN` is set and valid.
  - Outbound network access to Sentry is allowed from the environment.
- Look at logs for a one-time initialization warning (e.g., missing DSN) from `SentryService`.

### Errors in Application Logs Referencing Sentry

- Monitoring must **never** throw unhandled exceptions that break the main flow.
- If logs show repeated Sentry-related errors:
  - Consider disabling monitoring (`ENABLE_SENTRY=false`) while debugging.
  - Verify DSN, environment variables, and that `@sentry/node` is correctly installed.

### Too Many Events / Noise

- Use Sentry sampling or adjust logic in `SentryService` to:
  - Only capture external failures after retries (not every attempt).
  - Skip expected configuration states (e.g., feature flags disabled).
- If needed, adjust `sendAlertContent` policy to reduce payload size or omit full texts.

---

## 8. Where to Look in the Codebase

Once this feature is implemented, the primary touchpoints will be:

- `src/services/monitoring/SentryService.js`  
  Initialization, configuration, and helpers for `captureError()`.

- `index.js`  
  Calls into `SentryService.init()` early in process startup.

- `src/controllers/webhooks/handlers/alert/alert.js`  
  Uses monitoring helpers in error paths for `/api/webhook/alert`.

- `src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`  
  Uses monitoring helpers for unexpected errors in `/api/news-monitor`.

- `src/services/notification/NotificationManager.js` and channel services  
  Attach external failure metadata when retries are exhausted.

Refer to `specs/005-sentry-runtime-errors/data-model.md` and `contracts/api.md` for detailed internal contracts and event shapes.
