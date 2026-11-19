# Feature Specification: Statistically-Guarded Outcomes Leaderboard

**Feature Branch**: `feat/outcomes-leaderboard-gh-826`  
**Created**: 2026-11-18  
**Status**: Approved  
**Issue**: [#826](https://github.com/francovp/cabros-bot/issues/826)

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Query Ranked, Statistically-Guarded Cohort Leaderboard via API (Priority: P1)

As a trading operator or admin dashboard user, I want to query `GET /api/outcomes/leaderboard` grouped by `setupType`, `symbol`, `exchange`, `side`, or `promptSource` (single or composite axes), sorted by `expectancy`, `hitRate`, `sampleSize`, or `consistency`, with sample-size gating (`minTrades`) and 95% confidence intervals, so I can immediately identify genuinely net-positive and reliably net-negative cohorts instead of chasing small-sample noise.

**Why this priority**: Core value of #826 — turns raw signal outcome logs into evidence-led trading and prompt-tuning decisions while separating small samples into `unreliableCohorts`.

**Independent Test**: Seed `tradingSignalOutcomes` fixtures in memory/mock Firestore with multi-axis cohorts above and below `minTrades`, invoke `GET /api/outcomes/leaderboard` via Express/Supertest and service unit tests, and verify exact statistical CIs, sorting, `unreliableCohorts`, and validation errors.

**Acceptance Scenarios**:

1. **Given** `ENABLE_SIGNAL_OUTCOME_TRACKING=true`, **When** `GET /api/outcomes/leaderboard?groupBy=setupType&window=1D&minTrades=10` is called with valid admin viewer credentials, **Then** cohorts with `trades >= minTrades` appear in `ranked` ordered by `expectancy` descending, each carrying `rank`, `key`, `components`, `trades`, `wins`, `losses`, `breakeven`, `hitRate`, `hitRateCI95` (Wilson 95%), `expectancyR`, `expectancyRCI95` (normal-approximation 95%), `averageMAEPercent`, `averageMFEPercent`, `averageReturnPercent`, `firstHitBreakdown`, `isStatisticallyReliable`, and `reliabilityNote`.
2. **Given** cohorts with `trades < minTrades`, **When** the leaderboard is queried, **Then** those cohorts are surfaced in `unreliableCohorts` with `{ key, components, trades, reason: "below minTrades=<n>" }` and counted in `excludedBelowThreshold` rather than silently dropped.
3. **Given** legacy outcome documents without `promptProvenance`, **When** `groupBy=promptSource` is requested, **Then** those documents are grouped under `promptSource: null` rather than discarded.
4. **Given** invalid parameters (`minTrades > 1000`, `minTrades <= 0`, `limit > 100`, `limit <= 0`, unsupported `groupBy`, `window`, `sort`, `order`, `from > to`, or `(to - from) > 31 days`), **When** `GET /api/outcomes/leaderboard` is requested, **Then** the API rejects with `400 INVALID_REQUEST`.
5. **Given** `ENABLE_SIGNAL_OUTCOME_TRACKING !== 'true'` or Remote Config `ENABLE_OUTCOMES_LEADERBOARD=false`, **When** `GET /api/outcomes/leaderboard` is requested, **Then** the API rejects with `403 FEATURE_DISABLED`.

---

### User Story 2 - Telegram `/top` Leaderboard Command (Priority: P2)

As a trader using Telegram, I want to run `/top [setupType|symbol|exchange|side|promptSource] [window=1D] [minTrades=10] [limit=10]` so I can see the top 5–10 ranked setups with confidence intervals inline without leaving Telegram.

**Why this priority**: Extends `/outcomes` and `/check` command UX to cross-symbol cohort ranking using the same backend service and timeout/disable guards.

**Independent Test**: Unit test `topCommand` with Telegraf mock context verifying MarkdownV2 escaping, top-5 default rendering, custom filters (`groupBy`, `window`, `minTrades`, `limit`), 8s timeout protection, and matching disabled message when signal outcome tracking is off.

**Acceptance Scenarios**:

1. **Given** signal outcome tracking is enabled, **When** `/top` or `/top exchange window=4h minTrades=5 limit=8` is sent, **Then** it replies with MarkdownV2-safe formatted entries (`rank · key · n · hit% · R · CI`).
2. **Given** signal outcome tracking is disabled (or `ENABLE_OUTCOMES_LEADERBOARD=false`), **When** `/top` is sent, **Then** it replies with `'El seguimiento de resultados de señales está desactivado — pide a un operador que active ENABLE_SIGNAL_OUTCOME_TRACKING'`.

---

### User Story 3 - Status Feature Flag, Cache Isolation & Coverage Visibility (Priority: P3)

As an SRE/operator, I want `/api/status` and `/api/capabilities` to expose `featureFlags.outcomesLeaderboard`, repeated leaderboard queries within 60s to hit an isolated per-filter memoization cache, and incomplete/capped scans (1000-doc limit or unevaluated signals) to emit transparent coverage metadata and `warnings`.

**Why this priority**: Controls production read costs, keeps Remote Config kill-switch parity without adding any new required environment variable, and prevents truncated samples from masquerading as a full universe.

**Independent Test**: Query `/api/status` and `/api/capabilities` under enabled/disabled flags, benchmark cache hits vs misses across differing `groupBy`/`window` args, and assert `coverage` and `warnings` when scan limit or pending docs are present.

## Statistical Definitions

- **Hit Rate Wilson 95% Confidence Interval (`hitRateCI95`)**: Two-sided Wilson score interval with $z = 1.96$ over `wins / trades`, clamped cleanly to `[0, 1]`. Returns `{ lower: 0, upper: 0 }` when `trades === 0`.
- **Expectancy R Normal-Approximation 95% Confidence Interval (`expectancyRCI95`)**: Explicitly documented **normal approximation** $\bar{R} \pm 1.96 \cdot \frac{s}{\sqrt{m}}$ using sample standard deviation $s = \sqrt{\frac{\sum (R_i - \bar{R})^2}{m - 1}}$ over the $m$ evaluated trades with finite `rMultiple` (`null` when $m < 2$). Never labeled as Wilson CI.
- **Statistical Reliability (`isStatisticallyReliable`)**: `true` iff `trades >= 30 && expectancyRCI95 !== null && (expectancyRCI95.lower > 0 || expectancyRCI95.upper < 0)`, catching both reliably positive and reliably net-negative cohorts while flagging ambiguous CIs crossing zero.

## Requirements

- Shared read-only domain helper (`src/services/storage/outcomesLeaderboard.js`) re-exported via `SignalOutcomeService.getOutcomesLeaderboard`.
- Reuses `SignalOutcomeService.fetchOutcomeDocs` bounded to max 31 days and max 1000 documents; no new Firestore collection, index, worker, or external npm package.
- Preserves optional `promptProvenance` in `recordSignalInternal` / `formatOutcomeDocument` and forwards it from alert/news signal recording call sites when present.
- Exposes `featureFlags.outcomesLeaderboard` on `/api/status` and `/api/capabilities` (defaults to `true` when `ENABLE_SIGNAL_OUTCOME_TRACKING=true`; eligible for Remote Config runtime override via non-secret `ENABLE_OUTCOMES_LEADERBOARD` without introducing any required environment variable).
- Updates OpenAPI (`src/openapi/openapi.json`), Postman (`CabrosBot.postman_collection.json`), Remote Config schema/template, `.env.example` documentation note, `README.md`, `docs/signal-outcomes.md`, and `docs/PRODUCT.md`.
