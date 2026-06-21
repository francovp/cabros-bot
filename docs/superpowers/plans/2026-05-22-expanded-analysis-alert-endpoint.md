# Expanded Analysis Alert Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a TradingView MCP-backed report endpoint that dispatches the generated alert through existing notification channels.

**Architecture:** Add a focused handler under `src/controllers/webhooks/handlers/expandedAnalysisAlert/` and keep expanded analysis report formatting in `src/services/tradingview/`. Reuse the existing `TradingViewMcpService` MCP client and `NotificationManager` initialization path.

**Tech Stack:** Node.js 20, Express, Jest, Supertest, existing MCP Streamable HTTP client helper.

---

### Task 1: Tests First

**Files:**
- Create: `tests/unit/expanded-analysis-alert-report.test.js`
- Create: `tests/integration/expanded-analysis-alert-endpoint.test.js`

- [ ] Write unit tests for symbol parsing, env fallback, RSI grouping, and report formatting.
- [ ] Write integration tests for `POST /api/webhook/expanded-analysis-alert` success, missing symbols `400`, invalid symbols `400`, and all-symbol failures `502`.
- [ ] Run focused tests and confirm they fail because the endpoint and formatter do not exist.

### Task 2: Report Service

**Files:**
- Create: `src/services/tradingview/expandedAnalysisAlertReport.js`
- Modify: `src/services/tradingview/TradingViewMcpService.js`

- [ ] Implement `parseExpandedAnalysisAlertRequest`.
- [ ] Implement `buildExpandedAnalysisAlertReport`.
- [ ] Add `analyzeSymbolIdentifier` to call `coin_analysis` from `EXCHANGE:SYMBOL`.
- [ ] Run the unit test and confirm it passes.

### Task 3: Endpoint Handler

**Files:**
- Create: `src/controllers/webhooks/handlers/expandedAnalysisAlert/expandedAnalysisAlert.js`
- Modify: `src/routes/index.js`

- [ ] Implement request handling, per-symbol result collection, notification dispatch, and error responses.
- [ ] Mount `POST /api/webhook/expanded-analysis-alert`.
- [ ] Run the integration test and confirm it passes.

### Task 4: Docs and Validation

**Files:**
- Modify: `agents.md`
- Modify: `.github/copilot-instructions.md` if present

- [ ] Document the endpoint and env vars.
- [ ] Run focused tests.
- [ ] Run the full test suite once.
- [ ] Commit the implementation with a conventional commit message.
