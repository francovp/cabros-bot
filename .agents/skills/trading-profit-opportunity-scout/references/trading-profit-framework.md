# Trading Profit Opportunity Framework

## Scan Areas

- Prompt registry and local fallbacks: `src/services/prompts/`, `src/services/prompts/defaults/`
- Alert enrichment: `src/controllers/webhooks/handlers/alert/`, `src/services/grounding/`
- TradingView MCP client: `src/services/tradingview/TradingViewMcpService.js`
- Expanded reports: `src/controllers/webhooks/handlers/expandedAnalysisAlert/`, `src/services/tradingview/expandedAnalysisAlertReport.js`
- Market scanner: `src/controllers/webhooks/handlers/marketScanner/`, `src/services/tradingview/marketScannerReport.js`
- Volume confirmation: `src/controllers/webhooks/handlers/volumeConfirmation/`, `src/services/tradingview/volumeConfirmationRequest.js`
- Signal parsing: `src/services/tradingview/parseTradingViewSignal.js`
- Status and observability: `src/controllers/status.js`, `src/lib/logging.js`, Sentry wiring
- Contracts and client examples: `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`

## High-Value Opportunity Patterns

### Signal Quality

- Rank scanner results by confluence instead of raw order only.
- Add confidence calibration that combines technical indicators, volume, news, and source count.
- Detect contradictory signals and suppress or downgrade noisy alerts.
- Track why a signal fired so future analysis can compare winners vs losers.

### TradingView MCP Usage

- Compare `standard` vs `combined` analysis outputs and choose per endpoint/use case.
- Use multi-timeframe analysis for trend alignment before high-confidence alerts.
- Tune scanner defaults per market regime, exchange, timeframe, and volatility.
- Add explicit timeout budgets and partial-result behavior where slow MCP calls would block timely alerts.

### Prompt And LLM Output

- Require structured JSON fields that map directly to trading decisions.
- Ask prompts to separate facts, inferred sentiment, uncertainty, and recommended action.
- Penalize stale or single-source news.
- Add fields for invalidation level, setup type, time horizon, and confidence reasoning.
- Keep local fallback prompts in sync with Langfuse prompt names.

### Risk And Profit Controls

- Add risk/reward calculations using ATR, support/resistance, or Bollinger bands.
- Add take-profit and stop-loss suggestions with explicit invalidation.
- Add position-sizing hints only as optional decision support, never as guaranteed advice.
- Add cool-downs or duplicate suppression for repeated alerts on the same weak setup.

### Feedback Loops

- Add replay/backtest support for alerts and scanner outputs.
- Store signal metadata needed to compare future returns.
- Add paper-trading/shadow-mode evaluation before production delivery changes.
- Add dashboards or exports that show hit rate, drawdown, latency, false positives, and missed opportunities.

## Minimum Validation Plan

Every issue should include at least one concrete validation path:

- unit tests for prompt assembly, parsers, ranking, or risk calculations
- integration tests for endpoint contract and fail-open behavior
- historical replay using stored alerts or fixtures
- shadow-mode metric collection without changing live delivery
- preview `/healthcheck` plus targeted endpoint smoke test

## Scoring

Use a 1-5 score for each dimension:

- `impact`: likely effect on better entries/exits or fewer bad alerts
- `evidence`: repo or production evidence quality
- `testability`: how directly success can be measured
- `effort`: lower effort gets higher score
- `risk`: lower operational/trading risk gets higher score
- `dedupe`: no overlap gets higher score

Prefer filing candidates with total score >= 20 and no dimension below 3, unless the user explicitly wants exploratory issues.

## Issue Template

```markdown
## Problem

<What trading decision or signal quality gap exists?>

## Trading Hypothesis

<Why this could improve entries, exits, risk control, or false-positive rate. Avoid profit guarantees.>

## Proposed Change

<Concrete repo change, endpoint behavior, prompt change, MCP query change, or telemetry loop.>

## Acceptance Criteria

- [ ] <Testable criterion>
- [ ] <Testable criterion>
- [ ] Existing auth, feature gates, and fail-open behavior are preserved.

## Validation Plan

- <Focused tests, replay, paper-trading, preview smoke, or telemetry plan>

## Evidence

- `<file path>`: <why it matters>
- Related issues/PRs: <links or "none found after live dedupe">

## Risks

- <Operational, cost, latency, or trading-risk caveat>
```
