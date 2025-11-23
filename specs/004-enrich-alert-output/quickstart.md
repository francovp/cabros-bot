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

**Bitcoin breaks above $83,000 resistance level with strong volume.**

🟢 **Sentiment:** BULLISH

💡 **Key Insights:**
• Bitcoin price surged past $83k.
• Volume indicates strong momentum.

📊 **Technical Levels:**
• Support: $80,000
• Resistance: $85,000

🔗 **Sources:**
• [CoinDesk](https://coindesk.com/...)
