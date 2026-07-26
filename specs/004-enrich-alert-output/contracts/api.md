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
  "invalidation_level": "$80,000",
  "target_level": "$90,000",
  "setup_type": "breakout",
  "risk_reward_ratio": "2.5:1",
  "sources": [
    {
      "title": "CoinDesk",
      "url": "https://coindesk.com/...",
      "snippet": "..."
    }
  ]
}
```

Risk metadata is optional. `invalidation_level`, `target_level`, and `risk_reward_ratio`
accept a non-empty string or finite number; `setup_type` is one of `breakout`,
`mean_reversion`, `trend_continuation`, or `reversal`.
