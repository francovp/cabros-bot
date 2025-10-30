## Quick orientation for AI coding agents

This project is a small Express + Telegraf (Telegram) bot service that exposes an HTTP webhook and a Telegram command interface.

Key files / entry points
- `index.js` — app entry. Starts Express server and conditionally launches the Telegraf bot. Important logic for enabling the bot lives here.
- `app.js` — Express app configuration (body parsing, CORS, helmet, healthcheck route).
- `src/routes/index.js` — registers routes (mounted under `/api` when the bot is enabled).
- `src/controllers/commands.js` — Telegram command handlers wired in `index.js` (`/precio`, `/cryptobot`).
- `src/controllers/commands/handlers/core/fetchPriceCryptoSymbol.js` — calls Binance `MainClient.getAvgPrice` to fetch prices.
- `src/controllers/webhooks/handlers/alert/alert.js` — webhook handler that forwards alert text to a Telegram chat.
- `src/controllers/helpers.js` — small numeric helper (`round10`) used by price formatting.

Environment and runtime behavior (discoverable)
- NODE version: `20.x` (see `package.json` engines).
- Required env vars: `BOT_TOKEN` (throws if missing). Optional but relevant: `ENABLE_TELEGRAM_BOT`, `PORT`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`, `RENDER`, `IS_PULL_REQUEST`, `RENDER_GIT_COMMIT`, `RENDER_GIT_REPO_SLUG`.
- Bot startup is gated: bot is launched only when `ENABLE_TELEGRAM_BOT === 'true'` and not a preview environment (`RENDER==='true' && IS_PULL_REQUEST==='true'` disables it).
- Routes under `/api` (e.g. `/api/webhook/alert`) are only mounted after the bot is launched.

Dev / run commands
- `npm install` — install deps.
- `npm start` — run production entry (`node index.js`).
- `npm run start-dev` — runs `nodemon index.js` for development.
- Healthcheck endpoint: `GET /healthcheck` (provided by `app.js`).

Patterns and conventions to follow
- Telegram command handlers receive `context` (Telegraf). Commands parse the full text with `context.message.text.split(' ')` and expect parameters at index 1. Example: `/precio BTCUSDT` where symbol = `messageSplited[1]`.
- When interacting with external APIs, handlers return Promises (resolve on success, reject on error). `fetchSymbolPrice` is async and returns `{ price, symbol }` when successful.
- Webhook `/api/webhook/alert` accepts either plain text (text/plain body) or JSON body with a `text` property. The handler sends messages with `parse_mode: 'MarkdownV2'` to `process.env.TELEGRAM_CHAT_ID`.
- Simple, explicit logging is used (`console.log`, `console.debug`, `console.error`) rather than a structured logger.

External integrations
- Binance: uses `binance` package `MainClient` and `getAvgPrice({ symbol })` (see `fetchPriceCryptoSymbol.js`). Responses are configured with `beautifyResponses: true`.
- Telegram: `telegraf` package; commands wired in `index.js` and direct `bot.telegram.sendMessage` used for alerts and admin notifications.

Common failure modes to check (based on code)
- Missing `BOT_TOKEN` throws on startup (explicit check in `index.js`).
- If `ENABLE_TELEGRAM_BOT` is not `'true'`, the bot and `/api` routes will not be available.
- Webhook failures will attempt to read `error.response` when building error responses; some external errors may not match that shape.

Small, concrete examples
- Get price via Telegram: send message `/precio BTCUSDT` -> handler calls `client.getAvgPrice({ symbol: 'BTCUSDT' })` and replies with `Precio de BTCUSDT es <price>`.
- Send a webhook alert (when bot enabled): POST to `/api/webhook/alert` with body `{ "text": "Alert body" }` or `text/plain` body `Alert body`.

What an AI code change should preserve
- Do not change how env gating works in `index.js` without adjusting tests/deploys — deployments rely on `RENDER` and `IS_PULL_REQUEST` checks.
- Keep the `parse_mode: 'MarkdownV2'` when composing Telegram messages unless escaping/formatting is implemented project-wide.

## Multi-Channel Notification Architecture (002-whatsapp-alerts)

The alert delivery system now supports parallel delivery to multiple channels (Telegram, WhatsApp) without blocking. Key patterns:

**Service Layer** (`src/services/notification/`):
- `NotificationChannel.js` — Abstract base class defining send(alert), validate(), isEnabled() contract
- `TelegramService.js` — Wraps Telegraf bot.telegram.sendMessage() with MarkdownV2 parsing
- `WhatsAppService.js` — GreenAPI integration with message truncation (20K chars), 10s timeout, retry logic
- `NotificationManager.js` — Orchestrates: validateAll() at startup, sendToAll() in parallel via Promise.allSettled()

**Formatting** (`src/services/notification/formatters/`):
- `MarkdownV2Formatter.js` — Escapes special chars (_ * [ ] ( ) ~ ` > # + - = | { } . !) for Telegram; preserves link URLs
- `WhatsAppMarkdownFormatter.js` — Strips unsupported syntax (links → plain text, underline removed); logs conversions

**Retry Logic** (`src/lib/retryHelper.js`):
- sendWithRetry(sendFn, maxRetries=3, logger) with exponential backoff (1s, 2s, 4s) + ±10% jitter
- Per-channel retry (one channel failure doesn't block others)
- Returns SendResult { success, channel, messageId?, error?, attemptCount, durationMs }

**Alert Flow**:
1. Webhook receives text (plain or JSON)
2. Optional Gemini enrichment (stored in alert.enriched) — single call, reused across channels
3. notificationManager.sendToAll(alert) fires in parallel
4. Returns 200 OK with per-channel results (fail-open pattern)

**Configuration**:
- WhatsApp disabled by default (ENABLE_WHATSAPP_ALERTS=false for backward compat)
- Requires: WHATSAPP_API_URL, WHATSAPP_API_KEY, WHATSAPP_CHAT_ID (format: 120363xxxxx@g.us)
- Telegram requires existing: BOT_TOKEN, TELEGRAM_CHAT_ID

**Extending**:
- Add new channel: Create class extending NotificationChannel, implement send(), validate(), isEnabled()
- Register in NotificationManager constructor
- Create tests in tests/unit/ and tests/integration/

Where to look first when extending or debugging
- `index.js` for lifecycle and bot wiring (calls initializeNotificationServices after bot.launch)
- `src/controllers/webhooks/handlers/alert/alert.js` for webhook flow and notificationManager.sendToAll()
- `src/services/notification/NotificationManager.js` for parallel send orchestration
- `src/services/notification/WhatsAppService.js` for retry logic, GreenAPI integration, truncation
- `src/lib/retryHelper.js` for exponential backoff timing
- Tests in `tests/integration/` for multi-channel scenarios (dual-channel, config validation, graceful degradation)

If anything in this file is unclear or you want more examples (tests, extra command patterns, or a CI/dev workflow), tell me which area to expand and I'll iterate.

## Active Technologies
- Node.js 20.x (from package.json engines) + Express 4.17+, telegraf 4.3+; NO new HTTP client (use native fetch)
- GreenAPI for WhatsApp (REST API integration via native fetch with AbortController timeout)
- Google Gemini for optional alert enrichment (existing integration in grounding service)
- N/A for storage (stateless webhook handler; uses env vars for config)

## Recent Changes
- 002-whatsapp-alerts: Added multi-channel notification system with TelegramService, WhatsAppService, NotificationManager; exponential backoff retry logic; MarkdownV2 and WhatsApp markdown formatters; comprehensive integration tests for parallel delivery, config validation, graceful degradation
