# Cabros Crypto Bot

Express + Telegraf-based Telegram bot service with multi-channel alert delivery (Telegram and WhatsApp).

## Features

- 📱 **Multi-Channel Alerts**: Send trading alerts to both Telegram and WhatsApp
- 🚀 **Webhook API**: HTTP endpoint for receiving alerts from external services (e.g., TradingView)
- 🧠 **AI Grounding**: Optional enrichment of alerts using Google Gemini API
- ⚡ **Retry Logic**: Automatic retry with exponential backoff for failed deliveries
- 🔄 **Graceful Degradation**: Continue operating if one channel is unavailable

## Environment Configuration

### Required Variables

- `BOT_TOKEN` - Telegram bot token (from BotFather)
- `TELEGRAM_CHAT_ID` - Telegram chat ID where alerts are sent
- `ENABLE_TELEGRAM_BOT` - Enable Telegram bot (`true` or `false`)

### Optional Variables

#### WhatsApp Alerts (GreenAPI)

- `ENABLE_WHATSAPP_ALERTS` - Enable WhatsApp alerts (`true` or `false`, default: `false`)
- `WHATSAPP_API_URL` - GreenAPI endpoint URL (e.g., `https://7107.api.green-api.com/waInstance7107356806/`)
- `WHATSAPP_API_KEY` - GreenAPI API key for authentication
- `WHATSAPP_CHAT_ID` - Destination WhatsApp chat/group ID (format: `120363xxxxx@g.us`)

#### AI Grounding

- `ENABLE_GEMINI_GROUNDING` - Enable Gemini-based alert enrichment (`true` or `false`)
- `GOOGLE_API_KEY` - Google API key for Gemini access

#### Admin Notifications

- `TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID` - Chat ID for admin notifications and deployment alerts

#### Server Configuration

- `PORT` - HTTP server port (default: `80`)
- `RENDER` - Render.com deployment flag (used internally)
- `IS_PULL_REQUEST` - Render preview environment flag (disables bot in PRs)

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Create `.env` File

```bash
# Required
BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=-1001234567890
ENABLE_TELEGRAM_BOT=true

# Optional: WhatsApp Alerts
ENABLE_WHATSAPP_ALERTS=false
WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107356806/
WHATSAPP_API_KEY=your_greenapi_key_here
WHATSAPP_CHAT_ID=120363xxxxx@g.us

# Optional: Admin notifications
TELEGRAM_ADMIN_NOTIFICATIONS_CHAT_ID=-1009876543210

# Optional: AI Grounding
ENABLE_GEMINI_GROUNDING=false
GOOGLE_API_KEY=your_google_api_key_here
```

### 3. Run Development Server

```bash
npm run start-dev
```

### 4. Run Production Server

```bash
npm start
```

## API Endpoints

### POST /healthcheck

Health check endpoint.

**Response:**
```json
{"uptime":"..."}
```

### POST /api/webhook/alert

Send alert via webhook. Accepts either JSON or plain text.

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

## Commands

### /precio `<symbol>`

Get crypto price from Binance.

**Example:**
```
/precio BTCUSDT
```

**Response:**
```
Precio de BTCUSDT es $45,000.50
```

### /cryptobot

Crypto bot help command.

## Running Tests

```bash
# Run all tests
npm test

# Run with watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```

## Architecture

### Notification Services

- **NotificationChannel**: Abstract base class for notification channels
- **TelegramService**: Implements Telegram delivery via Telegraf bot
- **WhatsAppService**: Implements WhatsApp delivery via GreenAPI
- **NotificationManager**: Orchestrates sending to multiple channels in parallel

### Supporting Utilities

- **retryHelper**: Exponential backoff retry logic (1s → 2s → 4s)
- **messageHelper**: Message truncation and formatting
- **MarkdownV2Formatter**: Telegram MarkdownV2 text escaping
- **WhatsAppMarkdownFormatter**: WhatsApp markdown conversion

### Alert Processing

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
TELEGRAM_CHAT_ID=-1001234567890
ENABLE_TELEGRAM_BOT=true

ENABLE_WHATSAPP_ALERTS=true
WHATSAPP_API_URL=https://7107.api.green-api.com/waInstance7107356806/
WHATSAPP_API_KEY=your_greenapi_key
WHATSAPP_CHAT_ID=120363xxxxx@g.us
```

### With Gemini Enrichment

```bash
ENABLE_GEMINI_GROUNDING=true
GOOGLE_API_KEY=your_google_api_key

# Alerts will be enriched with AI analysis before sending
```

## Deployment

### Render.com

The application includes support for Render.com deployment:

- Respects `RENDER` environment variable
- Skips bot launch in preview environments (`IS_PULL_REQUEST=true`)
- Sends deployment notification to admin chat on startup

### Local Development

```bash
# Start dev server with auto-reload
npm run start-dev

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

### Logs

The application logs to stdout:

- `INFO`: Bot initialization, webhook received, alerts sent
- `DEBUG`: Detailed processing steps
- `WARN`: Configuration warnings, retry attempts
- `ERROR`: Delivery failures, API errors

## Troubleshooting

### WhatsApp Alerts Not Sending

1. Verify `ENABLE_WHATSAPP_ALERTS=true`
2. Check `WHATSAPP_API_URL`, `WHATSAPP_API_KEY`, `WHATSAPP_CHAT_ID` are set
3. Test GreenAPI connection: `curl -X POST https://api.green-api.com/...`
4. Check application logs for detailed error messages

### Telegram Alerts Not Sending

1. Verify `BOT_TOKEN` is correct (from BotFather)
2. Verify `TELEGRAM_CHAT_ID` is correct (use `/start` to find)
3. Ensure bot has permission to send messages to the chat
4. Check Telegram API status

### Retry Logic

- Failed alerts automatically retry up to 3 times
- Each retry waits: 1s, then 2s, then 4s
- ±10% jitter prevents thundering herd
- All retries logged at WARN/ERROR level

## Development

### Project Structure

```
.
├── index.js                              # App entry point
├── app.js                                # Express setup
├── src/
│   ├── controllers/                      # Request handlers
│   │   ├── commands.js                   # Telegram commands
│   │   └── webhooks/
│   │       └── handlers/alert/
│   │           ├── alert.js              # Alert webhook handler
│   │           └── grounding.js          # Gemini integration
│   ├── services/
│   │   ├── notification/                 # Multi-channel services
│   │   │   ├── NotificationChannel.js    # Abstract base
│   │   │   ├── TelegramService.js        # Telegram impl
│   │   │   ├── WhatsAppService.js        # WhatsApp impl
│   │   │   ├── NotificationManager.js    # Orchestrator
│   │   │   └── formatters/
│   │   │       ├── markdownV2Formatter.js
│   │   │       └── whatsappMarkdownFormatter.js
│   │   └── grounding/                    # Gemini enrichment
│   ├── lib/                              # Utilities
│   │   ├── retryHelper.js
│   │   ├── messageHelper.js
│   │   └── validation.js
│   └── routes/
│       └── index.js                      # Route definitions
└── tests/                                # Test suites
    ├── unit/
    └── integration/
```

## License

ISC