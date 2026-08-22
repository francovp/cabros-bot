fix(tradingview): fit webhook MCP retries within enrichment budget (CB-183)

## Summary

Bound TradingView MCP webhook enrichment retries and preserve successful base analysis when optional calls time out.

## Key Changes

- Give base `coin_analysis` attempts a bounded sub-budget with per-attempt abort signals.
- Combine volume, confluence, and multi-timeframe calls with the remaining total deadline.
- Mark full/partial/failed enrichment in runtime and stored alert telemetry.
- Update OpenAPI, Postman, README, and AGENTS.md documentation.

## Technical Implementation

- Reused native `AbortController`, `AbortSignal.any`, and the existing `sendWithRetry` helper.
- Optional provider failures remain fail-open and retain the successful base result.
- No new environment variables or dependencies.

## Testing

- Added regression coverage for base retry after budget-aware per-attempt timeout, optional timeout with base preservation, failed status accounting, and Firestore status persistence.
- Review follow-up reserves retry backoff inside the base attempt budget and aligns the non-TradingView Postman response example.
- Follow-up also reserves the full exponential backoff sum, distinguishes non-signal Gemini failures as not applicable, and adds all four status variants to Postman.
- Local focused Jest execution is currently blocked because the workspace shell has no `node` binary (`env: node: No such file or directory`).
- Static checks: `git diff --check`, OpenAPI JSON parse, and Postman JSON parse.

## References

- GitHub issue: https://github.com/francovp/cabros-bot/issues/422
- Fixes #422
- Linear: [CB-183](https://linear.app/knil/issue/CB-183/fixtradingview-fit-webhook-mcp-retries-within-enrichment-budget-gh-422)
