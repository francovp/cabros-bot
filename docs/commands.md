# Telegram Bot Commands Reference

[← Back to README](../README.md)

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

### /outcomes `<symbol>` (alias: `/rendimiento`)

Query recent evaluated signal outcomes for a symbol in chat (hits `GET /api/outcomes`).

**Example:**
```
/outcomes BINANCE:BTCUSDT
```

---

## WhatsApp Inbound Command Bridge

`ENABLE_WHATSAPP_COMMANDS=true` enables a bridge that polls GreenAPI `receiveNotification` and executes commands typed with a `!` prefix from chats allowlisted in `WHATSAPP_COMMAND_CHAT_IDS`.

The bridge does **not** reimplement the handlers above. It synthesizes a Telegraf-shaped command context and delegates to the same `expandedAnalysisCmd`, `marketScannerCmd`, `newsMonitorCmd` and `outcomesCommand` functions Telegram uses, so the reply body and every internal timeout are identical on both channels.

**Mapping:**

| WhatsApp | Telegram command | Aliases |
| :--- | :--- | :--- |
| `!precio <symbol>` | `/precio` | — |
| `!analisis [symbols]` | `/analisis` | — |
| `!scanner [options]` | `/scanner` | — |
| `!noticias [symbols]` | `/noticias` | `!news` |
| `!outcomes <symbol>` | `/outcomes` | `!rendimiento` |
| `!help` | `/help` | `!start` |

**Delivery routing.** A job created from WhatsApp carries `channels: ['whatsapp']` and the originating chat id, so its completion report returns to the chat that requested it. Telegram callers are unaffected and keep their existing `telegramChatId` routing.

**Differences from Telegram, and why:**

- **Replies are formatted for WhatsApp.** Telegram bodies arrive as MarkdownV2; `WhatsAppMarkdownFormatter` strips the escape sequences, so `*bold*` and `_italic_` render natively and `\(...\)` becomes `(...)`.
- **No `parse_mode` is forwarded.** `parse_mode` is a Telegram concept; the shim ignores it and lets the WhatsApp channel's own formatter handle the body.
- **`!outcomes` without a symbol replies with usage** rather than delegating, because the shared Telegram usage string references a `/outcomes` verb that does not exist on WhatsApp.
- **`!analisis` with no symbols is accepted**, exactly as Telegram is, and falls back to `EXPANDED_ANALYSIS_ALERT_SYMBOLS`.

**Guardrails.** Allowlisted chats only; 10 commands per chat per minute; an unrecognized command gets a hint at most once per chat per 60s cooldown; non-`!` messages are ignored silently. Each command runs under a bounded 120s deadline: on expiry the chat is told the command is still processing, `dependencies.whatsappCommandBridge.commandTimeouts` increments, and a Sentry `command_timeout` event is captured. The underlying handler is not cancelled, so a late reply may still arrive.
