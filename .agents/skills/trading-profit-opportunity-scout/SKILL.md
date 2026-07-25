---
name: trading-profit-opportunity-scout
description: Analyze this repository and production Firebase alerts for deduplicated opportunities that could improve trading outcomes, alert quality, signal selection, prompt quality, TradingView MCP usage, scanner coverage, confidence/risk scoring, or trade decision support. Use when the user asks to check recent alerts, maximize trading gains, improve profitability, find alpha/edge opportunities, tune prompts, improve TradingView MCP queries, improve scanner/report logic, or create/update GitHub issues for trading-strategy improvements.
---

# Trading Profit Opportunity Scout

## Overview

Use this skill to turn a repo review and production alert analysis into concrete, evidence-backed GitHub issue proposals focused on improving trading outcomes. It extends `repo-opportunity-scout` by inspecting live production alert telemetry from Firebase/Render alongside codebase patterns to uncover alpha generation, signal quality, risk control, and decision support opportunities.

## Hard Rules

- Check open GitHub issues before proposing anything new.
- Check open pull requests before proposing anything new.
- If a live issue already covers the opportunity, update or comment there instead of opening a duplicate.
- If a PR already implements the opportunity, skip it and report the overlap.
- Check stored production Firebase alerts from the target window (e.g. last 2 weeks) using Render deployment endpoints when available (`GET /api/alerts/summary?from=<ISO>&to=<ISO>`, `GET /api/alerts/export?from=<ISO>&to=<ISO>&includeText=true`, `GET /api/alerts`) with `WEBHOOK_API_KEY`.
- Do not claim or imply guaranteed profits.
- Do not file speculative trading ideas without repo/telemetry evidence, measurable hypothesis, and validation path.
- Prefer improvements that can be tested with historical replay, paper-trading, shadow mode, production telemetry, or deterministic fixtures.
- Keep protected webhook auth, feature gates, MarkdownV2 formatting, and fail-open alert delivery intact.

## Workflow

### 1. Build Trading Context & Inspect Telemetry

- Read `README.md`, `agents.md`, `src/routes/index.js`, and the relevant TradingView/prompt files.
- Fetch and analyze stored production Firebase alerts from the last 2 weeks (or requested window):
  - Base URL: Render deployment (`NOTIFY_WEBHOOK_URL` host, e.g. `https://cabros-crypto-bot-telegram.onrender.com`).
  - Request `GET /api/alerts/summary?from=<FROM_ISO>&to=<TO_ISO>`, `GET /api/alerts/export?from=<FROM_ISO>&to=<TO_ISO>&includeText=true&limit=500`, and `GET /api/alerts?limit=100` with header `x-api-key: <WEBHOOK_API_KEY>`. Compute explicit `from` (e.g. 14 days ago) and `to` (now) ISO-8601 timestamps, as `export` requires both bounded timestamps and `summary` defaults to 24 hours when `from` is omitted.
  - Audit recent alert texts, ticker patterns (`BATS:`, `BINANCE:`), symbol indexing (`bySymbol`), enrichment insights, grounding sources, token usage, delivery results, and errors.
  - Scan for entity hallucinations (e.g. `BATS:` exchange prefix confused with `BAT` crypto or `LSE:BATS` stock), unparsed tickers (`bySymbol: { unknown: ... }`), or missing risk parameters.
- Identify active trading surfaces:
  - alert enrichment and prompt registry
  - TradingView MCP `coin_analysis`, `combined_analysis`, `multi_timeframe_analysis`, and `volume_confirmation_analysis`
  - market scanner scan types and report format
  - news monitor, grounding, confidence scoring, and notification routing
- Capture current feature gates and runtime env vars before suggesting changes.

### 2. Dedupe Live Backlog

- Inspect open issues and PRs with queries for:
  - `TradingView`, `MCP`, `scanner`, `prompt`, `Gemini`, `Langfuse`
  - `signal`, `confidence`, `volume`, `RSI`, `MACD`, `Bollinger`
  - `profit`, `alpha`, `backtest`, `paper trading`, `risk`, `BATS`, `symbol`
- Inspect recently closed issues/PRs when a near match exists.
- Reuse/update the existing item if the user outcome overlaps.

### 3. Find Profit-Focused Opportunities

Read `references/trading-profit-framework.md` when evaluating candidates. Compare recent Firebase alerts with live TradingView data from TradingView MCP or Google search grounding. Prioritize opportunities in these lanes:

- entity disambiguation and exchange prefix normalization (`BATS:SYMBOL` vs `BAT` crypto)
- regex symbol extraction for stored alerts to eliminate `bySymbol: unknown`
- replacing or enriching raw search grounding with quantitative TradingView MCP technical indicators
- multi-timeframe and multi-source confluence
- prompt changes that produce more actionable and calibrated outputs (invalidation levels, target prices, setup type, RRR)
- false-positive reduction for alerts and scanners
- risk/reward, stop-loss, take-profit, and position-sizing support
- backtesting, replay, paper-trading, and telemetry feedback loops
- cost/latency reductions that preserve or improve decision quality

### 4. Rank Candidates

Score each candidate with:

- expected trading impact
- evidence strength (repo code + production alert telemetry)
- testability
- implementation effort
- operational risk
- duplicate risk

Prefer high-confidence, testable changes over broad strategy rewrites.

### 5. Write Or Update GitHub Issues

Create one issue per atomic trading opportunity. Include:

- problem statement (including specific production alert telemetry findings)
- trading hypothesis
- proposed implementation
- acceptance criteria
- validation plan
- repo evidence with file paths and telemetry examples
- related issues or PRs
- risk controls and rollout plan

If updating an existing issue, add a concise comment explaining the new trading angle and evidence.

### 6. Report Back

Return a compact summary of:

- production alert telemetry summary (total alerts, top symbols, hallucinations/errors detected)
- issues created
- issues updated
- proposals skipped due to overlap
- top opportunities not filed and why
- highest-confidence next step

## Evidence Checklist

Before filing, capture at least two of:

- production Firebase alert telemetry (`GET /api/alerts`) showing exact failure modes, hallucinations, or unindexed metrics
- exact repo file paths and relevant code paths
- existing tests that show current behavior
- missing tests for a high-value behavior
- documented endpoint contract or env config
- issue/PR history proving no duplicate exists

## Stop Conditions

- Stop without filing if GitHub access is unavailable.
- Stop without filing if all high-value ideas are already covered.
- Stop without filing if the opportunity needs market data or performance metrics that are not available; report `No measurements found`.
- Stop and ask if the user wants implementation instead of issue creation.

