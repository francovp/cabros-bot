# Cabros Bot — Product Overview

Cabros Bot is a small but opinionated alert-delivery service for active traders. It receives trading signals from external platforms (TradingView, custom webhooks, news feeds), enriches them with optional AI context (Gemini grounding, TradingView MCP technical analysis), and forwards them as formatted alerts to Telegram and WhatsApp groups. The same service stores every alert for later auditing, evaluates which signals actually made money, and exposes an admin console for operators. It runs on Render or Railway (or any Node 24 host) and stays small: one Express process plus optional Firestore, Redis, and a remote TradingView MCP endpoint.

If you are evaluating the project, reading the README first is fine — but the README is an operator reference. This document is the **narrative**: what the bot is for, what it does today, and what you should do in your first 24 hours.

---

## Product Statement

A signal-only bot is loud but useless. Cabros Bot delivers only the signals that an operator has graded as worth a trader's attention, formats them consistently across Telegram and WhatsApp, and records what happened next so the operator can iterate on the **quality** of the alerting pipeline rather than its throughput. It treats every external dependency as optional and fails open — Telegram being down never blocks alert persistence, and Firestore being unavailable never blocks Telegram delivery.

---

## Capability Inventory (by user outcome)

Each capability lists: one-line description, primary endpoint or command, status, and the GitHub issue(s) that introduced or block it.

### Receive an alert when something happens

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| TradingView webhook → multi-channel alert | `POST /api/webhook/alert` | live | — |
| Generic forward message webhook | `POST /api/webhook/message` | live | #854 |
| On-demand technical analysis report | `POST /api/webhook/expanded-analysis-alert` | live | — |
| On-demand single-symbol analysis | `POST /api/webhook/symbol-analysis` | live | #852 |
| TradingView volume confirmation | `POST /api/webhook/volume-confirmation` | live | #841 |
| Periodic market scanner summary | `POST /api/webhook/market-scanner-alert` | live | — |
| News-monitor sweep (cron) | `POST /api/news-monitor` | opt-in | — |

### Make alerts more useful before delivery

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Gemini grounding + sources | `ENABLE_GEMINI_GROUNDING=true` | opt-in | — |
| Brave Search fallback | `FORCE_BRAVE_SEARCH=true` | opt-in | — |
| TradingView MCP confluence | `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true` | opt-in | — |
| Multi-timeframe alignment | `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true` | opt-in | — |
| Langfuse-managed prompts | `ENABLE_LANGFUSE_PROMPTS=true` | opt-in | — |
| Per-channel routing override | `channels`, `telegramChatId`, `whatsappChatId`, `telegramThreadId` | live | — |
| Same-signal repeat suppression | `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION=true` | opt-in | — |
| Header metadata footer | `ENABLE_MESSAGE_FOOTER_METADATA=true` | opt-in | — |

### Track whether alerts made money

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Signal outcome evaluation (+1h / +4h / +1D / +1W) | shadow sweep | live | — |
| Stored alert audit trail | `GET /api/alerts`, `GET /api/alerts/:id` | live | — |
| Aggregate metrics + risk coverage | `GET /api/alerts/summary` | live | — |
| Alert JSONL/CSV export | `GET /api/alerts/export` | live | — |
| Outcome query + summary | `GET /api/outcomes`, `GET /api/outcomes/summary` | live | — |
| Replay an alert to current channels | `POST /api/alerts/:id/replay` | live | #840 |
| Twelve Data equity outcomes | `ENABLE_EQUITY_MARKET_DATA=true` | opt-in | — |

### Operate the service

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Web admin console | `/admin` | live | #842, #843 |
| Authenticated status snapshot | `GET /api/status` / `/api/capabilities` | live | — |
| Public OpenAPI contract | `GET /openapi.json`, `GET /docs` | live | — |
| Idempotency on webhook ingest | `idempotency-key` header | live | — |
| Webhook ingest rate-limit bucket | internal | live | — |
| Process-lifecycle health | `GET /healthcheck` | live | — |
| Structured logging with secret redaction | `LOG_LEVEL=info` | live | — |
| Sentry runtime monitoring | `ENABLE_SENTRY=true` | opt-in | — |

### Operate from Telegram

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Price lookup | `/precio <SYMBOL>` | live | — |
| Expanded analysis job | `/analisis <SYM>` | live | — |
| Market scanner job | `/scanner` | live | — |
| News-monitor on-demand | `/noticias` | live | — |
| List recent jobs | `/jobs`, `/trabajos` | live | — |
| Signal outcomes | `/outcomes`, `/rendimiento` | live | — |
| Help / start | `/help`, `/start` | live | — |
| Command allow-list gate | `TELEGRAM_COMMAND_ALLOWED_CHAT_IDS` | opt-in | #808 |

### Execute orders (operator-only)

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Place / list / cancel Binance Spot order | `POST/GET/DELETE /api/trading/binance/orders` | opt-in | — |
| Testnet / demo / live selection | `BINANCE_TRADING_ENV` | opt-in | — |
| Notional cap | `BINANCE_TRADING_MAX_NOTIONAL` | opt-in | — |

### Run background work

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Async TradingView job | `POST /api/jobs/tradingview-analysis` | live | — |
| Async market scanner job | `POST /api/jobs/tradingview-analysis` (marketScanner) | live | — |
| Async job polling | `GET /api/jobs`, `GET /api/jobs/:id` | live | — |
| Job cancel / retry / retry-failed | `POST /api/jobs/:id/cancel|retry|retry-failed` | live | — |
| BullMQ + Redis queue | `JOB_EXECUTION_MODE=render-worker` | opt-in | — |
| Firestore poller (Redis-free Railway) | `JOB_EXECUTION_MODE=firestore-poller` | opt-in | #710 |
| Webhook callback on terminal events | `callbackUrl`, `callbackSecret`, `callbackEvents` | opt-in | — |

### Persist durable state

| Capability | Surface | Status | Tracked in |
|---|---|---|---|
| Alert storage in Firestore | `ENABLE_FIRESTORE_ALERT_STORAGE=true` | opt-in | — |
| Idempotency reservations | `ENABLE_FIRESTORE_IDEMPOTENCY=true` | opt-in | — |
| Async job storage | `ENABLE_FIRESTORE_JOB_STORAGE=true` | opt-in | — |
| Scanner preset storage | `ENABLE_FIRESTORE_SCANNER_PRESETS=true` | opt-in | — |
| News-monitor dedup | `ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP=true` | opt-in | — |
| Native TTL retention | `ALERT_STORAGE_RETENTION_DAYS` | opt-in | — |
| Remote Config runtime tuning | `ENABLE_FIREBASE_REMOTE_CONFIG=true` | opt-in | — |

---

## First-24-Hours Operator Journey

1. **Clone and install** — `git clone https://github.com/francovp/cabros-bot && cd cabros-bot && pnpm install --frozen-lockfile`.
2. **Configure the minimum** — copy `.env.example` to `.env` and set `BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ENABLE_TELEGRAM_BOT=true`, and a `WEBHOOK_API_KEY` (any random ≥32 chars).
4. **Run doctor** — `pnpm run doctor` validates env, credentials, and outbound reachability without starting the service.
5. **Start dev mode** — `pnpm run start-dev` (nodemon) or `pnpm start` (production). Confirm `GET /healthcheck` returns `200`.
6. **Send a test alert** — `curl -X POST http://localhost:3000/api/webhook/alert -H "x-api-key: $WEBHOOK_API_KEY" -H "Content-Type: application/json" -d '{"text":"hello from cabros"}'` and check Telegram for the message.
7. **Open the admin console** — visit `http://localhost:3000/admin`, paste the API key, and confirm the Operational overview renders.
8. **Turn on durable persistence** (optional) — provision Firebase, set `FIREBASE_SERVICE_ACCOUNT_JSON` and `ENABLE_FIRESTORE_ALERT_STORAGE=true`, restart, and confirm `/api/alerts/summary` returns rows.
9. **Wire a TradingView alert** — point a TradingView alert at `POST /api/webhook/alert` with `x-api-key: $WEBHOOK_API_KEY` and the JSON body `{"text":"<message>"}`.
10. **Evaluate a signal** — wait one cycle (default 5 minutes) and confirm `/api/alerts/summary` shows evaluated windows. Iterate on prompt + symbol list, not on the alert pipeline.
11. **Promote to staging** — deploy to a preview environment, verify `/healthcheck` and `/openapi.json`, and re-run the test alert against the preview URL.
12. **Promote to production** — once preview is healthy, deploy the same commit to the production service and verify `/api/status` reports `ready: true` for every dependency you enabled.

---

## Status Legend

- **live** — production-tested; default behavior unless a flag is set; safe to rely on.
- **opt-in** — flag-gated; ready, but you must turn it on; safe defaults when off.
- **experimental** — works but rough; expect API drift and rough edges.
- **planned** — tracked in issues only; not yet shipped.

---

## Roadmap Signals (active work)

The top issues / PRs the maintainer is actively driving — start here if you want to know what is landing next.

- **#854** Validate notification channels before spending Gemini / MCP enrichment budget — partial fix in flight.
- **#841** Mount idempotency on TradingView single-symbol + volume-confirmation webhooks — sender replays fix.
- **#840** Optional re-enrichment with fresh TradingView MCP on alert replay — improves audit replay accuracy.
- **#833** Volatility-adjusted position sizing hints in ranked market-scanner output — improves trader actionability.
- **#831** TradingView MCP multi-timeframe confluence in webhook alert enrichment — already partial behind `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME`.
- **#827** Bounded admin-paging deduplication so a Telegram/MCP outage stops flooding the admin chat — operational hardening.
- **#825** Restore Sentry production transaction traces after 2026-08-10 — observability fix.
- **#710** Enable durable TradingView job worker in Railway production — `JOB_EXECUTION_MODE=firestore-poller` rollout.
- **#760** Remediate 77 production dependency advisories (1 critical protobufjs ACE) and gate `pnpm audit` in CI — security hardening.
- **#692** Rate-limiter uses IP-only tracking — proxy + API-key bucket keys (PR #997 in review) — production correctness.

---

## Pointers

- Operator reference (every env var, every endpoint): [`README.md`](../README.md)
- Agent / contributor guidance: [`AGENTS.md`](../AGENTS.md)
- Public OpenAPI contract: `GET /openapi.json` (or `/docs` for Swagger UI)
- Live status: `GET /api/status` (authenticated) — gives feature flags, delivery channels, and dependency readiness
- Issues backlog: [github.com/francovp/cabros-bot/issues](https://github.com/francovp/cabros-bot/issues)