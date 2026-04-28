# Research: Enrich Alert Output

**Feature**: Enrich Alert Output (004)
**Date**: 22 de noviembre de 2025

## Unknowns & Clarifications

### 1. Existing Grounding Service Capabilities

- **Question**: Does the current `grounding.js` support structured output?
- **Finding**: No. `grounding.js` calls `gemini.generateGroundedSummary` which returns a simple summary and citations. `alert.js` attempts to import `enrichAlert` from `grounding.js`, but it is not exported (likely a bug or mismatch in current codebase state).
- **Resolution**: Implement `enrichAlert` in `grounding.js` and `generateEnrichedAlert` in `gemini.js` to support the required JSON structure.

### 2. Prompt Engineering

- **Question**: How to extract sentiment and technical levels reliably?
- **Finding**: `analyzeNewsForSymbol` in `gemini.js` already uses a JSON-enforcing prompt for news analysis. We can adapt this pattern for alert enrichment.
- **Decision**: Use a system prompt that enforces JSON output with specific fields (`sentiment`, `insights`, `technical_levels`).

## Technical Decisions

### 1. JSON Output for Alerts

- **Decision**: The Gemini model will be instructed to return a strict JSON object.
- **Rationale**: Structured data is required for consistent formatting across Telegram and WhatsApp. Parsing text-based summaries is unreliable.
- **Schema**:

  ```json
  {
    "sentiment": "BULLISH|BEARISH|NEUTRAL",
    "insights": ["point 1", "point 2"],
    "technical_levels": {
      "supports": ["$80k", "$78k"],
      "resistances": ["$85k"]
    }
  }
  ```

### 2. Function Naming & Structure

- **Decision**: Rename/Refactor `generateGroundedSummary` to `generateEnrichedAlert` (or similar) to reflect the new structured nature.
- **Decision**: Ensure `grounding.js` exports `enrichAlert` to match `alert.js` usage.

### 3. Formatting Strategy

- **Decision**: Update `MarkdownV2Formatter` (Telegram) and `WhatsAppMarkdownFormatter` (WhatsApp) to render the structured data.
- **Strategy**: Implement a new `formatWebhookAlert` method for Feature 004. Preserve/rename existing logic as `formatNewsAlert` for Feature 003 to avoid breaking the News Monitor (Option B).
- **Telegram**: Use bolding, emojis, and lists.
- **WhatsApp**: Use bolding, emojis, and bullet points (plain text).

### 4. Prompt Selection Strategy

- **Decision**: Use Parameter-Driven Prompt Selection (Option A).
- **Implementation**: Update `GroundingService` methods to accept a `useCase` or `promptType` parameter (e.g., `'NEWS_ANALYSIS'` vs `'ALERT_ENRICHMENT'`) to select the appropriate system instruction internally. This prevents regressions in Feature 003.

## Alternatives Considered

- **Modify `generateGroundedSummary` in place**:
  - Pros: Less code duplication.
  - Cons: Might break other consumers if any (currently none known, but safer to be explicit).
  - Decision: We will effectively replace the logic but might keep the function signature compatible or create a new one. Given `alert.js` expects `enrichAlert`, we will align with that.

- **Unified Formatter Method**:
  - Pros: Single method for all alerts.
  - Cons: Complex logic to handle different data structures (`NewsAlert` vs `EnrichedAlert`).
  - Decision: Rejected in favor of separate methods for clarity and safety.

- **Separate Service for Enrichment**:
  - Pros: Complete isolation.
  - Cons: Code duplication for Gemini client wrapping.
  - Decision: Rejected in favor of parameter-driven prompt selection in the existing service.

