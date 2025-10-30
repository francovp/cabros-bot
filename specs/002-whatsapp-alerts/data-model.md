# Data Model: Multi-Channel Alerts (WhatsApp & Telegram)

**Branch**: `002-whatsapp-alerts` | **Date**: 2025-10-29  
**Purpose**: Define entities, relationships, validation rules, and state transitions for WhatsApp alert integration

---

## Core Entities

### 1. NotificationChannel (Abstract Base)

Defines the interface all notification channels must implement.

```javascript
class NotificationChannel {
  // Properties
  name: string;                          // Identifier: "telegram", "whatsapp"
  enabled: boolean;                      // Whether channel is configured
  
  // Methods
  isEnabled(): boolean;                  // Check if channel is ready to send
  send(alert: Alert): Promise<SendResult>; // Send alert; return result
  validate(): Promise<ValidationResult>; // Check config on startup
}
```

**Implementation Classes**:
- `TelegramService extends NotificationChannel`
- `WhatsAppService extends NotificationChannel`

---

### 2. WhatsAppService

Concrete implementation for GreenAPI integration.

```javascript
class WhatsAppService extends NotificationChannel {
  // Properties
  name = "whatsapp";
  apiUrl: string;                 // GreenAPI endpoint (e.g., https://7107.api.green-api.com/waInstance7107356806/sendMessage/)
  apiKey: string;                 // Auth key appended to URL
  chatId: string;                 // Destination chat/group ID (e.g., 120363xxxxx@g.us)
  enabled: boolean;
  
  // Config validation rules
  validate(): Promise<ValidationResult> {
    if (!process.env.ENABLE_WHATSAPP_ALERTS) {
      this.enabled = false;
      return { valid: true, message: "WhatsApp disabled via env" };
    }
    
    if (!this.apiUrl || !this.apiKey || !this.chatId) {
      return { 
        valid: false, 
        message: "Missing WHATSAPP_API_URL, WHATSAPP_API_KEY, or WHATSAPP_CHAT_ID",
        fields: { apiUrl: !!this.apiUrl, apiKey: !!this.apiKey, chatId: !!this.chatId }
      };
    }
    
    this.enabled = true;
    return { valid: true, message: "WhatsApp configured" };
  }
  
  // Send alert with retry logic
  send(alert: Alert): Promise<SendResult> {
    // Delegates to retryHelper.sendWithRetry()
    // Calls _sendSingle() with exponential backoff
    // Returns SendResult with success/error
  }
  
  // Internal: single send attempt
  private async _sendSingle(alert: Alert): Promise<SendResult> {
    const formattedText = whatsappMarkdownFormatter.format(alert.enriched || alert.text);
    const truncatedText = truncateMessageBody(formattedText, 20000);
    
    const payload = {
      chatId: this.chatId,
      message: truncatedText,
      customPreview: { title: "Trading View Alert" }
    };
    
    const response = await fetch(`${this.apiUrl}${this.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000) // 10s timeout
    });
    
    if (!response.ok) {
      throw new Error(`GreenAPI ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    return {
      success: data.success,
      messageId: data.idMessage,
      channel: "whatsapp",
      error: data.success ? undefined : `GreenAPI error: ${data.error}`
    };
  }
}
```

**Configuration (Environment Variables)**:
- `ENABLE_WHATSAPP_ALERTS`: `true` or `false` (default: `false`)
- `WHATSAPP_API_URL`: Base endpoint from GreenAPI account
- `WHATSAPP_API_KEY`: API key (appended to URL)
- `WHATSAPP_CHAT_ID`: Destination chat/group ID

---

### 3. TelegramService (Refactored)

Wraps existing Telegram `bot.telegram.sendMessage()` logic.

```javascript
class TelegramService extends NotificationChannel {
  name = "telegram";
  botToken: string;
  chatId: string;
  enabled: boolean;
  private bot: Telegraf;
  
  validate(): Promise<ValidationResult> {
    if (!process.env.BOT_TOKEN) {
      return { valid: false, message: "Missing BOT_TOKEN" };
    }
    
    if (!process.env.TELEGRAM_CHAT_ID) {
      return { valid: false, message: "Missing TELEGRAM_CHAT_ID" };
    }
    
    this.enabled = true;
    return { valid: true, message: "Telegram configured" };
  }
  
  async send(alert: Alert): Promise<SendResult> {
    const formattedText = markdownV2Formatter.format(alert.enriched || alert.text);
    
    try {
      const result = await this.bot.telegram.sendMessage(this.chatId, formattedText, {
        parse_mode: 'MarkdownV2'
      });
      
      return {
        success: true,
        messageId: String(result.message_id),
        channel: "telegram"
      };
    } catch (error) {
      return {
        success: false,
        channel: "telegram",
        error: `Telegram error: ${error.message}`
      };
    }
  }
}
```

**Configuration (Environment Variables)**:
- `BOT_TOKEN`: Telegraf bot token (existing)
- `TELEGRAM_CHAT_ID`: Alert channel ID (existing)
- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID`: Admin notification channel (existing)

---

### 4. Alert

Represents an incoming alert webhook (refined).

```javascript
interface Alert {
  // Raw content
  text: string;                          // Alert message body from webhook (max 20K after truncation)
  
  // Optional enrichment
  enriched?: EnrichedAlert;              // Gemini grounding data (if enabled)
  
  // Metadata
  metadata?: {
    source?: string;                     // e.g., "TradingView"
    webhookId?: string;                  // e.g., "tv_alert_123"
    receivedAt?: Date;                   // Timestamp when webhook arrived
    contentHash?: string;                // For deduplication (optional)
  };
}

interface EnrichedAlert {
  // Content enriched by Gemini
  summary?: string;                      // Brief summary
  context?: string;                      // Trading context / analysis
  confidence?: number;                   // Confidence score 0-1 (if applicable)
  timestamp?: Date;                      // When enrichment was generated
}
```

**Validation Rules**:
- `text`: Required, non-empty, max 20,000 characters
- `enriched`: Optional; if present, must have non-empty `summary` or `context`
- `metadata.source`: Optional, string
- `metadata.webhookId`: Optional, string (useful for tracing)

---

### 5. SendResult

Result of attempting to send alert to a single channel.

```javascript
interface SendResult {
  // Outcome
  success: boolean;                      // Whether send succeeded
  
  // Channel info
  channel: string;                       // "telegram" or "whatsapp"
  
  // Success details
  messageId?: string;                    // Message ID from platform (if successful)
  
  // Error details
  error?: string;                        // Error message (if failed)
  
  // Timing (optional, for monitoring)
  attemptCount?: number;                 // Number of send attempts
  durationMs?: number;                   // Total time from start to final result
}
```

**Example**:
```javascript
// Success
{ success: true, channel: "whatsapp", messageId: "true_120363xxxxx_BAE...", attemptCount: 1, durationMs: 1250 }

// Failure after retries
{ success: false, channel: "whatsapp", error: "Max retries exhausted (3)", attemptCount: 3, durationMs: 7450 }
```

---

### 6. NotificationManager

Orchestrates multi-channel sending.

```javascript
class NotificationManager {
  private channels: Map<string, NotificationChannel>; // { "telegram": TelegramService, "whatsapp": WhatsAppService }
  
  constructor(telegramService: TelegramService, whatsappService: WhatsAppService) {
    this.channels = new Map([
      ["telegram", telegramService],
      ["whatsapp", whatsappService]
    ]);
  }
  
  // Validate all channels on startup
  async validateAll(): Promise<ValidationResult[]> {
    return Promise.all(
      Array.from(this.channels.values()).map(ch => ch.validate())
    );
  }
  
  // Send alert to all enabled channels
  async sendToAll(alert: Alert): Promise<SendResult[]> {
    // Single grounding request (if enrichment needed)
    if (!alert.enriched && process.env.ENABLE_GROUNDING === 'true') {
      alert.enriched = await groundingService.enrich(alert.text);
    }
    
    // Send to all enabled channels in parallel
    const sendPromises = Array.from(this.channels.values())
      .filter(ch => ch.isEnabled())
      .map(ch => ch.send(alert));
    
    return Promise.allSettled(sendPromises)
      .then(results => results.map((r, idx) => r.status === 'fulfilled' ? r.value : {
        success: false,
        channel: Array.from(this.channels.keys())[idx],
        error: r.reason?.message || 'Unknown error'
      }));
  }
  
  // Get enabled channels
  getEnabledChannels(): string[] {
    return Array.from(this.channels.values())
      .filter(ch => ch.isEnabled())
      .map(ch => ch.name);
  }
}
```

---

## Formatters

### MarkdownV2Formatter

Converts raw/enriched alert text to Telegram MarkdownV2 format.

```javascript
class MarkdownV2Formatter {
  format(text: string): string {
    // Escape special MarkdownV2 characters: _ * [ ] ( ) ~ ` > # + - = | { } . !
    // Apply existing Telegram formatting rules
    // Return escaped, formatted text
  }
}
```

**Existing Implementation**: Refactor from `src/controllers/webhooks/handlers/alert/alert.js`

---

### WhatsAppMarkdownFormatter

Converts enriched alert text to WhatsApp markdown format.

```javascript
class WhatsAppMarkdownFormatter {
  format(text: string): string {
    // Parse MarkdownV2 tokens or raw text
    // Convert supported formats:
    //   *bold* → *bold* (MarkdownV2 to WhatsApp)
    //   _italic_ → _italic_
    //   ~strikethrough~ → ~strikethrough~
    //   `code` → `code`
    //   > quote → > quote
    //
    // Strip unsupported:
    //   __underline__ → underline (plain text)
    //   [link](url) → link (plain text)
    //   Nested formats → flatten to single format
    //
    // Return WhatsApp-compatible text
    // Log conversions (e.g., "Stripped 1 link, 1 underline")
  }
}
```

---

## Utility: RetryHelper

Implements exponential backoff retry logic.

```javascript
async function sendWithRetry(
  sendFn: () => Promise<SendResult>,
  maxRetries: number = 3,
  logger: Logger
): Promise<SendResult> {
  let lastResult: SendResult;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      lastResult = await sendFn();
      
      if (lastResult.success) {
        return lastResult;
      }
      
      // Failure; retry if attempts remain
      if (attempt < maxRetries) {
        const baseDelay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        const jitter = baseDelay * (Math.random() * 0.2 - 0.1);
        const delayMs = Math.round(baseDelay + jitter);
        
        logger.warn(`Retry ${attempt}/${maxRetries}: ${lastResult.channel} send failed. Retrying in ${delayMs}ms`, {
          error: lastResult.error
        });
        
        await sleep(delayMs);
      }
    } catch (error) {
      logger.error(`Attempt ${attempt}/${maxRetries} threw exception`, { error: error.message });
      lastResult = {
        success: false,
        channel: "unknown",
        error: error.message
      };
    }
  }
  
  logger.error(`All ${maxRetries} retries exhausted`, { lastResult });
  return lastResult;
}
```

---

## Relationships & State Transitions

### Alert Lifecycle

```
1. Webhook Received (Raw)
   └─ text: raw alert
   └─ enriched: null
   
2. Enriched (if ENABLE_GROUNDING=true)
   └─ text: raw alert
   └─ enriched: { summary, context, timestamp }
   
3. Sent to Telegram (formatted with MarkdownV2)
   └─ channel: telegram
   └─ success: true/false
   
4. Sent to WhatsApp (formatted with WhatsApp markdown)
   └─ channel: whatsapp
   └─ success: true/false
   
5. Final Result
   └─ results: [SendResult, SendResult]
   └─ If all failed: notify admin via Telegram
   └─ Always: return 200 OK to webhook caller
```

### Channel Initialization

```
Application Start
  ↓
LoadConfig (env vars)
  ↓
CreateServices (Telegram, WhatsApp)
  ↓
ValidateAll (each channel checks credentials)
  ├─ Telegram: valid → enabled
  ├─ WhatsApp: valid → enabled
  └─ Any missing: log warning, disabled
  ↓
RegisterWebhookHandler (/api/webhook/alert)
  └─ Ready to receive alerts
```

---

## Validation Rules Summary

| Entity | Field | Rule | Example |
|--------|-------|------|---------|
| Alert | text | Required, non-empty, ≤20K chars | "BTC alert..." |
| Alert | enriched.summary | Optional, non-empty if present | "Price breakout" |
| WhatsAppService | apiUrl | Required if enabled, valid URL | "https://7107.api..." |
| WhatsAppService | apiKey | Required if enabled, non-empty | "your-api-key" |
| WhatsAppService | chatId | Required if enabled, format `\d+@g.us` | "120363xxxxx@g.us" |
| TelegramService | botToken | Required, valid Telegram token | "1234567890:ABCdef..." |
| TelegramService | chatId | Required, valid Telegram chat ID | "-1001234567890" |

---

## Constraints & Limits

| Constraint | Value | Source |
|-----------|-------|--------|
| Message body length | 20,000 chars | GreenAPI JSON limit (100KB total) |
| Message truncation indicator | "…" | Spec FR-010a |
| Preview title length | No pre-validation | Trust GreenAPI (spec clarification) |
| Retry delays | 1s → 2s → 4s | Spec clarification Q1 |
| Max retry attempts | 3 | Spec FR-008 |
| Max total retry time | ~7 seconds | 1 + 2 + 4 = 7s |
| GreenAPI rate limit | 50 RPS | GreenAPI docs, spec research |
| HTTP timeout | 10 seconds | Reasonable for GreenAPI (~2s typical) |
| Grounding requests | 1 per alert | Spec clarification Q5 |

