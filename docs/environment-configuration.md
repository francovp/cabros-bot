# Environment Configuration Guide

[← Back to README](../README.md)

## Environment Configuration

### Required Variables

- `BOT_TOKEN` - Telegram bot token (from BotFather). Required only when `ENABLE_TELEGRAM_BOT=true` and the app is expected to launch Telegraf outside PR previews
- `TELEGRAM_CHAT_ID` - Telegram chat ID where alerts are sent
- `ENABLE_TELEGRAM_BOT` - Enable Telegram bot (`true` or `false`)
- `ENABLE_TELEGRAM_COMMAND_RATE_LIMITING` - Enable per-chat throttling for expensive Telegram commands (`true` by default; security control, excluded from Remote Config)
- `TELEGRAM_COMMAND_RATE_LIMITS_JSON` - Optional JSON overrides for per-command `max` and `windowMs`; defaults are `/precio` 10 per 60 seconds and `/analisis`, `/scanner`, `/noticias` 3 per hour. Values are bounded to `max` 1-1000 and `windowMs` 1-86400000; invalid values use defaults (security control, excluded from Remote Config)

### Optional Variables

#### Telegram Forum Topic Routing

- `TELEGRAM_TOPIC_ROUTES` - Optional mapping of alert categories/sources to Telegram forum topic `message_thread_id` values. Format: comma-separated pairs `category:threadId` (e.g. `webhook-signal:101,market-scanner:202,news-monitor:303,default:0`) or JSON object string `{"webhook-signal":101,"market-scanner":202}`. Thread ID `0` or `null` routes alerts to the chat's General topic.
- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` - Dedicated Telegram chat ID for admin/error notices (optional, falls back to `TELEGRAM_CHAT_ID`)
- `ENABLE_STRICT_CHAT_ID_VALIDATION` - When `true`, validates per-request `telegramChatId` overrides as numeric chat IDs (5-20 digits, optional `-` prefix) and `whatsappChatId` overrides as GreenAPI `<digits>@<c.us|g.us>` chat IDs. Malformed or hostile IDs are rejected with `400 INVALID_REQUEST`. Default: `false` (backwards-compatible — any non-empty string is accepted). Classified as **environment-only** for Remote Config parity (controls request-time validation behavior; opt-in operator toggle).
- `TELEGRAM_ACTION_OPERATOR_USER_IDS` - Comma-separated numeric Telegram user IDs allowed to use inline Replay. Empty or unset rejects replay callbacks; this security control is environment-only and is not published through Remote Config.
- `TELEGRAM_ALLOWED_CHAT_IDS` - Optional comma-separated allowlist of Telegram chat IDs permitted to invoke bot commands (`/precio`, `/cryptobot`, `/analisis`, `/scanner`, `/jobs`, `/noticias`, `/outcomes`). Defaults to `TELEGRAM_CHAT_ID` when unset, so a single-owner setup works out of the box. Unauthorized senders are dropped silently (no reply, logged once per sender per cooldown) to avoid confirming the bot's features. This is a security control and remains **environment-only** - it is intentionally excluded from Remote Config.

#### Security

- `WEBHOOK_API_KEY` - API key used to secure `/api/*` webhook endpoints. Required in production-like environments (`NODE_ENV=production`, Render, Vercel, Railway), where endpoints fail-closed with HTTP 503 if unset. When configured, clients must provide the key via the `x-api-key` header. The legacy `api-key` query parameter is deprecated ([GH-756](https://github.com/francovp/cabros-bot/issues/756)) — query strings may leak through reverse-proxy access logs, so a one-time deprecation warning is emitted on use; migrate to the header before the announced sunset date.
- `API_KEY_QUERY_SUNSET` - Optional UTC sunset date (`YYYY-MM-DD`) for the deprecated `api-key` query-parameter auth path. After this date, requests authenticated only via `?api-key=...` are rejected with `401 API_KEY_QUERY_REMOVED`; the `x-api-key` header continues to work. Leave unset to keep accepting the legacy query parameter indefinitely. Classified as environment-only for Remote Config parity (auth/transport sunset policy; excluded from the Remote Config template).
- `WEBHOOK_MAX_BODY_SIZE` - Maximum accepted webhook request body size for `/api/webhook/*` and `/api/news-monitor` (default `256kb`). Applies to `application/json`, `text/plain`, and `application/x-www-form-urlencoded` bodies. Accepts human-readable units (`b`, `kb`, `mb`, `gb`). Values outside `[1kb, 10mb]` or malformed strings fall back to the default with a startup warning. Oversized payloads are rejected with a structured `413 PAYLOAD_TOO_LARGE` response before any controller or middleware downstream of the body parsers runs, so a misconfigured client cannot consume CPU/memory by streaming a 10 MB body. Classified as environment-only (security control; excluded from Remote Config).
- `ENABLE_FIREBASE_ADMIN_AUTH` - Enable opt-in Firebase email/password authentication for the browser admin console (`false` by default)
- `FIREBASE_WEB_API_KEY` - Public Firebase Web API key used by the browser sign-in flow; not a service-account credential
- `FIREBASE_AUTH_DOMAIN` - Public Firebase Auth domain used by the browser sign-in flow
- `FIREBASE_DATABASE_URL` - Public Firebase Realtime Database URL used by the browser configuration
- `FIREBASE_APP_ID` - Public Firebase Web app ID (optional for Auth, recommended)
- `FIREBASE_WEB_CONFIG_JSON` - Optional JSON alternative containing the public Firebase Web config (`apiKey`, `authDomain`, `projectId`, and optional `appId`)

To report a vulnerability, see [`SECURITY.md`](../SECURITY.md) — the project documents a private disclosure channel, scope, and safe-harbor guidance. Do not file security issues as public GitHub issues.

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
- `ZERO_CHANNEL_ALERT_COOLDOWN_MS` - Cooldown between admin notifications when all channels are disabled in milliseconds (default: `300000`, Remote Config supported)
- `ENABLE_API_ONLY_MODE` - Declare intentional API-only mode without notification delivery, suppressing zero-channel alerts and dead-letters (default: `false`, Remote Config supported)
- `ENABLE_MAINTENANCE_MODE` - Remotely toggleable incident response kill switch (`true` or `false`, default: `false`, Remote Config supported). When active, gates incoming webhook alerts and bot commands with HTTP 503 while preserving `/healthcheck` and `/api/status`.

#### URL Shortening (003-news-monitor)

- `URL_SHORTENER_SERVICE` - URL-shortening provider for WhatsApp citations (optional; defaults to `picsee`; supported values: `picsee`, `tinyurl`, `cuttly`)
- `URL_SHORTENER_CACHE_MAX_ENTRIES` - Maximum in-memory URL-shortener cache entries before LRU eviction (default: `1000`, range `1`-`100000`; Remote Config supported)
- `URL_SHORTENER_SERVICE_FAILURES_MAX_ENTRIES` - Maximum tracked URL-shortener providers (default: `32`, range `1`-`1024`; effective minimum is the number of configured providers)
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

#### Token Spend Tracking & Cost Budgeting

- `ENABLE_TOKEN_COST_BUDGET` - Enable daily LLM token cost tracking and budget limits (`true` or `false`, default: `false`; Remote Config supported)
- `TOKEN_COST_DAILY_BUDGET_USD` - Maximum daily spend in USD before LLM calls fail open safely (default: `5.00`, range `0.01`-`1000.00`; Remote Config supported)
- `TOKEN_COST_WARN_THRESHOLD_PCT` - Percentage of daily budget that triggers an admin Telegram alert (default: `80`, range `1`-`100`; Remote Config supported)

#### Cloudflare AI Gateway

- `MODEL_PROVIDER=cloudflare` selects Cloudflare runtime routing when the gateway credentials are configured
- `ENABLE_CLOUDFLARE_AIG` only exposes Cloudflare readiness in status/capabilities (`true` or `false`, default: `false`); it does not select the runtime provider
- `CF_AIG_TOKEN` - Cloudflare AI Gateway token; keep it in a secret store
- `CF_AIG_BASE_URL` - OpenAI-compatible Cloudflare gateway base URL
- `CF_AIG_MODEL` - Gateway target model (default: `google-ai-studio/gemini-2.5-flash`)

#### Langfuse Prompt Management

Enabled in production (`render.yaml`: `value: true`, `previewValue: false` on the web service and the jobs worker; credentials are `sync: false` and live in the Render dashboard). Previews stay off so a throwaway PR deploy cannot publish traces against the production Langfuse project.

- `ENABLE_LANGFUSE_PROMPTS` - Fetch runtime prompts from Langfuse (`true` or `false`, default: `false`). Environment-only for Remote Config parity: a process-startup gate.
- `LANGFUSE_PUBLIC_KEY` - Langfuse public key (required when Langfuse prompt management is enabled). **Secret**: platform secret store only.
- `LANGFUSE_SECRET_KEY` - Langfuse secret key (required when Langfuse prompt management is enabled). **Secret**: platform secret store only.
- `LANGFUSE_BASE_URL` - Langfuse base URL (default: `https://cloud.langfuse.com`). Must be an HTTP(S) URL; only its host is reported by `/api/status`. Environment-only: an external destination.
- `LANGFUSE_PROMPT_LABEL` - Prompt label to fetch (default: `latest` in local/dev/test, `production` in production-like environments; `render.yaml` pins `production`). Environment-only.
- `LANGFUSE_PROMPT_CACHE_TTL_SECONDS` - Prompt cache TTL in seconds (default: `0` for `latest`, `60` for `production`; `render.yaml` pins `300`). Must be a non-negative integer. Environment-only.
- Optional local prompt overrides: `SEARCH_QUERY_PROMPT`, `GEMINI_SYSTEM_PROMPT`, `ALERT_ENRICHMENT_SYSTEM_PROMPT`, `NEWS_ANALYSIS_SYSTEM_PROMPT`, and `CONFIDENCE_ENRICHMENT_SYSTEM_PROMPT`. Unset values use the versioned local fallback files.

##### Verifying Langfuse prompts are actually resolving

Setting the flag is **necessary but not sufficient**. Prompt resolution fails **open** to the local prompt file, which is what keeps alert delivery alive — and which also makes a deployment where every alert silently resolves locally indistinguishable from a healthy one. `dependencies.langfuse.configured` is credential *shape* only, so a typo'd, revoked, or wrong-project key satisfies it. `ready` is therefore proven from observed resolutions (issue #1178):

| `status` | Meaning | Operator action |
|---|---|---|
| `disabled` | The gate is not `true`. | Nothing; local prompts are the configured intent. |
| `misconfigured` | Enabled, but a credential is missing or blank. | Set it in the Render dashboard. |
| `unverified` | Configured, but nothing has resolved yet. **No evidence, not health.** | Wait for the startup probe, then re-check. |
| `ready` | A managed prompt actually resolved. | Nothing. |
| `degraded` | A resolution failed; the local file was used. | Read `lastErrorReason`. |

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" \
  "$BASE_URL/api/capabilities" \
  | jq '{flag: .featureFlags.langfusePrompts,
         dep: .dependencies.langfuse | {status, ready, promptsSucceeded,
                                         localFallbackCount, lastErrorReason,
                                         fallingBack: .localFallbackByPrompt}}'
```

Read `localFallbackCount`, not the flag: it counts resolutions that used the local file *while the gate was on*, and is the number that proves the enablement is doing something. `status: "ready"` with a non-zero `promptsSucceeded` and an empty `fallingBack` map is the evidence the managed prompts are live.

`lastErrorReason` is a closed enum — `langfuse_not_configured`, `langfuse_client_unavailable`, `langfuse_auth_failed`, `langfuse_prompt_not_found`, `langfuse_timeout`, `langfuse_invalid_response`, `langfuse_unavailable` — because a Langfuse error body can embed the project id, base URL, and API key.

**`langfuse_prompt_not_found` is the expected first-deploy failure**: prompts published under `latest` but never under a `production` label make every fetch 404, every alert fall back to the local file, and the deployment still *look* healthy. Publish the label with the [`langfuse-prompt-sync`](../../.agents/skills/langfuse-prompt-sync/SKILL.md) skill. `consecutiveFailures` clears on the next success, so publishing the label self-heals the verdict without a restart.

Unlike equity market data, this feature **does** run a bounded startup probe (5s, `unref`'d, fail-open, non-blocking) that resolves every registered prompt once, precisely so an idle deployment gets a proven verdict instead of `unverified` forever.

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
- `ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT` - Enable multi-agent consensus analysis fallback for `/api/webhook/symbol-analysis` (`true` or `false`, default: `false`)
- `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION` - Suppress duplicate channel delivery for the same `exchange|symbol|timeframe|side` signal within its cooldown window; suppressed alerts are still persisted with a `suppressedRepeat: true` marker and opposite-side flips always deliver (`true` or `false`, default: `false`)
- `ALERT_SIGNAL_COOLDOWN_BARS` - Cooldown length in alert-timeframe bars for repeat suppression (`1`-`10`, default: `1`)
- Runtime gate: TradingView MCP data is only used when webhook requests include `?useTradingViewData=true`

#### Firestore Alert Storage

- `ENABLE_FIRESTORE_ALERT_STORAGE` - Enable Firestore persistence and alert read API (`true` or `false`, default: `false`). Remote Config eligible.
- `ALERT_STORAGE_RETENTION_DAYS` - Retention for `alerts` and `alertReplays` records in days (`1`-`3650`, default: `90`). New records get `expiresAt`; run `bash ops/configure-firestore-alert-retention.sh` once per Firebase project to backfill legacy records and enable native Firestore TTL deletion.
- **Backup & Disaster Recovery**: To safeguard high-value analytical history (`alerts`, `alertReplays`, `tradingSignalOutcomes`, `scannerPresets`) against permanent TTL deletion, automated scheduled workflows (`.github/workflows/firestore-backup.yml`), managed GCS exports (`ops/export-firestore-managed.sh`), and selective JSONL exports (`pnpm run backup:firestore`, `pnpm run restore:firestore`) are provided. See [`docs/firestore-backup-and-restore.md`](firestore-backup-and-restore.md) for the complete runbook and restore procedures.
- `ENABLE_FIRESTORE_JOB_STORAGE` - Enable Firestore persistence for async TradingView jobs without enabling alert read APIs (`true` or `false`, default: `false`). Remote Config eligible.
- `ENABLE_FIRESTORE_IDEMPOTENCY` - Enable durable webhook idempotency persistence in Cloud Firestore (`true` or `false`, default: `false`). Remote Config eligible. **Enabled in production** via `render.yaml` on the web service only (issue #1111). Read [`dependencies.idempotencyStorage`](#verifying-idempotency-storage-is-actually-durable) before treating it as working.
- `ENABLE_FIRESTORE_ALERT_FEEDBACK` - Enable Firestore persistence for trader alert feedback (👍/👎 verdicts from inline keyboard callbacks) (`true` or `false`, default: `false`). Disabled falls back to a process-local in-memory surface so the summary endpoints still return aggregate counts in development.
- `ALERT_FEEDBACK_RETENTION_DAYS` - Retention for `alertFeedback` records in days (`1`-`3650`, default: `90`, matches alert retention). New records get `expiresAt`; backfill + native TTL can be enabled via `ops/configure-firestore-alert-retention.sh` once per Firebase project.
- `ENABLE_SIGNAL_OUTCOME_TRACKING` - Enable shadow-mode signal outcome recording and evaluation (`true` or `false`, default: `false`)
- `SIGNAL_OUTCOME_RETENTION_DAYS` - Retention for `tradingSignalOutcomes` records in days (`1`-`3650`, default: `365`). New records get `expiresAt`; run `bash ops/configure-operational-collection-retention.sh` (or with `BACKFILL=true`) once per Firebase project to backfill legacy records and enable native Firestore TTL deletion.
- `SIGNAL_OUTCOME_ENTRY_PRICE_SOURCES` - Optional comma-separated first-success provider chain (`mcp`, `binance`, `twelve-data`, `gemini`); empty preserves the existing crypto (`mcp,binance,gemini`) and equity (`twelve-data`) defaults. Active chains are reported under `dependencies.signalOutcomeWorker.entryPriceSources`.
- `ENABLE_EQUITY_MARKET_DATA` - Opt in to equity/forex/index outcome evaluation for `NASDAQ`, `BATS`, `NYSE`, `AMEX`, `NYSE ARCA`, `FX_IDC`, and `SPCFD` signals (`true` or `false`, default: `false`)
- `EQUITY_MARKET_DATA_PROVIDER` - Equity provider name; currently `twelve-data`
- `TWELVE_DATA_API_KEY` - Twelve Data API key; sent in the `Authorization` header and never returned by status endpoints
- `TWELVE_DATA_BASE_URL` - Optional Twelve Data base URL override (default: `https://api.twelvedata.com`)
- `EQUITY_MARKET_DATA_TIMEOUT_MS` - Per-request equity market-data timeout, capped at 30 seconds (default: `5000`)

#### Verifying equity market data is actually working

Setting `ENABLE_EQUITY_MARKET_DATA=true` and `TWELVE_DATA_API_KEY` is **necessary but not sufficient**, and `/api/status` is deliberately built so it cannot claim otherwise:

| Field | Meaning |
| :--- | :--- |
| `featureFlags.equityMarketData` | The `ENABLE_EQUITY_MARKET_DATA` gate only. Says nothing about whether the feature works. |
| `dependencies.equityMarketData.configured` | Credential **shape** only: gate on, provider selected, key non-empty. Not proof the key works. |
| `dependencies.equityMarketData.status` | `disabled`, `misconfigured`, `unverified`, `ready`, or `degraded`. |
| `dependencies.equityMarketData.ready` | `true` only after an observed **successful** provider call. |
| `dependencies.equityMarketData.readiness` | `unverified` / `verified` / `degraded` from the observed-call window. |
| `dependencies.equityMarketData.lastErrorReason` | Sanitized failure class, e.g. `twelve_data_misconfigured`, `twelve_data_rate_limited`, `twelve_data_timeout`. |

A typo'd, revoked, quota-exhausted, or wrong-plan key all pass the `configured` check, so `configured: true` must never be read as "equity outcomes are working". Roll the feature out by watching `status` transition `unverified` → `ready` once the first equity evaluation runs:

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" https://<host>/api/capabilities \
  | jq '{flag: .featureFlags.equityMarketData, dep: .dependencies.equityMarketData}'
```

- `status: "unverified"` — the key is configured but no provider call has succeeded yet. Wait for the first evaluation sweep; equity outcomes are evaluated on the signal-outcome cadence, not continuously.
- `status: "ready"` — proven working.
- `status: "degraded"` with `lastErrorReason` — the provider rejected the call. A `twelve_data_misconfigured` reason is the signal to replace or fix the key; `twelve_data_rate_limited` means raise `EQUITY_MARKET_DATA_RPM` budget or reduce signal volume.

Counters (`requestsAttempted`, `requestsSucceeded`, `requestsFailed`, `consecutiveFailures`) and timestamps (`lastSuccessAt`, `lastFailureAt`) are process-local and reset on restart, so `unverified` is also the normal state immediately after every deploy. There is no startup probe: a probe would spend provider quota on every restart purely to manufacture a green checkmark, and on the 8-RPM free tier that is a real cost for no new information.

#### Verifying idempotency storage is actually durable

`ENABLE_FIRESTORE_IDEMPOTENCY=true` is **enabled in production** (issue #1111, declared on the web service in `render.yaml`), but the gate alone is not proof that duplicates are suppressed. `IdempotencyStorageService` is fail-open by design: every Firestore error is logged and swallowed, and the request continues with in-memory idempotency. A deployment whose credentials look valid but cannot reach Firestore behaves exactly as it did before the flag existed, so the reported state is derived from observed durable work instead:

| Field | Meaning |
| :--- | :--- |
| `featureFlags.firestoreIdempotency` | The `ENABLE_FIRESTORE_IDEMPOTENCY` gate only. |
| `dependencies.idempotencyStorage.configured` | Credential **shape** only. Not proof that reservations persist. |
| `dependencies.idempotencyStorage.status` | `disabled`, `misconfigured`, `unverified`, `ready`, or `degraded`. |
| `dependencies.idempotencyStorage.ready` | `true` only after an observed **successful** durable operation. |
| `dependencies.idempotencyStorage.readiness` | `unverified` / `verified` / `degraded` from the observed-operation window. |
| `dependencies.idempotencyStorage.mode` / `backend` | Configured **intent** (`durable`/`firestore`), unchanged by a failure. |
| `dependencies.idempotencyStorage.failOpen` | Always `true`: a degraded verdict still delivers alerts, it just cannot suppress a duplicate after a restart or across replicas. |
| `dependencies.idempotencyStorage.lastErrorReason` | Closed enum: `firestore_not_initialized` or `firestore_unavailable`. Never provider text. |

```bash
curl -s -H "x-api-key: $WEBHOOK_API_KEY" https://<host>/api/capabilities \
  | jq '{flag: .featureFlags.firestoreIdempotency, dep: .dependencies.idempotencyStorage}'
```

- `status: "unverified"` — the normal state right after a deploy, before the first keyed request has been served. Send one idempotent webhook with an `idempotency-key` and re-check.
- `status: "ready"` — proven durable.
- `status: "degraded"` — falling back to in-memory. `firestore_unavailable` points at the Firestore SDK or network path; `firestore_not_initialized` points at the credential loader, and is the signal to check `FIREBASE_SERVICE_ACCOUNT_JSON` / `GOOGLE_APPLICATION_CREDENTIALS`. `consecutiveFailures` clears on the next success, so a transient outage self-heals without a restart.

Counters (`operationsAttempted`, `operationsSucceeded`, `operationsFailed`, `consecutiveFailures`) and timestamps are process-local and reset on restart. A status read never counts as a durable attempt.

**Prerequisite — TTL on `idempotency_keys`.** Every document carries `expiresAt`, but Firestore only deletes on it once the TTL policy exists, and Firestore TTL deletion is eventually consistent (up to ~24 h) and only removes documents that are *already* expired. `getEntry()` lazily deletes a document it reads after expiry, which is a safety net rather than a cleanup strategy: a key that is never replayed is never read. Run once per Firebase project:

```bash
bash ops/configure-operational-collection-retention.sh   # covers idempotency_keys
```

Until that runs, the collection grows without bound. This is the same eventual deletion the other operational collections depend on, and it is a deployment step — it is not something this repository can apply for you.

**Rollback.** Set the variable back to `false` and redeploy; the service falls back to in-memory idempotency on the next request and no code change is needed. Nothing is lost that matters — unexpired reservations simply stop being shared, so a duplicate is possible again, which is the pre-#1111 behaviour.
- `SIGNAL_OUTCOME_WORKER_ROLE` - Scheduler role: `web` preserves the local/web timer, `worker` enables only the dedicated worker entrypoint, and `disabled` prevents scheduler startup (default: `web`)
- `SIGNAL_OUTCOME_EVALUATION_LEASE_MS` - Distributed sweep lease duration in milliseconds (`10000`-`600000`, integer, default: `120000`). The sweep is claimed in the Firestore `signalOutcomeLocks` collection so exactly one process evaluates a pending signal when more than one has tracking enabled; a replica that loses the claim skips with `reason: "lease-held"` and makes no market-data calls. Fails open to single-process behaviour when Firestore or the lease write is unavailable, so it can never disable evaluation. Reported as `dependencies.signalOutcomeWorker.leaseMs`.
- `FIREBASE_SERVICE_ACCOUNT_JSON` - Inline Firebase service account JSON for server-side Firestore access. Service accounts only; an ADC document supplied inline is rejected with an actionable error because ADC is resolved from a file or the managed runtime, never from an inline value.
- `FIREBASE_PROJECT_ID` - Optional Firebase project override for Admin SDK initialization. Required when credentials resolve through Application Default Credentials, since `authorized_user` and `external_account` documents carry no project id of their own.
- `GOOGLE_APPLICATION_CREDENTIALS` - Optional path to a credential JSON file for local development. Accepts a service account key (used directly) or an Application Default Credentials document such as the `authorized_user` file written by `gcloud application-default login` or an `external_account` workload-identity config (resolved by the Firebase Admin SDK).

#### Per-Chat User Preferences

- `ENABLE_FIRESTORE_CHAT_PREFERENCES` - Enable persistent per-chat alert preferences in Cloud Firestore (`true` or `false`, default: `false`, Remote Config supported)
- `CHAT_PREFERENCES_RETENTION_DAYS` - Retention for `chatPreferences` documents in days (`1`-`365`, default: `90`, Remote Config supported). New records write `expiresAt`; run `bash ops/configure-operational-collection-retention.sh` once per Firebase project to enable native Firestore TTL deletion on `expiresAt`. Reads safely reject expired records past `expiresAt`.
- `CHAT_PREFERENCES_CACHE_TTL_MS` - In-memory cache TTL for chat preferences in milliseconds (`1000`-`3600000`, default: `60000`, Remote Config supported). Governs local cache expiration before querying Firestore on alert routing and commands.

#### Worker Queue & Poller Execution

- `JOB_EXECUTION_MODE` - Use `local` for in-process fallback, `render-worker` for BullMQ/Redis worker queue, or `firestore-poller` for Redis-free durable Firestore polling (`local` by default)
- `JOB_POLL_INTERVAL_MS` - Polling sweep interval for `firestore-poller` mode in milliseconds (default: `15000` ms)
- `REDIS_URL` - Render Key Value connection string required by `render-worker`
- `JOB_QUEUE_ATTEMPTS` / `JOB_QUEUE_BACKOFF_MS` - Retry count and backoff delay (defaults: `5` / `30000` ms)
- `JOB_QUEUE_CONCURRENCY` - Worker concurrency (default: `1`)
- `JOB_QUEUE_CLAIM_LEASE_MS` - Firestore claim lease and heartbeat interval (default: `60000` ms)
- `JOB_QUEUE_CONNECT_TIMEOUT_MS` - Redis connection timeout (default: `5000` ms)

#### Async Job Backlog Monitoring

- `ENABLE_JOB_BACKLOG_MONITOR` - Enable the periodic background async job backlog depth probe and operator paging (`true` or `false`, default: `true`)
- `JOB_BACKLOG_ALERT_THRESHOLD_MS` - Age in milliseconds at which the oldest queued job triggers an operator page (`1000`-`86400000`, default: `900000` / 15m, Remote Config supported)
- `JOB_BACKLOG_PAGE_COOLDOWN_MS` - Cooldown in milliseconds between repeated backlog pages so a sustained stall cannot storm the operator (`1000`-`86400000`, default: `900000` / 15m, Remote Config supported)
- `JOB_BACKLOG_PROBE_INTERVAL_MS` - Interval in milliseconds between background backlog depth probes (`1000`-`3600000`, default: `60000` / 1m, Remote Config supported)

The probe reads BullMQ waiting/delayed/failed/active counts plus a bounded Firestore count of non-terminal `queued` durable rows, and surfaces them on `GET /api/status` and `GET /api/capabilities` under `dependencies.jobExecutionQueue` (`waitingCount`, `delayedCount`, `failedCount`, `activeCount`, `durableQueuedCount`, `oldestQueuedAgeMs`, `backlogAlert`). No Redis URL or credential is exposed. When `oldestQueuedAgeMs` crosses the threshold, the monitor pages `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` once per cooldown window and sends a single all-clear when the backlog drains. All probing and paging fails open: a probe or notification failure never blocks job intake or alert delivery.

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

The allow-list contains news thresholds, timeouts, concurrency, quota retries, TradingView timeouts/retries, `SIGNAL_OUTCOME_RETENTION_DAYS` (retention in days between `1` and `3650`, default `365`), `ENABLE_MESSAGE_FOOTER_METADATA`, `ENABLE_MAINTENANCE_MODE` (an operational incident-response kill switch), per-chat user preferences (`ENABLE_FIRESTORE_CHAT_PREFERENCES`, `CHAT_PREFERENCES_RETENTION_DAYS` between `1` and `365`, `CHAT_PREFERENCES_CACHE_TTL_MS` between `1000` and `3600000`), and the four Firestore storage gates (`ENABLE_FIRESTORE_ALERT_STORAGE`, `ENABLE_FIRESTORE_IDEMPOTENCY`, `ENABLE_FIRESTORE_JOB_STORAGE`, `ENABLE_FIRESTORE_SCANNER_PRESETS`, all boolean, default `false`). Remote values are parsed as numbers/booleans and must satisfy the existing finite, integer, positive, and range constraints. Credentials, API keys, webhook authentication, permanent security controls, route/security gates, and Telegram destinations are never read from Remote Config.

##### Storage gates resolve `remote ?? env`, not `env || remote`

The four Firestore storage gates are re-evaluated on every call (each gate is checked *before* the cached Firestore client is handed out), so a published value flips durable storage at runtime without a redeploy. That makes precedence load-bearing, and `render.yaml` pins three of them to `true` in production (`ENABLE_FIRESTORE_IDEMPOTENCY`, `ENABLE_FIRESTORE_JOB_STORAGE`, `ENABLE_FIRESTORE_SCANNER_PRESETS` on the web service):

- A **published value always wins**, including `false`. Combining the two sources with `env || remote` would let the `true` pin mask a remote `false`, which would make the gate impossible to switch off in production.
- **No published value means the environment decides.** Remote Config being disabled, stale, or simply lacking the key is *not* evidence about the gate, so `undefined` falls through to `process.env` rather than being coerced to `false`.
- Consumers read this through `getRemoteOverride(key)`, not `getRuntimeConfig()`. `getRuntimeConfig()` always returns a value for every schema key — environment-derived when the gate is off — so it cannot distinguish "Remote Config said `false`" from "the environment says `false`".

`ENABLE_FIRESTORE_SCANNER_PRESETS`, `ENABLE_FIRESTORE_JOB_STORAGE`, `ENABLE_FIRESTORE_ALERT_STORAGE` and `ENABLE_FIRESTORE_IDEMPOTENCY` are all declared in the template with **`useInAppDefault: true`**, which means "no published value". That is deliberate, and it is not cosmetic:

> **A template `defaultValue` is an override, not a default.** When no condition matches, `firebase-admin` falls through to `parameter.defaultValue` and tags it with source `'remote'`, which this service accepts as a real override. Shipping `defaultValue: { "value": "false" }` would therefore have silently disabled the three storage modes `render.yaml` pins to `true` (idempotency, job storage, scanner presets) the first time the template was published, re-enabling duplicate alert delivery after every restart and replica. `useInAppDefault: true` makes the SDK skip the parameter, so nothing is overridden and the deployment value decides.

So: to change a storage gate, set a **conditional/actual value** in `firebase-remote-config-template.json` and republish. Do not "just edit the default" — the default is a remote value.

Previews are unaffected either way: they run with `ENABLE_FIREBASE_REMOTE_CONFIG=false`, so `getRemoteOverride()` returns `undefined` and they keep their `render.yaml` values — a throwaway PR deployment can never mutate the production collection through a remote toggle.

The service loads once at startup and refreshes on the bounded cadence; it does not fetch Remote Config per alert. `SIGNAL_OUTCOME_EVALUATION_INTERVAL_MS` remains environment-only because the worker timer is created during process startup and is not a request-time setting. Disabled, unavailable, timed-out, stale, malformed, or invalid values fail open to the current environment/default behavior. The server-side Remote Config API is currently a Firebase Preview feature, so monitor its quota and error rate before enabling it in production. `firebase-admin` is upgraded to the Node 24-compatible 12.x line (`^12.1.0`, lockfile resolution `12.7.0`).

##### Publishing the server template (`firebase-server` namespace)

Enabling `ENABLE_FIREBASE_REMOTE_CONFIG` alone does **not** activate remote tuning: the flag and valid credentials only mean the loader is *wired up*. A template must also be published to the **`firebase-server`** namespace, which is the exact namespace `admin.remoteConfig().initServerTemplate()` reads.

- Publish with `pnpm run deploy:firebase-remote-config:server` locally, or by running the **Deploy Firebase Remote Config Server Template** workflow (`.github/workflows/firebase-remote-config.yml`, `workflow_dispatch`) against `master`. The workflow uses the `FIREBASE_SERVICE_ACCOUNT_JSON` Actions secret and the `FIREBASE_PROJECT_ID` repository variable (default `cabros-bot`).
- **Namespace contract**: the publish target is `projects/{projectId}/namespaces/firebase-server/serverRemoteConfig`. Publishing to the default/client namespace (`/remoteConfig`) is a silent no-op for this loader — the template appears in the console while the service keeps reading an empty server template forever.
- The `firebase-server` namespace does not exist until the first publish, so the script bootstraps it with `If-Match: *`. A pre-publish `getServerTemplate()` that returns `remote-config/not-found` is the expected bootstrap state, not a failure.

Verify activation through `GET /api/status` → `dependencies.firebaseRemoteConfig`:

| Field | Meaning |
| --- | --- |
| `enabled` / `configured` | The loader is wired up. Neither implies remote values are being served. |
| `templatePublished` | `true` only after at least one successful template load. `false` means nothing was ever fetched. |
| `ready` | `true` only after a **successful and still-fresh** load. |
| `source` | `remote` only when live remote overrides are in use; `environment`/`default` mean they are not. |
| `lastErrorCategory` | `template_not_published` means the `firebase-server` namespace has no template and must be published. This is distinct from a transient `load_failed`; `permission_denied` and `unauthenticated` mean the service account lacks the server-template permission. |
| `consecutiveFailures` | Consecutive failed loads; reset to `0` on success. |

In the inert state (`templatePublished: false, ready: false, source: "environment", lastErrorCategory: "template_not_published"`) every value comes from the environment fallback — intended fail-open behavior; the alert path is never blocked.

##### Production enablement (issue #1113)

Production enables the gate on **every compute service** in `render.yaml` — the web service, the BullMQ job worker, and the signal-outcome worker — with `previewValue: false`. Two properties follow, and both are load-order dependent rather than code dependent:

- **The gate is declared, not assumed.** `RemoteConfigService.start()` returns `false` immediately when `ENABLE_FIREBASE_REMOTE_CONFIG` is not `true`, so a service that omits the key never loads the template at all and silently keeps evaluating environment values. The gate must be on any process that calls `remoteConfigService.start()`; `getRuntimeConfig()` merges remote overrides only when it is.
- **A per-service gate is a correctness bug, not a config preference.** `getRuntimeConfig()` merges remote overrides only where the gate is on, so two processes with different gate values evaluate *different* effective configs from the same published template. `SIGNAL_OUTCOME_RETENTION_DAYS` is the sharpest case: the web service stamps `expiresAt` on outcome documents while the signal-outcome worker applies the same window when evaluating them, so a split gate makes the two processes disagree about document lifecycle.

Enabling the gate does not by itself activate remote tuning, so the deploy is a **two-step** rollout:

1. Merge this change. Render applies the blueprint and redeploys. Until a template exists the service reports `status: "degraded"` with `lastErrorCategory: "template_not_published"` — the honest inert state above, with every value still coming from the environment. Nothing is degraded functionally, and this is the expected state between the two steps.
2. Once the deployment is green, run the **Deploy Firebase Remote Config Server Template** workflow (`workflow_dispatch`, ref `master`). The service then reports `ready: true`, `templatePublished: true`, `source: "remote"`, and `templateVersion` matching the published version.

The publish workflow is deliberately manual and agent-driven publishes are prohibited: a template becomes the live authority for production the moment it lands. Confirm step 2 on each compute service, not only on the web service.

##### After publishing, `render.yaml` no longer owns allow-listed values

This is the main operational consequence of turning the feature on, and it is easy to get wrong.

The Firebase Admin SDK reports a fetched template parameter's `defaultValue` with source `remote` (`ValueImpl('remote', parameterDefaultValue)` in `remote-config.js`), and `RemoteConfigService.getRemoteValue()` accepts any value whose source is `remote`. So **every parameter present in `firebase-remote-config-template.json` becomes a remote override that takes precedence over `process.env`**, even though the template entries look like plain defaults.

Once the template is published, editing an allow-listed key in `render.yaml` or in the Render dashboard has **no effect** on that running process. To change an allow-listed value you must edit `firebase-remote-config-template.json` and re-run the publish workflow. The template is therefore the source of truth for the allow-list after first publish, and `render.yaml` acts only as a fallback for keys the template omits (and for the gate itself).

Keep `firebase-remote-config-template.json` aligned with the intended production values before publishing. A template whose defaults are stale will silently override freshly corrected `render.yaml` values, and `ready: true` will still be reported because the load succeeded.

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
- HTTP server timeouts are fixed at 10 seconds for headers, 120 seconds for complete requests, and 30 seconds for keep-alive connections to bound slow-client resource use. Node only enforces `headersTimeout` when its periodic connection checker fires, so `connectionsCheckingInterval` is also fixed at 5 seconds (Node's 30s default would defer rejection to ~30s). Because the sweep is aligned to server start rather than to each connection, a slow-header client is rejected within a worst case of **15 seconds** (`headersTimeout + connectionsCheckingInterval`), not exactly 10 (see `src/lib/serverTimeouts.js`).
- `SHUTDOWN_TIMEOUT_MS` - Maximum graceful shutdown budget in milliseconds (default: `10000`, hard cap: `30000`); after the deadline active jobs receive a bounded finalization attempt and are persisted as retryable cancellations, remaining HTTP connections are force-closed, and the process exits
- `RENDER` - Render.com deployment flag (used internally)
- `IS_PULL_REQUEST` - Render preview environment flag (disables bot in PRs)
- `VERCEL` / `VERCEL_ENV` - Vercel system deployment markers; `VERCEL_ENV=preview` disables the bot
- `VERCEL_GIT_COMMIT_SHA` / `VERCEL_GIT_REPO_OWNER` / `VERCEL_GIT_REPO_SLUG` - Vercel deployment metadata used for release and deployment notifications
- `RAILWAY_ENVIRONMENT_NAME` / `RAILWAY_GIT_PULL_REQUEST_NUMBER` - Railway preview markers; a PR number or environment name containing a hyphen-delimited `pr` segment disables the bot
- `RAILWAY_GIT_COMMIT_SHA` / `RAILWAY_GIT_REPO_OWNER` / `RAILWAY_GIT_REPO_NAME` - Railway GitHub deployment metadata used for release and deployment notifications
- `TRUST_PROXY` - Express trusted proxy setting for reverse-proxy deployments (`true`, `false`, `1` hop, or subnet string; defaults to `1` on Render/Vercel/Railway, and `false` for direct deployments)
- `REQUEST_TIMEOUT_MS` - Hard request-deadline ceiling for mounted `/api` routes in milliseconds (default: `30000`, valid range: `1000`-`120000`; invalid values fall back to the default). The timeout returns `408 REQUEST_TIMEOUT` with a request ID.
- `REQUEST_DEADLINE_EXEMPT_PATHS` - Optional comma-separated paths excluded from the deadline; `/healthcheck`, `/ready`, `/openapi.json`, and `/docs` (including its static asset subtree) are always exempt. This is the single exemption vocabulary shared with structured request logging, so a path added here is silenced in both the deadline and the request log — see [Structured Request Logging](monitoring.md#structured-request-logging-gh-665). Per-endpoint deadlines such as `EXPANDED_ANALYSIS_ALERT_TIMEOUT_MS` and `MARKET_SCANNER_TIMEOUT_MS` remain the operation-specific soft budgets inside the global ceiling.
- `RATE_LIMIT_WINDOW_MS` - Global API rate limiter window in milliseconds (default: `900000` / 15 minutes; invalid values use the default)
- `RATE_LIMIT_MAX` - Global API rate limiter max requests per window (default: `100`; invalid values use the default). Webhook and MCP ingest endpoints (`/api/webhook/alert`, `/api/webhook/message`, `/api/webhook/expanded-analysis-alert`, `/api/webhook/market-scanner-alert`, `/api/webhook/volume-confirmation`, `/api/webhook/symbol-analysis`, and `/api/news-monitor`) use an isolated finite bucket of 1,000 requests per window so TradingView and scanner bursts do not consume the ordinary client bucket; API-key validation still applies. Public documentation and admin console assets (`/openapi.json`, `/docs`, `/admin`, and associated static assets) are mounted before the rate limiter and are exempt from the global rate limit budget, mirroring `/healthcheck` and `/ready`.
- `LOG_LEVEL` - Structured JSON log verbosity (`debug`, `info`, `warn`, `error`, `silent`; defaults to `debug` in development and `info` in production). The logger automatically masks sensitive plain-object keys, bare-scalar secrets preceded by sensitive labels, URL query secrets, embedded JSON strings, Authorization/Bearer credentials, Telegram bot tokens, Discord webhook tokens, OpenAI keys, and dynamically registered request-scoped secrets via `registerSecretValue` / `clearSecretValue`.
- `SERVICE_NAME` - Optional service name included in JSON logs (default: package name or `cabros-bot`)

#### News Monitoring (003-news-monitor)

- `ENABLE_NEWS_MONITOR` - Enable news monitoring endpoint (`true` or `false`, default: `false`)
- `ENABLE_NEWS_MONITOR_CLASSIFIER` - Re-check Gemini `none` headlines with classifier.dev (`true` or `false`, default: `false`). Sends the symbol and generated headline externally; this privacy gate is environment-only and excluded from Firebase Remote Config.
- `NEWS_SYMBOLS_CRYPTO` - Default crypto symbols if not provided in request (comma-separated, e.g., `BTCUSDT,ETHUSD`)
- `NEWS_SYMBOLS_STOCKS` - Default stock symbols if not provided in request (comma-separated)
- `NEWS_ALERT_THRESHOLD` - Confidence score threshold for sending alerts (default: `0.7`, range 0.0-1.0)
- `NEWS_CACHE_TTL_HOURS` - Cache time-to-live for deduplication (default: `6` hours)
- `NEWS_CACHE_MAX_ENTRIES` - Maximum in-memory news-cache entries before LRU eviction (default: `5000`, range `1`-`1000000`; Remote Config supported)
- `NEWS_DELIVERY_LOCK_MAX_ENTRIES` - Maximum in-memory channel delivery leases (default: `1000`, range `1`-`100000`; active leases are preserved)
- `ENABLE_NEWS_MONITOR_PERSISTENT_DEDUP` - Enable Firestore-backed news deduplication (`true` or `false`, default: `false`; failures fall back to memory)
- `NEWS_TIMEOUT_MS` - Per-symbol analysis timeout (default: `30000` ms)
- `NEWS_GEMINI_CONCURRENCY` - Max concurrent Gemini-backed symbol analyses. Production policy is `3`; unset keeps legacy parallel fan-out for backward compatibility.
- `NEWS_GEMINI_QUOTA_MAX_RETRIES` - Max per-symbol retries for Gemini `429 RESOURCE_EXHAUSTED` errors (default: `2`)
- `NEWS_GEMINI_QUOTA_RETRY_BASE_MS` - Base exponential backoff when Gemini does not provide retry delay metadata (default: `1000` ms)
- `NEWS_MAX_ALERTS_PER_BATCH` - Maximum alerts delivered per `/api/news-monitor` request (default: `10`, range: `1`-`50`; Remote Config supported)
- `NEWS_MAX_ALERTS_PER_WINDOW` - Maximum alerts delivered by this process during the volume window (default: `20`, range: `1`-`200`; Remote Config supported)
- `NEWS_MAX_ALERTS_PER_WINDOW_MS` - Sliding volume-window duration (default: `300000` ms / 5 minutes, range: `1000`-`3600000`; Remote Config supported)
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

- `ENABLE_FIRESTORE_SCANNER_PRESETS` - Enable the scanner-preset Firestore persistence gate independently from alert storage, job storage, and outcome tracking (default: `false`). Remote Config eligible.
- `storage.mode` and `storage.backend` are **intent-derived**: they report the configured target and stay `durable`/`firestore` whenever the flag is on and credentials are present. They only report `ephemeral`/`memory` when the flag is off or credentials are unusable — the two cases where presets really are lost on restart or redeploy. Do not read `memory` as "the flag is off": that confusion is what made a transient Firestore error look like a disabled feature in [#1342](https://github.com/francovp/cabros-bot/issues/1342).
- `dependencies.scannerPresetStorage` reports `status` so the three causes an operator must act on differently stay distinguishable, and `configured`/`ready` are not the same question:

| `status` | Meaning | Operator action |
| :--- | :--- | :--- |
| `disabled` | `ENABLE_FIRESTORE_SCANNER_PRESETS` is not `true`. | Nothing; presets are ephemeral by choice. |
| `misconfigured` | The gate is on but credentials are genuinely absent or rejected. | Fix Firebase credentials. This is the only status that means "check your credentials". |
| `unverified` | No durable operation has been observed yet. Not a failure, and not health — the normal state immediately after a restart. | None. |
| `ready` | A durable read or write has actually succeeded. | None. |
| `degraded` | A durable operation failed and nothing has answered since. `lastErrorReason` names the class. | Investigate Firestore reachability; `consecutiveFailures` clears on the next success. |

- `configured` is credential **shape** only. `ready` is the proof question and is true only after an observed durable read or write, so a deployment whose key looks valid but cannot reach Firestore reports `degraded` instead of `ready`. `GET /api/status` and `GET /api/capabilities` prove it with a bounded, single-flight durable read (rate-limited to one probe per 5s so polling cannot amplify Firestore reads), so **no prior write is required**.
- Alongside the verdict: `readiness`, `failOpen` (always `true` — preset CRUD keeps serving from the in-memory mirror), `collection`, the `operationsAttempted`/`operationsSucceeded`/`operationsFailed`/`consecutiveFailures` counters, `lastSuccessAt`/`lastFailureAt`, and a closed-enum `lastErrorReason` (`firestore_not_initialized`, `firestore_unavailable`, `firestore_probe_timeout`) that never contains a provider message.
- `pendingWrites`, `inFlightWrites`, `pendingDeletes`, `oldestPendingWriteAt`, and `lastReadFellBack` report local unsynced workload. They are deliberately **not** part of the verdict: an unsynced record is a pending-sync fact, not a store fault, so a record left behind by a failed write can never pin the process to `ephemeral`. Watch `pendingWrites > 0` with a rising `oldestPendingWriteAt` as the signal that records are at risk of being lost on restart.
- The readiness counters are process-local and reset on restart. The probe issues the same indexed `orderBy('createdAt','desc')` query `listPresets()` uses, bounded to one document, so it needs no composite index beyond the single-field sort the list already requires.

#### Scanner Preset Optimistic Concurrency

- `GET /api/scanner-presets/:id`, `POST /api/scanner-presets`, and `PUT /api/scanner-presets/:id` set an `ETag` response header (e.g. `ETag: "3"`) that mirrors a per-preset monotonic `version` field returned in the response body.
- `PUT /api/scanner-presets/:id` and `DELETE /api/scanner-presets/:id` accept an optional `If-Match: "<version>"` request header for opt-in optimistic concurrency. A missing `If-Match` keeps today's behavior (the write succeeds and increments `version`).
- A mismatched `If-Match` returns `412 PRECONDITION_FAILED` with the current preset (including `version`) so the client can rebase before retrying.
- An update targeting a preset whose `lockedUntil` is in the future returns `409 PRESET_LOCKED` with the `lockedUntil` timestamp and the current preset, so an operator save cannot silently overwrite an in-flight sweep's lease.
- `POST /api/scanner-presets` and `PUT /api/scanner-presets/:id` enforce case-insensitive unique names: a create/update that collides with another preset's name returns `409 NAME_CONFLICT` with the conflicting preset so the operator can rename/reuse the existing record instead of producing an ambiguous duplicate. The current preset can rename itself with a case-only change (e.g. `My Watchlist` → `my watchlist`) without tripping the conflict.

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

#### Alert Scheduler

- `ENABLE_ALERT_SCHEDULER` - Enable JSON-defined recurring background runner for news-monitor and market-scanner runs (default: `false`).
- `ALERT_SCHEDULER_WORKER_ROLE` - Scheduler worker role: `web` (default), `worker`, or `disabled`.
- `ALERT_SCHEDULER_INTERVAL_MS` - Background sweep interval in milliseconds (default: `60000`, bounds `1000`-`3600000`).
- `ALERT_SCHEDULER_BATCH_LIMIT` - Maximum due schedules processed per sweep (default: `10`, bounds `1`-`100`).
- `ALERT_SCHEDULER_TIMEOUT_MS` - Per-sweep execution deadline in milliseconds (default: `90000`, bounds `1000`-`600000`).
- `ALERT_SCHEDULER_LEASE_MS` - Distributed concurrency lock lease duration in milliseconds (default: `120000`, bounds `10000`-`600000`).
- `ALERT_SCHEDULER_SCHEDULES` - JSON array defining recurring news and scanner schedules.
- `dependencies.alertScheduler` in `/api/status` exposes `enabled`, `configured`, `ready`, `status`, `role`, `running`, `scheduleCount`, `lastRunAt`, `lastRunDurationMs`, `lastRunExecutedCount`, `lastRunErrorCount`, and `lastError` without secrets.


---

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
