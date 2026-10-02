# Deployment & Operations Guide

[← Back to README](../README.md)

## Setup

### Supported Runtime

The repository pins Node.js `24.18.0` in `.node-version` and bounds `package.json` to `>=24.18.0 <25`. GitHub Actions reads the same file, and Render native services consume the root `.node-version` file. Use that file with your local Node.js version manager.

### 1. Install Dependencies

```bash
pnpm install --frozen-lockfile
```

### 2. Create `.env` File

Copy the `.env.example` file (which serves as the canonical operator template) to `.env` and fill in your configuration values:

```bash
cp .env.example .env
```

Then edit `.env` with your specific values. See `.env.example` for complete documentation of all available environment variables organized by category:

- **Required**: Core bot token and chat IDs
- **Optional: Security**: API Key configuration to secure webhook endpoints
- **Optional: WhatsApp**: GreenAPI integration for multi-channel alerts
- **Optional: AI Grounding**: Gemini API for alert enrichment
- **Optional: Prompt Management**: Langfuse-backed runtime prompts with local fallbacks
- **Optional: TradingView MCP**: Real-time technical enrichment for webhook signals
- **Optional: Admin Notifications**: Separate chat for deployment alerts
- **Optional: Server Configuration**: Port, Render.com flags
- **Optional: News Monitoring**: Feature flags and thresholds
- **Optional: Binance Integration**: Real-time crypto prices
- **Optional: Secondary LLM**: Azure AI or GitHub Models enrichment

See [Environment Configuration](#environment-configuration) section below for detailed descriptions of each variable.

### 3. Check Configuration

Run the fail-open configuration doctor before deployment. It exits successfully even when it finds warnings and never prints secret values:

```bash
pnpm run doctor
```

### CI secret scanning and credential rotation

The `Secret Scan` workflow runs Gitleaks on every push to `master`, pull request, and manual dispatch. It scans the full Git history and fails when a credential is detected. Keep secrets in the platform's encrypted secret store or local `.env` files that are excluded from git; never add real credentials to source, fixtures, Postman examples, or workflow files.

If a credential may have been committed or exposed:

1. Disable the affected integration first, especially Binance trading.
2. Rotate `WEBHOOK_API_KEY` in the production secret store, then redeploy and verify protected endpoints with the new key.
3. Revoke and replace `BINANCE_API_KEY`/`BINANCE_API_SECRET`; validate on testnet before any approved live enablement.
4. Revoke the exposed Firebase service-account key, create a replacement, update `FIREBASE_SERVICE_ACCOUNT_JSON` in the deployment secret store, and verify Firestore/Remote Config access.
5. Review the scan result and confirm no credential remains in git history; treat the old credential as compromised even if the file was deleted.

### 4. Run Development Server

```bash
pnpm start-dev
```

### 5. Run Production Server

```bash
pnpm start
```


---

## Deployment

### Render.com

The application includes support for Render.com and Vercel deployments:

- Respects Render and Vercel deployment environment variables
- Skips bot launch in preview environments (`IS_PULL_REQUEST=true` or `VERCEL_ENV=preview`)
- Sends deployment notification to admin chat on startup
- `render.yaml` defines an opt-in paid `starter` Background Worker using `pnpm run start:signal-outcome-worker`. It is configured with `SIGNAL_OUTCOME_WORKER_ROLE=worker` and `ENABLE_SIGNAL_OUTCOME_TRACKING` as a manual value so the paid worker and Firestore credential decision are explicit.
- The worker also declares `ENABLE_SENTRY` and `SENTRY_DSN` as manual values; monitoring remains disabled when either value is absent.
- To cut over production, enable signal tracking on both services, set the web service's `SIGNAL_OUTCOME_WORKER_ROLE=disabled`, and keep the worker role as `worker`. Leave the default web role as `web` when the dedicated worker is not enabled.

### Local Development

```bash
# Start dev server with auto-reload
pnpm start-dev

# Open ngrok tunnel for webhook testing
ngrok http 80

# Use ngrok URL for TradingView webhooks
# https://your-ngrok-domain.ngrok.io/api/webhook/alert
```
