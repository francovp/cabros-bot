# feat: add model used to webhook alert

## Summary

Add model metadata to enriched webhook alerts and propagate provider/model identity through the grounding pipeline so Telegram and WhatsApp messages can show which model produced the enrichment output.

## Key Changes

### 🤖 Add model metadata footer to enriched alerts

- Extended alert enrichment payload with `extraText` generated in `src/controllers/webhooks/handlers/alert/grounding.js`.
- Footer includes `Model used` and grounding model details.
- Added feature flag behavior: footer is enabled by default and can be disabled with `ENABLE_MESSAGE_FOOTER_METADATA=false`.

### 🔁 Propagate model identity through grounding/LLM calls

- `src/services/grounding/gemini.js` now captures and returns `modelUsed` from `llmCallv2()`.
- Token usage attribution now uses the effective model used in execution.
- `src/services/grounding/genaiClient.js` now returns `modelUsed` across Gemini/Azure/OpenRouter paths.

### 🔎 Simplify Brave Search execution path

- Refactored Brave search fallback behavior in `src/services/grounding/genaiClient.js` to reuse formatted search context directly as `searchResultText`.
- Updated model naming in `src/services/grounding/config.js` so forced Brave mode reports `brave-search` consistently.

### 💬 Render footer in both notification channels

- `src/services/notification/formatters/markdownV2Formatter.js` appends `extraText` footer for Telegram messages.
- `src/services/notification/formatters/whatsappMarkdownFormatter.js` appends equivalent footer content for WhatsApp output.

## Technical Implementation

### Architecture changes

#### `src/controllers/webhooks/handlers/alert/grounding.js`

- Consumes `modelUsed` from grounding output and composes `extraText` footer.
- Keeps fail-open behavior for enrichment errors unchanged.

#### `src/services/grounding/gemini.js`

- Returns structured enrichment plus `modelUsed`.
- Ensures token usage accounting tracks the effective model.

#### `src/services/grounding/genaiClient.js`

- Standardizes `modelUsed` in provider responses.
- Simplifies Brave search execution helper signature and output.

#### Notification formatters

- Telegram and WhatsApp formatters now include optional `extraText` footer when present.

## Configuration Updates

### Environment Variables

```bash
ENABLE_MESSAGE_FOOTER_METADATA=true
```

## Examples

Webhook-enriched alert output now includes an additional footer section in notification channels, for example:

- `Model used: gemini-2.5-flash`
- `Grounding by: gemini-2.5-flash`

(Values vary based on provider/model routing and runtime configuration.)

## Testing

### Test Suite

- Full suite executed with `npm test`
- Result: **27/28 suites passing**, **359/361 tests passing**

### Current Known Failing Tests

- `tests/unit/genaiClient.test.js`
  - `Fallback to Brave › falls back to Brave when Google Search fails`
  - `Forced Brave Search › uses Brave Search directly when FORCE_BRAVE_SEARCH is true`

These failures align with the branch refactor that changed Brave fallback output and call behavior.

### Pre-merge Verification

- [ ] Update failing unit tests in `tests/unit/genaiClient.test.js` to match current Brave execution behavior
- [ ] Re-run full test suite and ensure all tests pass
- [ ] Validate Telegram/WhatsApp enriched footer rendering in integration flow

### Post-merge Verification

- [ ] Confirm enriched webhook alerts include model footer in production-like environment
- [ ] Confirm `ENABLE_MESSAGE_FOOTER_METADATA=false` disables footer without affecting delivery

## References

- `context/webhook-alert-footer-enhancement.md`
- `specs/004-enrich-alert-output/spec.md`

---

**Review Checklist:**

- [ ] Code quality meets project standards
- [ ] All tests pass and coverage is maintained
- [ ] Documentation is complete and accurate
- [ ] Breaking change assessment completed
