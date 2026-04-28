# 004-webhook-alert-footer-enhancement: Add Model Metadata to Message Footers

## Summary

Enhance webhook and alert event message footers by adding "Model Confidence" and "Model used" information, providing transparency about the AI model's analysis and confidence levels, consistent with the news-monitor event implementation.

## Key Changes

### 📊 Message Footer Enhancement

- Add "Model Confidence" field displaying the confidence score (0-1 or percentage) from AI analysis
- Add "Model used" field showing which AI model generated the alert (e.g., "Gemini 1.5 Flash", "GPT-4o-mini")
- Apply consistently across Telegram and WhatsApp message formatting
- Maintain backward compatibility with existing message structures

### 🎯 Objectives

- **Transparency**: Users can see which model analyzed the data and its confidence level
- **Consistency**: Align webhook/alert events with news-monitor event formatting standards
- **Trust**: Confidence scores help users assess alert reliability
- **Debugging**: Model information aids troubleshooting and performance analysis

## Technical Implementation

### Message Footer Format

#### Telegram (MarkdownV2)

```
[Main alert content]

---
📊 *Model Confidence:* 85%
🤖 *Model used:* Gemini 1\.5 Flash
```

#### WhatsApp (Plain Markdown)

```
[Main alert content]

---
📊 *Model Confidence:* 85%
🤖 *Model used:* Gemini 1.5 Flash
```

### Data Structure Enhancement

Extend the alert/webhook event data structure to include:

```javascript
{
  // Existing fields...
  enrichmentMetadata: {
    modelUsed: 'gemini-1.5-flash',      // or 'gpt-4o-mini', 'gpt-4o', etc.
    modelDisplayName: 'Gemini 1.5 Flash', // User-friendly model name
    confidence: 0.85,                     // Confidence score (0-1)
    confidencePercent: '85%',             // Formatted for display
    timestamp: '2026-01-10T01:00:00Z'     // When analysis was performed
  }
}
```

### Implementation Files to Update

```
src/services/notification/formatters/
├── markdownV2Formatter.js       # Add footer formatting for Telegram
├── whatsappMarkdownFormatter.js # Add footer formatting for WhatsApp
└── messageFooterBuilder.js      # New utility for consistent footer generation

src/controllers/webhooks/handlers/
├── [webhook-handler].js         # Ensure metadata is passed to formatters
└── [alert-handler].js           # Ensure metadata is passed to formatters

src/services/inference/
├── geminiService.js             # Include model info in responses
├── azureAiClient.js             # Include model info in responses
└── enrichmentService.js         # Ensure metadata propagates through
```

### Footer Builder Utility

Create a centralized footer builder for consistency:

```javascript
class MessageFooterBuilder {
  /**
   * Build footer section with model metadata
   * @param {Object} metadata - Enrichment metadata
   * @param {string} format - 'telegram' or 'whatsapp'
   * @returns {string} Formatted footer text
   */
  static buildFooter(metadata, format = 'telegram') {
    if (!metadata || !metadata.modelUsed) {
      return ''; // No footer if metadata missing
    }

    const confidence = metadata.confidencePercent || 
                      `${Math.round(metadata.confidence * 100)}%`;
    const modelName = metadata.modelDisplayName || metadata.modelUsed;

    if (format === 'telegram') {
      // MarkdownV2 format with escaping
      return `\n\n${this.escapeMarkdownV2('---')}\n` +
             `📊 *Model Confidence:* ${this.escapeMarkdownV2(confidence)}\n` +
             `🤖 *Model used:* ${this.escapeMarkdownV2(modelName)}`;
    } else {
      // WhatsApp plain markdown
      return `\n\n---\n` +
             `📊 *Model Confidence:* ${confidence}\n` +
             `🤖 *Model used:* ${modelName}`;
    }
  }

  static escapeMarkdownV2(text) {
    // Escape special characters for Telegram MarkdownV2
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
  }
}
```

## Configuration Updates

### Environment Variables

```bash
# Feature flag to enable/disable footer metadata
ENABLE_MESSAGE_FOOTER_METADATA=true

# Default confidence threshold for displaying footer (optional)
MESSAGE_FOOTER_MIN_CONFIDENCE=0.0

# Model display name mappings (optional, for custom naming)
MODEL_DISPLAY_NAMES='{"gemini-1.5-flash":"Gemini 1.5 Flash","gpt-4o-mini":"GPT-4o Mini"}'
```

## Examples

### Before (Current Format)

```
🚨 *BTCUSDT Alert*

Price surge detected: +8.5% in the last hour

*Summary:* Bitcoin shows strong bullish momentum...

*Sources:*
- Reuters: Bitcoin rallies...
- CoinDesk: Market analysis...
```

### After (Enhanced Format)

```
🚨 *BTCUSDT Alert*

Price surge detected: +8.5% in the last hour

*Summary:* Bitcoin shows strong bullish momentum...

*Sources:*
- Reuters: Bitcoin rallies...
- CoinDesk: Market analysis...

---
📊 *Model Confidence:* 87%
🤖 *Model used:* Gemini 1.5 Flash
```

## Implementation Checklist

### Phase 1: Core Implementation
- [ ] Create `MessageFooterBuilder` utility class
- [ ] Update `markdownV2Formatter.js` to include footer
- [ ] Update `whatsappMarkdownFormatter.js` to include footer
- [ ] Ensure all webhook/alert handlers pass enrichmentMetadata

### Phase 2: Service Integration
- [ ] Update `geminiService` to include model information in responses
- [ ] Update `azureAiClient` to include model information in responses
- [ ] Update `enrichmentService` to propagate metadata correctly
- [ ] Add model name mapping configuration

### Phase 3: Testing
- [ ] Unit tests for `MessageFooterBuilder`
- [ ] Unit tests for updated formatters with footer
- [ ] Integration tests for webhook events with footer
- [ ] Integration tests for alert events with footer
- [ ] Test footer with various confidence levels
- [ ] Test footer with different model names

### Phase 4: Documentation
- [ ] Update README with footer format examples
- [ ] Update `.env.example` with new configuration variables
- [ ] Add footer format to API documentation
- [ ] Update user guide with footer interpretation

## Testing

### Unit Tests

- `tests/unit/message-footer-builder.test.js`: Footer generation, escaping, format variations
- `tests/unit/markdownv2-formatter-with-footer.test.js`: Telegram formatting with footer
- `tests/unit/whatsapp-formatter-with-footer.test.js`: WhatsApp formatting with footer

### Integration Tests

- `tests/integration/webhook-footer-metadata.test.js`: Webhook events include footer
- `tests/integration/alert-footer-metadata.test.js`: Alert events include footer
- `tests/integration/footer-across-channels.test.js`: Footer consistency across Telegram/WhatsApp

### Test Scenarios

1. **Happy Path**: Alert with valid metadata displays footer correctly
2. **Missing Metadata**: Alert without metadata omits footer gracefully
3. **Partial Metadata**: Alert with only confidence or only model name handles gracefully
4. **Low Confidence**: Footer displays correctly even with low confidence scores
5. **Long Model Name**: Footer truncates or wraps long model names appropriately
6. **Special Characters**: Model names with special characters are escaped correctly

## Performance Considerations

- Footer generation adds minimal overhead (~1ms per message)
- Metadata object size is negligible (~100 bytes)
- No additional API calls required (metadata comes from existing analysis)
- Footer caching not needed (generated on-demand is fast enough)

## Security

- Model names are validated/sanitized to prevent injection
- Confidence scores are validated as numeric (0-1 range)
- No sensitive information exposed in footer
- Feature can be disabled via `ENABLE_MESSAGE_FOOTER_METADATA=false`

## Backward Compatibility

- Footer is additive; existing functionality unchanged
- If metadata missing, footer is omitted (no breaking changes)
- Existing messages without footer remain valid
- Feature flag allows gradual rollout

## Migration Guide

1. Deploy code with `ENABLE_MESSAGE_FOOTER_METADATA=false`
2. Verify existing alerts/webhooks work unchanged
3. Update service integrations to provide enrichmentMetadata
4. Enable feature flag: `ENABLE_MESSAGE_FOOTER_METADATA=true`
5. Monitor message formatting across channels
6. Adjust confidence threshold if needed

## Future Enhancements

- Add timestamp to footer showing analysis time
- Include processing duration in footer
- Add footer customization via user preferences
- Support multiple model contributors (ensemble models)
- Add color coding for confidence levels in Telegram

## References

- News-monitor implementation: `context/003-news-monitor.md`
- Telegram MarkdownV2 spec: https://core.telegram.org/bots/api#markdownv2-style
- WhatsApp formatting: Internal formatter documentation

---

**Review Checklist:**

- [ ] Footer format is consistent across channels
- [ ] Metadata structure is well-defined and extensible
- [ ] Tests cover all edge cases
- [ ] Documentation is clear and complete
- [ ] Backward compatibility is maintained
- [ ] Performance impact is acceptable
