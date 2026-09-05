# Cabros Bot

Express + Telegraf-based Telegram bot service with multi-channel alert delivery (Telegram and WhatsApp) and intelligent news monitoring.

## Features

- 📱 **Multi-Channel Alerts**: Send trading alerts to both Telegram and WhatsApp
- 🚀 **Webhook API**: HTTP endpoint for receiving alerts from external services (e.g., TradingView)
- 📰 **News Monitoring**: Analyze financial news and market sentiment for crypto and stock symbols with AI-powered event detection
- 🧠 **AI Enrichment**: Optional enhancement of alerts using Google Gemini API (grounding) and optional secondary LLM (Azure AI)
- 🧩 **Langfuse Prompt Management**: Manage all runtime LLM prompts centrally in Langfuse with local fail-open fallbacks
- 📊 **TradingView MCP Analysis**: Optional webhook enrichment plus expanded technical-analysis reports from TradingView MCP data
- 💎 **Event Detection**: Identify significant trading events (price surges, public figure mentions, regulatory announcements)
- 💰 **Market Context**: Optional Binance integration for real-time crypto prices with Gemini fallback
- 🎯 **Smart Deduplication**: In-memory cache prevents duplicate alerts for the same event category within 6-hour TTL
- ⚡ **Retry Logic**: Automatic retry with exponential backoff for failed deliveries
- 🔄 **Graceful Degradation**: Continue operating if one channel is unavailable
- ⏱️ **Parallel Processing**: Analyze multiple symbols concurrently with intelligent timeout management

## Environment Configuration

### Required Variables

- `BOT_TOKEN` - Telegram bot token (from BotFather). Required only when `ENABLE_TELEGRAM_BOT=true` and the app is expected to launch Telegraf outside PR previews
- `TELEGRAM_CHAT_ID` - Telegram chat ID where alerts are sent
- `ENABLE_TELEGRAM_BOT` - Enable Telegram bot (`true` or `false`)

### Optional Variables

#### Telegram Forum Topic Routing

- `TELEGRAM_TOPIC_ROUTES` - Optional mapping of alert categories/sources to Telegram forum topic `message_thread_id` values. Format: comma-separated pairs `category:threadId` (e.g. `webhook-signal:101,market-scanner:202,news-monitor:303,default:0`) or JSON object string `{"webhook-signal":101,"market-scanner":202}`. Thread ID `0` or `null` routes alerts to the chat's General topic.
- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` - Dedicated Telegram chat ID for admin/error notices (optional, falls back to `TELEGRAM_CHAT_ID`)

#### Security

- `WEBHOOK_API_KEY` - API key used to secure `/api/*` webhook endpoints. Required in production-like environments (`NODE_ENV=production`, Render, Vercel, Railway), where endpoints fail-closed with HTTP 503 if unset. When configured, clients must provide the key via the `x-api-key` header (or the `api-key` query parameter)
- `ENABLE_FIREBASE_ADMIN_AUTH` - Enable opt-in Firebase email/password authentication for the browser admin console (`false` by default)
- `FIREBASE_WEB_API_KEY` - Public Firebase Web API key used by the browser sign-in flow; not a service-account credential
- `FIREBASE_AUTH_DOMAIN` - Public Firebase Auth domain used by the browser sign-in flow
- `FIREBASE_DATABASE_URL` - Public Firebase Realtime Database URL used by the browser configuration
- `FIREBASE_APP_ID` - Public Firebase Web app ID (optional for Auth, recommended)
- `FIREBASE_WEB_CONFIG_JSON` - Optional JSON alternative containing the public Firebase Web config (`apiKey`, `authDomain`, `projectId`, and optional `appId`)

To report a vulnerability, see [`SECURITY.md`](./SECURITY.md) — the project documents a private disclosure channel, scope, and safe-harbor guidance. Do not file security issues as public GitHub issues.

#### WhatsApp Alerts & Commands (GreenAPI)

- `ENABLE_WHATSAPP_ALERTS` - Enable WhatsApp alerts (`true` or `false`, default: `false`)
- `WHATSAPP_API_URL` - GreenAPI endpoint URL (e.g., `https://7107.api.green-api.com/waInstance7107356806/`)
- `WHATSAPP_API_KEY` - GreenAPI API key for authentication
- `WHATSAPP_CHAT_ID` - Destination WhatsApp chat/group ID (format: `120363xxxxx@g.us`)
- `ENABLE_WHATSAPP_COMMANDS` - Enable WhatsApp inbound commands poller (`!precio`, `!help`) (`true` or `false`, default: `false`)
- `WHATSAPP_COMMAND_CHAT_IDS` - Comma-separated list of WhatsApp chat/group IDs permitted to run commands (e.g., `120363025492938@g.us`)
- `WHATSAPP_COMMAND_POLL_INTERVAL_MS` - Inbound command polling interval in milliseconds (default: `3000`)

#### Discord Alerts (Webhook)

- `ENABLE_DISCORD_ALERTS` - Enable Discord alerts (`true` or `false`, default: `false`)
- `DISCORD_WEBHOOK_URL` - Discord webhook URL (e.g., `https://discord.com/api/webhooks/<id>/<token>`)
- `DISCORD_MAX_RETRIES` - Additional Discord attempts after the first request (default: `2`)
- `DISCORD_FALLBACK_RETRY_DELAY_MS` - Fallback delay for Discord 429 retries (default: `500` ms)
- `DISCORD_MAX_RETRY_DELAY_MS` - Maximum individual Discord retry delay (default: `5000` ms)
- `DISCORD_MAX_TOTAL_RETRY_WAIT_MS` - Maximum cumulative Discord retry wait (default: `10000` ms)

#### Notification Dead-Letter & Redrive

- `ENABLE_NOTIFICATION_REDRIVE` - Enable dead-letter recording and background redrive for failed channel deliveries (`true` or `false`, default: `false`)
- `NOTIFICATION_REDRIVE_WORKER_ROLE` - Scheduler execution role (`web`, `worker`, or `disabled`, default: `web`)
- `NOTIFICATION_REDRIVE_INTERVAL_MS` - Background sweep interval in milliseconds (default: `60000`, Remote Config supported)
- `NOTIFICATION_REDRIVE_BATCH_LIMIT` - Maximum candidate records per sweep (default: `50`, Remote Config supported)
- `NOTIFICATION_REDRIVE_MAX_ATTEMPTS` - Maximum attempts before terminal exhaustion (default: `5`, Remote Config supported)
- `NOTIFICATION_REDRIVE_MAX_AGE_MS` - Maximum lifespan of dead-letter records before expiration (default: `3600000`, Remote Config supported)
- Firestore-backed `notificationDeadLetters` records use `expiresAt`; run `bash ops/configure-operational-collection-retention.sh` once per project to enable native TTL and optionally backfill legacy records.
- **Redrive idempotency contract**: every redrive dispatch threads a deterministic `idempotencyKey` of the form `redrive:<deadLetterId>:<channel>:<attemptNumber>` through `NotificationManager.sendToChannels`. The key is preserved on the redrive Firestore document (`lastIdempotencyKey`) and exposed on every `SendResult.idempotencyKey` so downstream subscribers can dedupe accidental replays even though Telegram has no `sendMessage` idempotency (CB-178). Alert-producing webhooks may also forward an explicit `idempotencyKey` field, which `parseNotificationRouting` validates (≤256 chars) and preserves on the dispatched alert payload.
- `ZERO_CHANNEL_ALERT_COOLDOWN_MS` - Cooldown between admin notifications when all channels are disabled in milliseconds (default: `300000`, Remote Config supported)
- `ENABLE_API_ONLY_MODE` - Declare intentional API-only mode without notification delivery, suppressing zero-channel alerts and dead-letters (default: `false`, Remote Config supported)

#### URL Shortening (003-news-monitor)

- `URL_SHORTENER_SERVICE` - URL-shortening provider for WhatsApp citations (optional; defaults to `picsee`; supported values: `picsee`, `tinyurl`, `cuttly`)
- `PICSEE_API_KEY` - PicSee API key, required when PicSee is selected
- `CUTTLY_API_KEY` - Cuttly API key, required when Cuttly is selected
- TinyURL uses its free endpoint and requires no credential. Bitly, reurl, and Pixnet0rz.tw are unavailable in the runtime.

#### AI Grounding

- `ENABLE_GEMINI_GROUNDING` - Enable Gemini-based alert enrichment (`true` or `false`)
- `GEMINI_API_KEY` - Google API key for Gemini access
- `GROUNDING_MODEL_NAME` - Grounding model when Brave Search is not forced (default: `gemini-2.5-flash`)
- `GROUNDING_MAX_SOURCES` - Maximum grounded sources per alert (default: `3`)
- `GROUNDING_TIMEOUT_MS` - Grounding request timeout (default: `30000` ms)
- `GROUNDING_MAX_LENGTH` - Maximum alert text length used in grounding prompts (default: `2000` characters)
- `ALERT_GROUNDING_COALESCE_MS` - Optional equity-alert search coalescing window in milliseconds (default: `0`, disabled; Remote Config supported)

#### Cloudflare AI Gateway

- `MODEL_PROVIDER=cloudflare` selects Cloudflare runtime routing when the gateway credentials are configured
- `ENABLE_CLOUDFLARE_AIG` only exposes Cloudflare readiness in status/capabilities (`true` or `false`, default: `false`); it does not select the runtime provider
- `CF_AIG_TOKEN` - Cloudflare AI Gateway token; keep it in a secret store
- `CF_AIG_BASE_URL` - OpenAI-compatible Cloudflare gateway base URL
- `CF_AIG_MODEL` - Gateway target model (default: `google-ai-studio/gemini-2.5-flash`)

#### Langfuse Prompt Management

- `ENABLE_LANGFUSE_PROMPTS` - Fetch runtime prompts from Langfuse (`true` or `false`, default: `false`)
- `LANGFUSE_PUBLIC_KEY` - Langfuse public key (required when Langfuse prompt management is enabled)
- `LANGFUSE_SECRET_KEY` - Langfuse secret key (required when Langfuse prompt management is enabled)
- `LANGFUSE_BASE_URL` - Langfuse base URL (default: `https://cloud.langfuse.com`)
- `LANGFUSE_PROMPT_LABEL` - Prompt label to fetch (default: `latest` in local/dev/test, `production` in production-like environments)
- `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` - Prompt cache TTL in seconds (default: `0` for `latest`, `60` for `production`)
- Optional local prompt overrides: `SEARCH_QUERY_PROMPT`, `GEMINI_SYSTEM_PROMPT`, `ALERT_ENRICHMENT_SYSTEM_PROMPT`, `NEWS_ANALYSIS_SYSTEM_PROMPT`, and `CONFIDENCE_ENRICHMENT_SYSTEM_PROMPT`. Unset values use the versioned local fallback files.

#### TradingView MCP Analysis

- `ENABLE_TRADINGVIEW_MCP_ENRICHMENT` - Enable TradingView MCP enrichment for TradingView-like webhook messages (`true` or `false`, default: `false`)
- `EXPANDED_ANALYSIS_ALERT_SYMBOLS` - Comma-separated fallback symbols for `/api/webhook/expanded-analysis-alert` using `EXCHANGE:SYMBOL` format (for example `BINANCE:BTCUSDT,NASDAQ:NVDA`)
- `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` - Total analysis deadline for `/api/webhook/expanded-analysis-alert` in milliseconds (default: `60000`, capped at `120000`)
- `EXPANDED_ANALYSIS_ALERT_CONCURRENCY` - Maximum concurrent expanded-analysis MCP calls in webhook and job paths (default: `3`, valid range: `1`-`10`)
- `TRADINGVIEW_MCP_URL` - MCP server HTTP endpoint (default: `https://tradingview-mcp-yp6b.onrender.com/mcp`)
- `TRADINGVIEW_MCP_TIMEOUT_MS` - Timeout per MCP request in milliseconds (default: `12000`, valid range: `1000`-`120000`)
- `TRADINGVIEW_MCP_MAX_RETRIES` - Retries for MCP failures (default: `3`, valid range: `1`-`5`)
- `TRADINGVIEW_MCP_ENRICHMENT_BUDGET_MS` - Total budget envelope for the synchronous webhook enrichment flow (default: `12000`, valid range: `1000`-`120000`). When exceeded, all in-flight MCP calls are aborted and the enrichment fails open, preventing the alert webhook from being blocked for too long.
- `TRADINGVIEW_MCP_DEFAULT_EXCHANGE` - Default exchange when not present in signal (default: `BINANCE`)
- `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` - Default timeframe fallback (default: `1D` for `/api/webhook/expanded-analysis-alert`, `1h` for webhook signal enrichment)
- `ENABLE_TRADINGVIEW_VOLUME_CONFIRMATION` - Enable volume confirmation validation for TradingView alerts (`true` or `false`, default: `false`)
- `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT` - Enable optional `combined_analysis` confluence enrichment for TradingView webhook alerts (`true` or `false`, default: `false`)
- `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME` - Also call `multi_timeframe_analysis` during confluence enrichment (`true` or `false`, default: `false`)
- `ENABLE_ALERT_HTF_RENDER` - Enable rendering higher-timeframe trend alignment on enriched webhook alerts (`true` or `false`, default: `true`)
- `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION` - Suppress duplicate channel delivery for the same `exchange|symbol|timeframe|side` signal within its cooldown window; suppressed alerts are still persisted with a `suppressedRepeat: true` marker and opposite-side flips always deliver (`true` or `false`, default: `false`)
- `ALERT_SIGNAL_COOLDOWN_BARS` - Cooldown length in alert-timeframe bars for repeat suppression (`1`-`10`, default: `1`)
- Runtime gate: TradingView MCP data is only used when webhook requests include `?useTradingViewData=true`

#### Firestore Alert Storage

- `ENABLE_FIRESTORE_ALERT_STORAGE` - Enable Firestore persistence and alert read API (`true` or `false`, default: `false`)
- `ALERT_STORAGE_RETENTION_DAYS` - Retention for `alerts` and `alertReplays` records in days (`1`-`3650`, default: `90`). New records get `expiresAt`; run `bash ops/configure-firestore-alert-retention.sh` once per Firebase project to backfill legacy records and enable native Firestore TTL deletion.
- `ENABLE_FIRESTORE_JOB_STORAGE` - Enable Firestore persistence for async TradingView jobs without enabling alert read APIs (`true` or `false`, default: `false`)
- `ENABLE_FIRESTORE_IDEMPOTENCY` - Enable durable webhook idempotency persistence in Cloud Firestore (`true` or `false`, default: `false`)
- `ENABLE_SIGNAL_OUTCOME_TRACKING` - Enable shadow-mode signal outcome recording and evaluation (`true` or `false`, default: `false`)
- `SIGNAL_OUTCOME_RETENTION_DAYS` - Retention for `tradingSignalOutcomes` records in days (`1`-`3650`, default: `365`). New records get `expiresAt`; run `bash ops/configure-operational-collection-retention.sh` (or with `BACKFILL=true`) once per Firebase project to backfill legacy records and enable native Firestore TTL deletion.
- `ENABLE_EQUITY_MARKET_DATA` - Opt in to equity/forex/index outcome evaluation for `NASDAQ`, `BATS`, `NYSE`, `AMEX`, `NYSE ARCA`, `FX_IDC`, and `SPCFD` signals (`true` or `false`, default: `false`)
- `EQUITY_MARKET_DATA_PROVIDER` - Equity provider name; currently `twelve-data`
- `TWELVE_DATA_API_KEY` - Twelve Data API key; sent in the `Authorization` header and never returned by status endpoints
- `TWELVE_DATA_BASE_URL` - Optional Twelve Data base URL override (default: `https://api.twelvedata.com`)
- `EQUITY_MARKET_DATA_TIMEOUT_MS` - Per-request equity market-data timeout, capped at 30 seconds (default: `5000`)
- `SIGNAL_OUTCOME_WORKER_ROLE` - Scheduler role: `web` preserves the local/web timer, `worker` enables only the dedicated worker entrypoint, and `disabled` prevents scheduler startup (default: `web`)
- `FIREBASE_SERVICE_ACCOUNT_JSON` - Inline Firebase service account JSON for server-side Firestore access
- `FIREBASE_PROJECT_ID` - Optional Firebase project override for Admin SDK initialization
- `GOOGLE_APPLICATION_CREDENTIALS` - Optional path to a service account JSON file for local development

#### Worker Queue & Poller Execution

- `JOB_EXECUTION_MODE` - Use `local` for in-process fallback, `render-worker` for BullMQ/Redis worker queue, or `firestore-poller` for Redis-free durable Firestore polling (`local` by default)
- `JOB_POLL_INTERVAL_MS` - Polling sweep interval for `firestore-poller` mode in milliseconds (default: `15000` ms)
- `REDIS_URL` - Render Key Value connection string required by `render-worker`
- `JOB_QUEUE_ATTEMPTS` / `JOB_QUEUE_BACKOFF_MS` - Retry count and backoff delay (defaults: `5` / `30000` ms)
- `JOB_QUEUE_CONCURRENCY` - Worker concurrency (default: `1`)
- `JOB_QUEUE_CLAIM_LEASE_MS` - Firestore claim lease and heartbeat interval (default: `60000` ms)
- `JOB_QUEUE_CONNECT_TIMEOUT_MS` - Redis connection timeout (default: `5000` ms)

`render.yaml` provisions a starter Background Worker and Key Value store. The web service remains on `JOB_EXECUTION_MODE=local` by default; switching it to `render-worker` requires the worker, Redis, and Firestore credentials to be available. For deployments without Redis, `JOB_EXECUTION_MODE=firestore-poller` allows dedicated workers to poll Firestore directly without extra infrastructure. The API returns `503 JOB_QUEUE_UNAVAILABLE` instead of accepting a job when durable storage or queue requirements are not met. If enqueue acknowledgement and deterministic Redis reconciliation both fail in `render-worker` mode, it returns `503 JOB_QUEUE_ACCEPTANCE_UNKNOWN` with the durably stored `jobId`; the worker periodically re-enqueues durable queued rows, retries retained failed BullMQ jobs, and recovers expired claims after Redis recovers.

Unfiltered signal outcome summaries include `shadowModeMetrics` with full coverage buckets and per-window hit-rate metrics. The `exchangeBreakdown` and `providerBreakdown` maps carry `received`, `eligible`, `evaluated`, `pending`, and `unavailable` counts. Target and stop hit rates use barrier-eligible denominators: evaluated outcomes without a configured target or stop (`null`/non-positive) are excluded from the corresponding rate instead of counted as misses, and `windows[*].targetEligibleWindows` / `windows[*].stopEligibleWindows` expose each window's eligible denominator. Filtered alert summaries/exports omit shadow-mode metrics because that service has no matching source/enrichment filters. Equity signals only enter the eligible/evaluated population when the opt-in Twelve Data provider is configured; otherwise they remain explicitly unavailable.

#### Win metrics semantics

The `shadowModeMetrics` payload (also surfaced as the `X-Shadow-Mode-Metrics` response header on `GET /api/alerts/export`) follows these documented semantics so operators and downstream consumers compute the same number as the service:

- `hitRatePercent` — share of **evaluated window outcomes** whose `return > 0`. This is the loose "did price move in the trade direction" check; it diverges from `targetHitRatePercent` (see #550).
- `targetHitRatePercent` / `stopHitRatePercent` — share of evaluated window outcomes that hit the configured target or stop (including `firstHit` fallbacks). Denominator is **barrier-eligible**: evaluated outcomes without a configured target or stop are excluded, not counted as misses. A signal with no `target` value contributes only to `stopHitRatePercent`, not `targetHitRatePercent`.
- `expectancyR` — average `rMultiple` over evaluated windows with finite `rMultiple`. `null` when no window has a finite `rMultiple`.
- `averageReturnPercent` / `averageMfePercent` / `averageMaePercent` — unweighted mean over evaluated windows (not barrier-eligible; includes every evaluated window).
- `maxAdverseExcursionPercent` — worst observed `maxAdverseExcursion` across the window.
- `coveragePercent` — `(totalSignalsEvaluated / totalSignalsReceived) * 100`. `isCoverageComplete` is `true` when every received signal was evaluated.
- `populationNote` — human-readable coverage summary, e.g. `"Metrics represent 40 evaluated signals out of 50 total received signals (80% coverage)."`
- `windows.<1h|4h|1D|1W>` — the same metric set scoped to a single evaluation window. Each block may include `bySide` (`BUY` / `SELL`) and `bySetupType` sub-blocks when at least one evaluated signal exists for that bucket.
- `drawdownProxy` — `averageMaxAdverseExcursionPercent` (mean of per-signal worst excursion) and `absoluteMaxAdverseExcursionPercent` (single worst excursion observed).
- `falsePositiveCandidates` / `falsePositiveCandidatesCount` — up to 5 high-confidence signals (`|score| >= 0.75`, or news-monitor `|score| >= 0.7`) with `return < -1%` or `maxAdverseExcursion < -3%`.
- `latencyCostMetadata` — `averageProcessingTimeMs` and aggregated `tokenUsage` (numeric-only fields, `inputTokens` / `outputTokens` / `totalCost`).

When signal-outcome tracking is disabled, or when no measurements exist in the requested window, the field becomes the string sentinel `"No measurements found"` instead of an object payload. The same sentinel is emitted in the `X-Shadow-Mode-Metrics` response header on `GET /api/alerts/export`. Both surfaces honor the same fallback; filtered summaries/exports omit the field entirely because the shadow-mode metrics service has no matching source/enrichment filters.

#### Firebase Remote Config (server-side Preview)

- `ENABLE_FIREBASE_REMOTE_CONFIG` - Enable server-side Firebase Remote Config tuning (`true` or `false`, default: `false`)
- `FIREBASE_REMOTE_CONFIG_REFRESH_INTERVAL_MS` - Bounded refresh cadence (default: `900000`, maximum: `86400000`)
- `FIREBASE_REMOTE_CONFIG_LOAD_TIMEOUT_MS` - Maximum template-load wait (default: `10000`, maximum: `30000`)
- `FIREBASE_REMOTE_CONFIG_MAX_AGE_MS` - Maximum age of a successful template before environment/default fallback (default: `3600000`, maximum: `604800000`)

The initial allow-list contains news thresholds, timeouts, concurrency, quota retries, TradingView timeouts/retries, `SIGNAL_OUTCOME_RETENTION_DAYS` (retention in days between `1` and `3650`, default `365`), and `ENABLE_MESSAGE_FOOTER_METADATA`. Remote values are parsed as numbers/booleans and must satisfy the existing finite, integer, positive, and range constraints. Credentials, API keys, webhook authentication, route/security gates, and Telegram destinations are never read from Remote Config.

The service loads once at startup and refreshes on the bounded cadence; it does not fetch Remote Config per alert. `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS` remains environment-only because the worker timer is created during process startup and is not a request-time setting. Disabled, unavailable, timed-out, stale, malformed, or invalid values fail open to the current environment/default behavior. The server-side Remote Config API is currently a Firebase Preview feature, so monitor its quota and error rate before enabling it in production. `firebase-admin` is upgraded to the Node 24-compatible 12.x line (`^12.1.0`, lockfile resolution `12.7.0`).

#### Firestore Emulator Integration Tests

The optional `pnpm test:firebase` command runs the Firestore-backed integration suite against the local Firebase emulator using the `demo-cabros` project ID. It covers the Admin SDK storage paths, idempotency transactions, async jobs, scanner presets, signal outcomes, and deny-by-default client rules.

Prerequisites: Node.js 24+, Java/JDK 11+, and network access for the pinned Firebase CLI and emulator binary on the first run. The command uses `firebase emulators:exec`, clears emulator data between tests, unsets production Firebase credential variables, and stops the emulator on completion or failure. It never connects to a real Firebase project. The default `pnpm test` remains mock-based and does not require Java, the CLI, or external network access.

```bash
pnpm test:firebase
```

#### Admin Notifications

- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` - Chat ID for deployment alerts and fail-open notification-channel failure pages

#### Server Configuration

- `PORT` - HTTP server port (default: `80`)
- `SHUTDOWN_TIMEOUT_MS` - Maximum graceful shutdown budget in milliseconds (default: `10000`, hard cap: `30000`); after the deadline active jobs receive a bounded finalization attempt and are persisted as retryable cancellations, remaining HTTP connections are force-closed, and the process exits
- `RENDER` - Render.com deployment flag (used internally)
- `IS_PULL_REQUEST` - Render preview environment flag (disables bot in PRs)
- `VERCEL` / `VERCEL_ENV` - Vercel system deployment markers; `VERCEL_ENV=preview` disables the bot
- `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG` - Vercel deployment metadata used for release and deployment notifications
- `RAILWAY_ENVIRONMENT_NAME` / `RAILWAY_GIT_PULL_REQUEST_NUMBER` - Railway preview markers; a PR number or environment name containing a hyphen-delimited `pr` segment disables the bot
- `RAILWAY_GIT_COMMIT_SHA` / `RAILWAY_GIT_REPO_OWNER` / `RAILWAY_GIT_REPO_NAME` - Railway GitHub deployment metadata used for release and deployment notifications
- `TRUST_PROXY` - Express trusted proxy setting for reverse-proxy deployments (`true`, `false`, `1` hop, or subnet string; defaults to `1` on Render/Vercel/Railway, and `false` for direct deployments)
- `RATE_LIMIT_WINDOW_MS` - Global API rate limiter window in milliseconds (default: `900000` / 15 minutes; invalid values use the default)
- `RATE_LIMIT_MAX` - Global API rate limiter max requests per window (default: `100`; invalid values use the default). Core `/api/webhook/alert` and `/api/webhook/message` ingest uses an isolated finite bucket of 1,000 requests per window so TradingView bursts do not consume the ordinary client bucket; API-key validation still applies.
- `LOG_LEVEL` - Structured JSON log verbosity (`debug`, `info`, `warn`, `error`, `silent`; defaults to `debug` in development and `info` in production). The logger automatically masks sensitive plain-object keys, bare-scalar secrets preceded by sensitive labels, URL query secrets, embedded JSON strings, Authorization/Bearer credentials, Telegram bot tokens, Discord webhook tokens, OpenAI keys, and dynamically registered request-scoped secrets via `registerSecretValue` / `clearSecretValue`.
- `SERVICE_NAME` - Optional service name included in JSON logs (default: package name or `cabros-bot`)

#### News Monitoring (003-news-monitor)

- `ENABLE_NEWS_MONITOR` - Enable news monitoring endpoint (`true` or `false`, default: `false`)
- `NEWS_SYMBOLS_CRYPTO` - Default crypto symbols if not provided in request (comma-separated, e.g., `BTCUSDT,ETHUSD`)
- `NEWS_SYMBOLS_STOCKS` - Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` - Confidence score threshold for sending alerts (default: `0.7`, range 0.0-1.0)
- `NEWS_CACHE_TTL_HOURS` - Cache time-to-live for deduplication (default: `6` hours)
- `ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP` - Enable Firestore-backed news deduplication (`true` or `false`, default: `false`; failures fall back to memory)
- `NEWS_TIMEOUT_MS` - Per-symbol analysis timeout (default: `30000` ms)
- `NEWS_GEMINI_CONCURRENCY` - Max concurrent Gemini-backed symbol analyses. Production policy is `3`; unset keeps legacy parallel fan-out for backward compatibility.
- `NEWS_GEMINI_QUOTA_MAX_RETRIES` - Max per-symbol retries for Gemini `429 RESOURCE_EXHAUSTED` errors (default: `2`)
- `NEWS_GEMINI_QUOTA_RETRY_BASE_MS` - Base exponential backoff when Gemini does not provide retry delay metadata (default: `1000` ms)
- `ENABLE_BINANCE_PRICE_CHECK` - Enable Binance crypto price fetching (`true` or `false`, default: `false`)
- `BINANCE_DATA_BASE_URL` - Optional custom Binance market-data host for public data (klines, ticker, avgPrice), e.g. `https://data-api.binance.vision` (default: unset / `https://api.binance.com`)
- `BINANCE_FETCH_TIMEOUT_MS` - Binance price request timeout (default: `5000` ms)

#### Binance Spot Order Execution

- `ENABLE_BINANCE_TRADING` - Enable the operator-only Spot order endpoint (`true` or `false`, default: `false`)
- `BINANCE_API_KEY` / `BINANCE_API_SECRET` - Server-side Binance credentials with Spot trading permission only; withdrawals must remain disabled and IP restrictions are recommended
- `BINANCE_TRADING_ENV` - Binance environment: `testnet` (default), `demo`, or explicit `live`. Use `demo` (`https://demo-api.binance.com`) for pre-live validation — it mirrors production market data and exchange filters exactly. Use `testnet` (`https://testnet.binance.vision`) for exploratory sandbox testing.
- `BINANCE_TRADING_BASE_URL` - Optional custom base URL for Binance trading endpoints in live mode (default: unset / `https://api.binance.com`)
- `BINANCE_TRADING_ALLOWED_SYMBOLS` - Comma-separated Spot symbol allow-list, for example `BTCUSDT,ETHUSDT`
- `BINANCE_TRADING_MAX_NOTIONAL` - Maximum order notional in quote asset, enforced before submission
- `BINANCE_TRADING_TIMEOUT_MS` - Signed request timeout (default `10000` ms, capped at `30000` ms)

`POST /api/trading/binance/orders` requires `admin.operator` access through the existing API-key or Firebase admin authentication flow, and fails closed if neither mechanism is configured. It supports `MARKET` and `LIMIT` `BUY`/`SELL` orders, validates the live Binance symbol status and filters, and uses the existing `binance` `MainClient`. MARKET orders accept either `quoteOrderQty` or base asset `quantity` (evaluated using average price against the configured notional cap). Quantity-based MARKET BUYs are converted to an exchange-enforced `quoteOrderQty` at the estimated average price so Binance itself caps the realized quote spend at `BINANCE_TRADING_MAX_NOTIONAL`; quantity-based MARKET SELLs keep base-quantity sizing.

`DELETE /api/trading/binance/orders` closes a resting or partially filled order inside the same audited execution path so operators do not have to fall back to Binance's own web/app UI. It accepts a JSON body with the allow-listed `symbol` and exactly one of `orderId` or `origClientOrderId` (the same identifier format accepted by `POST` and the read endpoint). The response is the sanitized cancelled order. Already-terminal orders (Binance error `-2011`, "Unknown order sent", or `-2013`) return `404 ORDER_NOT_FOUND` without re-firing at Binance; ambiguous bodies return `400 INVALID_ORDER_REQUEST`; symbols outside the configured allow-list return `400`; definitive exchange rejections return `400 BINANCE_REQUEST_REJECTED`; transient provider failures return retryable `502 BINANCE_QUERY_FAILED`. The endpoint inherits every gate from `POST` (`ENABLE_BINANCE_TRADING`, credentials, `admin.operator`, allowed symbols) so an operator cannot bypass the execution safety envelope while cancelling an order.

`dryRun` defaults to `true` and validates the request without submitting. Set `dryRun: false` only after enabling the feature and explicitly selecting the intended environment. The default environment is Spot Testnet; `live` is never selected implicitly. Live requests require `idempotency-key` (or `x-idempotency-key`) or an explicit `clientOrderId`; a matching request is replayed and a changed payload returns `409 IDEMPOTENCY_CONFLICT`. Send decimal quantities, prices, and quote amounts as strings when exact precision matters; the service preserves those values through validation, submission, and reconciliation by disabling Binance SDK response beautification. MARKET orders must omit `timeInForce`; Binance order-test validation runs for LIMIT dynamic price filters and account-dependent filters such as `MAX_POSITION` and `MAX_NUM_ORDERS`. Definitive Binance rejections, including pre-execution timestamp and throttling failures, return `400 BINANCE_ORDER_REJECTED`; a recovered Binance order that does not match the request returns `409 BINANCE_ORDER_CONFLICT`; transient order-test failures return retryable `502 BINANCE_VALIDATION_FAILED`. A live request with an idempotency key derives a deterministic Binance `clientOrderId`; after cache expiration or process restart, the service reconciles that ID before submitting again. If Binance submission status is ambiguous, including Binance execution-unknown code `-1006`, the API returns `503 BINANCE_ORDER_STATUS_UNKNOWN` and replays that result for the same key; reconcile the order before retrying with a new key.

The response and audit logs include only sanitized order metadata. API credentials are never returned or logged.
- `ENABLE_LLM_ALERT_ENRICHMENT` - Enable optional secondary LLM enrichment (`true` or `false`, default: `false`)
- `AZURE_LLM_ENDPOINT` - Azure AI Inference endpoint URL (required if enrichment enabled)
- `AZURE_LLM_KEY` - Azure AI Inference API key (required if enrichment enabled)
- `AZURE_LLM_MODEL` - Azure AI LLM model name (e.g., `gpt-4o`, required if enrichment enabled)

#### Runtime Error Monitoring (005-sentry-runtime-errors)

- `ENABLE_SENTRY` - Enable Sentry error reporting (`true` or `false`, default: `false`)
- `SENTRY_DSN` - Sentry Data Source Name (DSN) from your Sentry project settings
- `SENTRY_ENVIRONMENT` - Explicit environment tag (`production`, `preview`, `development`). Auto-derived if not set
- `SENTRY_RELEASE` - Explicit release tag (e.g., `v1.2.3`). Auto-derived from git commit if not set
- `SENTRY_SEND_ALERT_CONTENT` - Include alert text in error events (`true` or `false`, default: `true`)
- `SENTRY_SAMPLE_RATE_ERRORS` - Error sample rate from 0.0 to 1.0 (default: `1.0` = 100%)
- `SENTRY_TRACES_SAMPLE_RATE` - Trace sample rate from 0.0 to 1.0 (leave unset to disable tracing and custom spans)
- `SENTRY_PROFILE_SESSION_SAMPLE_RATE` - Profiling session sample rate from 0.0 to 1.0 (leave unset to disable profiling; requires `SENTRY_TRACES_SAMPLE_RATE` to be set)
- `SENTRY_CONSOLE_LOG_LEVELS` - Comma-separated console levels sent as Sentry Logs (default: `warn,error`; allowed: `debug`, `info`, `warn`, `error`, `log`, `assert`, `trace`)
- `ENABLE_SENTRY_DEBUG_ROUTE` - Mount `GET /debug-sentry` only for explicit local/manual validation (`true` enables it; default disabled so normal runtime returns `404`)
- Sentry Logs are enabled automatically when `ENABLE_SENTRY=true`; configured console levels are sent as Sentry Logs.

#### TradingView Market Scanner Alerts

- `ENABLE_MARKET_SCANNER` - Enable market scanner endpoint (`true` or `false`, default: `false`)
- `MARKET_SCANNER_DEFAULT_EXCHANGE` - Default exchange when not provided in request (default: `BINANCE`)
- `MARKET_SCANNER_TIMEOUT_MS` - Timeout in milliseconds for scanner webhook process (default: `90000`, max `120000`)

#### Scanner Preset Storage

- `ENABLE_FIRESTORE_SCANNER_PRESETS` - Enable the scanner-preset Firestore persistence gate independently from alert storage, job storage, and outcome tracking (default: `false`)
- When Firestore is initialized and writes succeed, scanner-preset responses and `/api/status` report `storage.mode: "durable"` with `backend: "firestore"`.
- When the flag is disabled, or Firestore initialization/write fails, the service reports `storage.mode: "ephemeral"` with `backend: "memory"`; presets in this mode can be lost on restart or redeploy.
- `dependencies.scannerPresetStorage` in `/api/status` and `/api/capabilities` exposes `enabled`, `configured`, `ready`, `status`, `mode`, and `backend` without secrets. A `misconfigured` status means a Firestore gate is enabled but the client is unavailable.

#### Scanner Preset Optimistic Concurrency

- `GET /api/scanner-presets/:id`, `POST /api/scanner-presets`, and `PUT /api/scanner-presets/:id` set an `ETag` response header (e.g. `ETag: "3"`) that mirrors a per-preset monotonic `version` field returned in the response body.
- `PUT /api/scanner-presets/:id` and `DELETE /api/scanner-presets/:id` accept an optional `If-Match: "<version>"` request header for opt-in optimistic concurrency. A missing `If-Match` keeps today's behavior (the write succeeds and increments `version`).
- A mismatched `If-Match` returns `412 PRECONDITION_FAILED` with the current preset (including `version`) so the client can rebase before retrying.
- An update targeting a preset whose `lockedUntil` is in the future returns `409 PRESET_LOCKED` with the `lockedUntil` timestamp and the current preset, so an operator save cannot silently overwrite an in-flight sweep's lease.

#### Scanner Preset Scheduler

- `ENABLE_SCANNER_PRESET_SCHEDULER` - Enable background recurring execution of scheduled scanner presets (default: `false`)
- `SCANNER_PRESET_SCHEDULER_WORKER_ROLE` - Scheduler worker role: `web` (default), `worker`, or `disabled`.
- `SCANNER_PRESET_SCHEDULER_INTERVAL_MS` - Background sweep interval in milliseconds (default: `60000`, bounds `1000`-`3600000`).
- `SCANNER_PRESET_SCHEDULER_BATCH_LIMIT` - Maximum due presets processed per sweep (default: `50`, bounds `1`-`500`).
- `SCANNER_PRESET_SCHEDULER_LEASE_MS` - Distributed concurrency lock lease duration in milliseconds (default: `120000`, bounds `10000`-`600000`).
- `dependencies.scannerPresetScheduler` in `/api/status` and `/api/capabilities` exposes `enabled`, `configured`, `ready`, `status`, `role`, `running`, `shutdownRequested`, and execution counters without secrets.

#### News Monitor Scheduler

- `ENABLE_NEWS_MONITOR_SCHEDULER` - Enable built-in recurring execution of news-monitor sweeps (default: `false`)
- `NEWS_MONITOR_SCHEDULER_WORKER_ROLE` - Scheduler worker role: `web` (default), `worker`, or `disabled`.
- `NEWS_MONITOR_SCHEDULER_INTERVAL_MS` - Background sweep interval in milliseconds (default: `300000`, bounds `10000`-`3600000`).
- `NEWS_MONITOR_SCHEDULER_BATCH_LIMIT` - Maximum default news-monitor symbols processed per sweep (default: `50`, bounds `1`-`500`).
- `NEWS_MONITOR_SCHEDULER_LEASE_MS` - Distributed concurrency lock lease duration in milliseconds (default: `120000`, bounds `10000`-`600000`).
- `NEWS_MONITOR_SCHEDULER_TIMEOUT_MS` - Per-sweep execution deadline in milliseconds (default: `90000`, bounds `1000`-`600000`).
- `dependencies.newsMonitorScheduler` in `/api/status` and `/api/capabilities` exposes `enabled`, `configured`, `ready`, `status`, `role`, `running`, `lastRunAt`, `lastRunDurationMs`, `lastRunSymbolCount`, `lastRunExecutedCount`, `lastRunErrorCount`, and `lastError` without secrets.

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

## API Endpoints

The canonical API contract is served publicly at [`/openapi.json`](http://localhost:80/openapi.json), with interactive Swagger UI at [`/docs`](http://localhost:80/docs). Use those endpoints for request schemas, response shapes, examples, and the current route inventory. Protected `/api` operations still require `x-api-key`; the documentation endpoints never expose configured credentials.

### GET /healthcheck

Health check endpoint.

**Response:**
```json
{"uptime":"..."}
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

`featureFlags.cloudflareAig` reports `ENABLE_CLOUDFLARE_AIG`, while `dependencies.cloudflareAig` reports whether the Cloudflare AI Gateway credentials are configured and ready. Runtime provider selection is controlled separately by `MODEL_PROVIDER=cloudflare`; set both values when status/capability telemetry should match active Cloudflare routing.

When `ENABLE_EQUITY_MARKET_DATA=true`, `dependencies.equityMarketData` reports Twelve Data readiness and the supported `BATS`/`NASDAQ`/`NYSE`/`AMEX`/`NYSE ARCA`/`FX_IDC`/`SPCFD` exchanges without exposing the API key. Signal outcome tracking uses `/quote` for missing entry prices and `/time_series` for bounded historical bars; provider, timeout, malformed-data, and quota failures mark equity outcomes unavailable without blocking alert delivery. Extended-hours data is excluded by default. Confirm current Twelve Data plan limits and licensing before production use: [pricing](https://twelvedata.com/pricing), [US equities coverage](https://support.twelvedata.com/en/articles/9935903-us-equities-market-data), and [commercial usage](https://support.twelvedata.com/en/articles/5332349-commercial-and-personal-usage).
`dependencies.signalOutcomeWorker` reports the scheduler role, shutdown state, cadence/budgets, and the last-sweep heartbeat counters (`lastRunAt`, scanned, pending, evaluated, and error counts). The `worker` role is intended for the dedicated Render service; set the web service role to `disabled` during cutover so only one scheduler is active. A disabled local scheduler reports `ready: false` and `status: "disabled"` because it is not the process evaluating outcomes.

The dedicated worker also persists the same non-sensitive heartbeat to `workerHeartbeats/signal-outcome` in Firestore. Heartbeat writes fail open and never block alert delivery.
`featureFlags.firebaseRemoteConfig` reports `ENABLE_FIREBASE_REMOTE_CONFIG`. This is server-side Remote Config: the Firebase Admin SDK loads the published template with `initServerTemplate()`, while no Firebase Web/Client SDK configuration is involved. `dependencies.firebaseRemoteConfig` exposes only `enabled`, `configured`, `ready` (true only after a successful, fresh template load), `status` (`ready`, `degraded`, `unknown`, `misconfigured`, or `disabled`), `source` (`remote`, `environment`, `default`, or `disabled`), `templateVersion`, `lastSuccessfulLoad`, `lastErrorCategory`, `consecutiveFailures`, and bounded loader settings; it never returns remote parameter values or credentials.

`GET /api/capabilities` is an alias for the same payload.

When configured, `featureFlags.binanceTrading` and `dependencies.binanceTrading` expose only the non-sensitive execution gate, selected `testnet`/`demo`/`live` environment, allow-listed symbols, and readiness state.

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
    "tradingViewMcp": { "enabled": true, "configured": true, "ready": false, "status": "unknown", "lastCheckedAt": null, "lastSuccessAt": null, "lastFailureAt": null, "lastErrorCategory": null, "successCount": 0, "failureCount": 0, "enrichment": { "alertPath": { "windowMs": 86400000, "totalCount": 0, "appliedCount": 0, "failedCount": 0, "appliedRate24h": 0, "failureRate24h": 0 } } },
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

## Alert Enrichment with Gemini Grounding (001)

The webhook alert system can optionally enrich alerts with verified sources and market context using Google Gemini API with GoogleSearch grounding.

### MCP Flow

When `ENABLE_GEMINI_GROUNDING=true`:

1. Alert text received via webhook
2. Gemini API queries with GoogleSearch grounding enabled
3. Returns summary and extracted sources (URLs with titles)
4. Enriched alert formatted and sent to all enabled channels (Telegram, WhatsApp)

### Enrichment Features

- **Sentiment Analysis**: Determines market sentiment (BULLISH/BEARISH/NEUTRAL) with confidence score
- **Key Insights**: Extracts bullet points of critical information
- **Technical Levels**: Identifies support and resistance levels mentioned in context
- **Risk Parameters**: Optionally reports invalidation level, target level, setup type, and estimated risk/reward ratio
- **Verified Sources**: Extracts URLs and titles from GoogleSearch results
- **Language Support**: Respects original language of alert text
- **Graceful Fallback**: If enrichment fails, original alert is sent without delays
- **Reusable Results**: Single grounding call shared across all notification channels

### Configuration

- `ENABLE_GEMINI_GROUNDING` - Enable/disable enrichment (default: `false`)
- `GEMINI_API_KEY` - Google API key with Generative AI enabled

### How Langfuse Prompt Management Works

When `ENABLE_LANGFUSE_PROMPTS=true`, runtime prompts are fetched from Langfuse through the centralized prompt service in `src/services/prompts/`.

The local fallback prompts now live as editable text templates under `src/services/prompts/defaults/`, which makes them much easier to review, diff, and version independently from the prompt registry code.

Managed prompts currently include:

- search-query derivation
- grounded summary generation
- webhook alert enrichment
- news analysis
- secondary confidence enrichment
- Gemini market price fetch query

Behavior notes:

- **Fail-open by design**: if Langfuse is disabled, misconfigured, unavailable, or missing a prompt, the app automatically falls back to the local prompt text files in `src/services/prompts/defaults/`.
- **Label-based rollout**: use `LANGFUSE_PROMPT_LABEL` (for example `latest`, `staging`, or `production`) to switch prompt versions without code changes.
- **SDK caching**: prompt fetches use the Langfuse SDK cache and can be tuned with `LANGFUSE_PROMPT_CACHE_TTL_SECONDS`.
- **Current architecture contract**: prompts are compiled into the existing `systemPrompt` / `userPrompt` flow, so provider routing for Gemini, Azure, and OpenRouter remains unchanged.
- **Alert enrichment schema**: Langfuse `alert-enrichment` versions should mirror the local fallback's optional `invalidation_level`, `target_level`, `setup_type`, and `risk_reward_ratio` fields. The prompt service inspects resolved remote prompts against `REQUIRED_ALERT_ENRICHMENT_RISK_FIELDS`, records `schemaDriftDetected: true` and missing risk fields if any are omitted, and warns once per version without failing open delivery.

## TradingView Signal Enrichment with MCP

When `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`, webhook alerts matching TradingView-style patterns (for example `BTCUSDT(240) pasó a señal de VENTA`) are enriched with real technical data from the TradingView MCP server **only if the webhook request includes `?useTradingViewData=true`**.

### How It Works

1. Webhook receives alert text and the request includes `useTradingViewData=true`.
2. System detects TradingView signal pattern (`SYMBOL(TF)` + side `VENTA/COMPRA` or `SELL/BUY`).
3. If TradingView pattern is detected, it queries `coin_analysis` via MCP and uses that output as an **additional real-time technical source**.
4. If `ENABLE_TRADINGVIEW_CONFLUENCE_ENRICHMENT=true`, it also calls `combined_analysis` inside the same enrichment budget and annotates or downgrades the signal when confluence contradicts the webhook side.
5. If `ENABLE_TRADINGVIEW_CONFLUENCE_MULTI_TIMEFRAME=true`, it also calls `multi_timeframe_analysis` and returns the raw multi-timeframe metadata in dry-run/stored enrichment data.
6. Gemini/Brave grounding still runs when enabled, and the final `alert.enriched` merges grounding context + MCP technical data. When grounding returns no sources, Gemini sentiment magnitude is capped at `0.55`; the original signed value is retained as `sentiment_score_raw` only when that cap changes the score.
7. If either provider fails, the flow degrades gracefully to the other provider (or original text if none succeed).

Base `coin_analysis` gets the full configured budget when optional enrichment is disabled; when volume/confluence calls are enabled, it gets a bounded sub-budget so a timed-out first attempt can retry before the total envelope expires. Optional calls share the remaining envelope; if one times out, the base result is retained with `tradingViewEnrichmentStatus: "partial"` (or `"full"` when all requested enrichment completes). Failed base enrichment remains fail-open and is tracked as `"failed"` in runtime/storage telemetry.

When TradingView data is requested, `alert.enriched.tradingViewEnrichmentApplied` is `true` only when the MCP result was successfully applied. `tradingViewEnrichmentStatus` reports `full`, `partial`, `failed`, or `not_applicable`; the status is persisted separately from `useTradingViewData`, so analytics can distinguish requested, delivered, partial, and failed enrichment. When the MCP result supplies price data, `alert.enriched.current_price` (number or `null`) and the optional structured `alert.enriched.price_data` snapshot (e.g. `current_price`, `high`, `low`) are also part of the enrichment payload; these fields feed outcome-tracking entry prices and appear in dry-run `enrichedData` responses.

`GET /api/status` exposes `dependencies.tradingViewMcp.enrichment.alertPath`, an in-process rolling 24-hour window with `totalCount`, `appliedCount`, `failedCount`, `appliedRate24h`, and `failureRate24h`. The existing circuit-breaker admin page remains deduplicated and fail-open. `GET /api/alerts/summary` exposes `enrichment.tradingViewStatusCounts`; requested records without a persisted status are counted as `unrecorded`, while non-requested records are `not_applicable`.

### Timeframe Mapping

- `5 -> 5m`
- `15 -> 15m`
- `60 -> 1h`
- `240 -> 4h`
- `D/1D -> 1D`
- `W/1W -> 1W`
- `M/1M -> 1M`

### Example Enrichment Flow

**Request:**
```bash
POST /api/webhook/alert?useTradingViewData=true
Content-Type: application/json

{
  "text": "Bitcoin breaks $83,000 resistance level with strong volume."
}
```

**Response (with enrichment enabled):**
```json
{
  "success": true,
  "enriched": true,
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    }
  ]
}
```

**Message sent to Telegram:**
```text
*Bitcoin breaks $83,000 resistance level with strong volume.*

*Key Insights*
• Bitcoin price surged past $83k.
• Volume indicates strong momentum.

Sentiment: BULLISH 🚀 (0.85)

*Risk Parameters*
Setup: breakout
Invalidation: $80,000
Target: $90,000
Risk/Reward: 2.5:1

*Technical Levels*
Supports: $80,000
Resistances: $85,000

*Sources*
[CoinDesk](https://coindesk.com/...) / [CoinTelegraph](https://cointelegraph.com/...)
```

### Troubleshooting

- **Enrichment timeout**: If Gemini takes >8s, original alert is sent with warning logged
- **API errors**: Missing `GEMINI_API_KEY` or API rate limits fall back to original text
- **Long alerts**: Text >4000 chars may be truncated to manage costs
- **Disabled enrichment**: Set `ENABLE_GEMINI_GROUNDING=false` to skip processing

### POST /api/news-monitor

Analyze financial news and market sentiment for crypto and stock symbols. Detect significant trading events and send alerts to configured channels.

**Request (JSON):**
```json
{
  "crypto": ["BTCUSDT", "ETHUSD"],
  "stocks": ["NVDA", "MSFT"]
}
```

**Request (GET with query params):**
```
GET /api/news-monitor?crypto=BTCUSDT,ETHUSD&stocks=NVDA,MSFT
```

Add `dryRun=true` to either GET or POST to run the same validation and analysis without sending Telegram, WhatsApp, or Discord notifications, claiming or writing news-dedup cache entries, or recording signal outcomes. The response includes `dryRun: true`, the generated alerts, the intended `requestedChannels`, and an empty `deliveredChannels` array. POST also accepts `dryRun: true` in the JSON body.

```text
GET /api/news-monitor?crypto=BTCUSDT&channels=telegram,whatsapp&dryRun=true
POST /api/news-monitor?dryRun=true
```

Dry-run response excerpt:
```json
{
  "success": true,
  "dryRun": true,
  "requestedChannels": ["telegram", "whatsapp"],
  "deliveredChannels": [],
  "results": [{
    "symbol": "BTCUSDT",
    "status": "analyzed",
    "alert": { "eventCategory": "price_surge", "headline": "Bitcoin breaks resistance" },
    "deliveryResults": [],
    "cached": false
  }]
}
```

**Response:**
```json
{
  "success": true,
  "requestId": "req-abc123def456",
  "results": [
    {
      "symbol": "BTCUSDT",
      "status": "analyzed",
      "alert": {
        "eventCategory": "price_surge",
        "headline": "Bitcoin breaks $45,000 on positive market sentiment",
        "confidence": 0.85,
        "sources": ["Reuters", "CoinDesk"]
      },
      "deliveryResults": [
        {
          "channel": "telegram",
          "success": true,
          "messageId": "123456"
        },
        {
          "channel": "whatsapp",
          "success": true,
          "messageId": "whatsapp-msg-id"
        }
      ],
      "totalDurationMs": 2847,
      "cached": false,
      "requestId": "req-abc123def456"
    },
    {
      "symbol": "NVDA",
      "status": "cached",
      "alert": null,
      "cached": true,
      "requestId": "req-abc123def456"
    }
  ],
  "summary": {
    "total": 2,
    "analyzed": 1,
    "cached": 1,
    "timeout": 0,
    "error": 0,
    "quota_exhausted": 0,
    "alerts_sent": 1
  },
  "requestedChannels": ["telegram", "whatsapp"],
  "deliveredChannels": ["telegram", "whatsapp"],
  "totalDurationMs": 5234,
  "tokenUsage": {
    "inputTokens": 120,
    "outputTokens": 80,
    "totalTokens": 200
  }
}
```

**Event Categories** (detected by Gemini analysis):
- `price_surge` - Bullish price movement (>5% gain) with positive news
- `price_decline` - Bearish price movement (>5% loss) with negative news
- `public_figure` - Mentions of influential figures (Trump, Elon Musk, etc.)
- `regulatory` - Regulatory or official announcements

**Response Status Values**:
- `analyzed` - Symbol successfully analyzed, alerts generated/filtered
- `cached` - Result returned from cache (within TTL for same event category)
- `timeout` - Analysis exceeded per-symbol timeout (30s default)
- `error` - API failure (Binance, Gemini, or other service error). Gemini quota exhaustion is reported as `error.code = "GEMINI_QUOTA_EXHAUSTED"` and counted in `summary.quota_exhausted`.

When Sentry tracing is enabled, symbol analysis runs inside the `news_monitor.analyze_symbols` span, which records `news.symbol_count`, `news.quota_exhausted`, and `news.error_count` for quota correlation. Keep production `NEWS_GEMINI_CONCURRENCY=3` to bound provider bursts.

### POST /api/webhook/expanded-analysis-alert

Generate an expanded technical-analysis report with TradingView MCP `coin_analysis` data and send it through all enabled notification channels.

**Request (JSON):**
```json
{
  "symbols": ["BINANCE:BTCUSDT", "NASDAQ:NVDA"],
  "timeframe": "1D"
}
```

If `symbols` is empty or omitted, the endpoint falls back to `EXPANDED_ANALYSIS_ALERT_SYMBOLS`. If neither is defined, it returns `400 NO_SYMBOLS`. Symbols must be complete `EXCHANGE:SYMBOL` identifiers; crypto pairs are not normalized automatically.

The endpoint stops analysis at `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` (default 60 seconds, max 120 seconds). If the deadline is reached before any symbol is analyzed, it returns `504 EXPANDED_ANALYSIS_ALERT_TIMEOUT`; completed symbols are returned and remaining symbols are marked with `status: "timeout"`.

**Response:**
```json
{
  "success": true,
  "alertText": "📊 *ANÁLISIS AMPLIADO — Friday 22/05/2026*...",
  "results": [
    {
      "symbol": "NASDAQ:NVDA",
      "status": "analyzed",
      "price": 219.51,
      "rsi": 57.8
    }
  ],
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    }
  ],
  "summary": {
    "total": 1,
    "analyzed": 1,
    "error": 0,
    "delivered": 1
  },
  "requestId": "req-abc123",
  "processingTimeMs": 1200
}
```

### POST /api/webhook/volume-confirmation

Run TradingView MCP `volume_confirmation_analysis` on demand and return structured JSON without sending notifications.

**Request (JSON):**
```json
{
  "symbol": "BINANCE:BTCUSDT",
  "timeframe": "4h"
}
```

- `symbol`: Required `EXCHANGE:SYMBOL` identifier.
- `timeframe`: Optional indicator interval. Defaults to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `1h`.

**Response (JSON):**
```json
{
  "success": true,
  "symbol": "BINANCE:BTCUSDT",
  "exchange": "BINANCE",
  "asset": "BTCUSDT",
  "timeframe": "4h",
  "confirmed": true,
  "decision": "confirm",
  "volumeRatio": 1.7,
  "analysis": {
    "symbol": "BINANCE:BTCUSDT",
    "volume_analysis": {
      "volume_ratio": 1.7,
      "volume_strength": "HIGH"
    }
  },
  "requestId": "req-vol-123",
  "processingTimeMs": 310
}
```

If the symbol format is invalid, the endpoint returns `400 INVALID_REQUEST`. If TradingView MCP fails, it returns `502 VOLUME_CONFIRMATION_FAILED` with the upstream error message.

### POST /api/webhook/symbol-analysis

Analyze one `EXCHANGE:SYMBOL` with TradingView MCP and return the Spanish report plus decision-ready data without sending notifications or placing orders.

**Request (JSON):**
```json
{
  "symbol": "BINANCE:BTCUSDT",
  "timeframe": "1D",
  "analysisMode": "combined",
  "includeMultiTimeframe": true
}
```

The response includes `alertText`, normalized price/volume/indicator/signal/assessment data, sentiment/news/confluence and multi-timeframe results when requested, plus directional `risk` and `decision` metadata. `decision.action` is `BUY` or `SELL` only when the data and risk levels are sufficient; otherwise it is `NO_TRADE`. This endpoint never delivers notifications or submits orders. Invalid symbols return `400 INVALID_REQUEST`, TradingView failures return `502 SYMBOL_ANALYSIS_FAILED`, and deadline expiry returns `504 SYMBOL_ANALYSIS_TIMEOUT`.

### POST /api/webhook/market-scanner-alert

Execute multiple market scanner tools on the TradingView MCP server (such as top gainers, top losers, volume breakout, smart volume, or Bollinger squeeze), generate a formatted technical summary report in Spanish, and send it through all enabled notification channels.

**Request (JSON):**
```json
{
  "exchange": "BINANCE",
  "timeframe": "4h",
  "scans": [
    "top_gainers",
    "top_losers",
    "volume_breakout_scanner",
    "smart_volume_scanner",
    "bollinger_scan"
  ],
  "limit": 5,
  "bbw_threshold": 0.05,
  "ranked": true,
  "includeMultiTimeframe": true
}
```

- `exchange`: (Optional) The exchange identifier to run scans against. Defaults to `MARKET_SCANNER_DEFAULT_EXCHANGE` or `BINANCE`.
- `timeframe`: (Optional) Interval for indicators (e.g. `5m`, `15m`, `1h`, `4h`, `1D`, `1W`, `1M`). Defaults to `TRADINGVIEW_MCP_DEFAULT_TIMEFRAME` or `4h`.
- `scans`: (Optional) Array of scan types to execute sequentially. Defaults to `['top_gainers', 'top_losers', 'volume_breakout_scanner']`.
- `limit`: (Optional) Max number of results per section (clamped to `[1, 20]`, default: `5`).
- `bbw_threshold`: (Optional) Bollinger Band Width threshold for the Bollinger squeeze scan (default: `0.05`).
- `ranked`: (Optional) Sort results by actionable trade quality and include numeric `score` plus non-empty `reason` in each `scanResults[].scores[]` entry (default: `false`).
- `includeMultiTimeframe`: (Optional) Fetch higher-timeframe alignment for each scanner candidate through TradingView MCP. Aligned candidates receive a default `+10` score modifier, counter-trend candidates receive a default `-10` modifier, and upstream failures leave the original scanner item unchanged (default: `false`). The alias `include_multi_timeframe` is also accepted.

**Response (JSON):**
```json
{
  "success": true,
  "alertText": "📡 *SCANNER DE MERCADO — Saturday 23/05/2026*\n...",
  "scanResults": [
    {
      "scan": "top_gainers",
      "status": "success",
      "itemCount": 1
    }
  ],
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    }
  ],
  "summary": {
    "totalScans": 1,
    "success": 1,
    "error": 0,
    "timeout": 0,
    "totalItems": 1,
    "delivered": 1
  },
  "timedOut": false,
  "includeMultiTimeframe": true,
  "timeoutMs": 90000,
  "requestId": "req-xyz789",
  "processingTimeMs": 1450
}
```

When `ranked` is `true`, each successful scan also includes structured scores:

```json
{
  "scan": "top_gainers",
  "status": "success",
  "itemCount": 1,
  "scores": [{ "symbol": "BTCUSDT", "score": 83, "reason": "+3.5% · RSI 62.0 · Vol 1.8x · HTF aligned +10", "trendConfluence": { "status": "aligned", "direction": "bullish", "confidence": 82, "adjustment": 10 } }]
}
```

### POST /api/webhook/alert

Send alert via webhook. Accepts either JSON or plain text.

Optional headers:
- `x-request-id`: Optional client-supplied correlation ID (1-128 printable ASCII characters). If omitted or invalid, a UUIDv4 is generated.
- `idempotency-key` / `x-idempotency-key`: Optional replay key for deduplicating retries.

Optional query param: `useTradingViewData=true` enables TradingView MCP technical enrichment for this request (requires `ENABLE_TRADINGVIEW_MCP_ENRICHMENT=true`).

**Request (JSON):**
```json
{
  "text": "BTC price is at $45,000 - breakout detected!"
}
```

**Request (Plain Text):**
```
Content-Type: text/plain

BTC price is at $45,000 - breakout detected!
```

**Response:**
```json
{
  "success": true,
  "requestId": "0d63f03b-d5a2-4a0b-928d-1959b8eb6a95",
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "123456"
    },
    {
      "channel": "whatsapp",
      "success": true,
      "messageId": "whatsapp-msg-id"
    }
  ],
  "enriched": false
}
```

### Asynchronous Jobs API

To run long-running technical analysis or market scans without hitting HTTP request limits or gateway timeouts (502/504), you can use the asynchronous jobs API. All endpoints require the `x-api-key` header to be configured.

#### POST /api/jobs/tradingview-analysis

Start a background analysis or scanner job.

**Request (JSON - Expanded Analysis):**
```json
{
  "type": "expanded-analysis",
  "symbols": ["BINANCE:BTCUSDT"],
  "timeframe": "1D",
  "includeMultiTimeframe": true
}
```

**Request (JSON - Market Scanner):**
```json
{
  "type": "market-scanner",
  "exchange": "BINANCE",
  "timeframe": "4h",
  "scans": ["top_gainers", "top_losers"],
  "limit": 5,
  "ranked": true,
  "includeMultiTimeframe": true
}
```

For market-scanner jobs, `ranked` and `includeMultiTimeframe` use the same scoring and fail-open higher-timeframe enrichment as the synchronous scanner endpoint. If the job deadline aborts enrichment after a scan completes, that scan is retained and only remaining scans are marked as timed out.

**Response (201 Created):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "status": "processing",
  "createdAt": "2026-05-25T01:30:00.000Z"
}
```

**Idempotency:** `POST /api/jobs/tradingview-analysis`, `POST /api/jobs/:jobId/retry`, and `POST /api/jobs/:jobId/retry-failed` accept an optional client-generated `idempotency-key` header. Matching concurrent or sequential requests replay the original response and `jobId`/`newJobId` without starting another worker. The first response sends `Idempotency-Replay: false`; a replay sends `Idempotency-Replay: true` and includes `"idempotencyReplayed": true` in the JSON response. `JOB_QUEUE_ACCEPTANCE_UNKNOWN` responses are also replayable and include the durable `jobId`, preventing a retry from creating a second queue item. Reusing a key with a different request fingerprint returns `409 IDEMPOTENCY_CONFLICT`. Requests without the header retain current behavior.

Example:
```http
POST /api/jobs/tradingview-analysis
idempotency-key: job-create-2026-07-26-001
```

The idempotency cache is in-memory, bounded, and retained for five minutes by default (`WEBHOOK_IDEMPOTENCY_TTL_MS` can override the TTL). Request fingerprints canonicalize nested object key order while preserving array order.

#### POST /api/jobs/:jobId/retry and /api/jobs/:jobId/retry-failed

Retry a cancelled/failed job or only its failed items. Supply the same `idempotency-key` when retrying a request after a timeout or lost response to receive the original `newJobId` instead of creating another background job.

When `callbackUrl` is configured, each callback POST includes:

- `x-callback-timestamp` - ISO-8601 delivery timestamp; reject stale values outside your freshness window.
- `x-callback-event` - job event (`processing`, `completed`, `failed`, `cancelled`, or `timed_out`).
- `x-callback-delivery-id` - UUID unique to this HTTP delivery attempt; use it for deduplication.
- `x-callback-signature` - included when `callbackSecret` or `JOB_CALLBACK_SIGNING_SECRET` is configured.

Before each delivery attempt, hostname callback URLs are resolved with all current DNS answers. Any private answer blocks the callback (unless `ALLOW_PRIVATE_CALLBACKS=true`), and the connection is pinned to the validated answers so the subsequent fetch cannot perform a second hostname lookup and bypass the SSRF check. Redirects remain disabled with `redirect: 'error'`.

`ALLOW_HTTP_CALLBACKS` and `ALLOW_PRIVATE_CALLBACKS` are local/testing security overrides and should remain `false` in production. `JOB_CALLBACK_RETRY_DELAY_MS` defaults to `1000` ms; `JOB_CALLBACK_SIGNING_SECRET` is an optional server-side HMAC secret and must never be committed.

Verify the signature with HMAC-SHA256 over this exact canonical string, using the shared secret and the raw JSON request body:

```text
x-callback-timestamp + "\n" + x-callback-event + "\n" + x-callback-delivery-id + "\n" + raw-request-body
```

Retries generate a new delivery ID and signature for every attempt. The `callbackStatus.attempts` records include the same `deliveryId` for audit and deduplication.

#### GET /api/jobs

List recent sanitized jobs. The endpoint includes jobs from the in-memory repository and, when Firestore job storage is enabled, jobs persisted in `tradingviewJobs`. Expired terminal jobs are excluded.

**Query Parameters:**
- `status` - Optional: `pending`, `processing`, `completed`, `failed`, `cancelled`, or `timed_out`
- `type` - Optional: `expanded-analysis` or `market-scanner`
- `limit` - Integer between `1` and `100` (default: `50`)

**Response (200 OK):**
```json
{
  "success": true,
  "jobs": [
    {
      "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
      "type": "expanded-analysis",
      "status": "completed",
      "progress": { "total": 1, "current": 1 },
      "createdAt": "2026-05-25T01:30:00.000Z",
      "updatedAt": "2026-05-25T01:30:12.000Z",
      "totalDurationMs": 12053
    }
  ]
}
```

#### GET /api/jobs/:jobId

Retrieve status, partial progress, final report, and delivery state of a job.
Jobs are retained in memory and, when Firestore job storage is enabled, persisted to the `tradingviewJobs` collection so status survives process restarts. Completed, failed, cancelled, and timed-out jobs are automatically evicted after 1 hour. Durable terminal documents receive an `expiresAt` timestamp based on `createdAt`; run `bash ops/configure-firestore-alert-retention.sh` once per Firebase project to backfill legacy terminal jobs and enable native TTL deletion for `tradingviewJobs`. Firestore TTL deletion is eventually consistent, while the API still filters expired jobs on reads.

For completed ranked market-scanner jobs, `scanResults[].scores[]` contains the structured `symbol`, numeric `score`, non-empty `reason`, and optional `trendConfluence` fields used by the alert report. This is also included in configured terminal callback payloads.

Set `ENABLE_FIRESTORE_JOB_STORAGE=true` plus the normal Firebase Admin credentials (`FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS`) to enable durable job storage. The legacy in-memory path remains the fallback when Firestore is disabled or unavailable.

By default, jobs still execute in-process (`JOB_EXECUTION_MODE=local`). With `JOB_EXECUTION_MODE=render-worker` (BullMQ + Redis) or `JOB_EXECUTION_MODE=firestore-poller` (direct Firestore polling), the web service stores sanitized job metadata in Firestore and enqueues/persists the job for the dedicated `pnpm run start-worker` process. The worker claims eligible queued jobs transactionally, periodically reconciles durable rows still marked `processing`/`queued` plus expired `claimed`/`running` leases, renews its lease at persistence checkpoints, and drains active work on `SIGTERM`. Notification delivery is checkpointed durably before and after the external send; a redelivery with an unknown outcome fails closed as `JOB_DELIVERY_RECONCILIATION_REQUIRED` rather than sending the same alert twice. Missing Redis (in `render-worker` mode) or durable Firestore storage fails the create request with `503 JOB_QUEUE_UNAVAILABLE`.

**Response (200 OK - Processing):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "type": "expanded-analysis",
  "status": "processing",
  "progress": {
    "total": 2,
    "current": 1,
    "status": "Analyzing symbol BINANCE:BTCUSDT (1/2)"
  },
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 65430,
      "rsi": 43.5
    }
  ],
  "createdAt": "2026-05-25T01:30:00.000Z",
  "updatedAt": "2026-05-25T01:30:05.000Z",
  "totalDurationMs": 5123
}
```

### Stored Alerts API

When `ENABLE_FIRESTORE_ALERT_STORAGE=true`, successful `POST /api/webhook/alert`, news-monitor deliveries, and delivered `POST /api/webhook/market-scanner-alert` / `POST /api/webhook/expanded-analysis-alert` reports are persisted to Firestore and can be inspected through the protected alerts read API. Each stored record carries a `source` field of one of `webhook`, `news-monitor`, `market-scanner`, or `expanded-analysis`. Stored alert text is capped at 20,000 characters; when clipped, the record exposes `truncated: true` and `originalLength` so the read API, export, and replay can flag the loss — `replay` will redeliver the truncated text only.

Stored `alerts` and `alertReplays` records default to 90 days of retention. The service filters expired records before list, detail, export, and summary responses while Firestore's native TTL deletion is eventual. New records carry an `expiresAt` timestamp; `bash ops/configure-firestore-alert-retention.sh` backfills legacy records from `receivedAt`/`replayedAt` before enabling both TTL policies, shortens existing expiries when the configured deadline is earlier, removes legacy raw replay idempotency keys after hashing them, reports scanned/updated/skipped counts, and fails if a record has no usable timestamp. Replay audit documents retain only a SHA-256 `idempotencyKeyHash`, never the raw key. Inspect the TTL policies with `gcloud firestore fields ttls list`.

All endpoints below require the same `x-api-key` header used by the webhook routes.
If alert storage is enabled but Firestore credentials/project access are unavailable, they return `503 STORAGE_UNAVAILABLE` instead of a generic `500`.

#### GET /api/alerts

List stored alerts ordered by `receivedAt` descending.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `source` - Optional source filter. Valid values include `webhook`, `news-monitor`, `market-scanner`, and `expanded-analysis`.
- `enriched` - Optional boolean filter (`true` or `false`)
- `include` - Optional projection filter. Allowed value: `enrichment_summary`. When set, each returned alert item includes a sanitized `enrichmentSummary` projection object (with `sentiment`, `sentiment_score`, `setup_type`, `invalidation_level`, `target_level`, `risk_reward_ratio`, `sourceCount`, `sourceDomains`, `tradingViewEnrichmentApplied`, `tradingViewEnrichmentStatus`, and `promptProvenance`) and a sanitized `enrichmentData` payload without requiring N+1 detail fetches.

**Response (200 OK):**
```json
{
  "success": true,
  "alerts": [
    {
      "id": "alert-1",
      "receivedAt": "2026-06-06T12:00:00.000Z",
      "text": "BTC alert",
      "enriched": true,
      "enrichmentData": {
        "sentiment": "bullish"
      },
      "tokenUsage": {
        "totalTokens": 42
      },
      "deliveryResults": [
        {
          "channel": "telegram",
          "success": true
        }
      ],
      "source": "webhook",
      "useTradingViewData": false,
      "tradingViewEnrichmentApplied": false
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": "eyJ2IjoxLCJyZWNlaXZlZEF0IjoiMjAyNi0wNi0wNlQxMjowMDowMC4wMDBaIiwiaWQiOiJhbGVydC0xIn0"
  }
}
```

#### GET /api/alerts/export

Export bounded stored alerts as JSONL or CSV. CSV serialization prefixes string fields whose leading control characters (`tab`/`LF`/`CR`) are followed by `=`, `+`, `-`, or `@`—or that begin directly with those markers—with an apostrophe so spreadsheet clients treat them as inert text; finite numeric strings such as `-42` remain unchanged. JSONL output is unchanged.

**Query Parameters:**
- `format` - `jsonl` or `csv` (default: `jsonl`)
- `from` / `to` - Required bounded ISO-8601 timestamps
- `limit` - Integer between `1` and `1000` (default: `500`)
- `source` / `enriched` - Optional filters
- `includeText` - Optional boolean; raw alert text is excluded unless `true`

#### GET /api/alerts/summary

Return bounded JSON-only analytics for stored alerts without exposing raw alert text or credentials.

Each enriched alert records only safe prompt provenance (`name`, `source`, `label`, and `version`) when a prompt was resolved. The `enrichment.riskMetadataCoverage` block uses enriched alerts as its denominator and reports populated counts/percentages for `invalidation_level`, `target_level`, `setup_type`, and `risk_reward_ratio`. `byPromptProvenance` groups the same metrics by Langfuse/local provenance; legacy records without provenance use `null`. Missing or invalid optional values remain zero coverage and are never synthesized.

Similarly, `enrichment.evidenceCoverage` tracks whether enriched alerts cited grounding sources, reporting `zeroSources`, `oneToTwoSources`, and `threePlusSources` distribution along with `averageSourceCount`, overall and grouped `byPromptProvenance`.

**Query Parameters:**
- `from` - Optional ISO-8601 lower bound; defaults to 24 hours before `to`
- `to` - Optional ISO-8601 upper bound; defaults to request time
- `limit` - Integer between `1` and `1000` (default: `500`)

The service caps the queried window at 31 days to keep routine operator usage cheap.

**Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "window": {
      "from": "2026-06-06T00:00:00.000Z",
      "to": "2026-06-07T00:00:00.000Z",
      "limit": 500,
      "maxDays": 31
    },
    "totalAlerts": 2,
    "bySource": {
      "webhook": 2
    },
    "bySymbol": {
      "BTCUSDT": 1,
      "ETHUSDT": 1
    },
    "byFeatureFlag": {
      "enriched": 1,
      "plain": 1,
      "tradingViewData": 1,
      "tradingViewDataApplied": 1,
      "withoutTradingViewData": 1
    },
    "enrichment": {
      "enrichedAlerts": 1,
      "plainAlerts": 1,
      "tradingViewStatusCounts": {
        "full": 0,
        "partial": 0,
        "failed": 0,
        "not_applicable": 1,
        "unrecorded": 1
      },
      "riskMetadataCoverage": {
        "denominator": 1,
        "fields": {
          "invalidation_level": { "populated": 0, "percentage": 0 },
          "target_level": { "populated": 0, "percentage": 0 },
          "setup_type": { "populated": 0, "percentage": 0 },
          "risk_reward_ratio": { "populated": 0, "percentage": 0 }
        },
        "byPromptProvenance": [
          {
            "provenance": null,
            "denominator": 1,
            "fields": {
              "invalidation_level": { "populated": 0, "percentage": 0 },
              "target_level": { "populated": 0, "percentage": 0 },
              "setup_type": { "populated": 0, "percentage": 0 },
              "risk_reward_ratio": { "populated": 0, "percentage": 0 }
            }
          }
        ]
      },
      "evidenceCoverage": {
        "denominator": 1,
        "zeroSources": { "populated": 1, "percentage": 100 },
        "oneToTwoSources": { "populated": 0, "percentage": 0 },
        "threePlusSources": { "populated": 0, "percentage": 0 },
        "totalSourceCount": 0,
        "averageSourceCount": 0,
        "byPromptProvenance": [
          {
            "provenance": null,
            "denominator": 1,
            "zeroSources": { "populated": 1, "percentage": 100 },
            "oneToTwoSources": { "populated": 0, "percentage": 0 },
            "threePlusSources": { "populated": 0, "percentage": 0 },
            "totalSourceCount": 0,
            "averageSourceCount": 0
          }
        ]
      },
      "tokenUsage": {
        "inputTokens": 10,
        "outputTokens": 20,
        "totalTokens": 30,
        "totalCost": 0.001
      }
    },
    "delivery": {
      "totalSuccess": 2,
      "totalFailure": 1,
      "byChannel": {
        "telegram": {
          "total": 2,
          "success": 1,
          "failure": 1
        },
        "whatsapp": {
          "total": 1,
          "success": 1,
          "failure": 0
        }
      }
    },
    "latency": {
      "averageProcessingMs": 250,
      "averageDeliveryMs": 150
    }
  }
}
```

For rollout validation, first verify the active prompt provenance and coverage in preview, then observe a bounded production/shadow window after aligning the remote `alert-enrichment` prompt with the local optional-risk schema. Treat missing fields as unavailable data; do not use zero coverage as a trading outcome or fabricate stops, targets, setup types, or R:R values.

#### GET /api/alerts/replays

List bounded alert-replay audit records from the Firestore `alertReplays` collection, ordered by `replayedAt` descending. Each `POST /api/alerts/{alertId}/replay` writes a unique audit document so retries with the same idempotency key are preserved as history instead of overwriting prior attempts; the HTTP `Idempotency-Replay` contract remains upstream of storage. Raw idempotency keys are never stored or returned — only a SHA-256 hash prefix is exposed.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either a legacy ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `alertId` - Optional stored alert id to scope replays to a single document

**Response (200 OK):**
```json
{
  "success": true,
  "replays": [
    {
      "id": "1700000000000_<uuid>",
      "alertId": "alert-1",
      "idempotencyKeyHashPrefix": "06bdeddf2a29",
      "attemptId": "1700000000000_<uuid>",
      "channels": ["telegram"],
      "deliverySummary": [
        { "channel": "telegram", "success": true, "messageId": "tg-1" }
      ],
      "replayedAt": "2026-06-06T12:34:56.000Z"
    }
  ],
  "pagination": {
    "hasMore": false,
    "limit": 50,
    "nextBefore": null
  }
}
```

The same `403 FEATURE_DISABLED` (when `ENABLE_FIRESTORE_ALERT_STORAGE=false`) and `503 STORAGE_UNAVAILABLE` mapping as the sibling endpoints applies.

#### GET /api/alerts/:alertId

Retrieve a single stored alert by Firestore document ID. The response also surfaces `lastReplay` — the most recent `alertReplays` entry for the alert, or `null` if none has been recorded.

**Response (200 OK):**
```json
{
  "success": true,
  "alert": {
    "id": "alert-123",
    "receivedAt": "2026-06-06T10:30:00.000Z",
    "text": "Stored alert",
    "enriched": false,
    "enrichmentData": null,
    "tokenUsage": null,
    "deliveryResults": [],
    "source": "webhook",
    "useTradingViewData": true,
    "tradingViewEnrichmentApplied": false
  },
  "lastReplay": {
    "id": "1700000000000_<uuid>",
    "alertId": "alert-123",
    "idempotencyKeyHashPrefix": "06bdeddf2a29",
    "attemptId": "1700000000000_<uuid>",
    "channels": ["telegram"],
    "deliverySummary": [
      { "channel": "telegram", "success": true, "messageId": "tg-1" }
    ],
    "replayedAt": "2026-06-06T12:34:56.000Z"
  }
}
```

**Response (200 OK - Completed):**
```json
{
  "success": true,
  "jobId": "8f8ef192-349f-4318-8547-0e6d628bf739",
  "type": "expanded-analysis",
  "status": "completed",
  "progress": {
    "total": 1,
    "current": 1,
    "status": "Completed analysis"
  },
  "results": [
    {
      "symbol": "BINANCE:BTCUSDT",
      "status": "analyzed",
      "price": 65430,
      "rsi": 43.5
    }
  ],
  "alertText": "📊 *ANÁLISIS AMPLIADO — Monday 25/05/2026*...",
  "deliveryResults": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "987654"
    }
  ],
  "summary": {
    "total": 1,
    "analyzed": 1,
    "error": 0,
    "delivered": 1
  },
  "createdAt": "2026-05-25T01:30:00.000Z",
  "updatedAt": "2026-05-25T01:30:12.000Z",
  "totalDurationMs": 12053
}
```

### Signal Outcomes (CB-199)

#### GET /api/outcomes

Query durably recorded signal outcomes record-by-record with pagination and filtering by symbol, exchange, status, window, and date range. Requires `x-api-key` header (or `api-key` query parameter) or Firebase Bearer token with `admin.viewer` or `admin.operator` role. Returns `403 FEATURE_DISABLED` if `ENABLE_SIGNAL_OUTCOME_TRACKING !== 'true'`, and `503 STORAGE_UNAVAILABLE` if Firestore is enabled but inaccessible.

**Query Parameters:**
- `limit` - Integer between `1` and `100` (default: `50`)
- `before` - Either an ISO-8601 timestamp cursor or the opaque `nextBefore` token from a previous response
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `status` - Filter by evaluation status (`pending`, `evaluated`, `unavailable`)
- `window` - Filter by measurement window (`1h`, `4h`, `1D`, `1W`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "outcomes": [
    {
      "id": "outcome-doc-1",
      "receivedAt": "2026-08-23T12:00:00.000Z",
      "requestId": "req-1",
      "source": "news-monitor",
      "symbol": "BTCUSDT",
      "exchange": "BINANCE",
      "assetClass": "crypto",
      "timeframe": "1h",
      "setupType": "breakout",
      "score": 0.9,
      "side": "BUY",
      "price": 65000,
      "entryPriceSource": "tradingview-mcp",
      "stop": 63000,
      "target": 68000,
      "marketDataProvider": "binance",
      "eligibilityState": "supported_provider",
      "eligibilityReason": null,
      "outcomeEvaluated": true,
      "outcomes": {
        "1h": {
          "status": "evaluated",
          "reason": null,
          "targetTime": "2026-08-23T13:00:00.000Z",
          "price": 66000,
          "return": 1.5385,
          "maxFavorableExcursion": 2.0,
          "maxAdverseExcursion": -0.2,
          "firstHit": null,
          "targetHit": false,
          "stopHit": false,
          "firstHitTime": null,
          "rMultiple": 0.5
        }
      },
      "sources": [],
      "tokenUsage": {
        "inputTokens": 100,
        "outputTokens": 40,
        "totalTokens": 140,
        "totalCost": 0.00003
      },
      "processingTimeMs": 150
    }
  ],
  "pagination": {
    "limit": 50,
    "hasMore": false,
    "nextBefore": null
  }
}
```

#### GET /api/outcomes/summary

Query aggregated performance and coverage metrics for recorded signal outcomes, with optional filtering by symbol, exchange, status, window, and date range. When no outcomes match the filters or tracking is enabled with an empty dataset, the endpoint returns `200 OK` with `available: false` and a typed empty summary structure. Requires `x-api-key` header (or `api-key` query parameter) or Firebase Bearer token with `admin.viewer` or `admin.operator` role.

**Query Parameters:**
- `limit` - Maximum number of recent outcomes to aggregate (integer between `1` and `100`, default: `50`)
- `symbol` - Filter by trading symbol (e.g. `BTCUSDT` or `BINANCE:BTCUSDT`)
- `exchange` - Filter by exchange identifier (e.g. `BINANCE`, `NASDAQ`)
- `status` - Filter by evaluation status (`pending`, `evaluated`, `unavailable`)
- `window` - Filter by measurement window (`1h`, `4h`, `1D`, `1W`)
- `from` - Optional ISO-8601 lower bound timestamp
- `to` - Optional ISO-8601 upper bound timestamp

**Response (200 OK):**
```json
{
  "success": true,
  "summary": {
    "available": true,
    "totalSignalsReceived": 50,
    "totalSignalsEligible": 45,
    "totalSignalsEvaluated": 40,
    "totalSignalsPending": 5,
    "totalSignalsUnavailable": 5,
    "coveragePercent": 80,
    "isCoverageComplete": false,
    "targetHitRatePercent": 65.5,
    "stopHitRatePercent": 25,
    "expectancyR": 1.25,
    "populationNote": "Metrics represent 40 evaluated signals out of 50 total received signals (80% coverage).",
    "exchangeBreakdown": {
      "BINANCE": {
        "received": 40,
        "eligible": 40,
        "evaluated": 35,
        "pending": 3,
        "unavailable": 2
      }
    },
    "providerBreakdown": {
      "binance": {
        "received": 40,
        "eligible": 40,
        "evaluated": 35,
        "pending": 3,
        "unavailable": 2
      }
    },
    "entryPriceSourceBreakdown": {
      "tradingview-mcp": 40
    },
    "eligibilityBreakdown": {
      "supported_provider": 45
    },
    "windows": {
      "1h": {
        "totalSignals": 35,
        "hitRatePercent": 60,
        "targetEligibleWindows": 30,
        "stopEligibleWindows": 30,
        "targetHitRatePercent": 55,
        "stopHitRatePercent": 20,
        "expectancyR": 0.85,
        "averageReturnPercent": 2.15,
        "averageMfePercent": 3.45,
        "averageMaePercent": -1.1,
        "maxAdverseExcursionPercent": -4.5
      }
    },
    "drawdownProxy": {
      "averageMaxAdverseExcursionPercent": -1.85,
      "absoluteMaxAdverseExcursionPercent": -7.2
    },
    "falsePositiveCandidatesCount": 0,
    "falsePositiveCandidates": [],
    "latencyCostMetadata": {
      "averageProcessingTimeMs": 450,
      "tokenUsage": {
        "inputTokens": 1200,
        "outputTokens": 400,
        "totalCost": 0.0035
      }
    }
  }
}
```

## Multi-Channel Alerts (002)

The alert webhook system supports simultaneous delivery to multiple channels (Telegram, WhatsApp, and Discord) with independent retry logic and graceful degradation.

### Supported Channels

#### Telegram (Default)

- **Enabled by**: `ENABLE_TELEGRAM_BOT=true` + valid `BOT_TOKEN` and `TELEGRAM_CHAT_ID`
- **Format**: MarkdownV2 with special character escaping
- **Timeout**: ~10 seconds per delivery
- **Retry**: Rate limits (HTTP 429) retried up to 2 additional times (3 total attempts) with `Retry-After` parameter backoff and total wait budget caps
- **Forum Topics (`message_thread_id`)**: Route alerts automatically into forum topics by category/source via `TELEGRAM_TOPIC_ROUTES` or explicitly per request via `telegramThreadId` (set `0` to target the General topic). Precedence: explicit request payload `telegramThreadId` > `TELEGRAM_TOPIC_ROUTES[category]` > `TELEGRAM_TOPIC_ROUTES.default` > General topic.

#### WhatsApp (Optional)

- **Enabled by**: `ENABLE_WHATSAPP_ALERTS=true` + GreenAPI credentials
- **Format**: WhatsApp markdown (bold, italic, strikethrough, code blocks, lists)
- **Timeout**: ~10 seconds per delivery  
- **Retry**: 3 attempts with exponential backoff (1s → 2s → 4s) per chunk
- **Message Size**: Payloads exceeding 20,000 characters are automatically split into sequential chunks that each deliver and retry independently (no ellipsis truncation)
- **Provider**: GreenAPI (REST API via native fetch)

#### Discord (Optional)

- **Enabled by**: `ENABLE_DISCORD_ALERTS=true` + valid `DISCORD_WEBHOOK_URL`
- **Format**: Plain Discord webhook content with Markdown-friendly text
- **Timeout**: ~10 seconds per delivery
- **Retry**: Rate limits (HTTP 429) retried up to `DISCORD_MAX_RETRIES` additional attempts (default: `2`) using `Retry-After` backoff bounded by `DISCORD_FALLBACK_RETRY_DELAY_MS`, `DISCORD_MAX_RETRY_DELAY_MS`, and `DISCORD_MAX_TOTAL_RETRY_WAIT_MS`
- **Message Size**: Payloads exceeding 2,000 characters are automatically split into sequential chunks that each deliver and retry independently
- **Provider**: Discord webhook execute endpoint via native `fetch`

### Channel-Specific Formatting

**Telegram (MarkdownV2)**:
- Escapes special characters: `_ * [ ] ( ) ~ ` > # + - = | { } . !`
- Preserves hyperlinks
- Supports inline code, code blocks, and bold/italic text

**WhatsApp**:
- Converts unsupported Telegram syntax to WhatsApp equivalents
- Strips links (displayed as plain text)
- Supports bold (`*text*`), italic (`_text_`), strikethrough (`~text~`)
- Supports code blocks with triple backticks
- Supports lists with asterisk or hyphen

**Discord**:
- Sends webhook `content` payloads over native `fetch`
- Reuses the plain-text/Markdown-friendly formatting path
- Works with direct routing via `channels: ["discord"]`

### URL Shortening for WhatsApp

When a supported URL-shortening service is configured, URLs in WhatsApp alerts are automatically shortened to reduce character count and improve readability.

**Features**:
- **Automatic Detection**: Identifies HTTP/HTTPS URLs in alert text
- **Shortened URLs**: Converts long URLs (e.g., `https://example.com/very/long/path?param=value`) to a provider link
- **Session-Scoped Cache**: Caches shortenings during request processing to avoid redundant API calls (1-hour TTL per session)
- **Parallel Shortening**: Multiple URLs shortened concurrently
- **Fallback Behavior**: If shortening fails or is disabled, original URLs are preserved
- **Graceful Degradation**: Shortening errors don't block alert delivery

**How It Works**:
1. Alert received with one or more URLs
2. URLShortener detects and extracts URLs when a supported provider is configured
3. Checks session cache for previously shortened URLs
4. Calls the selected provider for new URLs
5. Replaces original URLs with shortened versions in alert text
6. Alert delivered to WhatsApp (and other channels) with shortened URLs

**Configuration**:
- Set `URL_SHORTENER_SERVICE=picsee` with `PICSEE_API_KEY`, `URL_SHORTENER_SERVICE=cuttly` with `CUTTLY_API_KEY`, or select `tinyurl` without a credential
- Optional: URLs only shortened for WhatsApp; other channels receive original URLs
- Cache per session: TTL 1 hour; cleared after request completes or session ends

**Example**:

**Before** (158 characters):
```
Sources: 
- https://example.com/research/crypto/bitcoin/technical-analysis?date=2024-01-15&symbol=BTCUSDT&period=4h&includeIndicators=true
```

**After** (with URL shortening):
```
Sources: 
- https://short.url/crypto-analysis
```

### Delivery Behavior

**Parallel Sending**: Alerts sent to all enabled channels simultaneously without blocking

**Independent Retry**: Each channel retries independently
- Channel A failure doesn't affect Channel B
- WhatsApp retries transient provider failures up to 3 attempts with exponential backoff (1s → 2s → 4s, ±10% jitter) per chunk
- Discord retries 429 rate-limit responses with up to `DISCORD_MAX_RETRIES` additional attempts (default: `2`, up to 3 total attempts) per chunk using `Retry-After` backoff bounded by `DISCORD_MAX_TOTAL_RETRY_WAIT_MS`
- Telegram retries 429 rate-limit responses up to 2 times

**Message Chunking**: Payloads exceeding provider length limits (20,000 characters for WhatsApp, 2,000 characters for Discord) are automatically split into sequential chunks that deliver and retry independently; earlier delivered chunks are preserved if a later chunk fails.

**Graceful Degradation**: If one channel fails
- Other channels still receive the alert
- Response includes per-channel results
- HTTP 200 OK returned (fail-open pattern)
- Failures logged at WARN/ERROR level
- If `channels` is omitted in the generic message webhook, delivery fans out to every enabled channel

**Example - Dual Channel Delivery**:

```bash
# Alert sent to both Telegram and WhatsApp
curl -X POST https://your-domain/api/webhook/alert \
  -H "Content-Type: application/json" \
  -d '{
    "text": "BTCUSDT: Price surge to $45,000 detected!"
  }'

# Response shows both channels received the message
{
  "success": true,
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "12345",
      "attemptCount": 1,
      "durationMs": 450
    },
    {
      "channel": "whatsapp",
      "success": true,
      "messageId": "msg-uuid-123",
      "attemptCount": 1,
      "durationMs": 320
    }
  ],
  "enriched": false
}
```

**Example - Partial Failure (WhatsApp Down)**:

```json
{
  "success": false,
  "results": [
    {
      "channel": "telegram",
      "success": true,
      "messageId": "12345",
      "attemptCount": 1,
      "durationMs": 450
    },
    {
      "channel": "whatsapp",
      "success": false,
      "error": "API timeout after 3 retries",
      "attemptCount": 3,
      "durationMs": 7800
    }
  ],
  "enriched": false
}
```

### Configuration for Multi-Channel

```bash
# Telegram (required only when the Telegram bot is enabled outside PR previews)
ENABLE_TELEGRAM_BOT=true
BOT_TOKEN=your_telegram_token
TELEGRAM_CHAT_ID=-1001234567890

# WhatsApp (optional)
ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107356806/
WHATSAPP_API_KEY=your_greenapi_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Discord (optional)
ENABLE_DISCORD_ALERTS=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>

# Optional enrichment (applies to all channels)
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=your_google_ai_studio_api_key
```

### Troubleshooting Multi-Channel Delivery

**Multiple channels failing**:
1. Verify network connectivity from server
2. If `ENABLE_TELEGRAM_BOT=true`, check BOT_TOKEN validity (Telegram)
3. Check GreenAPI credentials and account status (WhatsApp)
4. Verify `DISCORD_WEBHOOK_URL` is still valid and not revoked (Discord)
5. Review application logs for detailed error messages

**API-only or WhatsApp-only startup**:
1. Set `ENABLE_TELEGRAM_BOT=false`
2. Omit `BOT_TOKEN` if Telegram is intentionally disabled
3. Keep using `/api` routes and non-Telegram channels normally

**WhatsApp not sending**:
1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_CHAT_ID` format (should be `120363xxxxx@g.us`)
3. Verify GreenAPI account is active
4. Test API directly: `curl -X POST https://api.green-api.com/test`

**Discord not sending**:
1. Verify `ENABLE_DISCORD_ALERTS=true`
2. Check `DISCORD_WEBHOOK_URL` format and channel permissions
3. Confirm the webhook has not been deleted or regenerated in Discord

**Message size & chunking**:
- Payloads exceeding provider limits (20,000 characters for WhatsApp, 2,000 characters for Discord) are automatically split into sequential chunks and delivered in order rather than truncated.
- Each chunk retries independently. If a later chunk fails, earlier chunks remain delivered; for WhatsApp, the error response also identifies the failed chunk (`failedPart` and `splitMessageCount`).
- Use MarkdownV2 / concise formatting or summarize via Gemini enrichment to keep alerts within a single chunk when preferred.

**Retry exhaustion**:
- If all retries fail for a channel, the channel failure is recorded in the alert response and logged without blocking other channels.
- Discord and Telegram retry rate limits (HTTP 429) up to their configured max retries and total wait budget.
- WhatsApp retries transient provider errors up to 3 attempts per chunk.

## Commands

### /help, /start

Display the list of available Telegram bot commands, argument syntax, and aliases formatted in MarkdownV2.

**Example:**
```
/help
```

### /precio `<symbol>`

Get real-time price for crypto pairs (Binance) or equities/stocks (Twelve Data).

**Examples:**
```
/precio BTCUSDT
/precio NVDA
/precio NASDAQ:AAPL
```

**Responses:**
```
Precio de BTCUSDT es 65000
Precio de NVDA es 125.50 (+2.32%)
```

### /cryptobot id

Telegram bot utility command to get current Telegram chat ID.

**Example:**
```
/cryptobot id
```

### /analisis `<symbols>` (alias: `/analysis`)

Create a TradingView technical analysis background job.

**Example:**
```
/analisis BINANCE:BTCUSDT,NASDAQ:NVDA timeframe=1D mtf=true
```

### /scanner `[options]`

Create a TradingView market scanner background job (`top_gainers`, `top_losers`, `breakouts`).

**Example:**
```
/scanner scans=top_gainers,top_losers exchange=BINANCE timeframe=4h limit=10
```

### /jobs `[jobId]` (alias: `/trabajos`)

List recent TradingView jobs or inspect one job's progress, terminal status, compact result summary, and notification delivery state. Expired terminal jobs are reported as unavailable.

**Examples:**
```
/jobs
/jobs 4f0c2f2e-7e6b-4c4c-8f9a-2e1a3c4b5d6e
```

### /noticias `[options]` (alias: `/news`)

Run the news monitor and AI sentiment analysis.

**Example:**
```
/noticias crypto=BTCUSDT,ETHUSDT stocks=NVDA
```

## Runtime Error Monitoring (005-sentry-runtime-errors)

**📖 [Quickstart Guide](specs/005-sentry-runtime-errors/quickstart.md)** — Complete setup and verification instructions.

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

## News Monitoring & Event Detection

**📖 [Full Quickstart Guide](specs/003-news-monitor/quickstart.md)** — Complete setup instructions, API reference, and advanced configuration.

**🔄 [Scheduled Monitoring Example](.github/workflows/news-monitor-cron.yml.example)** — GitHub Actions workflow for periodic symbol analysis.

The news monitoring feature analyzes financial news and market sentiment to detect significant trading events automatically. When enabled, it provides real-time alerts about:

- **Price Surges** (>5% gains): Triggered by positive news, bullish sentiment, and significant price movements
- **Price Declines** (>5% losses): Triggered by negative news, bearish sentiment, and significant downturns
- **Public Figure Mentions**: Detects statements from influential personalities affecting asset prices
- **Regulatory Announcements**: Identifies official statements and regulatory changes

### Confidence Scoring

Each alert receives a confidence score (0.0-1.0) using the formula:
```
confidence = (0.6 × event_significance + 0.4 × |sentiment_score|)
```

Where:
- **event_significance** (0.0-1.0): Based on price movement magnitude, source credibility, and mention frequency
- **sentiment_score** (-1.0 to +1.0): Extracted from news articles (-1.0 = bearish, +1.0 = bullish)

Only alerts meeting `NEWS_ALERT_THRESHOLD` (default: 0.7) are sent to channels.

### Deduplication Strategy

The system prevents alert fatigue using an intelligent cache:
- **Cache Key**: `(symbol, event_category)` tuple
- **TTL**: 6 hours by default (configurable via `NEWS_CACHE_TTL_HOURS`)
- **Behavior**: Same event category for the same symbol within TTL is cached; different categories generate separate alerts
- **Example**: BTCUSDT receives one "price_surge" alert at 10:00; calling the endpoint at 11:00 returns cached result. But a "regulatory" alert for BTCUSDT at 11:30 generates a new alert (different category).
- **Enrichment Cache**: When secondary LLM enrichment is enabled (`ENABLE_LLM_ALERT_ENRICHMENT=true`), both primary analysis results AND enrichment results are cached under the same `(symbol, event_category)` key with the same TTL. This prevents redundant Gemini and LLM API calls for duplicate events. If enrichment fails, the original Gemini analysis is cached, and enrichment is not re-attempted until the cache entry expires.

### Timeout Strategy

- **Binance (crypto prices)**: ~5 seconds (aggressive)
- **Gemini (news analysis)**: ~20 seconds (fallback)
- **Optional LLM Enrichment**: ~10 seconds per symbol
- **Per-symbol Total**: 30 seconds (accounts for retry scenarios)
- **Batch Response**: Returns partial results if some symbols timeout

## Running Tests

```bash
# Run all tests
pnpm test

# Run with watch mode
pnpm test:watch

# Generate coverage report
pnpm test:coverage

# Run the opt-in Firestore emulator integration suite
pnpm test:firebase
```

## Architecture

### Notification Services

- **NotificationChannel**: Abstract base class for notification channels
- **TelegramService**: Implements Telegram delivery via Telegraf bot
- **WhatsAppService**: Implements WhatsApp delivery via GreenAPI
- **NotificationManager**: Orchestrates sending to multiple channels in parallel

### News Monitoring Services

- **NewsMonitor Controller** (`src/controllers/webhooks/handlers/newsMonitor/newsMonitor.js`): HTTP endpoint handler
- **Analyzer** (`src/controllers/webhooks/handlers/newsMonitor/analyzer.js`): Symbol analysis orchestrator with parallel processing
- **Cache** (`src/controllers/webhooks/handlers/newsMonitor/cache.js`): In-memory deduplication cache with TTL enforcement
- **Enrichment Service** (`src/services/inference/enrichmentService.js`): Optional secondary LLM for confidence refinement

### Grounding Services

- **Gemini Grounding** (`src/services/grounding/`): Reusable Gemini API integration for news sentiment analysis
- **Confidence Scoring**: Weighted formula combining event significance and sentiment
- **Event Detection**: Price surge, price decline, public figure mentions, regulatory announcements

### Supporting Utilities

- **retryHelper**: Exponential backoff retry logic (1s → 2s → 4s)
- **messageHelper**: Message chunking (`splitMessageIntoChunks`) and formatting utilities
- **MarkdownV2Formatter**: Telegram MarkdownV2 text escaping
- **WhatsAppMarkdownFormatter**: WhatsApp markdown conversion
- **PromptService** (`src/services/prompts/`): Centralized runtime prompt registry with Langfuse fetch + local file-based fallback behavior

### Alert Processing (News Monitor)

1. **Request Received** → Validate crypto/stock symbol arrays
2. **Parallel Analysis** → Analyze each symbol concurrently (30s timeout per symbol)
3. **Gemini Extraction** → Detect market sentiment and event categories
4. **Confidence Scoring** → Calculate alert confidence using weighted formula
5. **Optional Enrichment** → Secondary LLM refines confidence (if enabled)
6. **Threshold Filtering** → Only alerts meeting `NEWS_ALERT_THRESHOLD` proceed
7. **Deduplication** → Check cache for duplicate (symbol, event_category) pairs
8. **Multi-Channel Sending** → Send to all enabled channels in parallel
9. **Retry Logic** → Each channel retries independently with exponential backoff
10. **Response** → Return 200 OK with per-symbol results and metadata

### Alert Processing (Traditional Webhook)

1. **Webhook Received** → Validate alert text
2. **Optional Enrichment** → Gemini grounding (if enabled)
3. **Multi-Channel Sending** → Send to all enabled channels in parallel
4. **Retry Logic** → Each channel retries independently with backoff
5. **Response** → Return 200 OK with per-channel results

## Configuration Examples

### Telegram Only (Default)

```bash
BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=-1001234567890
ENABLE_TELEGRAM_BOT=true
```

### Telegram + WhatsApp

```bash
BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=telegram_chat_id
ENABLE_TELEGRAM_BOT=true

ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=your_whatsapp_api_url
WHATSAPP_API_KEY=your_whatsapp_api_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Optional: Enable URL shortening for WhatsApp
URL_SHORTENER_SERVICE=picsee
PICSEE_API_KEY=your_picsee_api_key
```

### With WhatsApp + URL Shortening

```bash
BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=telegram_chat_id
ENABLE_TELEGRAM_BOT=true

ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=your_whatsapp_api_url
WHATSAPP_API_KEY=your_whatsapp_api_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# URL shortening for WhatsApp (long URLs automatically shortened via PicSee)
URL_SHORTENER_SERVICE=picsee
PICSEE_API_KEY=your_picsee_api_key

# Alerts sent to both channels; WhatsApp receives shortened URLs
```

### With Gemini Enrichment

```bash
ENABLE_GEMINI_GROUNDING=true
GEMINI_API_KEY=your_google_ai_studio_api_key

# Alerts will be enriched with AI analysis before sending
```

### With Langfuse Prompt Management

```bash
ENABLE_LANGFUSE_PROMPTS=true
LANGFUSE_PUBLIC_KEY=pk-lf-your-public-key
LANGFUSE_SECRET_KEY=sk-lf-your-secret-key
LANGFUSE_BASE_URL=https://cloud.langfuse.com

# Use "latest" locally and "production" in deployed environments
LANGFUSE_PROMPT_LABEL=latest
LANGFUSE_PROMPT_CACHE_TTL_SECONDS=0
```

With this enabled, prompt edits can be shipped from Langfuse without redeploying the bot. If Langfuse is unavailable, the service falls back to the local prompt registry automatically.

### With News Monitoring (Gemini-only)

```bash
BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=telegram_chat_id
ENABLE_TELEGRAM_BOT=true

ENABLE_NEWS_MONITOR=true
GEMINI_API_KEY=your_google_ai_studio_api_key
NEWS_SYMBOLS_CRYPTO=BTCUSDT,ETHUSD,BNBUSDT
NEWS_SYMBOLS_STOCKS=NVDA,MSFT,AAPL
NEWS_ALERT_THRESHOLD=0.7

# External scheduler (GitHub Actions, Render cron) calls:
# curl -X POST https://your-domain/api/news-monitor \
#   -H "Content-Type: application/json" \
#   -d '{"crypto":["BTCUSDT"],"stocks":["NVDA"]}'
```

### With News Monitoring + Binance Integration

```bash
ENABLE_NEWS_MONITOR=true
ENABLE_BINANCE_PRICE_CHECK=true
NEWS_SYMBOLS_CRYPTO=BTCUSDT,ETHUSD

# Real-time crypto prices fetched from Binance (~5s timeout)
# Falls back to Gemini GoogleSearch if Binance unavailable
```

### With Optional Secondary LLM Enrichment

```bash
ENABLE_NEWS_MONITOR=true
ENABLE_LLM_ALERT_ENRICHMENT=true
AZURE_LLM_ENDPOINT=https://models.github.ai/inference
AZURE_LLM_KEY=your_github_personal_access_token
AZURE_LLM_MODEL=openai/gpt-5-mini

# Secondary LLM refines confidence using conservative strategy:
# enriched_confidence = min(gemini_confidence, llm_confidence)
# Prevents false positives from LLM hallucination
```

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

## Troubleshooting

### News Monitoring Issues

#### News Monitor Endpoint Not Responding

1. Verify `ENABLE_NEWS_MONITOR=true` in environment
2. Verify `GEMINI_API_KEY` is set (required for Gemini analysis)
3. Check application logs for `[NewsMonitor] Handler initialized` when news monitoring is enabled
4. Verify `/api/news-monitor` route is registered (check logs for route mounting)

#### News Alerts Not Sending

1. Verify `NEWS_ALERT_THRESHOLD` setting (default: 0.7). Confidence scores below threshold will be filtered
2. Check `NEWS_TIMEOUT_MS` is not too aggressive (default: 30000 ms is reasonable)
3. Verify notification channels (Telegram, WhatsApp) are properly configured
4. Check application logs for per-symbol analysis status and confidence scores
5. Test with explicit GET request: `GET /api/news-monitor?crypto=BTCUSDT`

#### Duplicate Alerts (Cache Not Working)

1. Verify `NEWS_CACHE_TTL_HOURS` is set (default: 6 hours). Set to 0 for no caching
2. Check application logs for "Cache hit" messages
3. Verify symbols and event categories match between requests (cache key is `(symbol, event_category)`)
4. Different event categories will NOT be deduplicated (e.g., "price_surge" + "regulatory" = 2 alerts)

#### Binance Price Not Being Fetched

1. Verify `ENABLE_BINANCE_PRICE_CHECK=true`
2. Verify symbol format is correct for Binance (e.g., `BTCUSDT` not `BTC`)
3. Check that crypto symbols are placed in `crypto` array (not `stocks`)
4. If Binance fails, system automatically falls back to Gemini GoogleSearch
5. Verify Binance API is accessible: `curl https://api.binance.com/api/v3/avgPrice?symbol=BTCUSDT`

**Symbol Classification**: The system trusts that you've correctly classified symbols into `crypto` and `stocks` arrays. If a symbol is misclassified (e.g., "NVDA" in the `crypto` array), Binance will return an error like `Invalid symbol: NVDA`. In this case:
- Verify the symbol exists on Binance: `https://api.binance.com/api/v3/avgPrice?symbol=NVDA` (will fail)
- Move stock symbols to the `stocks` array
- Use Binance symbol format (e.g., BTCUSDT for Bitcoin, not BTC)
- System will fall back to Gemini GoogleSearch if symbol is not found on Binance

#### Secondary LLM Enrichment Not Working

1. Verify `ENABLE_LLM_ALERT_ENRICHMENT=true`
2. Verify Azure AI Inference credentials: `AZURE_LLM_ENDPOINT`, `AZURE_LLM_KEY`, `AZURE_LLM_MODEL`
3. Check application logs for enrichment errors (will fall back to Gemini if unavailable)
4. Verify enrichment timeout is not exceeded (default: 10s per symbol)
5. If enrichment fails, alert is still sent using Gemini confidence (graceful degradation)

#### High Response Latency

1. Check `NEWS_TIMEOUT_MS` setting (each symbol waits up to this timeout)
2. Multiple symbols with timeouts = longer overall response. Per-symbol timeout: 30s. For 10 symbols, max wait: ~30s.
3. Enable only symbols that are actively traded (unused symbols slow down requests)
4. Reduce `NEWS_CACHE_TTL_HOURS` to refresh data more frequently (trades off cache hits vs. freshness)
5. Monitor external API latencies (Gemini, Binance) in application logs

### WhatsApp Alerts Not Sending

1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID` are set
3. Test WhatsApp API connection: `curl -X POST https://api.green-api.com/...`
4. Check application logs for detailed error messages

### Telegram Alerts Not Sending

1. Verify `BOT_TOKEN` is correct (from BotFather)
2. Verify `TELEGRAM_CHAT_ID` is correct (use `/start` to find)
3. Ensure bot has permission to send messages to the chat
4. Check Telegram API status

### URL Shortening

**URLs not being shortened**:
1. Verify `URL_SHORTENER_SERVICE` is set to `picsee`, `tinyurl`, or `cuttly`
2. Check that alert text contains valid HTTP/HTTPS URLs
3. Verify `PICSEE_API_KEY` or `CUTTLY_API_KEY` is set when the selected service requires it
4. Check application logs for "URLShortener" error messages

**Shortening timeout errors**:
- Default timeout: 5 seconds per URL batch
- If the selected provider is slow, increase timeout or reduce parallel URLs
- URLs gracefully fallback to original if shortening fails
- Alert still sends with original URLs

**Cache issues**:
- URL shortening cache is session-scoped (clears after request)
- Same URL requested multiple times in quick succession uses cache
- To clear cache manually, restart the application

**WhatsApp message still too long**:
- Shortening reduces URL length, not entire message
- If full alert text > 20,000 chars, it is automatically split into sequential chunks and delivered in parts
- Reduce alert detail or enable Gemini enrichment to summarize

### Retry Logic

- Failed alerts automatically retry per channel (WhatsApp up to 3 attempts with 1s → 2s → 4s exponential backoff per chunk; Telegram and Discord for 429 rate limits up to their configured retry limits)
- ±10% jitter prevents thundering herd on exponential backoff
- All retries logged at WARN/ERROR level
