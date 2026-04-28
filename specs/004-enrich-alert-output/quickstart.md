# Quickstart: Enrich Alert Output

## Overview

This feature enriches webhook alerts with sentiment analysis, key insights, and technical levels using Gemini Grounding.

## Configuration

Ensure the following environment variables are set:

- `ENABLE_GEMINI_GROUNDING=true`
- `GEMINI_API_KEY=your_api_key`

## Usage

### Sending an Alert

Send a POST request to `/api/webhook/alert` with a JSON body:

```json
{
  "text": "Bitcoin breaks above $83,000 resistance level with strong volume."
}
```

### Expected Output (Telegram)

The bot will reply with a formatted message:

```text
*Bitcoin breaks above $83,000 resistance level with strong volume.*

*Key Insights*
• Bitcoin price surged past $83k.
• Volume indicates strong momentum.

Sentiment: BULLISH 🚀 (0.85)

*Technical Levels*
Supports: $80,000
Resistances: $85,000

*Sources*
[CoinDesk](https://coindesk.com/...) / [CoinTelegraph](https://cointelegraph.com/...)
```

### Expected Output (WhatsApp)

If WhatsApp alerts are enabled (`ENABLE_WHATSAPP_ALERTS=true`), the message will be formatted as:

```text
*Bitcoin breaks above $83,000 resistance level with strong volume.*

*Key Insights*
• Bitcoin price surged past $83k.
• Volume indicates strong momentum.

Sentiment: BULLISH 🚀 (0.85)

*Technical Levels*
Supports: $80,000
Resistances: $85,000

*Sources*
CoinDesk: https://coindesk.com/...
CoinTelegraph: https://cointelegraph.com/...
```
