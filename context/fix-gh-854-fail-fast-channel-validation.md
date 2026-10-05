fix(webhooks): fail-fast on disabled channels before spending enrichment/MCP budget (GH-854)

## Summary

`POST /api/webhook/alert` and `POST /api/scanner-presets/:id/run` now validate that
any explicitly requested notification channel is enabled and configured **before**
running Gemini grounding, TradingView MCP enrichment, or TradingView MCP scans. A
request pointing at a disabled channel used to consume the full 12–120s enrichment
budget and then return a late `400 INVALID_REQUEST`. The new ordering returns
`400 INVALID_REQUEST` immediately, sparing TradingView MCP quota, Gemini tokens,
and Sentry spans for guaranteed-failing requests. Behavior for legacy broadcasts
(`channels` omitted) and valid explicit routing is unchanged.

## Key Changes

- **`src/services/notification/requestRouting.js`** — adds a focused
  `assertChannelsAvailable(notificationManager, routing)` helper that throws
  `NotificationRoutingValidationError` (statusCode 400) when any requested
  channel is unavailable. Reuses the existing
  `validateNotificationRouting` for the actual enabled-channel check so the
  late backstop in `sendWithNotificationRouting` keeps working unchanged.
- **`src/controllers/webhooks/handlers/alert/alert.js`** — initializes the
  notification manager eagerly when `routing.channels` is set, then calls
  `assertChannelsAvailable` *before* `processEnrichment`. The existing late
  validation in the delivery path is kept as a defensive backstop.
- **`src/controllers/webhooks/handlers/scannerPresets/scannerPresets.js`** —
  same eager-init + `assertChannelsAvailable` ordering, executed *before*
  `runScans` so the request cannot consume up to 120s of TradingView MCP
  budget on a guaranteed 400.
- **Tests** — three new focused tests covering the unit-level helper and the
  end-to-end fail-fast behavior on both endpoints; existing alert webhook
  and scanner-preset tests continue to pass without modification.

## Technical Implementation

```
POST /api/webhook/alert
└─ parseNotificationRouting(body)             // syntax check (existing)
└─ validateAlert(text)                        // existing
└─ if (routing.channels) {                    // NEW: eager validation gate
└─     await initializeNotificationServices() // lazy singleton, idempotent
└─     assertChannelsAvailable(manager, routing) // throws 400 on miss
└─ }
└─ processEnrichment(alert)                   // Gemini + TradingView MCP
   ... delivery path runs the same late validateNotificationRouting as a
   defensive backstop, so feature-flag toggles between parse and delivery
   still produce a 400 instead of silent failure.
```

The scanner-preset run path mirrors this ordering — validation runs before
`runScans` instead of after.

`assertChannelsAvailable` is intentionally a thin wrapper that only
validates when `routing.channels` is set. Legacy broadcasts and dry-run
requests that omit `channels` skip the call entirely, so the existing
test suite (and behavior contract) is preserved.

## Testing

- `pnpm test -- tests/unit/request-routing.test.js` — 17/17 pass (5 new
  helper-level cases added).
- `pnpm test -- tests/integration/alert-repeat-suppression.test.js` —
  19/19 pass (existing late-validation regression continues to pass; the
  new fail-fast ordering simply makes the same 400 cheaper to produce).
- `pnpm test -- tests/integration/scanner-presets-endpoint.test.js` —
  16/16 pass (1 new scanner-preset fail-fast case added; verifies
  `tradingViewMcpService.callScanTool` is **not** invoked when the
  requested channel is disabled).
- `pnpm test -- tests/integration/channel-availability-failfast.test.js` —
  3/3 pass (new dedicated suite covering fail-fast for `/api/webhook/alert`
  plus the unchanged legacy broadcast path).
- `pnpm test -- tests/unit/ --testTimeout=5000` — 108/108 unit suites,
  2163/2163 tests pass.

The new fail-fast test asserts the failing path does **not** invoke
`groundAlert` (Gemini) or `tradingViewMcpService.callScanTool` (MCP scan),
proving the budget is preserved on guaranteed-failing requests.

## References

- **Issue**: GH-854
  (`fix(webhooks): validate requested notification channels are enabled
  before spending Gemini/MCP enrichment budget`)
- Related: #852, #841, #818 (MCP budget burn reduction), #781 (dry-run
  preset validation, complementary).
- Existing late-validation backstop in
  `src/services/notification/requestRouting.js#sendWithNotificationRouting`
  is preserved for feature-flag race safety.
