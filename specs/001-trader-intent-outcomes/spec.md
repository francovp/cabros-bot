# Feature Specification: Request-level Trader Intent Outcomes

**Feature Branch**: `001-trader-intent-outcomes`  
**Created**: 2026-10-25  
**Status**: Draft  
**Input**: GitHub issue #791, phase 1 selected by the issue automator.

## User Scenarios & Testing

### User Story 1 - Submit an explicit trade plan (Priority: P1)

As an API caller, I want to attach an optional trader plan to an alert so the stored alert records the plan I actually intended without changing alerts that omit it.

**Independent Test**: Submit an alert with a valid `traderIntent`, confirm delivery proceeds, and read/export the stored alert with the same sanitized plan.

**Acceptance Scenarios**:

1. **Given** a valid alert with a complete trader plan, **When** the alert is accepted, **Then** the plan is persisted with the alert and signal outcome.
2. **Given** an alert without a trader plan, **When** it is accepted, **Then** delivery, persistence, and bot-default outcome behavior remain unchanged.
3. **Given** a valid symbol-analysis request with a trader plan, **When** analysis completes, **Then** the sanitized plan is echoed and included in optional analysis persistence without creating chat-scoped defaults.

### User Story 2 - Reject unsafe or ambiguous plans (Priority: P1)

As an operator, I want malformed or directionally inverted plans rejected before enrichment, delivery, or persistence so invalid analytics never enter the system.

**Independent Test**: Submit wrong-side, non-positive, non-finite, unsupported-horizon, inverted-level, and non-object values and verify precise `400 INVALID_REQUEST` responses with no delivery or storage calls.

**Acceptance Scenarios**:

1. **Given** a BUY plan with `invalidation >= entry` or `target <= entry`, **When** submitted, **Then** the request is rejected.
2. **Given** a SELL plan with `target >= entry` or `invalidation <= entry`, **When** submitted, **Then** the request is rejected.
3. **Given** any plan field without both `entry` and `horizon`, **When** submitted, **Then** the request is rejected with the field identified.

### User Story 3 - Compare trader-plan outcomes separately (Priority: P1)

As a trader, I want outcome analytics to evaluate my complete plan at its selected horizon without rewriting the bot-default metrics so I can compare the two honestly.

**Independent Test**: Evaluate a complete BUY and SELL plan against deterministic price bars, then verify the matching horizon carries trader-plan results and `/api/outcomes/summary` reports a distinct `byTraderPlan` aggregate.

**Acceptance Scenarios**:

1. **Given** a complete trader plan, **When** its matching outcome window is evaluated, **Then** target/stop precedence, return, and R multiple are recorded for that plan only.
2. **Given** a partial but valid annotation, **When** outcomes are summarized, **Then** it is preserved but excluded from `byTraderPlan.samples`.
3. **Given** no complete trader plans, **When** outcomes are summarized, **Then** `byTraderPlan` reports zero samples without changing existing hit-rate fields.

### Edge Cases

- `traderIntent: null`, arrays, strings, unknown keys, empty strings, booleans, zero, and negative numbers are rejected.
- `side` is optional only when no directional barrier is supplied. Supplying `target` or `invalidation` requires `side` so ordering can be verified.
- `notes` is optional, trimmed, and bounded to 500 characters; it is persisted but never logged.
- Horizons are exactly `1h`, `4h`, `1D`, or `1W`; case is not silently normalized.
- Existing outcome fields use bot-derived entry/target/stop unchanged; trader-plan evaluation is stored in a separate nested result.
- A bar touching both stop and target uses the service's existing conservative same-bar precedence.
- Alert replay preserves the stored top-level `traderIntent` instead of reconstructing selected fields.

## Requirements

### Functional Requirements

- **FR-001**: `POST /api/webhook/alert` and `POST /api/webhook/symbol-analysis` MUST accept an optional top-level `traderIntent` object.
- **FR-002**: An intent MUST require `entry` and `horizon`; `side`, `invalidation`, `target`, and `notes` are optional under the edge-case rules above.
- **FR-003**: Numeric fields MUST be finite positive numbers. `side` MUST be `BUY` or `SELL`; `horizon` MUST be one of `1h`, `4h`, `1D`, or `1W`.
- **FR-004**: Directional plans MUST enforce `invalidation < entry < target` for BUY and `target < entry < invalidation` for SELL across whichever barriers are present.
- **FR-005**: Invalid intent MUST return `400 INVALID_REQUEST` before enrichment, notification delivery, signal-outcome persistence, or analysis-provider calls.
- **FR-006**: Stored alerts, alert reads, replay payloads, JSONL export, and CSV export MUST preserve only the allow-listed sanitized intent fields.
- **FR-007**: Signal outcomes created by `/api/webhook/alert` MUST persist the sanitized intent without replacing bot-default `price`, `stop`, `target`, or existing outcome values.
- **FR-008**: A complete intent (`side`, `entry`, `invalidation`, `target`, `horizon`) MUST be evaluated in the matching outcome window using the same bounded market-data sample and conservative barrier precedence as the bot-default plan.
- **FR-009**: `/api/outcomes/summary` MUST expose additive `byTraderPlan` fields `{ hitRatePercent, samples, averageRMultiple }`; partial annotations MUST not enter its sample denominator.
- **FR-010**: `/api/webhook/symbol-analysis` MUST echo the sanitized intent and include it in enabled symbol-analysis storage; phase 1 MUST NOT create per-chat defaults or change outcome cardinality for that endpoint.
- **FR-011**: OpenAPI, Postman, README/operator docs, and focused contract tests MUST include valid, invalid, omitted, and partial intent variants.
- **FR-012**: This phase MUST add no dependency, environment variable, Remote Config key, Telegram command, collection, or chat-scoped identifier.
- **FR-013**: External provider, Firestore, and monitoring failures MUST retain existing fail-open behavior after validation succeeds.

### Key Entities

- **Trader intent**: Sanitized request-level annotation with optional `side`, `invalidation`, `target`, and `notes`, plus required `entry` and `horizon`.
- **Trader-plan outcome**: Matching-horizon evaluation stored separately from bot-default outcome fields, including barrier hits, first hit, return, and R multiple.
- **Trader-plan summary**: Aggregate over evaluated complete plans only.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every invalid variant in FR-003 through FR-005 returns `400 INVALID_REQUEST` before any external work.
- **SC-002**: Valid annotations round-trip through alert read, replay, JSONL export, and CSV export with zero unapproved fields.
- **SC-003**: Complete BUY and SELL plans produce deterministic matching-window results and the summary sample count equals the number of evaluated complete plans.
- **SC-004**: Existing webhook and outcome tests for requests without `traderIntent` remain green without snapshot or response-shape changes.
- **SC-005**: The full repository test suite passes and preview validation, when available, proves the PR head.

## Assumptions and Scope Decision

- The operator selected the issue's option 1: request-level intent and outcome metrics first.
- `/intentar`, per-chat defaults, per-destination outcome records, `ENABLE_TRADER_INTENT`, and `/api/status` dependency reporting are deferred because the current alert creates one outcome record while one request may broadcast to many chats.
- The issue's side-aware validation helpers inform the ordering rules; provider-generated targets are not reused to validate caller input.

## References

- GitHub issue [#791](https://github.com/francovp/cabros-bot/issues/791)
- Related issues: #550, #566, #587, #592, #647, #661.
