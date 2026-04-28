# API Contracts

## Webhook Endpoint

The webhook endpoint `/api/webhook/alert` remains unchanged from the definition in `specs/002-whatsapp-alerts/contracts/alert-webhook.openapi.yml`.

## Internal Data Contracts

### EnrichedAlert Structure

The `alert.enriched` object passed to formatters will have the following structure:

```json
{
  "original_text": "Bitcoin breaks above $83,000...",
  "sentiment": "BULLISH",
  "insights": [
    "Bitcoin price surged past $83k.",
    "Volume indicates strong momentum."
  ],
  "technical_levels": {
    "supports": ["$80,000"],
    "resistances": ["$85,000"]
  },
  "sources": [
    {
      "title": "CoinDesk",
      "url": "https://coindesk.com/...",
      "snippet": "..."
    }
  ]
}
```
