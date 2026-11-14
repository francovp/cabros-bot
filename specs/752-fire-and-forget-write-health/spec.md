# Feature Specification: Fire-and-Forget Firestore Write Health

**Feature Branch**: `752-fire-and-forget-write-health`  
**Created**: 2026-10-13  
**Status**: In Progress  
**Input**: GitHub issue [#752](https://github.com/francovp/cabros-bot/issues/752)

## User Scenarios & Testing

### User Story 1 - Preserve fail-open writes and record their health (Priority: P1)

When an alert, signal outcome, notification dead letter, or news dedup record is persisted asynchronously, a Firestore failure must remain non-blocking for alert delivery while producing bounded, per-domain health telemetry.

**Why this priority**: The current fail-open behavior protects delivery, but a silent write failure can make alert history, outcomes, redrive, and cross-replica dedup unreliable.

**Independent Test**: Reject each instrumented Firestore write and verify the existing caller result and delivery behavior remain unchanged while the matching health domain records one sanitized failure.

**Acceptance Scenarios**:

1. **Given** a write succeeds, **When** the shared helper observes it, **Then** the matching domain's success count and last-success timestamp advance.
2. **Given** a write rejects, **When** the helper observes it, **Then** the matching failure count, timestamp, and closed error category advance without rejecting the helper promise or changing the route's fail-open behavior.
3. **Given** a write error contains credential-like text, **When** its message is retained internally for diagnostics, **Then** the existing logger redactor is applied and the stored value is capped at 120 characters.

### User Story 2 - Inspect persistence health from status (Priority: P1)

An operator needs a safe, read-only status view for alert storage, signal outcomes, notification redrive, and persistent news dedup writes.

**Why this priority**: Operators need to detect persistence failures without scraping application logs or mistaking a healthy alert response for durable storage success.

**Independent Test**: Request `/api/status` and `/api/capabilities` before and after representative writes, then assert the per-domain counters, timestamps, failure rates, and status values.

**Acceptance Scenarios**:

1. **Given** a domain has no observed writes, **When** status is requested, **Then** that domain reports `unconfigured` with zero counters.
2. **Given** writes have been observed, **When** the last 100 attempts have a failure rate above 5% or a failure occurred within the last five minutes, **Then** status reports `degraded`; otherwise it reports `ok`.
3. **Given** a write fails, **When** status is requested, **Then** it exposes the closed error category and timestamps but no provider message, credentials, document contents, or destination.

### User Story 3 - Page once for sustained write failures (Priority: P2)

When a domain has at least 50 observed attempts and more than 20% of its latest 50 attempts failed, the service should emit one Sentry event for that domain and error category until the failure rate recovers.

**Why this priority**: Status is useful for diagnosis, while a deduplicated event makes sustained persistence failures actionable without flooding Sentry.

**Independent Test**: Drive a domain over and below the threshold with a mocked Sentry service; assert one event per active `(domain, error category)` incident and no provider message in its payload.

**Acceptance Scenarios**:

1. **Given** fewer than 50 attempts or a failure rate at or below 20%, **When** a write is recorded, **Then** no Sentry event is emitted.
2. **Given** the latest 50 attempts exceed 20% failures, **When** the threshold is first crossed, **Then** one event is emitted with feature `persistent-write-health`, the domain, and the closed failure category.
3. **Given** that incident remains above threshold, **When** further writes fail, **Then** no duplicate event is emitted; after recovery below threshold, a later threshold crossing may emit a new event.

## Edge Cases

- Unknown write domains and malformed helper inputs must fail open and must not create unbounded metric keys.
- Synchronous exceptions from the supplied write function and rejected promises use the same failure path.
- Existing idempotent “already exists” outcome writes remain successful operations and must not be counted as failures.
- A disabled or uninitialized persistence path with no attempted write reports `unconfigured`, not `degraded`.
- Metric state is process-local and bounded to the latest 100 attempts per domain; it resets on restart.
- Monitoring failures must never alter the result of the underlying write or alert delivery.

## Requirements

### Functional Requirements

- **FR-001**: A shared `fireAndForget(name, fn)` helper MUST record success or failure for the fixed domains `alertStorage`, `signalOutcomes`, `notificationRedrive`, and `newsDedup`.
- **FR-002**: The helper MUST resolve without throwing for synchronous exceptions, rejected promises, invalid input, or metric/Sentry failures, and MUST preserve the existing value on success.
- **FR-003**: Failure categories MUST be restricted to `firestore_permission_denied`, `firestore_unavailable`, `firestore_malformed`, or `unknown`.
- **FR-004**: Error messages retained internally MUST use the existing log redactor and be limited to 120 characters; raw messages MUST NOT appear in status responses or Sentry events.
- **FR-005**: The helper MUST be wired to alert storage, signal-outcome recording, notification dead-letter recording, and persistent news-dedup writes without changing their fail-open behavior or shutdown tracking.
- **FR-006**: `/api/status` and its `/api/capabilities` alias MUST expose `dependencies.persistentWriteHealth` with per-domain `success`, `failure`, `failureRate`, `lastSuccessAt`, `lastFailureAt`, `lastFailureCategory`, and `status` (`ok`, `degraded`, or `unconfigured`).
- **FR-007**: Health status MUST be `degraded` when the latest 100 attempts exceed a 5% failure rate or any failure occurred within five minutes; a domain with no observed write attempts MUST be `unconfigured`.
- **FR-008**: Sentry MUST receive one event per active domain/category incident only after at least 50 attempts and a failure rate greater than 20% across the latest 50 attempts. Events MUST use feature `persistent-write-health` and a domain/category fingerprint.
- **FR-009**: The existing `dependencies.firestoreWriteMetrics` shape and write behavior MUST remain unchanged.
- **FR-010**: The OpenAPI contract, Postman response examples, operator documentation, and focused tests MUST describe the new status block. No environment variable, Remote Config key, credential, or deployment setting is introduced.

## Assumptions

- The current `FirestoreWriteMetricsService` remains the source for the existing `firestoreWriteMetrics` contract and will host the separate process-local persistent-write-health snapshot to avoid creating duplicate counter services.
- “Last 50 attempts” means the alert threshold is evaluated only after 50 samples exist; “last 100 attempts” uses up to the latest 100 samples for status.
- Sentry deduplication is per `(domain, failure category)` and is re-armed after the rolling 50-attempt failure rate returns to 20% or lower.
- Existing `trackBackgroundTask` paths remain responsible for draining asynchronous writes during shutdown.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Each of the four write domains updates its own health counters on success and failure without changing the caller's fail-open result.
- **SC-002**: `/api/status` and `/api/capabilities` return the same new per-domain health block and preserve the existing Firestore write-metrics response.
- **SC-003**: Errors are classified into the four-value enum, redacted before in-memory retention, and never exposed in status or Sentry payloads.
- **SC-004**: One Sentry event is emitted when a domain crosses the sustained-failure threshold, with duplicates suppressed until recovery.
- **SC-005**: Existing Firestore metrics tests and the full repository test suite remain green.
