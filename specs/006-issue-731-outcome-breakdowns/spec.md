# Feature Specification: Per-symbol and Per-setup Outcome Breakdowns

**Feature Branch**: `006-issue-731-outcome-breakdowns`
**Created**: 2026-10-10
**Status**: Draft
**Input**: GitHub issue #731: Add per-symbol and per-setupType hit-rate rollup to `/api/outcomes/summary`.

## User Scenarios & Testing

### User Story 1 - Compare outcomes by symbol and setup (Priority: P1)

As an operator, I want an opt-in summary grouped by symbol or setup type so I can compare alert outcome performance without fetching and re-aggregating every record client-side.

**Independent Test**: Request `/api/outcomes/summary?breakdown=symbol,setup` against mixed stored records and verify bounded, filtered buckets and unchanged overall summary fields.

**Acceptance Scenarios**:

1. **Given** stored outcomes, **When** `breakdown=symbol` is requested, **Then** `symbolBreakdown` contains one bucket per normalized `(symbol, exchange)` and sorts by `received` descending.
2. **Given** stored outcomes, **When** `breakdown=setup` is requested, **Then** `setupBreakdown` contains one bucket per normalized `(setupType, exchange)` and sorts by `received` descending.
3. **Given** date, symbol, or setup type filters, **When** a breakdown is requested, **Then** filtering occurs before the summary limit and rollup, and overall totals describe the same filtered population.
4. **Given** outcomes with missing barriers, **When** hit rates are computed, **Then** only evaluated windows with a positive configured barrier count in the matching denominator; a null barrier is not a miss.

### User Story 2 - See the same analysis in alert summaries (Priority: P2)

As an operator reviewing alert analytics, I want the optional outcome breakdown under `shadowModeMetrics` so the existing alert summary can present the same rollup without creating a second response convention.

**Independent Test**: Request `/api/alerts/summary?breakdown=symbol,setup` without report-specific filters and verify the same outcome breakdown fields appear under `summary.shadowModeMetrics`.

**Acceptance Scenarios**:

1. **Given** signal outcome tracking is enabled and measurements exist, **When** a breakdown is requested through `/api/alerts/summary`, **Then** the matching arrays and truncation state appear under `shadowModeMetrics`.
2. **Given** signal outcome tracking is disabled or no measurements exist, **When** the alert summary is requested, **Then** its existing disabled and no-measurement behavior remains intact.

### Edge Cases

- Empty filtered results return empty requested breakdown arrays and `truncated: false`.
- Missing symbol, exchange, or setup type values use the existing `UNKNOWN` fallback for grouping.
- Each requested grouping retains at most 100 distinct buckets. `truncated` becomes true only when a further distinct bucket is omitted.
- Unknown, blank, repeated-array, or malformed `breakdown` values return `400 INVALID_REQUEST`.
- `setupType` is a single non-empty filter value; repeated query parameters return `400 INVALID_REQUEST` rather than dropping the filter.
- Unrequested breakdown fields remain absent so existing response payloads stay additive and backward compatible.
- Evaluated outcomes without a positive target or stop barrier do not contribute to that barrier's hit-rate denominator.

## Requirements

### Functional Requirements

- **FR-001**: `/api/outcomes/summary` MUST accept `breakdown=symbol`, `breakdown=setup`, or `breakdown=symbol,setup`.
- **FR-002**: Summary filters (`from`, `to`, `symbol`, `exchange`, `setupType`, `status`, and `window`) MUST be applied before the result limit and before breakdown aggregation.
- **FR-003**: Symbol buckets MUST group by `(symbol, exchange)`; setup buckets MUST group by `(setupType, exchange)`. Group keys MUST be normalized and use `UNKNOWN` for missing dimensions.
- **FR-004**: Each bucket MUST expose `received`, `eligible`, `evaluated`, `pending`, and `unavailable` counts using the existing outcome summary classification.
- **FR-005**: Each bucket MUST expose ratio-valued `targetHitRate` and `stopHitRate` in `[0, 1]`, plus their eligible-window denominators. Only evaluated windows with a positive corresponding barrier count in that denominator.
- **FR-006**: Each bucket MUST expose per-window MFE/MAE averages using evaluated windows with at least one positive configured target or stop barrier; the response MUST retain the existing `windows` map convention.
- **FR-007**: Each requested grouping MUST retain no more than 100 distinct buckets and MUST report top-level `truncated: true` if a requested grouping omits a bucket.
- **FR-008**: `/api/alerts/summary` MUST pass a valid requested breakdown through to its existing `shadowModeMetrics` summary when that field is available.
- **FR-009**: `/api/status` MUST expose the breakdown bucket cap and process-local bucket/truncation counters under `dependencies.signalOutcomeWorker`.
- **FR-010**: OpenAPI, Postman examples, and operator documentation MUST describe valid and invalid query values, response fields, filtering, denominators, and the cap.
- **FR-011**: The change MUST add no environment variables, dependencies, or Firestore writes.
- **FR-012**: `/api/outcomes/summary` MUST reject blank or repeated `setupType` query parameters with `400 INVALID_REQUEST` so invalid input cannot silently broaden the requested population.

### Key Entity

- **Outcome breakdown bucket**: A bounded aggregate for one normalized symbol/exchange or setup type/exchange key, containing coverage counts, barrier-aware hit rates, and per-window excursion metrics.

## Success Criteria

- **SC-001**: Requests for either grouping or both return only the requested arrays, with deterministic ordering and at most 100 buckets per array.
- **SC-002**: Filtered summary totals and buckets include only records that match every requested filter before the existing limit is applied.
- **SC-003**: Hit-rate numerators and denominators agree with the existing per-window target/stop semantics for all eligible barriers.
- **SC-004**: Existing summary fields and unrequested response shapes remain unchanged.
- **SC-005**: Unit, controller, endpoint, and status coverage exercises empty results, barrierless outcomes, filters, and truncation.

## References

- GitHub issue [#731](https://github.com/francovp/cabros-bot/issues/731)
- Related filter-before-aggregation contract: GitHub issue #715.
