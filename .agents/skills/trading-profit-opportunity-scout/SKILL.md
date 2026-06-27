---
name: trading-profit-opportunity-scout
description: Analyze this repository for deduplicated opportunities that could improve trading outcomes, alert quality, signal selection, prompt quality, TradingView MCP usage, scanner coverage, confidence/risk scoring, or trade decision support. Use when the user asks to maximize trading gains, improve profitability, find alpha/edge opportunities, tune prompts, improve TradingView MCP queries, improve scanner/report logic, or create/update GitHub issues for trading-strategy improvements.
---

# Trading Profit Opportunity Scout

## Overview

Use this skill to turn a repo review into concrete, evidence-backed GitHub issue proposals focused on improving trading outcomes. It extends `repo-opportunity-scout` but narrows the scan to alpha generation, signal quality, risk control, and decision support.

## Hard Rules

- Check open GitHub issues before proposing anything new.
- Check open pull requests before proposing anything new.
- If a live issue already covers the opportunity, update or comment there instead of opening a duplicate.
- If a PR already implements the opportunity, skip it and report the overlap.
- Do not claim or imply guaranteed profits.
- Do not file speculative trading ideas without repo evidence, measurable hypothesis, and validation path.
- Prefer improvements that can be tested with historical replay, paper-trading, shadow mode, production telemetry, or deterministic fixtures.
- Keep protected webhook auth, feature gates, MarkdownV2 formatting, and fail-open alert delivery intact.

## Workflow

### 1. Build Trading Context

- Read `README.md`, `agents.md`, `src/routes/index.js`, and the relevant TradingView/prompt files.
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
  - `profit`, `alpha`, `backtest`, `paper trading`, `risk`
- Inspect recently closed issues/PRs when a near match exists.
- Reuse/update the existing item if the user outcome overlaps.

### 3. Find Profit-Focused Opportunities

Read `references/trading-profit-framework.md` when evaluating candidates. Prioritize opportunities in these lanes:

- better signal selection and ranking
- stronger TradingView MCP query composition
- multi-timeframe and multi-source confluence
- prompt changes that produce more actionable and calibrated outputs
- false-positive reduction for alerts and scanners
- risk/reward, stop-loss, take-profit, and position-sizing support
- backtesting, replay, paper-trading, and telemetry feedback loops
- cost/latency reductions that preserve or improve decision quality

### 4. Rank Candidates

Score each candidate with:

- expected trading impact
- evidence strength
- testability
- implementation effort
- operational risk
- duplicate risk

Prefer high-confidence, testable changes over broad strategy rewrites.

### 5. Write Or Update GitHub Issues

Create one issue per atomic trading opportunity. Include:

- problem statement
- trading hypothesis
- proposed implementation
- acceptance criteria
- validation plan
- repo evidence with file paths
- related issues or PRs
- risk controls and rollout plan

If updating an existing issue, add a concise comment explaining the new trading angle and evidence.

### 6. Report Back

Return a compact summary of:

- issues created
- issues updated
- proposals skipped due to overlap
- top opportunities not filed and why
- highest-confidence next step

## Evidence Checklist

Before filing, capture at least two of:

- exact repo file paths and relevant code paths
- existing tests that show current behavior
- missing tests for a high-value behavior
- documented endpoint contract or env config
- production/preview/log evidence when available
- issue/PR history proving no duplicate exists

## Stop Conditions

- Stop without filing if GitHub access is unavailable.
- Stop without filing if all high-value ideas are already covered.
- Stop without filing if the opportunity needs market data or performance metrics that are not available; report `No measurements found`.
- Stop and ask if the user wants implementation instead of issue creation.
