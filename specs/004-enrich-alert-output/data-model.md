# Data Model: Enrich Alert Output

## Entities

### EnrichedAlert

Represents the structured data extracted from an alert.

| Field | Type | Description |
|---|---|---|
| `original_text` | `string` | The raw text of the alert as received by `/api/webhook/alert`. |
| `sentiment` | `string` | Sentiment of the alert: `BULLISH`, `BEARISH`, `NEUTRAL`. |
| `sentiment_score` | `number` | Confidence score between 0.0 and 1.0 for the sentiment classification. |
| `insights` | `string[]` | List of 1-3 key insights or summary points. |
| `technical_levels` | `object` | Object containing `supports` and `resistances` arrays. |
| `invalidation_level` | `string \| number` (optional) | Price level where the setup is invalidated. |
| `target_level` | `string \| number` (optional) | Primary profit target for the setup. |
| `setup_type` | `string` (optional) | One of `breakout`, `mean_reversion`, `trend_continuation`, or `reversal`. |
| `risk_reward_ratio` | `string \| number` (optional) | Estimated risk/reward ratio, such as `2.5:1`. |
| `sources` | `Source[]` | List of verified sources derived from `searchResults` returned by `genaiClient.search`. |

### Source

Represents a citation source.

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Title of the source page. |
| `url` | `string` | URL of the source. |
| `snippet` | `string` | Short snippet from the source (optional, typically taken from grounded search snippets). |

## JSON Schema (Gemini Output)

> Note: `original_text` and `sources` are not returned by Gemini in the JSON schema. `original_text` comes from the webhook request body, and `sources` are constructed locally from `searchResults` returned by `genaiClient.search`.

```json
{
  "type": "object",
  "properties": {
    "sentiment": {
      "type": "string",
      "enum": ["BULLISH", "BEARISH", "NEUTRAL"]
    },
    "sentiment_score": {
      "type": "number",
      "minimum": 0.0,
      "maximum": 1.0
    },
    "insights": {
      "type": "array",
      "items": { "type": "string" },
      "maxItems": 3
    },
    "technical_levels": {
      "type": "object",
      "properties": {
        "supports": { "type": "array", "items": { "type": "string" } },
        "resistances": { "type": "array", "items": { "type": "string" } }
      }
    },
    "invalidation_level": { "type": ["string", "number"] },
    "target_level": { "type": ["string", "number"] },
    "setup_type": {
      "type": "string",
      "enum": ["breakout", "mean_reversion", "trend_continuation", "reversal"]
    },
    "risk_reward_ratio": { "type": ["string", "number"] }
  }
}
```
