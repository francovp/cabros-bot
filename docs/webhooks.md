# Webhook Alerts API

[← Back to README](../README.md) | [API Reference](api-reference.md)

The bot exposes several webhook endpoints to receive alerts from TradingView, scanners, and external automation.
All webhook endpoints are protected by `validateApiKey` (via `x-api-key` header) and support multi-channel notification dispatch.

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
- `dryRun`: Optional. When `true` (or `?dryRun=true`), validates the request and returns the parsed `symbol`/`exchange`/`timeframe` echo with `dryRun: true`, `decision: 'unknown'`, `volumeRatio: null`, and `analysis: null` — no MCP call is made. Useful for validating request shape before paying the ~360s MCP budget.

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
  "includeMultiTimeframe": true,
  "includeMultiAgent": true
}
```

- `dryRun`: Optional. When `true` (or `?dryRun=true`), validates the request and returns the parsed `symbol`/`exchange`/`timeframe`/`analysisMode`/`includeMultiTimeframe` echo with `dryRun: true`, `side: null`, `analysis: null`, and `analysisStatus: 'dry-run'` — no MCP `coin_analysis` (or `multi_timeframe_analysis`) call is made. Useful for probe requests that want to avoid the ~120s MCP budget.

The response includes `alertText`, normalized price/volume/indicator/signal/assessment data, sentiment/news/confluence, multi-timeframe results, and multi-agent consensus results (`multiAgent`) when requested (or when `ENABLE_SYMBOL_ANALYSIS_MULTI_AGENT=true`), plus directional `risk` and `decision` metadata. When multi-agent consensus disagrees with the directional signal (decision is `HOLD`, confidence is `Low`, or decision opposes side), an advisory warning (`Consenso multi-agente no confirma la señal`) is appended to `decision.warnings` without flipping the primary action. `decision.action` is `BUY` or `SELL` only when the data and risk levels are sufficient; otherwise it is `NO_TRADE`. This endpoint never delivers notifications or submits orders. Invalid symbols return `400 INVALID_REQUEST`, TradingView failures return `502 SYMBOL_ANALYSIS_FAILED`, and deadline expiry returns `504 SYMBOL_ANALYSIS_TIMEOUT`. Upstream multi-agent failures fail open and mark `analysisStatus: "partial"` while preserving the base analysis.

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

**Provider-outage fast-fail (502):**

Before starting the sequential scans the handler reads the process-local TradingView MCP status. When the status is `degraded` with `lastErrorCategory` of `http_5xx`, `request_failed`, or `circuit_breaker_open` **and** the circuit breaker still reports `state: "open"`, no scanner call is attempted: the endpoint returns `502 TRADINGVIEW_MCP_UNAVAILABLE` with every requested scan reported as `status: "skipped"` plus a `reason`.

```json
{
  "success": false,
  "code": "TRADINGVIEW_MCP_UNAVAILABLE",
  "error": "TradingView MCP is currently unavailable (circuit breaker: open, lastError: http_5xx). Scans skipped.",
  "scanResults": [
    { "scan": "top_gainers", "status": "skipped", "reason": "TradingView MCP is currently unavailable (circuit breaker: open, lastError: http_5xx). Scans skipped." }
  ],
  "timedOut": false
}
```

This endpoint returns `502` in two distinct shapes:

| `code` | Meaning |
|---|---|
| `TRADINGVIEW_MCP_UNAVAILABLE` | The readiness gate skipped every scan; **no** scanner call was attempted. |
| `ALL_SCANS_FAILED` | The scans were attempted and every one failed at the provider. |

**Self-recovery guarantee:** the gate is intentionally keyed on the circuit breaker's time-based state, not on the sticky `status: "degraded"` runtime flag. `getBreakerState()` moves `open` → `half-open` once `TRADINGVIEW_MCP_BREAKER_COOLDOWN_MS` elapses, so the first request after the cooldown is allowed through as a bounded recovery probe. A transient outage therefore always self-heals without a process restart, while a provider that is genuinely still down still fails fast instead of firing every scan at it. Degraded states outside the provider-outcome categories (for example `http_4xx`), a missing circuit-breaker state, and readiness-lookup errors all fail open and scan normally.

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

**Truncation metadata (GH-637).** `validateAlert()` clips alert text to 4,000 characters
(plus an ellipsis). When the submitted text exceeds that cap, the 200 response — and the
`dryRun=true` response — also carries `truncated: true`, `originalLength`, and
`deliveredLength` so the caller can detect the loss:

```json
{
  "success": true,
  "requestId": "0d63f03b-d5a2-4a0b-928d-1959b8eb6a95",
  "truncated": true,
  "originalLength": 4001,
  "deliveredLength": 4003,
  "results": [],
  "enriched": false
}
```

The fields are absent when the text fits. The service logs a structured warning and keeps
processing the validated text — truncation never blocks delivery or enrichment.

#### Per-symbol channel routing (`symbolRoutes`)

`POST /api/webhook/alert` accepts an optional `symbolRoutes` object to send different
symbols to different channels:

```json
{
  "text": "BINANCE:BTCUSDT breakout confirmed",
  "symbolRoutes": {
    "BTCUSDT": { "channels": ["telegram"] },
    "NASDAQ:NVDA": { "channels": ["discord"] }
  }
}
```

Keys are bare symbols (`BTCUSDT`) or exchange-qualified (`NASDAQ:NVDA`), matched
case-insensitively against the alert text. Digit-initial symbols are supported
(e.g. `1INCHUSDT`).

A dispatch is produced **only** for a symbol that matches one of the configured keys.
Text containing no configured route key is delivered normally through the request-level
`channels` or the enabled-channel broadcast — indicator words and other uppercase
tokens are not treated as symbols. Each delivery result includes the matched `symbol`
(bare form, so a `NASDAQ:NVDA` route reports `NVDA`).

When `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION` is enabled and it narrows the
request-level channel set, every `symbolRoutes` entry is intersected with the same set,
so a route cannot resurrect a channel that is still in its repeat-suppression cooldown.

Omitting `symbolRoutes` preserves the existing broadcast and request-level routing
behavior exactly.

#### Cross-timeframe duplicate collapse

`ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION` keys on `exchange|symbol|timeframe|side`, so a
symbol that fires the same direction on two *different* timeframes seconds apart is two
separate keys and both messages are delivered:

```
2026-08-31T00:00:25.419Z  BINANCE:BTCUSDT(D)   cambió a señal de VENTA
2026-08-31T00:00:25.845Z  BINANCE:BTCUSDT(240) pasó a señal de VENTA
```

Set `ENABLE_ALERT_CROSS_TF_SUPPRESSION=true` to collapse that pair. The rule keys on
`exchange|symbol|side` — timeframe deliberately excluded — over a window of
`ALERT_CROSS_TF_WINDOW_MS` (default `60000`, bounded `0`-`600000`).

**Collapse direction: the first arrival reserves, the later arrival is suppressed.**
Preferring the higher timeframe would mean holding every alert until the window
closed before deciding, which would add up to a full window of latency to the
delivery path. The first signal to arrive is therefore always delivered, and
every same-direction signal on any other timeframe inside the window is
suppressed against it.

Reservations are provisional: the gate keeps one entry per
`(exchange|symbol|side)` **and per `(channel, destination)`**, and any destination
whose delivery produced nothing is released again as soon as the response is
built.

| Property | Behavior |
| :--- | :--- |
| Suppressed response | `200` with `suppressedRepeat: true`, `suppressionReason: "cross_timeframe_duplicate"`, empty `results` and `deliveredChannels` |
| Persistence | Still persisted with the suppression marker, so replay and audit stay complete |
| Opposite side | Never collapsed; a delivered flip also clears the stale opposite-side entry |
| Same timeframe | Not this rule's job — that stays `ENABLE_ALERT_SIGNAL_REPEAT_SUPPRESSION` |
| Unmapped timeframes | Signals whose raw token does not map exactly (e.g. `3M`) never enter the store |
| Store failures | Fail open to normal delivery |
| Replicas | The store is in-process and per replica, so each replica may still deliver one copy |
| `dryRun` | Bypasses the gate entirely and does not consume the store |
| Keying boundary | `entry` price is ignored; acceptable inside a `60s` window |
| Destination scoping | Keyed per `(channel, destination)`, where destination is the request's `telegramChatId`/`telegramThreadId`, `whatsappChatId` or `discordWebhookUrl` override, else the channel default. A reservation made for one chat never suppresses a signal routed to another chat, and the rule is independent of the request-level `channels` list |
| Partly available destinations | Collapsed only when *every* requested destination is already held; otherwise the request is delivered and narrowed to the still-available channels (and any `symbolRoutes` entry is intersected with the same set) |
| Failed or zero-channel delivery | The reservation is released after the response when the destination notified nobody — a failed channel, a throwing dispatch, or a deployment that cannot deliver at all — so a leg that reached no trader cannot swallow the next signal on another timeframe. The reservation is kept only while the dead-letter redrive queue owns the retry (`ENABLE_NOTIFICATION_REDRIVE` with an active worker role) |

Both flags are Remote Config eligible and default to disabled, so existing CB-230
behavior is unchanged until an operator opts in.
### Same-direction burst aggregation

`ENABLE_ALERT_SYNTH_BURST_AGGREGATION=true` (default `false`) buffers a parsed
TradingView signal for `ALERT_BURST_WINDOW_MS` and collapses alerts sharing the same
direction and identical routing into one regime message per channel:

```json
{
  "success": true,
  "results": [ { "channel": "telegram", "success": true } ],
  "aggregated": true,
  "burstAggregateId": "3f6b2a1e-...",
  "burstSignalCount": 4,
  "requestedChannels": ["telegram"],
  "deliveredChannels": ["telegram"]
}
```

The delivered message lists every constituent symbol with its exchange and timeframe, so
nothing is lost:

```
⚡ Regime shift: RISK-OFF — 4 same-direction signals
Direction: SELL
Symbols:
BINANCE:BTCUSDT (1D), BINANCE:BTCUSDT (4h), BINANCE:ETHUSDT (4h), BINANCE:BNBUSDT (1D)
Window: 3000ms window, 2300ms span
```

Rules:

- **Grouping is by direction, not by exchange.** A risk-on or risk-off event spans asset
  classes at the same instant; grouping per venue would leave one message per asset class.
- **Routing must be identical.** Different `channels`, `telegramChatId`, `telegramThreadId`,
  `whatsappChatId` or `discordWebhookUrl` values are never merged, because one message can
  only have one destination. `symbolRoutes` requests bypass aggregation entirely.
- **Each constituent is still persisted** with the shared `burstAggregateId` and its own
  symbol, so `/api/alerts` analytics and signal outcomes stay per-symbol.
- **Fail-open everywhere.** A window that closes below `ALERT_BURST_MIN_SIGNALS`, a store
  error, a failed aggregate dispatch, and shutdown mid-window all deliver the held alerts
  individually. Aggregation can cost noise reduction, never an alert.
- **Dry-run requests are never buffered.**
- The added latency is bounded by `ALERT_BURST_WINDOW_MS`; unparsed alert text is not buffered
  at all. The buffer is in-process, so a multi-replica deployment may aggregate partially.

### POST /api/webhook/message

Deliver a generic, non-alert message to the enabled notification channels. Use this when the payload is
operator-authored automation output rather than a TradingView alert or scanner run.

**Request (JSON):**
```json
{
  "message": "Custom notification from automation",
  "channels": ["telegram", "whatsapp"]
}
```

- `message`: Required non-empty string. Values longer than `GENERIC_MESSAGE_MAX_LENGTH` (default 4,000; integer
  range 1-20,000) are clipped before delivery. A valid fresh Remote Config value takes precedence over the
  environment setting. Invalid environment values use 4,000; invalid Remote Config values are ignored, leaving
  the environment value (or 4,000 when unset/invalid) effective.
- `channels`: Optional subset of `telegram`, `whatsapp`, `discord`. Omit it to broadcast to every enabled channel.
- `telegramChatId` / `telegramThreadId` / `whatsappChatId` / `discordWebhookUrl`: Optional per-channel destination
  overrides. `telegramThreadId` targets a forum topic (`0` = General).
- `dryValidate`: Optional boolean. Validates and returns chunk estimates without sending anything.
- `dryRun`: Optional. See [Dry-run routing preview](#dry-run-routing-preview-issue-876) below.
- Idempotency: send `idempotency-key` / `x-idempotency-key` (or `idempotencyKey` in the body or query) to replay a
  prior response instead of re-delivering. Reusing a key with a different payload returns `409`.

**Response (message within the configured limit):**
```json
{
  "success": true,
  "results": [
    { "channel": "telegram", "success": true, "messageId": "tg-msg-123" }
  ]
}
```

**Response (message exceeded the configured limit):**
```json
{
  "success": true,
  "truncated": true,
  "originalLength": 6000,
  "deliveredLength": 4003,
  "results": [
    { "channel": "telegram", "success": true, "messageId": "tg-msg-123" }
  ]
}
```

**Truncation metadata (GH-602).** Inbound messages above `GENERIC_MESSAGE_MAX_LENGTH` are clipped to the configured
limit plus a `'...'` suffix before delivery, so `deliveredLength` is 4,003 with the default configuration. When truncation occurs the
response adds:

- `truncated`: Always `true` when present. Callers can use it to detect silent content loss.
- `originalLength`: Inbound character count before clipping (minimum 2 when the configured cap is 1).
- `deliveredLength`: Character count of the text actually handed to the notification channels.

These three fields are **strictly additive and appear only when truncation occurred** — a message that fits returns
`{ success: true, results }` unchanged, so existing integrations are unaffected. Truncation is independent of chunk
estimation: a long message that also exceeds a channel's single-message limit returns both the truncation fields and
the `delivered` / `channelDetails` / `estimatedChunks` metadata.

A `console.warn` line records the clip with numeric `originalLength`, `deliveredLength`, and `max` values only; message
content is never logged. Delivery proceeds with the clipped text regardless — truncation never blocks a send.

#### Dry-run routing preview (issue #876)

`POST /api/webhook/message?dryRun=true`, or `{"message": "…", "dryRun": true}` in the body, validates the request and
returns the routing it *would* have used. Nothing is sent, nothing is persisted, and no idempotency key is reserved or
cached — so a dry run can be repeated freely and the same key is still free for the real request afterwards.

**Response:**
```json
{
  "success": true,
  "dryRun": true,
  "estimatedChunks": { "telegram": 1, "whatsapp": 1, "discord": 1 },
  "requestedChannels": ["telegram", "whatsapp"],
  "deliveredChannels": [],
  "payload": { "text": "Deployment completed" },
  "routing": {
    "channels": ["telegram", "whatsapp"],
    "telegramChatId": "-1001234567890",
    "telegramThreadId": 101,
    "whatsappChatId": "120363000000000000@g.us",
    "discordWebhookUrlProvided": true
  },
  "requestId": "0d63f03b-d5a2-4a0b-928d-1959b8eb6a95"
}
```

- `requestedChannels`: the channels that would receive the message — the request's `channels` subset, or every enabled
  channel when the request broadcasts.
- `broadcast: true`: added only when no `channels` subset was requested, so an empty `requestedChannels` list is not
  mistaken for "nothing would be sent".
- `deliveredChannels`: always `[]`. `results` is absent, because nothing was dispatched.
- `payload.text`: the exact text that would have been handed to the channels, after any inbound truncation. The
  `truncated` / `originalLength` / `deliveredLength` fields appear here under the same conditions as a live send.
- `routing`: the resolved per-channel overrides from the request. Each key is absent when that destination was not
  overridden. A Discord webhook URL is itself the credential, so only `discordWebhookUrlProvided` is echoed — the URL is
  never returned (the same reason the persistence path does not store it).
- Channel and destination overrides are **still validated**, so a dry run is a routing test: an unknown channel, a
  malformed `discordWebhookUrl`, a negative `telegramThreadId`, or a requested channel that is disabled or
  misconfigured returns the same `400` a live request would.
- A `dryRun` value — in the **query string or the body** — that is neither a boolean nor the string `"true"` / `"false"`
  returns `400 INVALID_REQUEST` (`code: "INVALID_REQUEST"`, `retryable: false`, `details.field: "dryRun"`). It is **not**
  silently treated as a live request — a caller who intended a preview must never get a real delivery instead. This
  applies equally to `?dryRun=yes`, `?dryRun=1`, `?dryRun=FALSE`, and a bare `?dryRun` with no value, so the flag always
  has to carry an explicit value.
- When both `dryValidate` and `dryRun` are supplied, the narrower `dryValidate` response is returned.
- A dry run never initializes the notification channel services (that validates them against their providers), so
  channel *availability* is only asserted when the channel registry already exists on the process.

A dry run does not set the `Idempotency-Replay` header, because no reservation is taken.
