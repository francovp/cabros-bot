# feat: add dry-run mode for webhook alert endpoints (CB-15)

## Summary

Adds a `dryRun` mode to the three webhook alert endpoints. When enabled, all validation and enrichment/analysis pipelines run as normal, but no messages are delivered to Telegram or WhatsApp and no data is persisted to Firestore. The response clearly indicates `dryRun: true` and returns the built message payload for inspection.

## Key Changes

### 🔧 Dry-run support for `POST /api/webhook/alert`

- Accepts `dryRun=true` via query string (`?dryRun=true`) or request body (`{ "dryRun": true }`)
- Runs request validation and enrichment (Gemini grounding, TradingView MCP) as usual
- Skips `NotificationManager.sendToAll()` — no Telegram/WhatsApp delivery
- Skips `alertStorageService.saveAlert()` — no Firestore side effects
- Returns `{ success: true, dryRun: true, payload: { text, enrichedData }, enriched, tokenUsage }`

### 🔧 Dry-run support for `POST /api/webhook/expanded-analysis-alert`

- Same flag detection (`dryRun` query or body)
- Runs per-symbol TradingView MCP analysis and report building as normal
- Skips `notificationManager.sendToAll()`
- Returns `{ success: true, dryRun: true, payload: { alertText }, results, summary, timedOut, ... }`

### 🔧 Dry-run support for `POST /api/webhook/market-scanner-alert`

- Same flag detection
- Runs all configured scans via TradingView MCP as normal
- Skips `notificationManager.sendToAll()`
- Returns `{ success: true, dryRun: true, payload: { alertText }, scanResults, summary, timedOut, ... }`

## Technical Implementation

### Architecture changes

#### `resolveDryRun(req)` helper

Each handler exposes a shared `resolveDryRun(req)` function that reads the flag from both `req.query.dryRun` and `req.body.dryRun` (coercing string `'true'` to boolean).

```js
function resolveDryRun(req) {
  const queryFlag = req.query && (req.query.dryRun === 'true' || req.query.dryRun === true);
  const bodyFlag = req.body && typeof req.body === 'object' && (req.body.dryRun === true || req.body.dryRun === 'true');
  return queryFlag || bodyFlag;
}
```

### File Structure Additions

```
src/controllers/webhooks/handlers/
├── alert/alert.js                     # Added resolveDryRun + dry-run guard
├── expandedAnalysisAlert/expandedAnalysisAlert.js  # Same
├── marketScanner/marketScanner.js     # Same
tests/integration/
└── dry-run-webhook-alerts.test.js     # 11 new integration tests
```

## Testing infrastructure

### Test Suite

- **11 Integration Tests** in `tests/integration/dry-run-webhook-alerts.test.js`

### Test Coverage

- Query string `?dryRun=true` skips delivery for all 3 endpoints
- Request body `{ dryRun: true }` skips delivery for all 3 endpoints
- Absent `dryRun` flag delivers normally (no regression)
- `tokenUsage` is present in `/alert` dry-run response
- `scanResults` and `summary` are present in market scanner dry-run response

## Examples

**Dry-run a simple alert:**
```bash
curl -X POST https://cabros-crypto-bot-telegram.onrender.com/api/webhook/alert?dryRun=true \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "BTC breaks $50K"}'

# Response:
{
  "success": true,
  "dryRun": true,
  "enriched": false,
  "payload": { "text": "BTC breaks $50K", "enrichedData": null },
  "tokenUsage": { ... }
}
```

**Dry-run an expanded analysis:**
```bash
curl -X POST https://cabros-crypto-bot-telegram.onrender.com/api/webhook/expanded-analysis-alert \
  -H "x-api-key: $WEBHOOK_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"symbols": ["BINANCE:BTCUSDT"], "timeframe": "1D", "dryRun": true}'
```

## Deployment Considerations

No new environment variables required. Existing live behavior is unchanged when `dryRun` is absent.

## Testing

### Pre-merge Verification

- [x] All 11 new dry-run integration tests pass
- [x] Full test suite passes (no regressions)
- [x] `dryRun` absent → live delivery unaffected

### Post-merge Verification

- [ ] Deploy to preview environment and test `?dryRun=true` against live endpoints
- [ ] Verify no Telegram messages are sent in dry-run mode
- [ ] Verify response contains `payload.text` with built message

## References

- GitHub Issue: https://github.com/francovp/cabros-bot/issues/59
- Linear Issue: CB-15 (https://linear.app/knil/issue/CB-15/add-dry-run-mode-for-webhook-alert-endpoints)
