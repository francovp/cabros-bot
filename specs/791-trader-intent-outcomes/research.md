# Research: Request-level Trader Intent Outcomes

## Decision 1: Split request-level from per-chat intent

- **Decision**: Implement request annotations now; defer `/intentar` and per-chat defaults.
- **Rationale**: A webhook can broadcast to many chats but creates one outcome record. Request scope has one unambiguous owner and preserves current cardinality.
- **Alternatives considered**: Per-destination outcome fan-out was rejected because it changes privacy, write volume, deduplication, replay, and analytics semantics.

## Decision 2: Keep trader-plan results parallel

- **Decision**: Store `traderIntent` and a nested matching-window `traderPlanOutcome` without replacing `price`, `stop`, `target`, or existing outcome fields.
- **Rationale**: The issue explicitly requires comparison with the bot plan, and #550 pins current hit-rate semantics.
- **Alternatives considered**: Overwriting barriers was rejected because it silently changes existing metrics and consumers.

## Decision 3: Reuse the existing market-data sample

- **Decision**: Evaluate the trader plan inside the already-running matching-window evaluation.
- **Rationale**: Avoids a second provider call/query and inherits deadlines, conservative same-bar handling, retry accounting, and shutdown behavior.
- **Alternatives considered**: A second evaluator was rejected as duplicated async risk and provider cost.

## Decision 4: No phase-1 feature flag

- **Decision**: The optional request field is always parseable; omission remains inert.
- **Rationale**: The proposed gate only protects the new Telegram command/default store, which is out of scope. A gate for an additive request field creates config drift without reducing risk.
- **Alternatives considered**: `ENABLE_TRADER_INTENT` plus Remote Config was rejected for this phase; it remains a future command-surface decision.

## Decision 5: Partial annotations are preserved but not aggregated

- **Decision**: `entry` and `horizon` are required; directional barriers require `side`. Only complete plans enter `byTraderPlan`.
- **Rationale**: Matches the source issue's optional-field rules while keeping denominators honest.
- **Alternatives considered**: Requiring every field would narrow the documented source contract; counting partial plans would bias hit-rate and R-multiple metrics.
