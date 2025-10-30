# Research: Multi-Channel Alerts (WhatsApp & Telegram)

**Branch**: `002-whatsapp-alerts` | **Date**: 2025-10-29  
**Purpose**: Resolve technical unknowns and document best practices for WhatsApp + Telegram dual-channel alert delivery

---

## Research Topic 1: Native Fetch API for GreenAPI Integration

**Decision**: Use native Node.js fetch (no external HTTP client library)

**Rationale**:

- Node.js 18+ (current project uses 20.x) has built-in `fetch()` API
- No additional dependency; reduces `package.json` bloat
- Constitution mandates simplicity & minimalism
- Sufficient for straightforward HTTP POST to GreenAPI

**Best Practices**:
- Always use `AbortController` with timeout for reliability (default: 10s, GreenAPI typically responds <2s)
- Wrap fetch calls in try-catch to handle network errors
- Log both successful and failed requests with request ID for tracing
- Use JSON.stringify for request body; parse response as JSON

**Implementation Pattern**:
```javascript
// Example from GreenAPI docs
const url = `${WHATSAPP_API_URL}${WHATSAPP_API_KEY}`;
const payload = {
  chatId: WHATSAPP_CHAT_ID,
  message: text,
  customPreview: { title: "Trading View Alert" }
};

const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10000);

try {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: controller.signal
  });
  clearTimeout(timeoutId);
  
  if (!response.ok) {
    throw new Error(`GreenAPI returned ${response.status}`);
  }
  
  return await response.json(); // { success, message, idMessage }
} catch (error) {
  // Handle timeout, network, or API errors
}
```

**Fallback for Older Node**: Project already requires Node 20.x; fetch is native and stable.

---

## Research Topic 2: MarkdownV2 to WhatsApp Markdown Conversion

**Decision**: Create a dedicated formatter module to convert Telegram MarkdownV2 to WhatsApp markdown

**Rationale**:
- Telegram uses `*bold*`, `_italic_`, `__underline__`, `~strikethrough~`, `` `code` ``, ` ```pre``` `
- WhatsApp supports: `*bold*`, `_italic_`, `~strikethrough~`, `` `code` ``, ` ```monospace``` `
- GreenAPI docs confirm limited markdown support (no underline, no links, no nested formatting)
- Need explicit conversion to avoid MarkdownV2 syntax breaking in WhatsApp

**Supported Features (WhatsApp via GreenAPI)**:
| Format | WhatsApp Syntax | Telegram MarkdownV2 | Mapping |
|--------|-----------------|---------------------|---------|
| Bold | `*text*` | `*text*` | Direct match ✅ |
| Italic | `_text_` | `_text_` | Direct match ✅ |
| Strikethrough | `~text~` | `~text~` | Direct match ✅ |
| Monospace | `` `text` `` | `` `text` `` | Direct match ✅ |
| Code block | ` ```text``` ` | ` ```text``` ` | Direct match ✅ |
| Underline | (not supported) | `__text__` | Strip to plain text |
| Links | (not supported) | `[text](url)` | Strip to plain text |
| Nested | (not supported) | `*_text_*` | Flatten to single format |
| Quotes | `> text` | (not in MarkdownV2) | Add if present in enrichment |

**Implementation Strategy**:
1. Parse Telegram MarkdownV2 tokens (bold, italic, code, etc.)
2. For each token: convert if supported in WhatsApp, else extract plain text
3. Reconstruct message with WhatsApp markdown syntax
4. Log conversion when stripping occurs (e.g., "Stripped 2 links, 1 underline")

**Example Conversion**:
```
Input (Telegram MarkdownV2):
  "*Alert:* _Price_ __below__ $10K [view](url)"

Output (WhatsApp Markdown):
  "*Alert:* _Price_ below $10K view"
  (Stripped: 1 underline, 1 link)

Reason: WhatsApp doesn't support underline or links
```

**Fallback**: If conversion fails, send original text as-is (fail-open, not fail-closed)

---

## Research Topic 3: Retry Strategy with Exponential Backoff

**Decision**: Per-message exponential backoff (1s → 2s → 4s, max 3 retries); no global queue

**Rationale**:
- Clarification Q1 confirmed this approach
- GreenAPI 50 RPS limit is sufficient for typical alert volumes
- Per-message backoff is simpler than distributed queueing for MVP
- Per-message approach doesn't block other alerts if one fails

**Best Practices** (from Node.js patterns):
1. Start with base delay (1s)
2. Multiply by 2 for each retry (exponential)
3. Add small random jitter (±10%) to prevent thundering herd
4. Respect max retries limit (3 total attempts = 1 + 2 + 4 = 7 seconds max)
5. Log each attempt: "Retry 1/3: WhatsApp send failed, retrying in 1.2s"

**Implementation Pattern**:
```javascript
async function sendWithRetry(alert, channel, maxRetries = 3) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await channel.send(alert); // Returns { success, messageId, error? }
    } catch (error) {
      lastError = error;
      
      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        const jitter = baseDelay * (Math.random() * 0.2 - 0.1); // ±10%
        const delayMs = baseDelay + jitter;
        
        logger.info(`Retry ${attempt}/${maxRetries}: ${channel.name} send failed. Retrying in ${delayMs}ms`, { error: error.message });
        
        await sleep(delayMs);
      }
    }
  }
  
  // All retries exhausted
  logger.error(`${channel.name} send failed after ${maxRetries} attempts`, { error: lastError.message });
  return { success: false, channel: channel.name, error: lastError.message };
}
```

**Rate Limit Handling**: If GreenAPI returns 429 (rate limit), it's treated like any other error. Per-message backoff will naturally respect the 50 RPS limit. If 429 persists across all retries, the message is marked failed and admin notified.

---

## Research Topic 4: Single Grounding Request, Multi-Channel Reuse

**Decision**: Request grounding once; reuse enriched data for both Telegram and WhatsApp

**Rationale**:
- Clarification Q5 confirmed this approach
- Reduces Gemini API calls (cost, latency)
- Simplifies enrichment logic: one code path, two formatters
- Both channels display the same enriched content, just formatted differently

**Implementation Strategy**:
1. Receive raw alert at webhook
2. Check if `ENABLE_GROUNDING=true` (existing env var)
3. If enabled: request grounding from Gemini, store in `enriched` field
4. Create both notifications (Telegram + WhatsApp) from same `enriched` data
5. Format each notification independently:
   - Telegram: apply MarkdownV2 formatter to enriched text
   - WhatsApp: apply WhatsApp markdown formatter to enriched text

**Alert Data Structure**:
```javascript
const alert = {
  text: "BTC/USDT trading alert: price broke $45K support...",
  enriched: {
    summary: "BTC support broken",
    context: "Major downtrend signal",
    timestamp: "2025-10-29T10:00:00Z"
  },
  metadata: { source: "TradingView", webhookId: "tv_alert_123" }
};
```

---

## Research Topic 5: Error Handling & Admin Notifications

**Decision**: Log all errors; notify admin via Telegram if WhatsApp fails; return 200 OK to webhook caller

**Rationale**:
- Clarification Q1 & Q4 confirmed this approach
- Webhook caller (TradingView) should get 200 OK regardless of delivery outcome (fail-open)
- Admin notification via Telegram (existing channel) leverages infrastructure
- Prevents notification loop (WhatsApp failure → WhatsApp notification failure)

**Notification Payload** (to Telegram admin):
```
⚠️ WhatsApp Alert Delivery Failed

Alert ID: tv_alert_123
Chat ID: 120363xxxxx@g.us
Attempts: 3/3 failed
Final Error: Request timeout after 10s

Last Attempt: 2025-10-29T10:00:07Z
Webhook Received: 2025-10-29T10:00:00Z

Action: Check GreenAPI status, credentials, and network.
```

**Logging Strategy**:
- SUCCESS: Log at INFO level with messageId, duration
- RETRY: Log at WARN level with attempt number, error, delay
- FAILURE: Log at ERROR level with all context (alert ID, attempts, final error)
- Use structured logging (JSON format) for Datadog/monitoring

---

## Summary of Unknowns Resolved

| Unknown | Resolution | Status |
|---------|-----------|--------|
| HTTP client library | Use native fetch (no dependency) | ✅ RESOLVED |
| MarkdownV2 conversion | Create dedicated formatter, strip unsupported syntax | ✅ RESOLVED |
| Retry strategy | Per-message exponential backoff (1s→2s→4s, max 3) | ✅ RESOLVED |
| Grounding reuse | Single request; reuse data for both channels | ✅ RESOLVED |
| Admin notifications | Via Telegram; log all attempts | ✅ RESOLVED |
| HTTP timeout | 10 seconds (GreenAPI typically responds <2s) | ✅ RESOLVED |
| Error response handling | Treat 429/5xx like other errors; retry; fail gracefully | ✅ RESOLVED |

**Gate**: All research complete. Proceed to Phase 1 (Design & Contracts).
