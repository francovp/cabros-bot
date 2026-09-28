# Multi-Channel Alerts Guide

[← Back to README](../README.md)

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

**Message Chunking**: Payloads exceeding provider length limits (20,000 characters for WhatsApp, 2,000 characters for Discord) are automatically split into sequential chunks that deliver and retry independently; earlier delivered chunks are preserved if a later chunk fails. When the redrive worker retries a dead-lettered chunked delivery, it resumes from the first undelivered chunk instead of replaying chunks already received by the chat (legacy dead-letter records without chunk metadata fall back to a full replay and are logged).

**Graceful Degradation**: If one channel fails
- Other channels still receive the alert
- Response includes per-channel results
- HTTP 200 OK returned (fail-open pattern)
- Failures logged at WARN/ERROR level
- If `channels` is omitted in the generic message webhook, delivery fans out to every enabled channel
- Successful generic-message deliveries are persisted as `source: webhook-message` when Firestore alert storage is enabled, without delaying the response

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
