# Request-level Trader Intent Outcomes Implementation Plan

**Branch**: `001-trader-intent-outcomes` | **Date**: 2026-10-25 | **Spec**: [spec.md](spec.md)

## Summary

Add a shared request-boundary validator for `traderIntent`, carry the sanitized value through alert and symbol-analysis persistence, evaluate complete plans beside (not instead of) bot-default outcomes, and expose additive aggregate/export/API contracts. Per-chat intent remains deferred.

## Technical Context

**Language/Version**: Node.js 24.18.0, CommonJS  
**Primary Dependencies**: Express, Firebase Admin, existing native-fetch provider services  
**Storage**: Existing `alerts`, `symbolAnalyses`, and `tradingSignalOutcomes` Firestore documents  
**Testing**: Jest and SuperTest  
**Target Platform**: Linux web and worker processes  
**Project Type**: Single Node.js service  
**Performance Goals**: No additional provider request or Firestore query; constant work per alert/outcome  
**Constraints**: Fail open after boundary validation, no new dependency/env/config key, no credential or plan-value logging  
**Scale/Scope**: One optional fixed-shape annotation and one matching-horizon result per signal

## Constitution Check

- **Readable/minimal**: PASS — one shared validator and additive fixed-shape fields.
- **Testing**: PASS — boundary, persistence, evaluation, summary, replay, and contract behavior are test-first.
- **Review**: PASS — PR review, Codex review, and CI remain mandatory.
- **Incremental delivery**: PASS — request-level phase is independently useful; chat defaults are explicitly deferred.

Post-design re-check: PASS. No new subsystem, collection, dependency, or configuration surface was introduced.

## Project Structure

```text
specs/001-trader-intent-outcomes/
├── spec.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── contracts/trader-intent.yaml
└── tasks.md

src/
├── lib/traderIntent.js
├── controllers/webhooks/handlers/alert/alert.js
├── controllers/webhooks/handlers/symbolAnalysis/symbolAnalysis.js
├── controllers/alerts/alerts.js
├── services/storage/AlertStorageService.js
├── services/storage/SymbolAnalysisStorageService.js
├── services/storage/SignalOutcomeService.js
└── openapi/openapi.json

tests/
├── unit/trader-intent.test.js
├── unit/alert-storage-service.test.js
├── unit/symbol-analysis-storage-service.test.js
├── unit/signal-outcome-service.test.js
├── integration/alert-trader-intent.test.js
├── integration/symbol-analysis-endpoint.test.js
├── integration/alerts-endpoint.test.js
└── integration/outcomes-endpoint.test.js
```

**Structure Decision**: Reuse existing handlers and storage services. The only new production file owns validation/sanitization so both request paths cannot drift.

## Design

1. `validateTraderIntent(raw)` returns `undefined` when omitted, otherwise a new allow-listed object or throws the repository-standard `INVALID_REQUEST` error.
2. Alert handling validates before notification/provider work, places the sanitized annotation at `alert.traderIntent`, passes it separately to alert storage and outcome storage, and leaves enrichment data unchanged.
3. Symbol analysis validates before MCP work, echoes the sanitized annotation, and passes it to its existing optional persistence record.
4. `SignalOutcomeService.recordSignal()` stores `traderIntent` separately. During the already-bounded matching window evaluation, complete plans receive a nested `traderPlanOutcome`; bot-default outcome fields are untouched.
5. Summary aggregation reads evaluated complete-plan results into `byTraderPlan`; no second query is added.
6. Alert replay starts from the complete stored raw payload and preserves `traderIntent`; CSV uses explicit dotted columns and JSONL preserves the nested object.

## Verification

- Focused RED/GREEN commands are listed in `tasks.md`.
- Run affected unit/integration/contract suites, JSON parsing, `git diff --check`, then `pnpm test` once.
- Start the app with safe local gates, verify `/healthcheck`, invalid `/api/webhook/alert`, and valid dry-run behavior.
- Resolve and verify the PR preview against its exact head when available; otherwise record the OpenClaw exception truthfully.

## Complexity Tracking

No constitution violation. The separate nested trader-plan result is necessary to preserve the existing bot-default metric contract.
