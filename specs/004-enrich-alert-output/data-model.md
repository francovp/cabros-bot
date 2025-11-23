# Data Model: Enrich Alert Output

## Entities

### EnrichedAlert

Represents the structured data extracted from an alert.

| Field | Type | Description |
|---|---|---|
| `original_text` | `string` | The raw text of the alert. |
| `sentiment` | `string` | Sentiment of the alert: `BULLISH`, `BEARISH`, `NEUTRAL`. |
| `insights` | `string[]` | List of 1-3 key insights or summary points. |
| `technical_levels` | `object` | Object containing `supports` and `resistances` arrays. |
| `sources` | `Source[]` | List of verified sources used for grounding. |

### Source

Represents a citation source.

| Field | Type | Description |
|---|---|---|
| `title` | `string` | Title of the source page. |
| `url` | `string` | URL of the source. |
| `snippet` | `string` | Short snippet from the source (optional). |

## JSON Schema (Gemini Output)

```json
{
  "type": "object",
  "properties": {
    "sentiment": {
      "type": "string",
      "enum": ["BULLISH", "BEARISH", "NEUTRAL"]
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
    }
  }
}
```
