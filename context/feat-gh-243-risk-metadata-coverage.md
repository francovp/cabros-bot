## Summary

Exposes risk-metadata coverage and prompt provenance telemetry in stored alert enrichment and aggregate analytics (`GET /api/alerts/summary`). Resolves GH-243 / CB-100.

## Key Changes

### 🛠 Telemetry and Provenance Tracking

- Captured `prompt_provenance` (`name`, `source`, `label`, `version`) during Gemini alert enrichment generation in `src/services/grounding/gemini.js` and preserved it through `src/controllers/webhooks/handlers/alert/grounding.js`.
- Added `riskMetadataCoverage` aggregation to `summarizeAlerts` in `src/services/storage/AlertStorageService.js`, outputting total denominator, populated counts, percentages, and breakdowns by prompt provenance.
- Updated `CabrosBot.postman_collection.json` with sample response format containing `riskMetadataCoverage`.

## Technical Implementation

### Architecture changes

#### `src/services/storage/AlertStorageService.js`

Added `RISK_FIELDS`, `isRiskFieldPopulated`, and `extractPromptProvenance` to compute denominator, field counts/percentages, and prompt provenance groupings within `summarizeAlerts()`.

#### `src/services/grounding/gemini.js`

Captured `prompt` metadata from `PromptService.getChatPrompt` and attached `prompt_provenance` to enriched alert generation result objects.

#### `src/controllers/webhooks/handlers/alert/grounding.js`

Preserved `prompt_provenance` when merging Gemini and MCP enrichment payloads into `alert.enriched`.

## Testing Infrastructure

### Test Suite

- **Unit Tests**: Updated `tests/unit/gemini-client.test.js` and `tests/unit/alert-storage-service.test.js` with risk metadata and prompt provenance coverage test cases.
- **Integration Tests**: Verified `tests/integration/alerts-endpoint.test.js`.

## References

- Resolves #243
- Linear CB-100
