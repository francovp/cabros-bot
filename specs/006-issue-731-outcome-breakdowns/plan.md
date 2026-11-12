# Per-symbol and Per-setup Outcome Breakdowns Implementation Plan

> **For agentic workers:** This plan is being executed in the current issue-automation session.

**Goal:** Add bounded, opt-in symbol and setup outcome rollups to `/api/outcomes/summary` and `shadowModeMetrics`.

**Architecture:** Keep Firestore reads and existing overall calculations in `SignalOutcomeService`; build optional bounded maps from the already filtered and limited document set. Validate the comma-separated breakdown query in the controllers, and expose the same additive shape through the alert summary and operational status.

**Tech Stack:** Node.js 24.18.0, Express, Firebase Admin Firestore, Jest, SuperTest.

**Spec:** `specs/006-issue-731-outcome-breakdowns/spec.md`

## Global Constraints

- Add no environment variables, packages, Firestore writes, or new endpoints.
- Preserve all existing overall summary fields and defaults when `breakdown` is absent.
- Apply filters before the existing summary limit and rollup.
- Keep at most 100 buckets per requested grouping; set `truncated` only if a bucket is omitted.
- Hit-rate values are ratios in `[0, 1]`; target and stop denominators include only evaluated windows with the matching positive barrier.
- Reuse the current `windows` map, keyed by window name.

## Review Focus

1. Date, symbol, exchange, setup type, status, and window filters must precede the result limit and all rollups.
2. Null or non-positive barriers must not be counted as misses or in a hit-rate denominator.
3. Empty results and unrequested breakdowns must preserve a stable, backward-compatible response shape.
4. High-cardinality setup types must stop at the cap and accurately signal omitted buckets.
5. `/api/alerts/summary` and `/api/status` must report the same service metrics without exposing source records or destinations.

## Technical Context

**Storage:** Existing `tradingSignalOutcomes` Firestore collection; each summary reads at most the existing limit (default 1000). No writes.
**Tests:** Existing Jest unit and integration suites.
**Dependencies:** Existing manifest dependencies only.
**Scale:** At most 100 symbol buckets and 100 setup buckets per request.

## Project Structure

- `src/services/storage/SignalOutcomeService.js`: breakdown aggregation, bucket cap, and process-local status counters.
- `src/controllers/outcomes/outcomes.js`: parse `breakdown` and `setupType`; pass filters and requested groupings to the service.
- `src/controllers/alerts/alerts.js`: validate and pass breakdown to the existing shadow metrics path.
- `src/controllers/status.js`: expose bucket cap and counters.
- `src/openapi/openapi.json`, `CabrosBot.postman_collection.json`, `docs/signal-outcomes.md`, `README.md`: document the additive query and response contract.
- `tests/unit/signal-outcome-service.test.js`, `tests/unit/outcomes-controller.test.js`, `tests/integration/outcomes-endpoint.test.js`, `tests/integration/alerts-endpoint.test.js`, `tests/integration/status-endpoint.test.js`: focused coverage.

## Implementation Tasks

1. Add service tests for empty requested breakdowns, normalized grouping, counts, per-window barrier rates and excursions, setup-type filter-before-limit, and bucket truncation. Run the focused service test and confirm the new expectations fail.
2. Implement bounded bucket accumulation and per-window metrics in `SignalOutcomeService`; rerun the focused service suite.
3. Add controller tests for valid `symbol`, `setup`, and combined values; invalid/empty values; and `setupType` filter forwarding. Implement both controller paths and verify their focused tests.
4. Add endpoint tests for the new query contract and `shadowModeMetrics` shape; update OpenAPI, Postman, README, and `docs/signal-outcomes.md` with success and invalid-input examples.
5. Add status tests for bucket cap, latest bucket count, truncation state, and truncation count; implement the corresponding fields.
6. Run all affected unit and integration files, full tests, and focused lint. Review the final diff and branch status before commit and PR creation.

## Interfaces

`SignalOutcomeService.summarizeOutcomes({ ..., setupType, breakdown })` accepts `breakdown` as a validated array containing `symbol` and/or `setup`. Requested arrays contain `{symbol, exchange}` or `{setupType, exchange}`, the existing coverage counts, ratio-valued hit rates and denominator counts, and a `windows` object with per-window rates and MFE/MAE. `truncated` is present only when a breakdown was requested. `getMetricsSummary({ ..., breakdown })` passes the same optional breakdown through for `shadowModeMetrics`.
