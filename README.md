# Cabros Bot

[![Node.js CI](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml/badge.svg)](https://github.com/francovp/cabros-bot/actions/workflows/node.js.yml)
[![Coverage](https://img.shields.io/badge/coverage-100%25-brightgreen.svg)](https://github.com/francovp/cabros-bot)
[![License: ISC](https://img.shields.io/badge/License-ISC-blue.svg)](https://opensource.org/licenses/ISC)
[![Node Version](https://img.shields.io/badge/node-%3E%3D24.18.0%20%3C25-brightgreen.svg)](https://nodejs.org/)

A high-performance crypto, equity, and market intelligence bot service built with Node.js and Express. It connects incoming TradingView alerts and scheduled event monitors with Gemini Grounding, TradingView MCP analysis, and Binance Spot execution, dispatching formatted alerts concurrently across Telegram, WhatsApp, and Discord.

---

## Core Capabilities

- **Multi-Channel Alert Dispatch**: Broadcast alerts concurrently across Telegram, WhatsApp (GreenAPI), and Discord Webhooks with channel-specific Markdown escaping, URL shortening, independent retries, and dead-letter queue redrive.
- **TradingView MCP Integration**: Connects to the remote TradingView MCP Streamable HTTP service to fetch multi-timeframe oscillators, moving averages, pivot points, and technical summaries (`coin_analysis`).
- **AI Grounding & Prompt Management**: Enriches raw signals with Google Gemini Grounding (sentiment, key insights, technical levels, news sources) backed by Langfuse prompt management and token cost budgets.
- **News Monitoring & Event Detection**: Scans crypto and equity symbols on a schedule, scores news confidence, applies persistent deduplication, and falls back to Binance/Twelve Data real-time prices.
- **Binance Spot Trading**: Validates, tests, and places spot orders with strict exchange filters, balance verification, and idempotent client order tracking.
- **Signal Outcomes & Excursion Tracking**: Persists trading signals to Firestore, automatically tracking multi-window price excursion metrics (1h, 4h, 1D, 1W), MFE/MAE, win rates, and calibration.
- **Asynchronous Jobs & Background Workers**: Offloads heavy multi-symbol analyses and market scanner sweeps to Redis/BullMQ background workers with live status polling.
- **Operator Console & Admin API**: Web-based operator UI (served via Firebase Hosting) and REST API secured with Firebase Admin ID tokens and API keys.

---

## Documentation Index

Comprehensive guides and technical documentation are maintained inside the [`docs/`](docs/) directory:

| Guide | Description |
| :--- | :--- |
| **[Environment Configuration](docs/environment-configuration.md)** | Complete dictionary of required and optional environment variables, Remote Config parity, and recipe configurations. |
| **[API Reference](docs/api-reference.md)** | Core system endpoints (`/healthcheck`, `/ready`, `/api/status`, `/api/public/status`), browser admin auth, and Firebase Hosting. |
| **[Webhook Alerts API](docs/webhooks.md)** | TradingView webhook endpoints (`/api/webhook/alert`, `/expanded-analysis-alert`, `/volume-confirmation`, `/symbol-analysis`, `/market-scanner-alert`). |
| **[Asynchronous Jobs API](docs/jobs.md)** | Background TradingView analysis jobs (`/api/jobs/tradingview-analysis`, retry, status polling, BullMQ worker). |
| **[Stored Alerts API](docs/alerts.md)** | Stored alert query, cursor pagination, JSON/CSV export, analytics summary, user feedback, and safe replay mechanics. |
| **[Signal Outcomes Tracking](docs/signal-outcomes.md)** | Signal outcome lifecycle (CB-199), evaluation windows (1h, 4h, 1D, 1W), MFE/MAE excursions, and calibration API. |
| **[TradingView MCP Integration](docs/tradingview-mcp.md)** | Streamable HTTP endpoint setup, symbol resolution, timeframe mapping, and multi-timeframe technical confluence. |
| **[AI Grounding & Prompts](docs/ai-grounding.md)** | Gemini Grounding (001), enrichment flow, token spend tracking, and Langfuse prompt management. |
| **[Multi-Channel Alerts](docs/notifications.md)** | Multi-channel delivery rules (Telegram, WhatsApp, Discord), MarkdownV2 escaping, URL shortening, and dead-letter redrive. |
| **[Telegram Commands](docs/commands.md)** | Interactive bot commands (`/help`, `/precio`, `/cryptobot`, `/analisis`, `/scanner`, `/jobs`, `/noticias`), throttling, and forum topic routing. |
| **[News Monitoring](docs/news-monitor.md)** | Event detection engine, confidence scoring, persistent deduplication, secondary LLM refinement, and volume throttling. |
| **[Observability & Monitoring](docs/monitoring.md)** | Sentry runtime error monitoring (005), health probes, production smoke probes, structured JSON logging, and Firestore write metrics. |
| **[Deployment & Operations](docs/deployment.md)** | Render.com web services and BullMQ workers, preview PR environments, ngrok local tunneling, and Docker/Devcontainer. |
| **[Troubleshooting Guide](docs/troubleshooting.md)** | Diagnostic checklists and recovery runbooks for news monitoring, messaging channels, URL shortening, and retries. |
| **[Firestore Backup & Restore](docs/firestore-backup-and-restore.md)** | Procedures and scripts for backing up and restoring Firestore operational collections. |
| **[SDK Major Drift Audit](docs/runtime-sdk-major-drift-audit.md)** | Dependency audit and version compatibility policy across Node.js runtime and SDKs. |

---
## Quick Start

### 1. Prerequisites

- **Node.js**: `>=24.18.0 <25` (enforced via `.node-version` and `package.json` engines)
- **Package Manager**: `pnpm` (`pnpm@10.34.1` recommended)
- **Telegram Bot Token**: Created via [@BotFather](https://t.me/botfather)

### 2. Installation

```bash
# Clone the repository
git clone https://github.com/francovp/cabros-bot.git
cd cabros-bot

# Install dependencies using frozen lockfile
pnpm install --frozen-lockfile
```

### 3. Environment Configuration

Create a local `.env` file based on `.env.example`:

```bash
cp .env.example .env
```

Minimal `.env` setup:

```ini
# Required core credentials
BOT_TOKEN=123456789:ABCdefGHIjklMNOpqrsTUVwxyz
TELEGRAM_CHAT_ID=-1001234567890
WEBHOOK_API_KEY=your_secret_api_key

# Web server port
PORT=3000
```

Validate your configuration with the built-in diagnostic doctor:

```bash
pnpm run doctor
```

See the [Environment Configuration Guide](docs/environment-configuration.md) for full variable reference and recipe configurations.

### 4. Running the Application

```bash
# Start development server with auto-reload (nodemon)
pnpm run start-dev

# Start production server
pnpm start

# Start standalone BullMQ analysis worker (optional Render background worker)
pnpm run start-worker

# Start standalone signal outcome evaluation worker (optional Render background worker)
pnpm run start:signal-outcome-worker
```

Verify service readiness:

```bash
curl http://localhost:3000/healthcheck
curl http://localhost:3000/ready
```

---

## API Endpoints Summary

All webhook and mutation endpoints require the `x-api-key` header (configured via `WEBHOOK_API_KEY`). Browser admin endpoints support Firebase ID tokens (`Authorization: Bearer <token>`).

| Method | Path | Description | Documentation |
| :--- | :--- | :--- | :--- |
| `GET` | `/healthcheck` | Fast process liveness probe | [API Reference](docs/api-reference.md#get-healthcheck) |
| `GET` | `/ready` | Deep dependency readiness probe (Redis, Firestore, MCP) | [API Reference](docs/api-reference.md#get-ready) |
| `GET` | `/api/status` | Comprehensive system capabilities & dependency matrix | [API Reference](docs/api-reference.md#get-apistatus) |
| `GET` | `/api/public/status` | Safe public subset of capabilities & channel statuses | [API Reference](docs/api-reference.md#get-apipublicstatus) |
| `POST` | `/api/webhook/alert` | Ingest and dispatch alert to configured channels | [Webhook Alerts](docs/webhooks.md#post-apiwebhookalert) |
| `POST` | `/api/webhook/expanded-analysis-alert` | TradingView MCP technical analysis report | [Webhook Alerts](docs/webhooks.md#post-apiwebhookexpanded-analysis-alert) |
| `POST` | `/api/webhook/volume-confirmation` | TradingView volume and momentum confirmation | [Webhook Alerts](docs/webhooks.md#post-apiwebhookvolume-confirmation) |
| `POST` | `/api/webhook/symbol-analysis` | Immediate multi-timeframe symbol analysis | [Webhook Alerts](docs/webhooks.md#post-apiwebhooksymbol-analysis) |
| `POST` | `/api/webhook/market-scanner-alert` | Multi-asset market scanner report (gainers/losers) | [Webhook Alerts](docs/webhooks.md#post-apiwebhookmarket-scanner-alert) |
| `POST` | `/api/jobs/tradingview-analysis` | Queue long-running analysis or scanner job | [Jobs API](docs/jobs.md#post-apijobstradingview-analysis) |
| `GET` | `/api/jobs` | List recent background jobs with status & progress | [Jobs API](docs/jobs.md#get-apijobs) |
| `GET` | `/api/jobs/:jobId` | Poll background job progress and retrieve result | [Jobs API](docs/jobs.md#get-apijobsjobid) |
| `POST` | `/api/news-monitor` | Trigger symbol news scanning & event detection | [News Monitoring](docs/news-monitor.md) |
| `POST` | `/api/trading/binance/orders/preview` | Pre-trade Binance Spot cost & slippage preview | [API Reference](docs/api-reference.md#post-apitradingbinanceorderspreview) |
| `GET` | `/api/alerts` | Query stored alerts with pagination & filtering | [Stored Alerts](docs/alerts.md#get-apialerts) |
| `GET` | `/api/alerts/summary` | Analytics & delivery success rate metrics | [Stored Alerts](docs/alerts.md#get-apialertssummary) |
| `POST` | `/api/alerts/:alertId/replay` | Dry-run or live replay of stored alert | [Stored Alerts](docs/alerts.md#post-apialertsalertidreplay) |
| `GET` | `/api/outcomes` | Query signal outcomes with multi-window returns | [Signal Outcomes](docs/signal-outcomes.md#get-apioutcomes) |
| `GET` | `/api/outcomes/summary` | Expectancy, win rate, and performance summary | [Signal Outcomes](docs/signal-outcomes.md#get-apioutcomessummary) |

Interactive Swagger documentation is available at `/docs`, and OpenAPI 3.1 schema is published at `/openapi.json`.

---

## Telegram Commands Summary

When the Telegram bot is enabled (`ENABLE_TELEGRAM_BOT=true`), the bot provides interactive commands:

| Command | Arguments | Description |
| :--- | :--- | :--- |
| `/help`, `/start` | None | Displays command list and argument help. |
| `/precio` | `<symbol>` | Real-time crypto (Binance) or equity (Twelve Data) price quote. |
| `/cryptobot` | `id` | Displays the current Telegram chat ID. |
| `/analisis` | `<symbols>` | Runs quick TradingView technical analysis for specified symbols. |
| `/scanner` | `[options]` | Executes market scanner sweep across preconfigured assets. |
| `/jobs` | `[jobId]` | Inspects status or lists active background analysis jobs. |
| `/noticias` | `[options]` | Trigger news monitoring analysis for specified crypto/equity tickers. |

See the [Telegram Commands Reference](docs/commands.md) for aliases, throttling rules, and examples.

---

## Key Runtime Notes

### Multi-Channel Notification Dispatch
Notifications are dispatched concurrently across enabled channels. For Discord, transient rate limits and server errors are retried according to `DISCORD_MAX_RETRIES` and bounded by `DISCORD_MAX_TOTAL_RETRY_WAIT_MS`. Long messages exceeding platform limits are automatically split into sequential chunks with preserved markdown formatting. See [Multi-Channel Alerts Guide](docs/notifications.md).

### AI Provider Routing & Grounding
When configuring AI providers, `MODEL_PROVIDER=cloudflare` selects Cloudflare runtime routing, whereas `ENABLE_CLOUDFLARE_AIG` only exposes Cloudflare readiness in status/capabilities. Gemini Grounding provides web search citations and confidence scores for market alerts. See [AI Grounding & Prompts](docs/ai-grounding.md).

### News Monitoring Volume Throttling
The news monitor endpoint reports volume throttling status in its response payload:
```json
{
  "analyzed": 5,
  "alertsSent": 2,
  "throttled": 0,
  "errors": 0
}
```
- `throttled` - The number of symbols skipped during the execution sweep because the rate limit window was reached. See [News Monitoring Guide](docs/news-monitor.md).

---

## Running Tests

The test suite includes comprehensive unit tests, integration tests, contract audits, and an optional Firestore emulator suite.

```bash
# Run full unit and integration test suite
pnpm test

# Run tests in watch mode
pnpm run test:watch

# Generate code coverage report
pnpm run test:coverage

# Run focused test file
pnpm test -- tests/unit/alert-handler.test.js

# Run opt-in Firestore emulator integration suite (requires local Firebase emulator)
pnpm run test:firebase

# Run linter
pnpm run lint
```

---

## Architecture Overview

```
                      ┌──────────────────────┐
                      │   TradingView Webhook│
                      │  / External Trigger  │
                      └──────────┬───────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    Cabros Bot Service   │
                    │  (Express + Middlewares)│
                    └──────┬───────────┬──────┘
                           │           │
           ┌───────────────┘           └───────────────┐
           ▼                                           ▼
┌─────────────────────┐                     ┌─────────────────────┐
│TradingView MCP / AI │                     │ Firestore & BullMQ  │
│Grounding Enrichment │                     │Persistence & Jobs   │
└──────────┬──────────┘                     └──────────┬──────────┘
           │                                           │
           └───────────────────┬───────────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │Notification Dispatch│
                    └────┬──────┬──────┬──┘
                         │      │      │
            ┌────────────┘      │      └────────────┐
            ▼                   ▼                   ▼
     ┌──────────────┐    ┌──────────────┐    ┌──────────────┐
     │ Telegram Bot │    │WhatsApp Green│    │Discord Webhk │
     │ (MarkdownV2) │    │  (Shortened) │    │   (Chunks)   │
     └──────────────┘    └──────────────┘    └──────────────┘
```

See [Architecture Guide](docs/deployment.md) and [Notifications Guide](docs/notifications.md) for in-depth pipeline specifications.

---

## License

This project is licensed under the ISC License.
